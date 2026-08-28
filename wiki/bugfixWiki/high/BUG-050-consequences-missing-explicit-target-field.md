# BUG-050: Consequences Missing Explicit Target Field

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/ConsequenceDispatcher.js`, `data/actions.json`, `src/controllers/consequences/DamageConsequenceHandler.js`, `src/controllers/consequences/StatConsequenceHandler.js`, `src/controllers/consequences/SpatialConsequenceHandler.js`, `src/controllers/consequences/LogConsequenceHandler.js`, `src/controllers/consequences/EventConsequenceHandler.js`

## Symptoms

Consequences and failureConsequences in `data/actions.json` had no explicit `target` field: each handler resolved its own target with ad-hoc logic (guessing from consequence type, reading action params directly, or using private fallback chains), so `self` vs `target` vs entity-wide operations behaved inconsistently from handler to handler.

This led to:
1. **Implicit behavior**: No clear documentation of who each consequence affects
2. **Inconsistent resolution**: Each handler resolved targets differently
3. **Hard to extend**: Adding new target types required changes in multiple places
4. **No validation**: Missing target info was never validated

## Root Cause

The original consequence system was designed with implicit target resolution:
- Spatial consequences always targeted the entity
- Other consequences used `targetComponentId` from params or fell back to `entityId`
- No standard way to express "this consequence affects the source component" vs "this consequence affects the enemy target"

## Fix

### 1. Added Mandatory `target` Field to All Consequences

Every consequence and failureConsequence in `data/actions.json` now MUST include a `target` field, making each consequence's affected party explicit and self-documenting instead of implicit. The field has three values: `"self"` (the source component fulfilling the requirement), `"target"` (the explicitly targeted entity/component), and `"entity"` (the entire entity performing the action).

### 2. Added `_resolveTargetForConsequence()` Method

`ConsequenceDispatcher._resolveTargetForConsequence()` replaces the old `_resolveTarget()`: target resolution now happens in exactly one place, and a missing or unknown `target` value is a hard error (logged, consequence skipped) rather than a silently guessed destination.

### 3. Updated All Consequence Handlers

Each handler now receives a pre-resolved target from the dispatcher instead of performing its own resolution, so all consequence types interpret `self`/`target`/`entity` identically and can no longer diverge.

### 4. Removed `componentBinding` from Actions

The `componentBinding` metadata was removed from `data/actions.json` as it was redundant — the `target` field on consequences provides the same information more explicitly.

### 5. Updated `data/actions.json`

All actions updated with explicit `target` fields.

## Prevention

1. **Mandatory `target` field**: The `ConsequenceDispatcher` validates that every consequence has a `target` field. If missing, it logs an error and skips the consequence.
2. **Wiki documentation**: Updated `wiki/subMDs/action_system.md` and `wiki/subMDs/consequence_handler_architecture.md` with target field documentation.
3. **Action templates**: New actions should follow the documented pattern with explicit `target` fields.

## References

- Related wiki: `wiki/subMDs/action_system.md`
- Related wiki: `wiki/subMDs/consequence_handler_architecture.md`
- Related controller: `ConsequenceDispatcher`
- Related controller: `ActionController`