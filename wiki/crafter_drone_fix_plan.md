# Crafter Drone — Fix Plan (Code Problem Thinker output)

**Input:** Code Quality Checker report for the Crafter Drone feature (H1, M1–M5, L1–L8).
**Status:** Analysis complete — every recommendation below is grounded in the actual current code (line numbers verified; corrections to the checker's line references are marked inline).
**Contract:** The Code subtask implements this plan verbatim. The scope guard at the end is binding.

**Post-plan update — pickup-range contract (root-cause C, supersedes the range-related content below):** the follow-up this plan left open (L5/M2: "pin `PickUpItemHandler.maxRange` against `data/actions.json` mechanically") has since been resolved, and the body's range-related statements are superseded. `PICK_RANGE = 100` no longer exists in `src/utils/npcAiUtils.js`: the brain now resolves the pickup range each round from the `pickUpItem` action in `data/actions.json` through the shared `RangeResolver` (shared `PICK_UP_RANGE_FALLBACK`) — the exact same path the `PickUpItemHandler` uses — so the brain's in-range decision and the handler's validation cannot drift (the L5 cross-assertion now lives in `test/unit/npcAiUtils.test.js` as coverage of `resolvePickUpRange` against the data file). And when an in-range pickup is rejected by the handler, `craft_loop` falls back to the approach phase (logged at WARN) instead of re-deriving the same pickup decision every round, so the drone still completes its goal under a desync. This note is the authoritative current contract; the plan body below is the historical record of the earlier batch.

**Post-plan update — v2 turn-machine rebase of the contract test (root-cause B, supersedes the turn-driving content below):** the turn machine has since moved to the event-driven v2 (see `wiki/llm_turns_npc_spec.md` §5.1): the roster NPCs' agent callbacks fire at round start, the planning window closes when every roster planner signals (no deadline), close and resolution complete inside the same tick call, and the next round starts on the next tick. The three round-geometry constants the v1 driver relied on (`TURN_ROUND_TICKS`, `TURN_NPC_AGENT_TICK`, `TURN_PLANNING_TICKS`) were removed from `src/utils/Constants.js` by that v2 refactor (`d15fcb6`/`9460fc2`) — but the contract test kept importing them, the imports became `undefined`, and the driver's NaN round base poisoned the tick clock (`tick.currentTick = NaN`). WHY the fix took two parts: (1) `test/contract/crafterDrone.contract.test.js` was rebased to drive **one `onTick()` per round** plus a small settle window — the queue is inspected synchronously between the agent firing and the settled close/resolution (the v2 analogue of the old "between agent tick and resolution"), and the measured convergence at the data-driven pickup range 50 (10 px/round) is 7 approach moves → pickup at exactly 50 → craft + drop, i.e. the T1 appears after 9 rounds; (2) `TurnSystemController._currentTick()` now **rejects non-finite clock values** (warn with the raw value, existing fallback) so a corrupt clock can never masquerade as a tick again. The M5 text below records the v1 era as history; only its rogue-fact content (registry spawn at room center, 20-unit per-move step) remains current.

Verified sources (current state, all line numbers checked before writing this plan):
[`src/controllers/ai/NpcAIController.js`](../../src/controllers/ai/NpcAIController.js) (691 lines),
[`src/utils/npcAiUtils.js`](../../src/utils/npcAiUtils.js) (95 lines),
[`src/controllers/WorldStateController.js`](../../src/controllers/WorldStateController.js) (facade methods listed in M4),
[`src/controllers/consequences/PickUpItemHandler.js`](../../src/controllers/consequences/PickUpItemHandler.js),
[`src/controllers/core/TurnSystemController.js`](../../src/controllers/core/TurnSystemController.js),
[`test/unit/npcAiUtils.test.js`](../../test/unit/npcAiUtils.test.js) (159 lines),
[`test/unit/NpcAIController.craftLoop.test.js`](../../test/unit/NpcAIController.craftLoop.test.js) (627 lines),
[`test/contract/crafterDrone.contract.test.js`](../../test/contract/crafterDrone.contract.test.js) (238 lines),
[`wiki/crafter_drone_spec.md`](crafter_drone_spec.md), [`wiki/project_rules.md`](project_rules.md),
[`wiki/subMDs/controllers/npc_ai_controller.md`](subMDs/controllers/npc_ai_controller.md),
[`wiki/subMDs/controllers/controller_patterns.md`](subMDs/controllers/controller_patterns.md), [`wiki/map.md`](map.md),
[`data/npcs.json`](../../data/npcs.json), [`data/crafting.json`](../../data/crafting.json), [`data/blueprints.json`](../../data/blueprints.json), [`data/components.json`](../../data/components.json), [`data/actions.json`](../../data/actions.json).

---

## H1 — `_craftLoopBehavior` exceeds the 20–30-line refactoring trigger (MUST)

**Root cause.** The behavior was implemented as one monolithic method containing three self-named stages (A: craft, B: forage-scan, C: nearest/pick/move) — the spec §4.3 pseudocode is three labeled stages, and the implementation collapsed them into a single ~94-line method body (lines 465–558, ~63 lines of code). Violates [code_quality_and_best_practices.md](code_quality_and_best_practices.md) §5.2 (refactor when a function exceeds 20–30 lines) and §1.1 SRP (one method carrying three decision stages).

**Line correction.** The checker said "lines ~465–558, ~60 code lines" — exact current bounds: method body 465–558, JSDoc 434–464.

**Specific fix.** Extract the three stages into private methods; `_craftLoopBehavior` becomes a thin dispatcher. **This is a verbatim move first** (no semantic change) — M1 and M2 then apply inside the extracted methods (see Application Order).

New `_craftLoopBehavior` (replaces 434–558; the existing JSDoc 434–464 is kept, with the stage descriptions retained as the structural overview):

```js
_craftLoopBehavior({ entity, round, facade }) {
    // Guards: known room + finite spatial (mirrors chase_attack).
    if (!entity || !entity.location || !entity.spatial) {
        return null;
    }
    if (!Number.isFinite(entity.spatial.x) || !Number.isFinite(entity.spatial.y)) {
        Logger.warn(`[NpcAI] ${entity.name || entity.id} has non-finite spatial — skipping.`);
        return null;
    }

    const targetItemType = this._resolveCraftInputType(facade);

    // Stage A is TERMINAL: if the drone holds a foraged item, this round is
    // spent crafting it (or idling on craft failure) — it never falls
    // through to the forage scan. (Preserved from the original single method:
    // a craft-failure round must not also pick up another knife.)
    const heldItems = this._flattenEntityItems(facade.getEntityItems?.(entity.id));
    const heldTarget = heldItems.find(item => item && item.type === targetItemType);
    if (heldTarget && heldTarget.hostComponentId) {
        return this._craftLoopCraftStage({ entity, round, facade, targetItemType, heldItems, heldTarget });
    }

    // Stages B + C — no item held: forage in the drone's own room.
    return this._craftLoopForageStage({ entity, round, facade, targetItemType });
}
```

`_craftLoopCraftStage` — verbatim move of current lines 482–516, with the `heldItems`/`heldTarget` inputs passed in (the single `getEntityItems` call stays in the dispatcher; the second call after the craft, current line 492, stays inside the stage):

```js
/**
 * Stage A — the drone holds a foraged item: craft it (zero-cost, immediate)
 * and, on success, return the single turn action that drops the freshly
 * produced output item at the drone's own position. Returns null (idle) when
 * the craft fails or the new output cannot be detected — the drone
 * re-derives next round.
 *
 * @param {Object} ctx
 * @param {Object} ctx.entity
 * @param {number} ctx.round
 * @param {Object} ctx.facade — world state facade (public API only)
 * @param {string} ctx.targetItemType — resolved recipe input type
 * @param {Object[]} ctx.heldItems — flattened items held before the craft
 * @param {Object} ctx.heldTarget — the held target item (has a hostComponentId)
 * @returns {{ actionName: string, params: Object }|null}
 * @private
 */
_craftLoopCraftStage({ entity, round, facade, targetItemType, heldItems, heldTarget }) {
    const outputIdsBefore = new Set(
        heldItems
            .filter(item => item && item.type === CRAFT_OUTPUT_TYPE)
            .map(item => item.id)
    );

    const craftResult = facade.craftItems
        ? facade.craftItems(entity.id, RECIPE_ID, heldTarget.hostComponentId, [heldTarget.id])
        : null;

    if (craftResult && craftResult.success) {
        const outputIdsAfter = this._flattenEntityItems(facade.getEntityItems?.(entity.id))
            .filter(item => item && item.type === CRAFT_OUTPUT_TYPE)
            .map(item => item.id);
        // The new item is the set-difference (the recipe consumes exactly
        // the held input); fall back to any present output id defensively.
        const newItemId = outputIdsAfter.find(id => !outputIdsBefore.has(id)) ?? outputIdsAfter[0];
        if (newItemId) {
            Logger.debug(`[NpcAI] Round ${round}: ${entity.name || entity.id} crafted ${RECIPE_ID} — dropping ${CRAFT_OUTPUT_TYPE} ${newItemId}.`);
            return {
                actionName: CRAFT_DROP_ACTION,
                params: {
                    itemId: newItemId,
                    itemType: CRAFT_OUTPUT_TYPE,
                    targetX: entity.spatial.x,
                    targetY: entity.spatial.y
                }
            };
        }
        Logger.debug(`[NpcAI] Round ${round}: ${entity.name || entity.id} crafted ${RECIPE_ID} but the new ${CRAFT_OUTPUT_TYPE} could not be detected — idle this round.`);
        return null;
    }

    // Structured failure (e.g. nested-item guard) → idle; retry next round.
    Logger.debug(`[NpcAI] Round ${round}: ${entity.name || entity.id} craft ${RECIPE_ID} failed (${craftResult?.code || 'unknown'}) — idle this round.`);
    return null;
}
```

`_craftLoopForageStage` — verbatim move of current lines 519–557 **as a first step** (M1 then shrinks it; the M1-final shape is given in the M1 section). `_craftLoopAttemptPickup` — verbatim move of current lines 542–549 (M2 then adds the result check):

```js
/**
 * Immediate zero-cost pickup of an in-range dropped item on the drone's core
 * component (kept out of the 6-volume arms so the forged container fits,
 * spec §1). The handler re-validates at call time; on rejection the drone
 * re-derives next round (stateless) — but the rejection must be visible in
 * the log (code_quality_and_best_practices.md §3.1). See M2.
 *
 * @param {Object} entity
 * @param {number} round
 * @param {Object} facade — world state facade (public API only)
 * @param {Object} item — the dropped item entry (in range, in the drone's room)
 * @param {number} distance — pre-computed distance to the item
 * @param {string} targetItemType
 * @private
 */
_craftLoopAttemptPickup(entity, round, facade, item, distance, targetItemType) {
    const core = (Array.isArray(entity.components) ? entity.components : [])
        .find(comp => comp && comp.type === CRAFT_CORE_COMPONENT_TYPE);
    if (!core) {
        Logger.warn(`[NpcAI] Round ${round}: ${entity.name || entity.id} has no ${CRAFT_CORE_COMPONENT_TYPE} component — cannot pick up ${item.id}.`);
        return;
    }

    // M2 applied here: check the structured result, log the rejection.
    facade.executePickUpItem?.(entity.id, item.id, core.id);
    Logger.debug(`[NpcAI] Round ${round}: ${entity.name || entity.id} picked up dropped ${targetItemType} ${item.id} (dist: ${distance.toFixed(1)} ≤ ${PICK_RANGE}).`);
}
```

**Resulting sizes.** `_craftLoopBehavior` ≈ 18 code lines; `_craftLoopCraftStage` ≈ 26; `_craftLoopForageStage` ≈ 22 after M1 (≈ 30 before M1 — still under trigger once M1 removes the duplicated guards and the distance re-computation); `_craftLoopAttemptPickup` ≈ 12–16.

**Risk & side effects.** The only semantic hazard is breaking Stage-A terminality (a craft-failure round must NOT fall through to the forage scan — the dispatcher's `heldTarget && heldTarget.hostComponentId` gate preserves this exactly, including the odd-but-current case of a held item *without* a hostComponentId falling through to forage). Guard it: in the same commit, add `expect(calls.executePickUpItem).toHaveLength(0);` to unit test 6 (`test/unit/NpcAIController.craftLoop.test.js:350`) — test 6's world has `dropped: []` so today nothing pins the terminality mechanically. All other existing tests (5, 7, 8, 9, 10, contract 1–4) must pass unchanged — they assert on decisions/calls, not on method internals. `_chaseAttackBehavior` untouched.

**Prevention (future).** Document in [`npc_ai_controller.md`](subMDs/controllers/npc_ai_controller.md) Design Principles that new behaviors are registered as *stage-method groups from day one* (one method per spec stage), so the §5.2 trigger is never reached; the M3 commit adds this one line.

---

## M1 — Duplicated spatial guards + dead `maxRange` param + wrong JSDoc (MUST)

**Root cause.** Two implementations of one spatial query grew separately: the helper [`findNearestDroppedItem`](../../src/utils/npcAiUtils.js:72) (room + finite-coordinate guards at lines 80–81, optional `maxRange` at line 84) and Stage B of the controller (re-implementing room + finite guards at [`NpcAIController.js:521-527`](../../src/controllers/ai/NpcAIController.js:521)). The `maxRange` parameter was added anticipating a caller that never came: the only production caller (line 533) omits it (default `Infinity`) and re-applies `<= PICK_RANGE` itself (lines 538–539). The JSDoc (lines 68–69: "callers pass PICK_RANGE for the pickup decision") documents a contract the production path never honors. Violates DRI (code_quality §1.1) and JSDoc-reality accuracy (§4.2).

**Design fork — DECISION: range rule stays in the controller; the helper becomes a pure "nearest + distance in room" query returning `{ item, distance } | null`, and `maxRange` is deleted.** Justification, from the actual code:
1. **Precedent:** `chase_attack` (lines 392–431) does its own nearest scan and owns its range decision in the behavior (`minDistance <= attackRange` at line 416). Keeping the range rule in the behavior is the file's established pattern.
2. **Behavior requirement:** Stage C must distinguish *in-range → pick* from *out-of-range → move toward it*. If the helper hard-limited by `PICK_RANGE` (the checker's first option), the out-of-range item would come back as `null` and the move decision would need a second, unbounded helper call — more code, split "nearest" logic.
3. **DRI:** one owner of the spatial guards (helper), one owner of the range policy (behavior), and no re-computation of the winner's distance (the helper reports it).
4. **Spec convergence:** the spec's own recommendation (§6 change list, row 5, [`crafter_drone_spec.md:266`](crafter_drone_spec.md:266)) was `findNearestDroppedItem(candidates, x, y)` returning `{ item, distance }` — the implemented signature drifted *away* from the spec. This decision moves the implementation back onto the spec's return shape; only the `roomId` parameter (a deliberate implementation addition — the spec's pseudocode filtered room in the controller) and the removed `maxRange` differ. L8 updates the spec text to the final contract.

**Specific fix.**

1. `src/utils/npcAiUtils.js` — replace the JSDoc (53–71) and body (72–94); signature loses `maxRange`, return becomes `{ item, distance } | null`:

```js
/**
 * Finds the nearest dropped item in a given room (Euclidean distance,
 * ascending-id tie-break — fully deterministic) and reports its distance.
 *
 * Single owner of the spatial guards: entries without a matching `roomId`,
 * or with non-finite coordinates, are skipped. The pickup-range rule
 * (PICK_RANGE) is deliberately NOT part of this helper — it is owned by the
 * calling behavior (craft_loop), mirroring how chase_attack applies its own
 * attack range after selecting its nearest target.
 *
 * Returns `{ item, distance }` for the nearest qualifying entry, or null
 * when no candidate exists (empty input, no items in the room, or no
 * finite-coordinate items in the room).
 *
 * Pure — does not mutate its inputs.
 *
 * @param {Object[]|null|undefined} droppedItems — dropped item entries
 *   (`{ id, x, y, roomId, itemType, ... }`)
 * @param {string} roomId — the room uid to restrict the search to
 * @param {number} x — the searching entity's x coordinate
 * @param {number} y — the searching entity's y coordinate
 * @returns {{ item: Object, distance: number }|null} the nearest qualifying
 *   entry with its Euclidean distance, or null
 */
export function findNearestDroppedItem(droppedItems, roomId, x, y) {
    if (!Array.isArray(droppedItems) || !Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
    }

    let best = null;
    let bestDistance = Infinity;
    for (const item of droppedItems) {
        if (!item || item.roomId !== roomId) continue;
        if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) continue;

        const d = Math.hypot(x - item.x, y - item.y);
        if (best === null
            || d < bestDistance
            || (d === bestDistance && String(item.id) < String(best.id))) {
            best = item;
            bestDistance = d;
        }
    }
    return best ? { item: best, distance: bestDistance } : null;
}
```

2. `src/controllers/ai/NpcAIController.js` — inside the (already extracted, H1) `_craftLoopForageStage`, the final shape:

```js
_craftLoopForageStage({ entity, round, facade, targetItemType }) {
    // Stage B — target items dropped anywhere; the helper owns the
    // room/finite-coordinate guards, so this filter keeps only the craft
    // policy (item type).
    const droppedItems = facade.getDroppedItems ? Object.values(facade.getDroppedItems() || {}) : [];
    const candidates = droppedItems.filter(item => item && item.itemType === targetItemType);
    if (candidates.length === 0) {
        return null; // idle — no target items in the world at all
    }

    // Stage C — nearest in-room item (Euclidean, id tie-break); the helper
    // reports the distance so the range rule is applied exactly once, here
    // (mirrors chase_attack's in-behavior range decision).
    const nearest = findNearestDroppedItem(candidates, entity.location, entity.spatial.x, entity.spatial.y);
    if (!nearest) {
        // Reachable now: target items exist, but none in this room with
        // finite coordinates — idle.
        return null;
    }

    const { item: targetItem, distance } = nearest;
    if (distance <= PICK_RANGE) {
        this._craftLoopAttemptPickup(entity, round, facade, targetItem, distance, targetItemType);
        return null; // the pickup is free — nothing to queue this round
    }

    // Out of range → move toward the item (repeats each round; no pathfinding).
    return {
        actionName: CRAFT_MOVE_ACTION,
        params: { targetX: targetItem.x, targetY: targetItem.y }
    };
}
```

Behavior-equivalence proof (why the drone's decisions are unchanged): the old pipeline filtered by `type ∧ roomId ∧ finite` then took the nearest with `maxRange = ∞` — the new pipeline filters by `type` only, then the helper filters `roomId ∧ finite` and takes the nearest. Same candidate set, same winner, same distance (the removed line 538 re-computation is replaced by the helper's identical `Math.hypot`). The old "defensive — unreachable" comment (line 535) becomes genuinely reachable (candidates exist but all foreign/non-finite) and is re-worded accordingly.

3. `test/unit/npcAiUtils.test.js` — update the `findNearestDroppedItem` describe (80–159):
   - line 84 test: drop the 5th argument; assert `result.item.id === 'near'` and `expect(result.distance).toBeCloseTo(50, 5)` (pins the new return shape).
   - line 94 test ("returns null when all in-room items are beyond maxRange"): **delete** — the range contract no longer exists in the helper (the behavior-level boundary coverage lives in craftLoop tests 4a/4b and 10).
   - line 99 test: rename to "returns the nearer of two items (distance 100 vs 101) and reports the distance"; drop `PICK_RANGE`; assert `result.item.id === 'at100'` and `result.distance` close to 100.
   - lines 109, 119, 129, 140, 147, 153: drop the 5th argument; `result.id` → `result.item.id`; line 153 renamed "returns the nearest item even far away (no range limit in the helper)".

**Risk & side effects.** Churn is contained to `npcAiUtils.test.js` (−1 test, ~7 tests edited) — the only direct caller of the helper is `_craftLoopForageStage` (verified by search: no other `findNearestDroppedItem` references in `src/` or `test/`). The craftLoop unit tests and the contract tests never call the helper directly — the helper is internal to the behavior, and the behavior is behavior-identical, so they pass unchanged. Deleting `maxRange` breaks nothing (no caller passes it). The `PICK_RANGE` constant itself is untouched (still the behavior's range rule).

**Prevention (future).** Add to [`npc_ai_controller.md`](subMDs/controllers/npc_ai_controller.md) Design Principles (in the M3 commit): "Pure spatial helpers own coordinate guards and distance; range/pickup policy stays in the behavior — helpers never silently grow caller-specific parameters" (the `maxRange` anti-pattern). Also: any helper JSDoc parameter must be exercised by at least one production caller or a test, else it is dead and gets deleted.

---

## M2 — `executePickUpItem` result ignored; false "picked up" log on rejection (MUST)

**Root cause.** Stage C assumed the handler's success and logged unconditionally at DEBUG ([`NpcAIController.js:545-546`](../../src/controllers/ai/NpcAIController.js:545)). On handler rejection (stale target, out-of-range, capacity, nested children) the log falsely claims success and no WARNING is recorded — invisible graceful degradation. Violates [code_quality_and_best_practices.md](code_quality_and_best_practices.md) §3.1 (failures must be visible in the logging system) and §2.2 (never trust an external result unvalidated).

**Line/shape correction to the checker.** The checker said to log the failure `code`. The real [`WorldStateController.executePickUpItem`](../../src/controllers/WorldStateController.js:2151) (JSDoc line 2149) and [`PickUpItemHandler`](../../src/controllers/consequences/PickUpItemHandler.js:26) return `{ success: boolean, message?: string, pickedUpItem?: object }` — **`message`, not `code`** (e.g. line 100: `'Item is out of range. Distance: …'`). The unit-test mocks use `{ success: false, code }`. The log must therefore use `pickResult?.message || pickResult?.code || 'unknown'` to cover both shapes.

**Specific fix.** In `_craftLoopAttemptPickup` (created by H1; the code shown under H1 is the pre-M2 verbatim move — replace its last two lines):

```js
    const pickResult = facade.executePickUpItem?.(entity.id, item.id, core.id);
    if (pickResult && pickResult.success) {
        Logger.debug(`[NpcAI] Round ${round}: ${entity.name || entity.id} picked up dropped ${targetItemType} ${item.id} (dist: ${distance.toFixed(1)} ≤ ${PICK_RANGE}).`);
    } else {
        // Visible graceful degradation: the handler rejected the pickup
        // (stale target, out-of-range, capacity, nested children, or the
        // dispatcher is missing). The drone is stateless and re-derives next
        // round — but the rejection is logged (with the handler's reason)
        // instead of a false success.
        Logger.warn(`[NpcAI] Round ${round}: ${entity.name || entity.id} pickup of ${item.id} rejected (${pickResult?.message || pickResult?.code || 'unknown'}) — re-derives next round.`);
    }
```

The success-path log line is byte-identical to today's line 546 (scope guard: same logs-on-success). Note: if `facade.executePickUpItem` is absent (optional chaining → `undefined`), the code now logs a WARN with `'unknown'` where today it silently no-ops — that is the intended visibility, not a behavior change in decisions.

**Risk & side effects.** Decisions unchanged (the method returns nothing; the stage still returns `null`/idle and the drone re-derives next round, per spec §4.4 state machine edge "PickedUp → Idle: pickup rejected by the handler"). The only new observable is a WARNING line on the previously-silent failure path — exactly what §3.1 requires. Unit test 4e (L4) spies `Logger.warn` and restores it, so no cross-test contamination. No other code path calls `executePickUpItem` from the AI (verified).

**Prevention (future).** In the M3 commit, extend the subMD's "Fail-safe" design-principle line: "Structured results from immediate operations invoked on the tick path (pickup, craft) are always checked; rejections log at WARN with the handler's reason."

---

## M3 — `craft_loop` missing from the Behavior Registration table (MUST)

**Root cause.** The behavior was registered in code (constructor line 88) but the controller's subMD — the documented extension registry (["Behavior Registration"](subMDs/controllers/npc_ai_controller.md:15), table at line 19–21) — was never updated when the behavior was added. Violates [project_rules.md](project_rules.md) §7 (maps kept up-to-date on structure change) and the subMD's own registry contract. (Note: the high-level [`map.md`](map.md:104) AI-Controllers row already lists `craft_loop` — only the subMD table is stale; no `map.md` change needed.)

**Specific fix.** In [`npc_ai_controller.md`](subMDs/controllers/npc_ai_controller.md), add one row after the `chase_attack` row (line 21), written "why"-level per project rule §8 (purpose, not step-by-step flow — matching the existing row's register):

```markdown
| `craft_loop` | The Crafter Drone's forage loop: finds its target item (the first input of its recipe — currently `knife`) dropped in its own room, forges it into the recipe's output via a zero-cost craft call, and leaves the finished item on the ground at its own position; moves toward the nearest in-room item while out of reach. Deterministic and stateless; own-room only (no door traversal); fixed action names (`move`/`dropItem`) with no ai-configurable overrides, by design (spec: [crafter_drone_spec.md](../../crafter_drone_spec.md)). |
```

**Risk & side effects.** None — documentation only; no code, test, or data change.

**Prevention (future).** Same commit: add the M1/M2 prevention lines to the subMD's Design Principles, so the subMD becomes the single place documenting the behavior-registry contract and helper/behavior ownership rules.

---

## M4 — contract test uses sub-controllers despite its "public API only" claim (MUST)

**Root cause.** The test was written against the same internals `server.js` must not use: [`crafterDrone.contract.test.js:47`](../../test/contract/crafterDrone.contract.test.js:47) reads the private `world.stateEntityController.entities` map, line 53 calls `world.roomsController.getUidByLogicalId`, lines 62/65 call `stateEntityController.spawnEntity/getEntity`. Violates [project_rules.md](project_rules.md) §2 ("Public API Only") and §3 (facade methods are the literal rule examples), plus [controller_patterns.md](subMDs/controllers/controller_patterns.md) §5 (public methods only). A test that bypasses the facade cannot guarantee the facade path the production code uses.

**Specific fix.** Facade equivalents verified in [`WorldStateController.js`](../../src/controllers/WorldStateController.js) with their real signatures:

| Line | Current (sub-controller) | Becomes (facade, verified signature) |
|------|--------------------------|--------------------------------------|
| 47 | `Object.values(world.stateEntityController.entities)` | `Object.values(world.getEntities())` — `getEntities()` at line 658, returns the entity map (defensive copy) |
| 53 | `world.roomsController.getUidByLogicalId('start_room')` | `world.getRoomUidByLogicalId('start_room')` — line 1017 (the literal §3 example) |
| 62 | `world.stateEntityController.spawnEntity('smallBallDroid', startRoomId())` | `world.spawnEntity('smallBallDroid', startRoomId())` — line 971, `(blueprintName, roomId)` |
| 65 | `world.stateEntityController.getEntity(helper)` | `world.getEntity(helper)` — line 1027, `(entityId)` |

Documented exceptions (leave, with a one-line comment each — the checker's own caveats, confirmed against the facade's real method list):
- **Line 64** `world.stateEntityController.updateEntitySpatial(helper, { x, y })` — the facade has **no** absolute-spatial method (`moveEntity` at line 992 is door-traversal only). Comment: "no facade equivalent for absolute spatial positioning (documented exception; the production AI never needs it)".
- **Line 118** `world.roomsController.getRoom(roomId)` — checker: leave. (The facade does have `getRooms()` at line 1340, but its keying — logical id vs uid — is unverified; do not gamble a green suite on it. Comment: "room lookup has no verified facade equivalent (documented exception)".)
- **Line 45** `turns = world.turnSystemController` — leave (sanctioned composition root, mirrors [`server.js:68`](../../src/server.js:68)); the agent-callback usage of `turns` (setNpcAgent/onTick/getQueuedActions) is a public-method-only usage either way.

**Risk & side effects.** `getEntities()` returns defensive copies, so the `drone`/`rogue` objects captured in `beforeEach` are snapshots — all existing usages read only immutable-ish fields (`id`, `blueprint`, `isNPC`, `name`, `npcConfig`, `location`, `spatial`, `components[].id/type`), and anything asserted later is re-fetched via `world.getEntity()` — verified across tests 1–4. Test 2's `world.despawnEntity(rogue.id)` and test 3's are already facade calls (lines 165/203) and are unaffected. No behavior change; all four existing tests must pass unchanged.

**Prevention (future).** The file header already claims "public API only" — after this fix the claim is true. Going forward, the M3 subMD principles line (see above) plus project rule §9's checklist item "Use public API methods, not direct sub-controller access (Sections 2 & 3)" cover new tests; add "same rule applies to tests" to that checklist line only if the implementer judges it in-scope (it is a project_rules.md edit — flagged as follow-up, NOT part of this change surface).

---

## M5 — spec §7.2.5 regression guard not implemented (MUST)

**Root cause.** Spec §7.2.5 ([`crafter_drone_spec.md:304`](crafter_drone_spec.md:304)) requires "the existing `smallBallDroid` (chase_attack) … still spawns and (if cheap) still pursues"; instead both existing contract tests *despawn* the rogue first (lines 165, 203) and nothing ever drives it. The drone feature changed boot-time world population (+1 NPC in `start_room`, spec R7) — exactly the condition that could silently regress the rogue's boot/pursuit, and code_quality §5.1 (regression protection) has no test for it.

**Ground truth for the test** (verified): the rogue boots via `_spawnNpcs` from [`data/npcs.json:10-15`](../../data/npcs.json) — blueprint `smallBallDroid`, displayName "Rogue Droid", `ai.behavior: 'chase_attack'`, **no** `attackRange` override → the brain resolves the `droid punch` registry range (100, [`data/actions.json`](../../data/actions.json) component-targeting entry) or the `DEFAULT_ATTACK_RANGE_FALLBACK = 100` ([`NpcAIController.js:30`](../../src/controllers/ai/NpcAIController.js:30)). It spawns at the room center — the **same point** as the drone (both at `room.x + width/2, room.y + height/2` = 150,100 in the 300×200 `start_room`), so the test must displace it first. Turn machinery (v2 — the original v1 description, based on three tick-geometry constants later removed from `src/utils/Constants.js`, is superseded; see the post-plan update in the header): event-driven rounds — the roster's agent callbacks fire at round start, the planning window closes when every roster planner signals (no deadline), and close + resolution complete inside the same tick call; `getQueuedActions(entityId)` exposes the in-flight queue for inspection between the agent firing and the settled resolution. The rogue's per-`move` step is 20 (`droidRollingBall.traits.Movement.move = 20`, [`data/components.json:42`](../../data/components.json:42)).

**Specific fix.** Add test 5 to `test/contract/crafterDrone.contract.test.js` (after test 4, line 236). It drives ONE round manually and inspects the queue between the agent firing and the resolution — in v2 that window is synchronous (the tick call fires the agents; the close/resolution settles right after it) — which is why it cannot reuse `registerBrainAndDrive` as-is:

```js
it('5. regression guard (spec §7.2.5): the rogue droid still spawns with chase_attack and still pursues over a driven round', async () => {
    // Spawn assertions — the boot path still produces the rogue in start_room.
    expect(rogue).toBeDefined();
    expect(rogue.isNPC).toBe(true);
    expect(rogue.name).toBe('Rogue Droid');
    expect(rogue.npcConfig.ai.behavior).toBe('chase_attack');
    expect(rogue.location).toBe(startRoomId());

    const room = world.roomsController.getRoom(startRoomId()); // documented exception (test 1)
    const center = { x: room.x + room.width / 2, y: room.y + room.height / 2 };

    // Displace the rogue 120 units from the (stationary) drone toward the
    // room origin: same room, beyond the 100 attack range → chase_attack must
    // decide MOVE, not attack. Absolute spatial positioning has no facade
    // equivalent (documented exception, same as dropKnifeAt's helper).
    const d0 = Math.hypot(center.x - 0, center.y - 0);
    world.stateEntityController.updateEntitySpatial(rogue.id, {
        x: center.x + (0 - center.x) / d0 * 120,
        y: center.y + (0 - center.y) / d0 * 120
    });

    const brain = new NpcAIController({
        worldStateController: world,
        turnSystemController: turns
    });
    turns.setNpcAgent((npcId, round) => {
        const ent = world.getEntity(npcId);
        if (NpcAIController.hasDeterministicBrain(ent)) {
            return brain.think(npcId, round, ent);
        }
        return { acted: false };
    });

    // Drive ONE round, inspecting the queue between agent fire and resolution.
    // (v1 geometry — three onTick calls per round based on the TURN_*
    //  constants — was removed by the v2 refactor and is superseded by the
    //  post-plan update in the header: one onTick per round, then the settle
    //  window; the queue is inspected synchronously after that call.)
    await new Promise(res => setTimeout(res, 25)); // same settle margin as the helper

    // The rogue queued a MOVE toward the drone's position (its nearest entity).
    const queuedRogue = turns.getQueuedActions(rogue.id);
    expect(queuedRogue).toHaveLength(1);
    expect(queuedRogue[0].actionName).toBe('move');
    expect(queuedRogue[0].params).toEqual({ targetX: center.x, targetY: center.y });
    expect(queuedRogue[0].source).toBe('npc');

    // The drone (no knife in this fresh world) stays idle — it does not
    // react to the rogue.
    expect(turns.getQueuedActions(drone.id)).toHaveLength(0);

    // The queued move is applied by the resolution that settled in the
    // window: the rogue closes 20 units (120 → 100). (v1 had a separate
    // resolution tick — the v2 machine does not; see the header.)
    const before = world.getEntity(rogue.id).spatial;
    const distBefore = Math.hypot(center.x - before.x, center.y - before.y);

    const after = world.getEntity(rogue.id).spatial;
    const distAfter = Math.hypot(center.x - after.x, center.y - after.y);
    expect(distBefore).toBeCloseTo(120, 5);
    expect(distAfter).toBeLessThan(distBefore);
    expect(distAfter).toBeCloseTo(100, 5);

    // The drone never moved (nothing to forage).
    const droneAfter = world.getEntity(drone.id).spatial;
    expect(droneAfter.x).toBe(center.x);
    expect(droneAfter.y).toBe(center.y);
});
```

Determinism notes: the rogue's nearest entity is the drone (fresh world: exactly two entities, no drops — test 5 must not call `dropKnifeAt`); both brains fire in the agent slot, the drone returns idle; at resolution only the rogue has a queued action, so its 20-unit step is the only spatial mutation. If a future data change raises the `droid punch` range to ≥ 120 (or the rogue's blueprint/stats), this test fails loudly — that is the guard working as intended.

**Risk & side effects.** New test only (suite +1); it uses `world`/`turns`/`tick`/`drone`/`rogue` exactly as the `beforeEach` provides and does not mutate shared fixtures before other assertions (each `it` gets a fresh world via `beforeEach` → `buildWorldState`). The `setTimeout(25)` is the same settle margin the file already uses in `registerBrainAndDrive` (line 109) — accepted pattern here; see L6 for the only caveat.

**Prevention (future).** Update the file's header comment (lines 10–21, which lists the spec §5 checklist items the file covers) to add the §7.2.5 mapping, so the test-plan → test-file traceability is explicit for the next feature.

---

## Optional nits — L1–L8 (recommendations included; each marked OPTIONAL)

### L1 — bare `@constant` on `CRAFT_DROP_ACTION` (OPTIONAL)
**Root cause.** The "why" comment was written for `CRAFT_MOVE_ACTION` (lines 44–50) only; its sibling `CRAFT_DROP_ACTION` (lines 52–55) got a bare `/** @constant */` — comment drift when the constant was added.
**Fix.** [`NpcAIController.js:52-55`](../../src/controllers/ai/NpcAIController.js:52):
```js
/**
 * Fixed action name used by craft_loop: the delivery drop of the forged
 * output item at the drone's own position. The spec pins these (no
 * moveAction/attackAction overrides for this behavior), so they are module
 * constants rather than ai-configurable values.
 * @constant
 */
```
**Risk.** None (comment). **Prevention:** "every module constant carries a why-comment" is already the file's de-facto style; L2's header update reinforces it.

### L2 — stale module header + stale `allEntities` JSDoc (OPTIONAL)
**Root cause.** Header line 10 still reads "First behavior: `chase_attack`" — written before `craft_loop` existed; and [`NpcAIController.js:367`](../../src/controllers/ai/NpcAIController.js:367) documents the fallback as `facade.stateEntityController?.getAll()` while the code (line 383) actually uses `facade.getEntities?.()` — a factual error in the JSDoc (checker-sanctioned: fix it since it is factually wrong; comment-only, zero behavior change, and the only touch to `_chaseAttackBehavior`).
**Fix.** Replace line 10 with:
```js
 * Built-in behaviors:
 *   - `chase_attack`: chase and attack the nearest entity in the same room.
 *   - `craft_loop`: Crafter Drone — forage a dropped item, forge it into the
 *     recipe output, and drop it on the ground (wiki/crafter_drone_spec.md).
```
and line 367 with: `* @param {Object} [ctx.allEntities] — optional; fallback to facade.getEntities()`.
**Risk.** None. **Prevention:** the M3 subMD registry means the header's behavior list and the subMD table are both updated per behavior — one more check on the §9 checklist.

### L3 — `CRAFT_CORE_COMPONENT_TYPE` code constant vs recipe-resolved target type (OPTIONAL — DEFER)
**Root cause.** Inconsistent data-driven purity: the foraged *item type* is recipe-resolved at runtime (`_resolveCraftInputType`, lines 570–578, recipe as single source of truth), while the *core component type* is a hardcoded constant (line 63). Spec §4.3 (line 198) explicitly mandates the hardcode (`entity.components.find(c => c.type === 'crafterCore')`).
**Decision: DEFER the data-driven path — keep the constant.** The only "data-driven" alternative is a heuristic (e.g. "largest-volume component") that needs new logic with edge cases (ties, missing stats, knife-vs-t1 footprint differences) and would risk changing *which* component receives items — a behavior change the scope guard forbids, and no existing facade method resolves "the drone's core" from blueprint data without such a heuristic. The sync risk is already mechanically pinned twice: the constant's JSDoc (lines 57–61) says "Keep in sync with data/blueprints.json / data/components.json", and contract test 1 (lines 139–159) asserts the drone's component set matches the blueprint and its stats match `data/components.json`.
**Fix (minimal, comment-only).** Extend the JSDoc at [`NpcAIController.js:57-63`](../../src/controllers/ai/NpcAIController.js:57) with one line: `* Spec §4.3 mandates this hardcode; a data-driven resolution would add a fragile volume heuristic, so the sync risk is pinned by contract test 1's blueprint assertions.`
**Risk.** None. **Prevention:** the note itself documents why the asymmetry is deliberate, so the next reader doesn't "fix" it into a behavior change.

### L4 — no unit test for the spec §4.4 "pickup rejected by the handler" edge (OPTIONAL)
**Root cause.** Spec §4.4's state machine includes the edge "PickedUp → Idle: pickup rejected by the handler (stale/range) → re-derive next round", but the unit suite has no test where `executePickUpItem` returns `{ success: false }` — the mock's default even *always succeeds* when the target+core are valid ([`NpcAIController.craftLoop.test.js:135-145`](../../test/unit/NpcAIController.craftLoop.test.js:135)).
**Fix.** (a) Add an `opts.executePickUpItem` override hook to `buildCraftLoopWorld`, mirroring the existing `opts.craftItems` pattern (lines 120–134):
```js
executePickUpItem: (entityId, itemId, targetComponentId) => {
    calls.executePickUpItem.push({ entityId, itemId, targetComponentId });
    if (typeof opts.executePickUpItem === 'function') {
        return opts.executePickUpItem(entityId, itemId, targetComponentId, { held, dropped });
    }
    // ...existing default body (unchanged)...
},
```
(b) Add test `4e` inside the Stage B describe (after line 302), with a `Logger` warn spy verifying M2's new warning (import `Logger` from `'../../src/utils/Logger.js'`; `vi` is already imported at line 26):
```js
it('4e. pickup rejected by the handler → clean idle (no throw, no queue, no retry this round)', () => {
    const warnSpy = vi.spyOn(Logger, 'warn');
    const { brain, calls } = buildCraftLoopWorld({
        held: [],
        dropped: [
            { id: 'kn-rej', itemType: 'knife', roomId: ROOM_A, x: 30, y: 0 }
        ],
        // Mirrors the real handler's rejection shape ({ success, message }).
        executePickUpItem: () => ({ success: false, message: 'Item is out of range.' })
    });

    try {
        const result = brain.think(DRONE_ID, 1);

        expect(result).toEqual({ acted: false, reason: 'idle' });
        expect(calls.executePickUpItem).toHaveLength(1);
        expect(calls.queueAction).toHaveLength(0);
        expect(calls.executeAction).toHaveLength(0);
        expect(calls.craftItems).toHaveLength(0);
        // M2: the rejection is visible in the log (with the item id),
        // never a false success.
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('kn-rej'));
    } finally {
        warnSpy.mockRestore();
    }
});
```
**Risk.** Suite +1 test; the spy is restored in `finally` so no cross-test contamination; the mock change is additive (default behavior identical). **Prevention:** spec §4.4 edges ↔ test cases are now 1:1; keep that mapping when the state machine grows (note it in the file header checklist, lines 9–21).

### L5 — `expect(PICK_RANGE).toBe(100)` pins a literal with no mechanical sync (OPTIONAL)
**Root cause.** The "keep in sync" contract ([`npcAiUtils.js:8-13`](../../src/utils/npcAiUtils.js:8), spec R9 line 323) is comment-enforced only: `PICK_RANGE` must equal `PickUpItemHandler.maxRange` (hardcoded `100` at [`PickUpItemHandler.js:96`](../../src/controllers/consequences/PickUpItemHandler.js:96)) and the `dropItem` range in `data/actions.json`. The test at [`npcAiUtils.test.js:73`](../../test/unit/npcAiUtils.test.js:73) asserts the literal, so a data edit that breaks the contract fails nowhere.
**Fix.** In `test/unit/npcAiUtils.test.js`, add `import DataLoader from '../../src/utils/DataLoader.js';` and replace line 73's assertion with a cross-assertion against the shared data source (the mechanically verifiable end of the sync chain — the handler's local constant mirrors this same file, per its own comment):
```js
describe('craft_loop configuration constants (npcAiUtils)', () => {
    it('exposes the pickup range, recipe id, and item types used by the behavior', () => {
        // Keep-in-sync contract (PICK_RANGE JSDoc / spec R9): PICK_RANGE must
        // equal the dropItem range in the shared data file — the value
        // PickUpItemHandler.maxRange mirrors. Asserting against the data
        // source (not a literal) makes drift fail here, not in the wild.
        const actions = DataLoader.loadJsonSafe('data/actions.json', {});
        expect(PICK_RANGE).toBe(actions.dropItem?.range);
        expect(RECIPE_ID).toBe('single_knife_to_t1');
        expect(TARGET_ITEM_TYPE).toBe('knife');
        expect(CRAFT_OUTPUT_TYPE).toBe('t1');
    });
});
```
`data/actions.json:174-177` confirms `dropItem.range === 100`. (`DataLoader.loadJsonSafe` resolves relative to the project root via `__dirname` — cwd-independent, safe in vitest; it is the project's sanctioned loader, project rule §5.)
**Risk.** None if the data file is intact (it is — the assertion passes at 100). Residual gap, stated honestly: this pins `PICK_RANGE ↔ actions.json`; the separate `PickUpItemHandler.maxRange ↔ actions.json` link (handler line 96) remains comment-synced — fixing that would require touching the handler, outside this change surface (flagged as follow-up). **Prevention:** a project-rule note — "any code constant mirroring a `data/` file must be cross-asserted against that file in a unit test" (follow-up, project_rules.md §5).

### L6 — hardcoded `stepSize = 10` in the convergence simulation; timing-sensitive `setTimeout(25)` (OPTIONAL)
**Root cause.** [`NpcAIController.craftLoop.test.js:526`](../../test/unit/NpcAIController.craftLoop.test.js:526) hardcodes the drone's per-resolution movement (10) and line 594 hardcodes the derived consequence (`toBe(5)` move rounds) — if `crafterRollingBall.Movement.move` in [`data/components.json:88`](../../data/components.json:88) ever changes, the simulation silently models the wrong world (it still "passes" or fails confusingly). Separately, the contract test's `setTimeout(…, 25)` ([`crafterDrone.contract.test.js:109`](../../test/contract/crafterDrone.contract.test.js:109)) is documented-but-timing-sensitive.
**Fix (stepSize).** In `test/unit/NpcAIController.craftLoop.test.js`: add `import DataLoader from '../../src/utils/DataLoader.js';` and `import { PICK_RANGE } from '../../src/utils/npcAiUtils.js';`; in `apply()` (line 526) replace the literal with the value derived from the real component data:
```js
// Derived from the real component data (same source the stats controller
// loads) — no hardcoded movement: a data change must change this simulation,
// not be silently ignored by it.
const components = DataLoader.loadJsonSafe('data/components.json', {});
const stepSize = components.crafterRollingBall?.traits?.Movement?.move;
if (typeof stepSize !== 'number') throw new Error('crafterRollingBall.Movement.move missing in data/components.json');
```
(line 594) make the consequence formulaic: `const approachDistance = 150 - PICK_RANGE;` … `expect(moveRounds.length).toBe(Math.ceil(approachDistance / stepSize));` (currently 50/10 = 5 — identical).
**Fix (setTimeout) — recommendation: no change in this batch.** The sleep is pure settle margin for the fire-and-forget agent slot (v2: the agent fires at round start in [`TurnSystemController._fireNpcAgents`](../../src/controllers/core/TurnSystemController.js:677); the v1 `_fireAgentTick` slot no longer exists); the brain callback used in these tests is synchronous, so the margin is harmless, and the whole suite runs on the same pattern. If a genuinely async agent (e.g. LLM) is ever wired into these contract tests, replace the sleep with capturing the promise returned by the agent callback in the test's own `setNpcAgent` wrapper. Add a one-line comment noting that constraint (comment-only).
**Risk.** The derived `stepSize` must stay equal to what the real turn pipeline applies per `move` (it does: one `Movement.move` stat value is resolved per action; both `crafterRollingBall` entries are 10, and the existing green suite with stepSize 10 proves the resolution). Suite count unchanged. **Prevention:** "simulation constants derive from the same data files the system under test loads" — note it in the test file header.

### L7 — `data/crafting.json` formatting inconsistency (OPTIONAL)
**Root cause.** `single_knife_to_t1`'s input/output objects were written multi-line ([`data/crafting.json:6-17`](../../data/crafting.json:6)) while the sibling `knife_to_t1` uses the file's established compact one-liner style (lines 23–28) — cosmetic drift within one file.
**Fix.** Re-format only the two objects inside `single_knife_to_t1` (lines 6–17) to:
```json
    "inputs": [
      { "type": "knife", "quantity": 1 }
    ],
    "outputs": [
      { "type": "t1", "quantity": 1 }
    ]
```
(no other byte in the file changes; `knife_to_t1` untouched per spec §3.3/R4).
**Risk.** Zero semantic impact (identical JSON value; the CraftingController's `_validate*` path is value-based). **Prevention:** none needed beyond the file's existing convention; if a formatter is ever adopted project-wide, this class of drift disappears.

### L8 — spec/implementation signature drift for `findNearestDroppedItem` (OPTIONAL)
**Root cause.** The spec's recommended helper ([`crafter_drone_spec.md:266`](crafter_drone_spec.md:266), §6 change list row 5 — the checker's "§4.2" reference is slightly off; §4.2 is the constants block) was `findNearestDroppedItem(candidates, x, y)` returning `{ item, distance }`; the implementation shipped as `(droppedItems, roomId, x, y, maxRange=Infinity)` returning the bare item. The spec was never updated, so the documented contract no longer matches reality (the checker's own fork: update the spec to match reality, or vice versa — weighing M1's design, the implementation now *matches* the spec's return shape after M1, so only the parameter list and the range-owner note need correcting in the spec).
**Fix.** Two targeted spec edits (documentation only; apply AFTER M1 so the spec describes the final contract):
1. §6 row 5 (line 266) → "Export a pure helper `findNearestDroppedItem(droppedItems, roomId, x, y)`: min Euclidean distance with lexicographic-id tie-break; the helper owns the room + finite-coordinate guards and returns `{ item, distance }` or `null`. The `PICK_RANGE` pickup decision is owned by the behavior (mirrors `chase_attack`), not the helper — no range parameter."
2. §4.3 pseudocode (lines 187–205) → replace the inline `minBy`/recomputed `dist` with the helper call, keeping the pseudocode's register:
```
  knives  = dropped.filter(d => d.itemType === knifeType)        # type filter only
  nearest = findNearestDroppedItem(knives, entity.location, entity.spatial.x, entity.spatial.y)
            # -> { item, distance } | null (helper owns the room/finite guards)
  if nearest === null:
      return null         # IDLE: no in-room target item
  dist    = nearest.distance
```
with downstream references updated (`nearest.item.id` at the `executePickUpItem` line, `nearest.item.x/.y` in the move params).
**Risk.** None (documentation; no code depends on the spec text). **Prevention:** process note in the spec header — "implementation-facing contracts (signatures, return shapes) in this document are updated in the same PR that changes them".

---

## Application Order

Order chosen to minimize conflicts: structural move first (verbatim, no semantics), then semantic fixes applied to the final structure, then independent test/doc changes. Each step is a separate atomic commit (project rule §6.1):

| # | Step | File(s) | Depends on |
|---|------|---------|-----------|
| 1 | **H1** — verbatim stage extraction (`_craftLoopCraftStage` / `_craftLoopForageStage` / `_craftLoopAttemptPickup` + dispatcher) + strengthen unit test 6 with `expect(calls.executePickUpItem).toHaveLength(0)` | `src/controllers/ai/NpcAIController.js`, `test/unit/NpcAIController.craftLoop.test.js` | — |
| 2 | **M1** — helper loses `maxRange`, returns `{ item, distance }`, new JSDoc; `_craftLoopForageStage` updated (type-only filter, new destructure, re-worded null guard); `npcAiUtils.test.js` updated per M1.3 | `src/utils/npcAiUtils.js`, `src/controllers/ai/NpcAIController.js`, `test/unit/npcAiUtils.test.js` | 1 (edits land inside the extracted stage) |
| 3 | **L5** — `PICK_RANGE` cross-asserted against `data/actions.json` (`DataLoader`) | `test/unit/npcAiUtils.test.js` | 2 (same file; different `it` — no line conflict) |
| 4 | **M2** — pickup result check + WARN in `_craftLoopAttemptPickup` | `src/controllers/ai/NpcAIController.js` | 1 |
| 5 | **L4** — `opts.executePickUpItem` mock hook + test 4e with Logger warn spy | `test/unit/NpcAIController.craftLoop.test.js` | 4 (the spy asserts M2's warning exists) |
| 6 | **M4** — facade conversions (lines 47/53/62/65) + documented-exception comments (64/118) | `test/contract/crafterDrone.contract.test.js` | — (independent) |
| 7 | **M5** — contract test 5 (regression guard) + header checklist line | `test/contract/crafterDrone.contract.test.js` | 6 (same file) |
| 8 | **M3** — `craft_loop` row in the Behavior Registration table + design-principle lines (M1/M2 prevention) | `wiki/subMDs/controllers/npc_ai_controller.md` | 1–2 done (principles describe the final design) |
| 9 | **L1 + L2** — `CRAFT_DROP_ACTION` why-comment; module header behaviors; stale `allEntities` JSDoc (line 367, comment-only) | `src/controllers/ai/NpcAIController.js` | 1 |
| 10 | **L3** — `CRAFT_CORE_COMPONENT_TYPE` JSDoc note (defer decision documented) | `src/controllers/ai/NpcAIController.js` | 9 (same comment region) |
| 11 | **L6** — derived `stepSize` + formulaic move-rounds in the convergence simulation; `setTimeout` comment in the contract test | `test/unit/NpcAIController.craftLoop.test.js`, `test/contract/crafterDrone.contract.test.js` | — (last, to avoid re-editing already-changed files earlier) |
| 12 | **L7** — `single_knife_to_t1` compact re-format | `data/crafting.json` | — |
| 13 | **L8** — spec §6.5 + §4.3 updated to the final helper contract | `wiki/crafter_drone_spec.md` | 2 (spec must describe the post-M1 contract) |

After step 13: run the full suite (`npx vitest run`) — expected **45 files / 679 tests, all green** (678 − 1 deleted maxRange test + 1 L4 test + 1 M5 test).

---

## Scope Guard

1. **Observable behavior is unchanged.** Same decisions, same turn actions (identical `queueAction`/`executeAction` call sequences and params in every existing test), same logs-on-success (the M2 change adds a WARNING only on the previously-silent rejection path — that is the fix, not a behavior change).
2. **`_chaseAttackBehavior` is not touched** — the sole exception is its factually wrong JSDoc comment at line 367 (L2), which the checker explicitly sanctioned as a comment-only correction.
3. **No changes outside the listed surface:** only `src/controllers/ai/NpcAIController.js`, `src/utils/npcAiUtils.js`, `test/unit/npcAiUtils.test.js`, `test/unit/NpcAIController.craftLoop.test.js`, `test/contract/crafterDrone.contract.test.js`, `data/crafting.json` (formatting only), `wiki/subMDs/controllers/npc_ai_controller.md`, `wiki/crafter_drone_spec.md`, and this file (`wiki/crafter_drone_fix_plan.md`). No changes to `TurnSystemController`, consequence handlers, `CraftingController`, routes, composition, `server.js`, `data/npcs.json`, `data/blueprints.json`, `data/components.json`, or `data/actions.json`.
4. **The full vitest suite must remain green** — 45 files; 678 → 679 tests as itemized above.
5. Follow-up items deliberately excluded from this batch (documented, not done): pinning `PickUpItemHandler.maxRange` against `data/actions.json` mechanically (requires touching the handler); adding "tests included" to project rule §9; converting contract-test line 118 to `getRooms()` (keying unverified).
