# BUG-051: _filterProvidedForGroup missing sameComponentType matching after groupType unification

- **Severity**: HIGH
- **Status**: ✅ Fixed (Round 2)
- **Fixed In**: `pending`
- **Related Files**: `synergyController.js` (lines 201-245)

## Symptoms

When synergy computation takes the `providedComponentIds` code path (used by `ActionExecutor` during action execution), component type filtering was no longer applied after unifying all groupTypes to `sameComponentType`. This meant components of different types than the source component could be incorrectly included in synergy calculations.

## Root Cause

After unifying all `groupType` values to `sameComponentType` and removing the `componentType` field from synergy config:

1. The `_evaluateComponentGroups` path correctly delegates to `gatherSameComponentType()`, which auto-detects the component type from the source and matches same-type siblings.
2. The `_filterProvidedForGroup` path (used by `_evaluateProvidedComponents`) had its `componentType` filter removed but was **not updated** to perform equivalent type matching.

The two evaluation paths had **asymmetric filtering**:
- `_evaluateComponentGroups` → `gatherSameComponentType()` → type-matches from source
- `_filterProvidedForGroup` → no type filtering → all role-passing components included

## Fix (Round 2: Deterministic Type Detection)

### Phase 1: Initial Fix (Round 2a)
Added type auto-detection to the provided-components filtering path, mirroring the behavior the group evaluation path already had, so both paths filter by the source component's type.

### Phase 2: Preview Path Fixes
The synergy preview paths now pass the source component into the synergy computation, so type detection applies to previews as well as execution.

### Phase 3: Fallback Path Fix
The component gatherer's fallback path now applies the same allowed-component restriction as its primary path, so provided components can never bypass it.

## Prevention

When refactoring synergy filtering logic, always ensure both evaluation paths (`_evaluateComponentGroups` and `_filterProvidedForGroup`) maintain **symmetric filtering behavior**. Add integration tests that exercise both code paths.

## References
- Related wiki: `wiki/subMDs/synergy_system.md`
- Related controller: `SynergyController`
- Related bug: [BUG-046](high/BUG-046-filterProvidedForGroup-missing-filters.md)