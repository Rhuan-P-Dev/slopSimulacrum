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
Added type auto-detection to `_filterProvidedForGroup` that mirrors the behavior in `gatherSameComponentType`:

```javascript
_filterProvidedForGroup(actionName, entityId, providedComponentIds, groupDef) {
    // First pass: detect type from first valid component (regardless of roleFilter)
    let detectedType = null;
    for (const { componentId } of providedComponentIds) {
        if (lockedComponentIds.has(componentId)) continue;
        const component = entity.components.find(c => c.id === componentId);
        if (component) {
            detectedType = component.type;
            break;
        }
    }

    // Second pass: filter by roleFilter and same type
    const validComponents = providedComponentIds
        .filter(({ componentId, role }) => {
            if (lockedComponentIds.has(componentId)) return false;
            const component = entity.components.find(c => c.id === componentId);
            if (!component) return false;
            const stats = this.worldStateController.componentController.getComponentStats(componentId);
            if (!stats) return false;

            if (groupDef.roleFilter) {
                if (!this._matchesRoleFilter(stats, groupDef.roleFilter)) return false;
            }

            if (detectedType && component.type !== detectedType) return false;
            return true;
        })
        .map(...);

    return validComponents;
}
```

### Phase 2: Preview Path Fixes
Added `sourceComponentId` to all synergy preview paths:

1. **`actionController.js`**: `previewActionData()` now passes `sourceComponentId` to `computeSynergy()`.
2. **`synergyRoutes.js`**: Both `/synergy/preview` and `/synergy/preview-data` routes now pass `sourceComponentId`.

### Phase 3: Fallback Path Fix
Added `allowedComponentIds` filtering to `SynergyComponentGatherer.gatherSameComponentType()` fallback path.

## Prevention

When refactoring synergy filtering logic, always ensure both evaluation paths (`_evaluateComponentGroups` and `_filterProvidedForGroup`) maintain **symmetric filtering behavior**. Add integration tests that exercise both code paths.

## References
- Related wiki: `wiki/subMDs/synergy_system.md`
- Related controller: `SynergyController`
- Related bug: [BUG-046](high/BUG-046-filterProvidedForGroup-missing-filters.md)