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
Restored the filter checks that the rewrite had dropped in `_filterProvidedForGroup`: the component-type match required by `sameComponentType` groups, and the group-type-specific stat checks (`movementComponents` requires actual Movement stats, `anyPhysical` requires actual Physical stats). Without them, groups with those constraints silently matched nothing and the multiplier collapsed to 1.0; restoring them brings back the pre-refactor matching semantics.

## Prevention
- When extracting modules during SRP refactoring, verify all filter criteria are preserved.
- Add unit tests for each group type (`sameComponentType`, `movementComponents`, `anyPhysical`, `anyComponent`).

## References
- Related wiki: `wiki/subMDs/synergy_system.md`
- Related bug: BUG-042 (SynergyController SRP refactoring)