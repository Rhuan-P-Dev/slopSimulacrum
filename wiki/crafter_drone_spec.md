# Crafter Drone — Design Specification

**Status:** Approved design — implementation-ready for the Code subtask.
**Scope:** Design only. This document specifies exactly what changes (data + code); it contains no implementation code beyond JSON snippets and pseudocode.
**Sync:** Implementation-facing contracts in this document (signatures, return shapes) are updated in the same PR that changes them.

The **Crafter Drone** is a new deterministic-brain NPC that repeatedly: finds a dropped `knife` on the ground → moves to it with the normal turn-based `move` action → picks it up with the existing pick-up mechanism → crafts a `t1` (T1 container weapon) from the single knife via the data-driven crafting system → drops the `t1` on the ground → loops. It operates exactly like any other entity: same turn system, same action pipeline, same `WorldStateController` public API. No special movement, no direct state access, no new routes.

---

## 1. Verified mechanisms (evidence from the current codebase)

| # | Mechanism | Where verified | Fact the design relies on |
|---|-----------|----------------|---------------------------|
| 1 | Deterministic NPC brain | [`src/controllers/ai/NpcAIController.js`](src/controllers/ai/NpcAIController.js:22), [`src/utils/npcAiUtils.js`](src/utils/npcAiUtils.js:17) | An entity is brain-driven when `isNPC === true` and `npcConfig.ai.behavior` is a non-empty string. Behaviors are a `Map` registry keyed by behavior name; the dispatch passes `({ entity, round, ai, facade, allEntities })` to the strategy (line 113), then runs the capability gate `facade.canEntityExecuteAction(entityId, decision.actionName)` and `_dispatchDecision` (queue during planning / immediate `executeAction` fallback / discard when window closed). |
| 2 | NPC-agent hook wiring | [`src/server.js`](src/server.js:71) | The turn system's NPC-agent hook fires **fire-and-forget at round start** for each roster NPC — the agent is the slowest planner, so its plan begins the moment the round opens, never at a fixed tick (the tick clock is bookkeeping/observability only; nothing about round structure derives from it). It already routes deterministic-brain entities to `npcAIController.think(npcEntityId, round, entity)` and everything else to the LLM agent. **No `server.js` change needed.** |
| 3 | NPC boot spawn | [`src/controllers/WorldStateController.js`](src/controllers/WorldStateController.js:320) (`_spawnNpcs`) | `data/npcs.json` entries are keyed by **blueprint name**; the value needs `displayName`, `personality`, optional `room` (default `start_room`), and `ai.behavior` (validated at boot). The entity spawns `isNPC: true` with `npcConfig.ai` and is positioned at the room center. `isNPC` entities opt out of the declarative `data/world.json` `initialSpawns` (line 465) → the drone starts with an **empty inventory**. |
| 4 | Blueprints/components | [`data/blueprints.json`](data/blueprints.json:1), [`data/components.json`](data/components.json:1), [`src/controllers/core/entityController.js`](src/controllers/core/entityController.js:104) | Blueprints are recursive arrays (`"merchantDroid": ["merchantCore"]`, sub-entries are `"type"` or `["type", "identifier"]`). `createEntityFromBlueprint` emits component instances `{ type, identifier, id: "comp-<uuid>", dependsOn }`. The merchant precedent (Feature D) shows the sanctioned pattern of adding new component types for a new NPC. |
| 5 | Movement | [`data/actions.json`](data/actions.json:18) (`move`), [`src/controllers/consequences/SpatialConsequenceHandler.js`](src/controllers/consequences/SpatialConsequenceHandler.js:8) | The `move` action (registry id `move`, requirement `Movement.move ≥ 5`) applies `deltaSpatial` toward `targetX/targetY` — up to the `Movement.move` stat per execution, **within the current room**. `chase_attack` already uses exactly this pattern to close distance on a target each turn. No pathfinding exists; none is required (intra-room Euclidean approach). |
| 6 | Picking up a dropped item | [`src/controllers/WorldStateController.js`](src/controllers/WorldStateController.js:2151) (`executePickUpItem`), [`src/controllers/consequences/PickUpItemHandler.js`](src/controllers/consequences/PickUpItemHandler.js:28), [`src/routes/worldRoutes.js`](src/routes/worldRoutes.js:132) | The game's actual pick-up of ground items is the **immediate** operation `WorldStateController.executePickUpItem(entityId, droppedItemId, componentId)` (same call the player's map flow makes via `POST /pick-up-item`). The handler validates: item exists on the ground, entity+component exist, **distance ≤ the action's range** (data-driven from the `pickUpItem` entry in `data/actions.json` via the shared `RangeResolver`, with the shared fallback — the same value the brain's `craft_loop` resolves each round, see §4.2), component capacity, and rejects items with nested children. It is **not** turn-gated — the same category as crafting/equip/unequip (immediate inventory ops, see [`wiki/llm_turns_npc_spec.md`](wiki/llm_turns_npc_spec.md) §4). The `pickUpItem` entry in `data/actions.json` is **not usable** for dropped items: its consequence template (`sourceEntityId/sourceItemId/sourceComponentId/targetEntityId/targetComponentId`) does not match the handler's contract (`entityId/droppedItemId/componentId`), and no client flow executes it (verified: `Config.js` defines the constant but nothing consumes it; the client uses `POST /pick-up-item`). **Decision: the drone calls `executePickUpItem` on its turn (immediate), not the `pickUpItem` action.** See Risk R1. |
| 7 | Dropped items in world state | [`src/controllers/WorldStateController.js`](src/controllers/WorldStateController.js:2080) (`getDroppedItems`, `getDroppedItemsByRoom`) | `getDroppedItems()` returns `{ [droppedId]: { id, itemType, itemId, x, y, roomId, ownerId, name, description, volume, nestedItems } }` (defensive deep copy). `roomId` is the room **UID** — the same space as `entity.location`. `x/y` are room-relative coordinates — the same space as `entity.spatial`. |
| 8 | Crafting | [`src/controllers/crafting/CraftingController.js`](src/controllers/crafting/CraftingController.js), [`src/controllers/WorldStateController.js`](src/controllers/WorldStateController.js) (`craftItems`) | `WorldStateController.craftItems(entityId, recipeId, componentId, itemIds)` is the public API (delegates to `CraftingController.craft`). Crafting is **by design not a registry action** (no turn cost, cannot be queued — see [`wiki/subMDs/systems/crafting_system.md`](wiki/subMDs/systems/crafting_system.md) §2/§4: "if a future design wants crafting to cost a round, the right way is to register a real registry action at that point"). The drone therefore triggers it **directly on its turn** — the sanctioned pattern (see Risk R2). Capacity pre-check: `free(component) + released(inputs on that component) ≥ Σ output itemDef.volume`; inputs must be on `componentId` and free of nested items; failures are structured (`INSUFFICIENT_CAPACITY`, `INSUFFICIENT_INPUTS`, …) — never throws. |
| 9 | Existing recipes | [`data/crafting.json`](data/crafting.json:2) | The **only** recipe today is `knife_to_t1`: **2 knives → 1 t1**. There is **no** recipe converting a single knife into a T1 → a new recipe is required (see §3.3). |
| 10 | Items | [`data/inventoryItems.json`](data/inventoryItems.json:50) | `knife` (volume 1, sharpness 50) and `t1` (volume 10 **internal**, externalVolume 1, "dual-volume" container weapon) already exist. **No `inventoryItems.json` change is needed.** Host footprint for capacity = `externalVolume ?? volume` → both `knife` and `t1` occupy **1** slot on the host component. |
| 11 | Drop action | [`data/actions.json`](data/actions.json:27) (`dropItem`), [`src/controllers/consequences/DropItemHandler.js`](src/controllers/consequences/DropItemHandler.js:43) | `dropItem` is a real registry action (requirement `Physical.strength ≥ 1`, range 100). Its consequence template resolves `{ entityId: ":entityId", itemId: ":itemId", itemType: ":itemType", targetX: ":targetX", targetY: ":targetY" }`; the handler removes the item from the entity and places a dropped entry at `(targetX, targetY)` in the entity's room. Works through the normal action pipeline (queue or immediate). |
| 12 | Turn system (v2 event-driven rounds) | [`src/controllers/core/TurnSystemController.js`](src/controllers/core/TurnSystemController.js), [`src/utils/Constants.js`](src/utils/Constants.js:108) | Rounds are **event-driven rendezvous, not tick spans**: the tick loop merely carries them (round 0 starts lazily on the first tick, the next round starts on the tick after resolution), but no round-structure fact derives from the clock's value — the roster is a snapshot of the entities present at round start, the planning window closes only when every roster planner has signaled plan-complete (no deadline; a planner removed mid-planning counts as vacuously complete), and close and resolution settle inside the same tick call (the resolution phase stays observable for at least one tick, so the closed-window rejection window is real). WHY the clock never drives behavior: it is bookkeeping/observability only, and a non-finite value is rejected at its single read point, so a corrupt clock cannot change any outcome. The only remaining round constant is the per-entity queue cap (`TURN_MAX_QUEUED_PER_ROUND`, orthogonal to timing). The drone queues **at most one** action per round (its single decision). |
| 13 | Capacity of new components | [`src/utils/InventoryManager.js`](src/utils/InventoryManager.js:189) | Component capacity comes from `Physical.volume` in `data/components.json`; item footprint = `externalVolume ?? volume`. A `crafterCore` with `volume: 12` comfortably holds a `knife` (1) + a `t1` (1) plus headroom. Internal components do **not** interfere: both entries in [`data/internalComponents.json`](data/internalComponents.json:1) have `autoInstallOnSpawn: false` (and `transcendentSpeedCore` is restricted to `targetBlueprintTypes: ["smallBallDroid"]`). |

---

## 2. Blueprint & components (new entity)

### 2.1 `data/blueprints.json` — add exactly these two entries

```json
"crafterDrone": ["crafterCore"],
"crafterCore": [
  ["crafterArm", "left"],
  ["crafterArm", "right"],
  ["crafterRollingBall", "left"],
  ["crafterRollingBall", "right"]
]
```

- `crafterDrone` is the top-level blueprint name — the **same string** used as the key in `data/npcs.json` and passed to `spawnEntity`.
- Structure mirrors the `merchantDroid`/`merchantCore` precedent (core + paired arms + paired wheels). No head: the drone has no `Mind` trait (it is a functional worker, not an LLM/chat NPC) and no hands (nothing needs `cut`/punch capabilities).
- The deterministic-brain flag is **not** a blueprint field: it is `isNPC: true` + `npcConfig.ai = { behavior: "craft_loop" }`, stamped by `_spawnNpcs` from `data/npcs.json` (verified §1.3). The blueprint only needs to provide the stats that make the drone's actions pass the capability gate:

| Action used by the drone | Requirement (data-driven) | Provided by |
|---|---|---|
| `move` | `Movement.move ≥ 5` | `crafterRollingBall.Movement.move = 10` |
| `dropItem` | `Physical.strength ≥ 1` | `crafterArm.Physical.strength = 10` |
| (host for picked items) | `Physical.volume ≥ 1` + real capacity | `crafterCore.Physical.volume = 12` |

### 2.2 `data/components.json` — add exactly these three entries

```json
"crafterCore": {
  "traits": {
    "Physical": { "mass": 20, "durability": 100, "volume": 12 },
    "Spatial": { "x": 0, "y": 0 }
  }
},
"crafterArm": {
  "traits": {
    "Physical": { "durability": 50, "strength": 10, "volume": 6 },
    "Spatial": { "x": 18, "y": 10 }
  }
},
"crafterRollingBall": {
  "traits": {
    "Physical": { "durability": 80, "volume": 10 },
    "Movement": { "move": 10 },
    "Spatial": { "x": 0, "y": 20 }
  }
}
```

Rationale:
- `crafterCore.volume = 12` (same as `merchantCore`): holds the knife (host 1) and the crafted T1 (host 1) with room for a second knife before re-crafting; satisfies the crafting pre-check with margin (Risk R8).
- `crafterArm.strength = 10`: passes `dropItem` (≥ 1) with margin while staying far below the `droid punch` threshold (15) — the drone is non-combat by stat, matching its role.
- `crafterRollingBall.Movement.move = 10` (same as `merchantRollingBall`): 10 px per `move` action; crosses the 300×200 `start_room` in ~2–3 moves. Initiative 10 places the drone mid-order in resolution.
- No `Mind` trait on any drone component → the LLM context/chat path never finds anything to talk to; the brain path is selected purely by `npcConfig.ai.behavior`.

---

## 3. Data changes

### 3.1 `data/npcs.json` — add one entry (key = blueprint name)

```json
"crafterDrone": {
  "displayName": "Crafter Drone",
  "room": "start_room",
  "personality": "A tireless field-fabrication drone that forages dropped knives, forges each one into a T1 container weapon, and leaves the finished weapon on the ground.",
  "ai": { "behavior": "craft_loop" }
}
```

- No `initialItems` — the drone spawns empty-handed (and `isNPC` entities already opt out of `data/world.json` `initialSpawns`, verified §1.3).
- No `attackRange`/`attackAction`/`moveAction` overrides — `craft_loop` uses the fixed action names `move`/`dropItem` (see §4).
- Spawns at the `start_room` center (`width/2, height/2` = 150, 100) via the existing boot path. No route/API changes needed to spawn it (Risk: none; see §5).

### 3.2 No changes to `data/inventoryItems.json`

`knife` and `t1` already exist with the exact IDs and volumes the design needs (verified §1.10). No new item types are introduced.

### 3.3 `data/crafting.json` — add one recipe (additive)

```json
"single_knife_to_t1": {
  "id": "single_knife_to_t1",
  "name": "T1 Field Assembly",
  "description": "Forge a single knife into a T1 container weapon.",
  "inputs": [
    { "type": "knife", "quantity": 1 }
  ],
  "outputs": [
    { "type": "t1", "quantity": 1 }
  ]
}
```

- The existing `knife_to_t1` recipe (**2 knives → 1 t1**) is **left untouched** (it is player-facing balance; the drone must not change it).
- The drone uses `single_knife_to_t1` exclusively: its inputs match exactly one knife (what it holds), and one `t1` output is what it drops.
- Recipe format follows the existing file's schema exactly (`id`, `name`, `description`, `inputs[type, quantity]`, `outputs[type, quantity]`).
- Capacity check for a `crafterCore` (volume 12) holding one knife (host 1): `free = 11`, `released = 1`, `required = t1.volume = 10` → `11 + 1 = 12 ≥ 10` ✓ (Risk R8).

---

## 4. Behavior spec — `craft_loop`

### 4.1 Registration

In [`src/controllers/ai/NpcAIController.js`](src/controllers/ai/NpcAIController.js:40) (constructor), add the behavior to the registry `Map`, mirroring `chase_attack`:

```js
this._behaviors.set('craft_loop', this._craftLoopBehavior);
```

plus a new private method `craftLoopBehavior` on the class. No constructor-injection change (the behavior uses only the per-round snapshot args and the already-injected `facade`).

### 4.2 Constants and the pickup-range contract (in `src/utils/npcAiUtils.js`)

The behavior's configuration in `npcAiUtils.js`: the recipe id (`single_knife_to_t1`), the forged output type (`t1`), and the foraged-type fallback (`knife`, used only when the recipe registry is unavailable — the behavior prefers the recipe's first input type, keeping the recipe the single source of truth for what is foraged). These mirror the existing `ATTACK_RANGE`/`PUNCH_ACTION`/`MOVE_ACTION` pattern in `npcAiUtils.js`.

**There is no static pickup-range constant — and that is the contract.** The brain resolves the pickup range each round from the `pickUpItem` action definition in `data/actions.json`, through the shared `RangeResolver` and the shared fallback in `src/utils/Constants.js` — the exact same resolution path, source, and fallback that the `PickUpItemHandler` validates against. WHY: the brain's "in range → pick up" decision and the handler's acceptance check are two consumers of one data-driven value, so they cannot drift; a hardcoded constant on the brain side was precisely that drift — after the handler became data-driven, the brain kept deciding "in range" at distances the handler rejected, and the stateless loop re-derived the same rejected pickup every round forever (the drone stalled at its approach limit and never completed the goal).

### 4.3 Decision flow (stateless — re-derived from the facade every round)

Contract: `(ctx: { entity, round, ai, facade, allEntities }) => decision | null`, where `decision = { actionName, params }`.

```
craft_loop(ctx):
  entity = ctx.entity                      # brain guarantees non-null; entity.id, entity.location (room UID),
                                           # entity.spatial {x,y}, entity.components [{type, identifier, id}]

  knifeType  = ctx.facade.getCraftingRecipes()[RECIPE_ID]?.inputs?.[0]?.type ?? 'knife'

  # ---------- STAGE A: holding a knife? -> craft (free) + drop the new T1 (the one turn action) ----------
  itemsByComp = ctx.facade.getEntityItems(entity.id)      # { [componentId]: [ {id, type, hostComponentId, ...} ] }
  allItems    = flatten(itemsByComp)
  knife       = first item in allItems with type === knifeType
  if knife:
      host      = knife.hostComponentId
      t1Before  = set of ids of items with type === CRAFT_OUTPUT_TYPE in allItems
      result    = ctx.facade.craftItems(entity.id, RECIPE_ID, host, [knife.id])
      if result.success:
          t1After = set of ids of type CRAFT_OUTPUT_TYPE in ctx.facade.getEntityItems(entity.id)
          newT1   = first id in (t1After - t1Before); if none found, any id in t1After (defensive)
          if newT1:
              return {
                  actionName: 'dropItem',
                  params: {
                      itemId:   newT1,
                      itemType: CRAFT_OUTPUT_TYPE,
                      targetX:  entity.spatial.x,        # drop exactly where the drone stands
                      targetY:  entity.spatial.y
                  }
              }
      return null        # craft failed (or no new item detectable) -> idle this round, retry next round

  # ---------- STAGE B: not holding a knife -> find the nearest dropped knife in the SAME room ----------
  pickRange = resolvePickUpRange(ctx.facade, entity)
            # -> the pickUpItem range from data/actions.json (shared RangeResolver +
            #    shared fallback): the SAME value the PickUpItemHandler validates
            #    against — single source of truth, brain and handler cannot drift
  dropped = Object.values(ctx.facade.getDroppedItems())
  knives  = dropped.filter(d => d.itemType === knifeType)        # type filter only
  nearest = findNearestDroppedItem(knives, entity.location, entity.spatial.x, entity.spatial.y)
            # -> { item, distance } | null (helper owns the room/finite guards)
  if nearest === null:
      return null         # IDLE: no in-room target item
  dist    = nearest.distance

  if dist <= pickRange:
      core = entity.components.find(c => c.type === 'crafterCore')
      if core:
          ctx.facade.executePickUpItem(entity.id, nearest.item.id, core.id)   # IMMEDIATE, non-turn-gated
                                                                              # (same op the player's map pick-up uses)
      if the pickup was rejected:
          return { actionName: 'move', params: { targetX: nearest.item.x, targetY: nearest.item.y } }
          # GRACEFUL DEGRADATION (logged at WARN): the handler rejected the
          # in-range pickup (e.g. a range desync) -> approach fallback instead of
          # re-deriving the same pickup decision every round
      return null        # pickup committed this round; the craft happens in Stage A next round

  # ---------- STAGE C: knife out of reach -> normal turn-based movement ----------
  return { actionName: 'move', params: { targetX: nearest.item.x, targetY: nearest.item.y } }
```

### 4.4 State machine (per round)

```mermaid
stateDiagram-vr
    [*] --> Idle
    Idle --> Idle : no knife held and no dropped knife in room
    Idle --> Approaching : dropped knife found beyond the resolved pickUpItem range
    Approaching --> Approaching : knife still beyond the resolved pickUpItem range -> move action each round
    Approaching --> PickedUp : knife within the resolved pickUpItem range -> executePickUpItem immediate
    PickedUp --> Crafted : next round, knife held -> craftItems immediate succeeds
    Crafted --> Idle : dropItem action drops the new T1 at drone position
    Crafted --> Idle : craft failed -> idle, retry next round
    Approaching --> Idle : knife vanished (picked by another) -> re-derive, none left
    PickedUp --> Approaching : pickup rejected by handler (e.g. range desync) -> approach fallback; the drone keeps converging and retries (graceful degradation)
```

Key properties:

- **Multi-turn movement** is purely the existing `move` action: each round the drone queues (planning phase) or immediately executes one `move` toward the knife's current coordinates; `deltaSpatial` advances it up to `Movement.move` (10) px. There is no pathfinding and no special movement code — identical to how `chase_attack` closes on a target.
- **Loop**: after dropping the T1 the drone is back in Stage B (it no longer holds the knife; the dropped T1 is not a knife, so it is never re-targeted). It keeps working any next dropped knife.
- **Idle**: no dropped knife in the room and none held → `think()` returns `{ acted: false, reason: 'idle' }` (the framework's standard idle; nothing is queued).
- **Capability gate**: the only actions the behavior *returns* are `move` and `dropItem`; both pass the gate for the drone's stats (§2.1). `executePickUpItem` and `craftItems` are immediate operations that perform their own validation internally — they are not gated by the action registry, exactly as for players.
- **Dispatch**: returned decisions flow through the existing `_dispatchDecision` — `queueAction(entityId, actionName, params, 'npc')` during the planning window, immediate `executeAction` when the world has no turn system or turns are disabled, discard+log when the window is closed. No changes to `_dispatchDecision` or `TurnSystemController`.
- **Determinism & safety**: no RNG; nearest-knife tie-break by item id; the root try/catch in `think()` already contains any behavior bug (framework guarantees the turn loop survives).
- **Stale-world robustness**: everything is re-read from the facade each round. If another agent picks the target knife between rounds, Stage B simply finds nothing (or the next-nearest). If the pickup is rejected at call time (range desync, capacity, vanished item), the rejection is logged and the drone falls back to the approach phase (it keeps converging and retries the pickup) — no stale assumptions, no infinite re-derivation of the same pickup.

### 4.5 Sequence of a full cycle (turn-by-turn)

| Round | World condition | Behavior returns | Immediate calls |
|-------|-----------------|------------------|-----------------|
| 1 | knife dropped at dist 150 in `start_room` | `move → (knife.x, knife.y)` | — |
| 2 | dist 140 | `move` | — |
| 3–10 | dist decreases by ≤ 10 per round until ≤ 50 (the resolved pickUpItem range) | `move` | — |
| 11 | dist ≤ resolved range | `null` (idle) | `executePickUpItem(drone, knife, core)` → knife on `crafterCore` |
| 12 | holds knife | `dropItem { itemId: newT1, itemType: 't1', targetX/Y: drone pos }` | `craftItems(drone, 'single_knife_to_t1', core, [knife.id])` → T1 on core |
| 13 | T1 on the ground at drone's position | `null` or next-knife pursuit | — |

---

## 5. Integration (what is NOT touched)

- **`src/server.js`** — no change. The existing NPC-agent dispatcher (line 71–82) routes any `hasDeterministicBrain` entity to `NpcAIController.think`; the drone qualifies via `npcConfig.ai.behavior = 'craft_loop'`.
- **`src/composition/WorldComposition.js`** — no change. `NpcAIController` is already constructed in `server.js` with `worldStateController` (facade) + `turnSystemController`.
- **`src/routes/*`** — no change. The drone spawns at boot from `data/npcs.json` (`_spawnNpcs`), the same path as the merchant and rogue droid. No new HTTP endpoint is required for this feature.
- **`src/controllers/core/TurnSystemController.js`**, **`src/controllers/crafting/CraftingController.js`**, **`src/controllers/consequences/*`**, **`src/utils/InventoryManager.js`** — no changes; all reused as-is.
- **Client (`public/`)** — no change. The drone and its dropped T1 broadcast through the existing world-state broadcast (entities + dropped items are already rendered by `WorldMapView`).
- **Persistence** — the drone is part of the entity store; the existing snapshot/restore path (BUG-123) covers it. Its held items / ground drops persist like any other state.

---

## 6. Code change list (for the Code subtask)

| # | File | Change |
|---|------|--------|
| 1 | [`data/blueprints.json`](data/blueprints.json) | Add the two entries from §2.1 (`crafterDrone`, `crafterCore`). |
| 2 | [`data/components.json`](data/components.json) | Add the three component definitions from §2.2 (`crafterCore`, `crafterArm`, `crafterRollingBall`). |
| 3 | [`data/npcs.json`](data/npcs.json) | Add the `crafterDrone` entry from §3.1. |
| 4 | [`data/crafting.json`](data/crafting.json) | Add the `single_knife_to_t1` recipe from §3.3; do NOT modify the existing `knife_to_t1` entry. |
| 5 | [`src/utils/npcAiUtils.js`](src/utils/npcAiUtils.js) | Export `RECIPE_ID` (= `'single_knife_to_t1'`), `TARGET_ITEM_TYPE` (= `'knife'`, data-driven fallback), `CRAFT_OUTPUT_TYPE` (= `'t1'`), plus the data-driven `resolvePickUpRange(facade, entity)`: resolves the `pickUpItem` range from the live action registry through the shared `RangeResolver` + shared fallback — the exact same resolution path as the `PickUpItemHandler`, so brain and handler can never drift (no static pickup-range constant). Export a pure helper `findNearestDroppedItem(droppedItems, roomId, x, y)`: min Euclidean distance with lexicographic-id tie-break; the helper owns the room + finite-coordinate guards and returns `{ item, distance }` or `null`. The pickup-range decision is owned by the behavior (mirrors `chase_attack`), not the helper — no range parameter. |
| 6 | [`src/controllers/ai/NpcAIController.js`](src/controllers/ai/NpcAIController.js) | (a) Register `'craft_loop'` in the `_behaviors` Map in the constructor. (b) Add private method `_craftLoopBehavior(ctx)` implementing the §4.3 flow exactly (Stage A → B → C), using only the listed facade public APIs: `getCraftingRecipes`, `getEntityItems`, `craftItems`, `getDroppedItems`, `executePickUpItem`, `getActionRegistry`, plus `entity.location/spatial/components` from the passed snapshot. No direct access to `facade.*Controller` internals, no reads of `facade._*` fields. |

That is the complete change surface. Everything else (turn system, consequence handlers, crafting controller, routes, composition root, client) is reused unchanged.

---

## 7. Test plan

Follow existing conventions: unit tests live in `test/unit/` (vitest; external collaborators mocked as hand-built objects, see [`test/unit/NpcAIController.test.js`](test/unit/NpcAIController.test.js:1) for the facade-mock pattern); contract tests in `test/contract/` exercise the real composition root.

### 7.1 New unit test file: `test/unit/NpcAIController.craftLoop.test.js`

Fixture: a drone entity (`isNPC: true`, `npcConfig.ai.behavior = 'craft_loop'`, blueprint `crafterDrone`, `location: 'room-main'`, `spatial: {x:0, y:0}`, components `crafterCore`/`crafterArm`/`crafterRollingBall` with typed ids) + a mock facade exposing `getEntity`, `getEntities`, `getActionRegistry` (with `move`, `dropItem`, and `pickUpItem` entries — the brain resolves the pickup range from the `pickUpItem` entry, the same source as the handler), `canEntityExecuteAction`, `executeAction`, `getDroppedItems`, `getEntityItems`, `craftItems`, `executePickUpItem`, `getCraftingRecipes`, and a mock `turnSystem` (planning open / closed variants), mirroring the existing test file's `makeFacade`.

Cases:

1. **Idle — no knife anywhere**: empty inventory, empty dropped items → `think()` returns `{ acted: false, reason: 'idle' }`; no `queueAction`/`executeAction`/`executePickUpItem`/`craftItems` calls.
2. **Move — knife out of range, same room**: one dropped knife (`itemType 'knife'`, same `roomId`) at distance 150 → decision `{ actionName: 'move', params: { targetX, targetY } }` matching knife coords; `turnSystem.queueAction` called with source `'npc'` (planning open); `canEntityExecuteAction(id, 'move')` consulted and passing.
3. **Move — different room ignored**: knife dropped in another room's `roomId`, none in the drone's room → idle (no move decision based on the foreign knife).
4. **Pick up — knife within range**: knife at distance 50 (≤ the resolved pickUpItem range) → `executePickUpItem(droneId, knifeDroppedId, coreCompId)` called exactly once with the core component's id; `think()` returns idle (no action queued this round). A rejected in-range pickup (simulating a range desync) → approach fallback: a `move` decision is queued and the rejection is logged (graceful degradation — the loop keeps converging instead of re-deriving the same pickup forever).
5. **Pick up — boundary**: knife at exactly the resolved range (50) → still picks up (`≤` semantics, mirroring the handler's `> maxRange` rejection).
6. **Craft + drop — holds knife**: inventory contains one `knife` on `crafterCore` → `craftItems(droneId, 'single_knife_to_t1', coreCompId, [knifeId])` called; on success the mock `getEntityItems` (post-call) contains a new `t1` → decision `{ actionName: 'dropItem', params: { itemId: <new T1 id>, itemType: 't1', targetX: 0, targetY: 0 } }` queued via `turnSystem` (source `'npc'`).
7. **New-T1 detection with a pre-existing T1**: inventory holds a knife **and** an older `t1` → after craft, the decision drops the *new* T1 id (set-difference), not the pre-existing one.
8. **Craft failure → idle**: `craftItems` mock returns `{ success: false, code: 'INSUFFICIENT_CAPACITY' }` → no drop decision; `think()` returns idle; no exception.
9. **Capability gate failure**: `canEntityExecuteAction(id, 'move')` false (simulated) → decision discarded, `acted: false, reason: 'capability'` (framework behavior, confirms the behavior returns a gate-able action).
10. **Window closed / no turn system**: planning closed → decision discarded (no `queueAction`, no `executeAction`); world without `turnSystem` → immediate `executeAction('move', …)` fallback (framework behavior, covered for completeness as in the existing suite).
11. **Unknown behavior still guarded**: an entity with `ai.behavior = 'craft_loop'` dispatches through the registry (implicitly covered by cases 1–10 since the fixture uses that behavior); keep the existing `UNKNOWN_BEHAVIOR` case for a bogus name unchanged.
12. **Multi-round convergence (small simulation)**: with a mock `executeAction` that applies `deltaSpatial`-like movement (reducing distance by 10 per `move`) and a knife at distance 150, run `think()` repeatedly over simulated rounds → assert the sequence reaches `executePickUpItem`, then (next round) `craftItems` + `dropItem` decision, matching §4.5.

### 7.2 New contract test file: `test/contract/crafterDrone.contract.test.js`

Uses the real composition root + `WorldStateController` (pattern: [`test/contract/persistence.contract.test.js`](test/contract/persistence.contract.test.js)).

1. **Boot spawn**: after world construction, exactly one entity with `blueprint === 'crafterDrone'` exists, `isNPC === true`, `npcConfig.ai.behavior === 'craft_loop'`, located in the `start_room` UID at the room center; inventory empty.
2. **Full cycle end-to-end**: (a) place a `knife` on the ground in `start_room` away from the drone (e.g., have a player entity execute `dropItem` on a held knife, or dispatch the drop handler directly); (b) drive the v2 machine the way the real world does — **one `onTick()` per round, each followed by a small settle window** for the fire-and-forget agent promises: the roster NPCs' agents fire at round start, the all-ready close (event-driven, no deadline) and the resolution settle inside that same call, and the next round starts on the next tick; the measured timeline at the data-driven pickup range (50, from `data/actions.json` — the same source the handler validates) and 10 px per `move` is **seven approach moves (120 → 50) → pickup at exactly the boundary (round 7) → craft + drop (round 8) → T1 first observable after 9 rounds**, within a 10-round budget — the duration is not a pinned constant but falls out of that data, so a data change re-tunes the timeline without a code change; (c) assert the terminal state: the drone's `spatial` stopped exactly at the resolved pickup-range boundary; the foraged knife is gone from the world and the drone is empty-handed; `getDroppedItems()` contains a new entry with `itemType === 't1'` at the drone's position in its room, with `ownerId === drone.id`; the stored `roundNumber` confirms several rounds elapsed (stored state, never derived from the tick clock).
3. **Idle with no knife**: fresh world, no dropped knives → advance 3 rounds → drone's `spatial` unchanged (stays at spawn center); no dropped items created.
4. **Data contract**: `DataLoader`-loaded `crafting.json` contains `single_knife_to_t1` with exactly 1 knife input and 1 t1 output; a fresh test entity holding one knife on a volume-12 component succeeds `craftItems` and ends up holding a `t1` (validates the recipe through the real `CraftingController`, including the capacity pre-check).
5. **Regression guard**: existing `smallBallDroid` (chase_attack) and merchant behavior unaffected — assert the rogue droid still spawns and (if cheap) still pursues as before.

### 7.3 Additions to existing test files

- [`test/unit/npcAiUtils.test.js`](test/unit/npcAiUtils.test.js) — add cases for the new exported constants/helper (`findNearestDroppedItem` distance ordering, id tie-break, empty-input guard) if the helper is added, plus coverage of `resolvePickUpRange` against the data file (the brain/handler single-source-of-truth contract, §4.2).
- **Any contract test that asserts exact entity counts or NPC-only assumptions** (e.g., [`test/contract/persistence.contract.test.js`](test/contract/persistence.contract.test.js), [`test/contract/TurnSystem.contract.test.js`](test/contract/TurnSystem.contract.test.js), [`test/contract/worldStateController.contract.test.js`](test/contract/worldStateController.contract.test.js)): the new boot-time NPC increases the entity population by one. The Code subtask MUST run the full suite and update count-sensitive assertions to be robust (count by blueprint, or allow the drone) — no weakening of unrelated assertions.

---

## 8. Risks & assumptions (decisions made)

- **R1 — "the existing game action 'pick'"**: the prompt refers to a `'pick'` action; the codebase's actual dropped-item pick-up is the immediate public op `WorldStateController.executePickUpItem(entityId, droppedItemId, componentId)` (the same call behind `POST /pick-up-item`, which is what the player's map flow uses). The `pickUpItem` entry in `data/actions.json` cannot serve dropped items: its consequence-template params (`sourceEntityId/sourceItemId/sourceComponentId/targetEntityId/targetComponentId`) don't match `PickUpItemHandler`'s contract (`entityId/droppedItemId/componentId`), and no client flow executes it. **Decision: the drone calls `executePickUpItem` on its turn, as an immediate (non-turn-gated) inventory operation — the same category the project already classifies for crafting/equip/unequip. Movement (the part the prompt explicitly constrains to the turn system) still goes exclusively through the `move` action.** If a future design wants pick-up to cost a round, the sanctioned fix is a data change to the `pickUpItem` action template, not a special case in the turn system.
- **R2 — Crafting on a turn**: the crafting wiki states crafting is a UI-panel, non-turn-cost operation and that NPC brains are "invisible to crafting". **Decision: the drone triggers `facade.craftItems(...)` directly during its round-start agent call (free, like the panel), and consumes its one turn action for the `dropItem` of the result. No new registry action is added** (adding one would contradict the documented design; the wiki prescribes registering a real action only if a round cost is ever wanted).
- **R3 — Room scope**: the drone only acts on dropped items in its **own room** (`d.roomId === entity.location`) and never performs door traversal (`move` is intra-room by design). A knife dropped in another room is ignored until it (or the drone's world) brings them together. Cross-room pursuit would need the `move-entity` door flow and is explicitly out of scope.
- **R4 — New recipe, not a modification**: the existing 2-knife `knife_to_t1` is untouched; the additive `single_knife_to_t1` keeps player-facing balance intact while giving the drone its 1-knife conversion.
- **R5 — T1 "auto-assignment" is a non-issue**: the wiki (`components_and_entities.md` §5) mentions T1 auto-assignment on spawn; the actual mechanism is the declarative `data/world.json` `initialSpawns`, and `isNPC` entities opt out (verified in code, `WorldStateController._applyInitialSpawns`). The drone spawns with an empty inventory — no surprise T1, no capacity contention.
- **R6 — Internal components**: neither internal component auto-installs on the drone (`autoInstallOnSpawn: false`; `transcendentSpeedCore` is blueprint-restricted to `smallBallDroid`) → the core's 12 volume is fully available for items.
- **R7 — World population change**: adding the drone changes boot-time state (one more NPC in `start_room`). Count-sensitive tests must be updated (§7.3); persistence snapshots grow by one entity — the existing snapshot path handles arbitrary entity counts, but the Code subtask must verify a restore round-trip in the contract test.
- **R8 — Capacity arithmetic**: `craftItems` pre-check uses output `volume` (t1 = 10) vs. `free + released` on the host component (core 12, knife host-footprint 1 → `11 + 1 = 12 ≥ 10` ✓). Post-craft the core holds the T1 (host 1) and can pick up further knives (host 1 each) without ever locking — the drone cannot get stuck capacity-wise. (If a future item change alters `t1.volume`, re-verify this inequality.)
- **R9 — Pick-up threshold (single source of truth)**: the pickup range has exactly one definition — the `pickUpItem` action in `data/actions.json`. Both the `PickUpItemHandler` (validation) and the brain's `craft_loop` (in-range decision) resolve it through the shared `RangeResolver` with the shared fallback in `src/utils/Constants.js`, so they cannot drift — the previous hardcoded brain-side constant was exactly that drift (the root cause of the drone stalling at the boundary the handler rejected). If a future data change ever desynchronizes the two anyway (or the handler rejects an in-range attempt for another reason), `craft_loop` degrades gracefully: it falls back to the approach phase (logged at WARN) instead of re-deriving the same pickup decision every round, so the drone keeps converging and still completes its goal.
- **R10 — Concurrency with other agents**: a player (or LLM NPC) could steal the target knife between rounds, or the drone's `executePickUpItem` could fail at call time. The behavior is stateless and re-derives from the facade every round — a rejected pickup falls back to the approach phase instead of being re-derived forever — so it self-corrects; handler failures are structured results (logged, non-throwing) and never break the turn loop (root guard in `think()`).
- **R11 — Held-knife edge cases**: a dropped knife with nested children cannot be picked up (handler rejects it), so a drone-held knife is always clean and craftable. If some external action later nests an item inside a held knife, `craftItems` fails with `ITEM_HAS_NESTED_ITEMS` and the drone idles with retries until the world state changes — a documented, acceptable degenerate state (no corruption, no crash).
