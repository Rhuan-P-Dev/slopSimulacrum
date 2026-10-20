# Perception System

## 1. Overview

The perception system answers one question on the server: **"what changed in room R since this reader last looked?"** — and, since the action-observability extension, **"what did the entities in room R *do* since this reader last looked, which components powered each action, and *who* (which entity / which component) was acted upon?"**

It is the single observation surface for the world:

- **NPC brains** poll "what changed since my last observation?" before deciding what to do (see [LLM Turn & NPC Spec](../../llm_turns_npc_spec.md) — perception is the *input* to that turn; the agent cursor is the "last looked" marker).
- **The UI's InText panel** polls per room (see [Client Architecture](../frontend/client_architecture.md)) and renders the entries as text — including the performed-action rows with the components actually used.

Everything downstream (NPC context building, the panel, any future observer) reads the same entries, so one implementation serves every reader.

```
mutation (spawn / move / despawn / drop / stat / …)
      │  marks room(s) dirty (O(1), no snapshot)
      ▼
per tick / on read ──► snapshot dirty room ──► diff vs last snapshot ──► entry ──► ring buffer
                                                                              │
                                     ┌────────────────────────────────────────┤
                                     ▼                                        ▼
                            NPC brains (agent cursor)               InText panel (per room)
```

**Implementation files:**

| File | Role |
|---|---|
| `src/controllers/core/PerceptionController.js` | dirty set, per-room last snapshots, per-agent cursors, per-entity action seen-cursors, ring buffers, flush |
| `src/utils/DeltaDiff.js` | pure snapshot→snapshot diff (room level, no controller state) |
| `src/utils/DeltaSummary.js` | ≤300-char one-line human summary per entry |
| `src/utils/ActionAttributionStore.js` | shared per-entity "which components powered action X — and what it was applied to" store (single writer: the consequence dispatcher) |
| `shared/CoordFormat.js` | the coordinate display rule — truncate to 2 decimals, render "00.00" (shared by the server entry builder and the client formatter) |
| `src/controllers/consequences/ConsequenceDispatcher.js` | the **only** place action attribution is written (the choke point) |
| `src/routes/perceptionRoutes.js` | the HTTP endpoints |
| `public/js/InTextPanel.js` | the UI consumer (per-room feed + performed-action rows) |
| `src/controllers/WorldStateController.js` | facade seams: `markPerceptionDirty`, `getPerceptionDeltasForRoom`, `getAgentPerception`, `recordAgentObservation`, `getActionAttributionStore` |

## 2. Why it is delta-based (not a full-state broadcast)

The world-state broadcast already ships full entity/item state to clients. Re-sending an entire room every tick would cost O(room size) per reader per tick for information that is 99% unchanged. A diff costs only what changed: a quiet room produces **no entry at all** (the room isn't even flushed), and a flush with no visible changes is dropped.

The price — and the invariant that keeps it correct — is that **every observable mutation must mark its room(s) dirty.** If a mutation forgets to mark, that change is invisible to perception. The marks are deliberately placed at the *mutating seams* (the consequence handlers, the spatial handler, the facade's spawn/move/despawn), never at read time: reads must never be able to change what the next reader sees.

## 3. Why mutations mark dirty instead of polling

Per tick (and on demand at read time) the controller flushes only the rooms in the dirty set:

1. snapshot the room's current state (room-level: entities, their components, dropped items, equipment, internal items — **excluding** the perception controller's own internal state, so a flush can never make itself dirty);
2. diff it against the room's last-seen snapshot;
3. if there is a visible change, build an entry, enrich component names, **credit the actions the room's entities performed since their last surfacing** (see §7), write it to the room's ring buffer, and advance that room's last-seen snapshot;
4. clear the dirty mark.

Dirty marking is O(1) at the mutation site; the expensive snapshot+diff work happens once per change per room, never per reader.

## 4. Why the first observation is a "baseline", not a diff

A reader's very first look at a room has no "last seen" to diff against. The controller emits a `kind: 'baseline'` entry describing the *whole* current room (everything is "appeared"), then immediately stores that snapshot as the room's new last-seen reference. Every subsequent entry for that room is a `kind: 'delta'`.

Baselines are initial observations, **not** action windows — which is why the `actions.performed` category is always empty on them (see §7).

## 5. Why per-agent cursors are reader-relative

"Since your last observation" is a **reader-relative** window, not a wall-clock one. Two readers (an NPC brain and the UI) that start looking at the same world at different times need different "since" points. The cursor advances when the *reader* confirms it looked (`getAgentPerception` on read, or the explicit `recordAgentObservation`), never when the world changed — so a reader that sleeps between ticks still sees everything that changed while it was asleep.

Each agent keeps a cursor per room plus a global "world sequence" cursor (a monotonically increasing per-flush sequence, tick-independent so it also orders changes made in non-loop contexts). The agent view returns, across all rooms, only entries newer than the cursor.

## 6. Why moved rows claim only the components that were used

A "moved" row must not guess *how* the entity moved. The authoritative answer comes from the **ActionAttributionStore**: every successful action passes through the consequence dispatcher's single `execute`/`executeMultiAttacker` choke point, which records — for that entity and action — the primary component, the **used set** as `ids`, the **target** (the entity and/or component the action was applied to — *who* was acted upon), the per-requirement fulfillment, and the tick.

**"Used" has exactly two meanings, resolved in order at the recording choke point:**

1. **The caller's explicit designations** — the components the action call named as its source (SOURCE-role `componentIds` / `componentId` / `attackerComponentId`). If the caller named N, N were used — perception shows exactly N, verbatim. Naming two of a droid's four legs for a move shows two; naming all four shows four (the quadruped gait).
2. **The engine's selection** — when the caller named nothing, the resolver selects one *best* component per requirement (whose stats the action's consequences consume); those are the used set. An un-named move on a four-leg droid uses exactly the one best leg.

**What is never "used": the eligible set.** Components that merely *satisfied* a requirement threshold without being named or selected (the other legs that also meet `Movement.move ≥ 5`) are not part of `ids` — they remain discoverable as metadata in the record's per-requirement `fulfillment` breakdown (eligible, in most-capable order). The union `allFulfillingIds` is metadata too. This is the invariant that keeps the surface honest: perception can never over-claim ("all four legs" when one powered the move) or under-claim ("one leg" when the caller named two).

The diff then resolves the moved entity's `lastMoveAction` through that store and lists **only the recorded (used) ids** (falling back to a `Movement.move` heuristic — every movement-granting component, flagged as a guess, when the store has no record, e.g. pre-store history).

The store is keyed `(entityId, actionName)` with overwrite semantics: at most the most recent execution of each distinct action per entity — small, bounded, and exactly what a perception flush needs.

## 7. Why performed-action rows exist ("the action, and only the components used")

An observer wants to know what the entities **did**, not only the side effects their actions produced. An action can complete with zero observable state change (a punch that misses, a move to an adjacent cell the diff can't see as a reposition) — yet it *happened*, and it consumed components.

So every flush credits, per room entity, the distinct actions performed since that entity's **last surfacing**:

- **One writer, one reader per role.** The dispatcher writes the record at the choke point (always — the store is written regardless of consequences); the perception controller is the consumer that turns those records into observation rows. No other code path records actions, so the rows can never be fabricated by a reader.
- **A per-entity seen-cursor, keyed by the record's write timestamp** (not the tick — ticks are coarse and can be static in non-loop contexts). Each record is surfaced **at most once**: when a room flushes, the entities in it have their cursors advanced past the records already shown, so a later flush with no new actions produces no performed rows. The cursor also means an action surfaces in the room the entity stands in *at flush time* (the perception model is same-room observation).
- **"Only the ones used", never more and never fewer.** Each row lists exactly the components that powered the action, with the real count: the caller's explicitly named source components when any were named (2 named → 2 shown, 4 named → 4 shown), otherwise the resolver's selected fulfillers (one per requirement). Eligible-but-unnamed components (the other legs that also met the threshold) are never listed. Each entry is resolved against the current snapshot for its type. A recorded id that no longer resolves (a part destroyed since the action) is still listed with `type: null`. When the used set is empty — nothing named, nothing selected — the row still appears, with an **empty used list**: the action is reported, and *no* components are claimed. The surface can never over- or under-claim "which components were used".

```jsonc
// actions.performed row shape (one per distinct action per entity per flush window)
{
  "entity": "ent-9c1f…",        // stable entity id
  "name": "Rover",              // display name (falls back to the id)
  "action": "punch",            // the action name
  "used": [                     // ONLY the components recorded as used (may be empty)
    { "type": "arm", "id": "comp-77aa…" },
    { "type": "centralBall", "id": "comp-31b0…" }
  ],
  "target": {                   // WHO was acted upon (null for spatial/no-target actions)
    "id": "ent-dc94…",           // target entity id (null when only a component was named)
    "name": "Tree",              // display name resolved from the CURRENT world (null if the target no longer exists / is unnamed)
    "componentId": "comp-a92a…", // the specific component hit (null for entity-level actions)
    "componentName": "Tree"      // its recipe display name, resolved the same way
  },
  "tick": 42,                   // tick of the recorded execution (may be null)
  "source": "store"             // provenance: the shared attribution store
}
```

The `target` ids are recorded at the choke point from the call's `params` (`targetEntityId`, and `targetComponentId` — with the owning entity resolved through the component controller when the call named the component only). Display names are **never stored** — the perception controller resolves them against the current snapshot at render time, so a destroyed target degrades to ids only (never a stale name) and a still-existing one always shows its current name. The component name comes from the same recipe-name source the dispatcher's log phrases use (`ComponentNaming`).

The entry's `counts.actions` tracks these rows (deliberately **not** folded into `counts.total`), `hasDeltaChanges()` treats a non-empty list as a change (an action-only flush must surface even when `counts.total === 0`), the one-line summary names the actions performed (representative examples, `+N more`), and the InText panel renders one bullet per row — `⚔ <name> · action: <action> · used (N): <type (id), …> → <target name> (<target id>) · hit: <component name> (<component id>)` (the `→`/`hit` clauses only when a target was recorded) — deduplicating a `move` row against the moved bullet that already showed it.

## 8. Entry schema

Every entry (baseline or delta) has a stable shape — consumers may rely on the keys existing:

```jsonc
{
  "tick": 42,                  // world tick at flush
  "sinceTick": 40,             // tick of the previous observation
  "ts": 1750000000000,         // wall-clock ms at flush
  "roomId": "start_room",
  "kind": "delta",             // or "baseline" (first observation of a room)
  "counts": {                  // cheap "how much changed" without reading the rows
    "total": 5,                // NOT including performed actions (§7)
    "entities": 3, "items": 1, "components": 0,
    "internal": 0, "equipped": 1, "dropped": 0,
    "actions": 1               // performed-action rows (set by the controller)
  },
  "summary": "1 action performed (punch by Rover) in start_room",  // ≤300 chars
  "actions": { "performed": [ /* §7 rows */ ] },
  "entities": {
    "appeared":  [{ "id": "ent-…", "name": "Rover" }],
    "despawned": [{ "id": "ent-…" }],
    "moved": [{                                  // with from→to and attribution
      "id": "ent-…", "name": "Rover",
      "fromRoom": "start_room", "toRoom": "right_room",
      "fromXY": { "x": 0, "y": 0 }, "toXY": { "x": 25.5, "y": 12.25 },  // truncated to 2 decimals (§8.1)
      "action": "move",                          // lastMoveAction, or null (not action-driven)
      "locomotion": [{ "type": "centralBall", "id": "comp-…" }], // ONLY the used components
      "attributionSource": "store"               // "store" | "heuristic"
    }],
    "statChanges": [{ "id": "ent-…", "traitId": "…", "statName": "energy", "from": 0.5, "to": 0.2 }]
  },
  "items":      { "added": [], "removed": [] },          // world-level items in the room
  "dropped":    { "added": [], "removed": [], "moved": [] }, // floor items (with dropper actor)
  "components": { "added": [], "removed": [], "changed": [] }, // per-entity component diffs
  "equipped":   { "added": [], "removed": [] },
  "internal":   { "added": [], "removed": [] }           // item-inside-component
}
```

## 8.1 Why coordinates are truncated to two decimals ("00.00")

The world keeps coordinates at full float precision internally, but a *perceived* coordinate is a display value, and a full-precision tail (`18.81000041279735`) is noise for every reader — the UI bullet and the NPC brain alike. So every coordinate the perception surface shows is **truncated to two decimal places (toward zero) and rendered with exactly two decimal digits**: `18.81000041279735 → 18.81`, `-6.795872605527817 → -6.79`, `300 → "300.00"`, `0 → "0.00"`. (Truncation, not rounding: the value is *cut* at the second decimal — `0.999 → 0.99`, never `1.00`.)

The rule lives in one shared module (`shared/CoordFormat.js`: `truncateCoord` / `formatCoord` / `formatPosition`) and is applied at **two layers, both idempotent**:

1. **Server, on the entry** — `PerceptionController._truncateEntryCoordinates` runs on every built entry (baseline or delta) before it reaches the ring buffer: it walks the row lists (`entities.moved` fromXY/toXY, `dropped`/`items` x/y, `actor` positions) and truncates each coordinate in place. This is why the agent/NPC JSON view (`GET /perception/agent/:id`) never carries a full-precision float.
2. **Client, on the render** — `InTextPanel.formatPosition` (the single coordinate choke point of the panel: room line, entity rows, moved bullets, floor items, actor `@` positions, door edge points) formats through the same module, so whatever value arrives is always shown as `00.00`.

It is a **display rule by construction, never a world rule**: the room snapshots the diff runs on keep full precision, the world state broadcast is untouched, and truncating an already-truncated value is a no-op — so the two layers can coexist without double-shifting. A float-noise guard keeps `0.29` (stored as `0.28999999999999998`) truncating to `0.29`, and `-0.00` is normalized to `0.00`. The one exception that stays out of scope: the event-log context line ("you: (2, -1)") is a separate, older surface and keeps its integer `Math.round`.

**The display resolution is also the perceptual threshold** — the rule that kills the phantom move: a *"moved" row is only reported when the truncated coordinates differ* (entities and dropped items alike). Since a row prints its coordinates through the very same truncation, a moved row can never claim a move its own endpoints display as identical ("(35.85, -17.73) → (35.85, -17.73)") — a move no observer could see. The world side matches it (`SpatialConsequenceHandler`): a target within one display step (0.01 = `MIN_MOVEMENT_DISTANCE`) of the current position is a genuine no-op, a target within `speed` is **snapped exactly** to the target (the algebraic `x + (target - x)` never converges in floating point — the sum lands on a neighbouring double and successive corrections oscillate around the target by 1 ulp forever, which is exactly the "standing still but moved every round" loop), and both the perception-dirty mark and the move attribution fire only when the *stored* position actually changed. The feedback loop is broken at both ends: the panel stops printing phantom moves, and the NPC/LLM brain that was re-dashing at its own position every round (because its own perception told it it was moving) now sees "action performed, position unchanged" and converges.

## 9. API surface

| Endpoint | Scope | Notes |
|---|---|---|
| `GET /api/perception/room/:roomId?limit=N` | one room, since the room's last flush | the InText panel's source; `limit` caps the ring buffer (default 10) |
| `GET /api/perception/agent/:entityId?limit=N` | whole world, since the agent's last observation | advances the agent cursor (read = observation) |
| `POST /api/perception/agent/:entityId/observe` | — | explicit cursor advance without a read (an NPC that "looked" without asking for the diff) |

All three are read-only with respect to world state (the only writes are the controller's own cursor/buffer bookkeeping). The facade additionally exposes `getActionAttributionStore()` for direct store queries (`get(entityId, actionName?)`, `getIds`, `getCount`, `listFor`) — the same store the performed-action rows are built from.

**Reset semantics:** `PerceptionController.reset()` (called on world reset/restore) clears buffers, snapshots, cursors, dirty set, the per-entity action seen-cursors, **and the shared attribution store** — a restored world carries no action history from the voided one.

## 10. Related Documentation

- [LLM Turn & NPC Spec](../../llm_turns_npc_spec.md) — the agent cursor is the "since your last observation" input to NPC decision turns
- [Action System](../architecture/action_system.md) — the pipeline whose choke point writes the attribution store
- [Synergy System](synergy.md) — synergy results flow into the attribution payload
- [Client Architecture](../frontend/client_architecture.md) — the InText panel as the UI consumer
- [Unique ID System](unique_id_system.md) — the typed entity/component ids used throughout the rows
