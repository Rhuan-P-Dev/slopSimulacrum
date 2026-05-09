# BUG-051: _filterProvidedForGroup missing sameComponentType matching after groupType unification

- **Severity**: HIGH
- **Status**: ⚠️ Known
- **Fixed In**: `pending`
- **Related Files**: `synergyController.js` (lines 187-220)

## Symptoms

When synergy computation takes the `providedComponentIds` code path (used by `ActionExecutor` during action execution), component type filtering is no longer applied after unifying all groupTypes to `sameComponentType`. This means components of different types than the source component may be incorrectly included in synergy calculations.

## Root Cause

After unifying all `groupType` values to `sameComponentType` and removing the `componentType` field from synergy config:

1. The `_evaluateComponentGroups` path correctly delegates to `gatherSameComponentType()`, which auto-detects the component type from the source and matches same-type siblings.
2. The `_filterProvidedForGroup` path (used by `_evaluateProvidedComponents`) had its `componentType` filter removed but was **not updated** to perform equivalent type matching.

```javascript
// synergyController.js - _filterProvidedForGroup (line ~187)
// BEFORE: Had componentType filter check
// if (groupDef.componentType && component.type !== groupDef.componentType) return false;

// AFTER: Filter removed, but no replacement type-checking logic added
// Components pass through without type validation
```

The two evaluation paths now have **asymmetric filtering**:
- `_evaluateComponentGroups` → `gatherSameComponentType()` → type-matches from source
- `_filterProvidedForGroup` → no type filtering → all role-passing components included

## Fix

Add type auto-detection to `_filterProvidedForGroup` that mirrors the behavior in `gatherSameComponentType`:

```javascript
_filterProvidedForGroup(actionName, entityId, providedComponentIds, groupDef) {
    const lockedComponentIds = this.componentGatherer.getLockedComponentIds(actionName);
    const entity = this.worldStateController.stateEntityController.getEntity(entityId);
    if (!entity) return [];

    // Auto-detect the expected type from the first provided component
    // that passes the role filter (acts as the "source" for type detection)
    let detectedType = null;
    const roleFiltered = providedComponentIds
        .filter(({ componentId, role }) => {
            if (lockedComponentIds.has(componentId)) return false;
            const component = entity.components.find(c => c.id === componentId);
            if (!component) return false;
            const stats = this.worldStateController.componentController.getComponentStats(componentId);
            if (!stats) return false;

            if (groupDef.roleFilter) {
                if (!this._matchesRoleFilter(stats, groupDef.roleFilter)) return false;
            }

            // Auto-detect type from first passing component
            if (detectedType === null) {
                detectedType = component.type;
            }

            return true;
        });

    // Filter to only same-type components
    return roleFiltered
        .filter(({ componentId }) => {
            const component = entity.components.find(c => c.id === componentId);
            return component && component.type === detectedType;
        })
        .map(({ componentId, role }) => ({
            componentId, entityId,
            componentType: entity.components.find(c => c.id === componentId)?.type,
            role
        }));
}
```

## Prevention

When refactoring synergy filtering logic, always ensure both evaluation paths (`_evaluateComponentGroups` and `_filterProvidedForGroup`) maintain **symmetric filtering behavior**. Add integration tests that exercise both code paths.

## References
- Related wiki: `wiki/subMDs/synergy_system.md`
- Related controller: `SynergyController`
- Related bug: [BUG-046](high/BUG-046-filterProvidedForGroup-missing-filters.md)