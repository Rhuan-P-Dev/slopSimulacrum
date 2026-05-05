# BUG-046: _filterProvidedForGroup missing componentType/groupType filters

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/synergyController.js`

## Symptoms
- `POST /synergy/preview-data` with `providedComponentIds` returns synergy multiplier 1.0 even when components should match
- Synergy groups like `sameComponentType: droidRollingBall` fail to match because component type filter was missing
- Server logs: `SynergyController] Synergy computed | Context: {"actionName":"dash","multiplier":1,"capped":false,"capKey":null,"componentCount":0}`

## Root Cause
When `SynergyController` was refactored (BUG-042), the `_filterProvidedForGroup` method was rewritten but lost the `componentType` filter for `sameComponentType` groups and the `groupType`-specific filters (`movementComponents`, `anyPhysical`). The original code had these checks but they were accidentally removed.

## Fix
Added missing filters to `_filterProvidedForGroup`:
```javascript
// Check componentType filter for sameComponentType groups
if (groupDef.componentType && component.type !== groupDef.componentType) return false;

// Check groupType-specific filters
if (groupDef.groupType === 'movementComponents') {
    if (!stats.Movement || Object.keys(stats.Movement).length === 0) return false;
} else if (groupDef.groupType === 'anyPhysical') {
    if (!stats.Physical || Object.keys(stats.Physical).length === 0) return false;
}
```

## Prevention
- When extracting modules during SRP refactoring, verify all filter criteria are preserved.
- Add unit tests for each group type (`sameComponentType`, `movementComponents`, `anyPhysical`, `anyComponent`).

## References
- Related wiki: `wiki/subMDs/synergy_system.md`
- Related bug: BUG-042 (SynergyController SRP refactoring)