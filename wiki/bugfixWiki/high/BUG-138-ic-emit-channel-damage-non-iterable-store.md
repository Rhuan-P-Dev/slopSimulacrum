# BUG-138: IC emitChannelDamage Target Loop Iterated the Entity Store as an Array

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `e0cb1f2`
- **Related Files**: `src/controllers/core/InternalComponentController.js` (`_applyEmitChannelDamage`)

## Symptoms
The `emitChannelDamage` target loop threw `TypeError: ... is not iterable` on **every interval**. The error was absorbed by the per-effect `try/catch` (and logged), so the visible behavior was zero targets damaged and the feature appearing to do nothing. It was **unreachable in production** as long as the BUG-137 position guard short-circuited first (the guard returned before the loop), but it surfaced immediately once the contract test supplied a resolvable position and let execution reach the loop.

## Root Cause
A **return-type mismatch on the entity-store snapshot**. `stateEntityController.getAll()` returns a **deep-cloned keyed object** — a plain object keyed by entity id, the defensive-copy shape established by [BUG-035](BUG-035-state-entity-get-all-direct-reference.md) — not an array. The target loop consumed that snapshot with `for...of`, which is only valid on iterables. A keyed object is not iterable, so the loop threw before examining a single target. The bug was invisible while BUG-137's position guard returned early; the two defects masked each other.

## Fix
Iterate the **values** of the store snapshot explicitly (`Object.values(...)` of the `getAll()` clone), matching the snapshot's actual keyed-object return type. This is paired with the BUG-137 flat-shape position reads and the same-room guard in the same method, so the loop both runs and selects the right targets.

## Prevention
The store snapshot's **keyed-object return type is a contract**: any consumer of `getAll()` must take `.values` (or iterate keys) explicitly and must never assume an array. Keep the per-effect `try/catch` logging visible (do not swallow it) so a future type/shape regression in a range consumer logs a readable error at the effect level instead of masquerading as "nobody in range". The two defects that masked each other (BUG-137 + BUG-138) are why a single "it does nothing" symptom needs to be decomposed into "does the loop run" and "does the loop resolve positions" before it can be trusted.

## References
- Related bug (companion defect, same method): [BUG-137](BUG-137-ic-emit-channel-damage-spatial-shape-mismatch.md)
- Related bug (defensive-copy shape origin): [BUG-035](BUG-035-state-entity-get-all-direct-reference.md)
- Related controller: `InternalComponentController`
- Related test: `test/contract/worldRulesOnDamage.contract.test.js`
