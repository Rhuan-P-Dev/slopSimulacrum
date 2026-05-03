# BUG-032: Controllers Directly Access Sub-Controller Private Properties

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/actionController.js`, `src/controllers/WorldStateController.js`

## Symptoms

- ActionController directly accessed `this.worldStateController.stateEntityController.getEntity()` in 5+ locations (lines 539, 683, 734, 896, 901)
- Tight coupling between ActionController and stateEntityController
- Changes to stateEntityController's internal API require modifications in ActionController
- Violates Controller Patterns wiki §5 (Controllers must communicate via public methods)

## Root Cause

Controllers were accessing internal properties of other controllers directly instead of using the public API methods defined in WorldStateController. This bypasses the loose coupling pattern and creates unnecessary dependencies between controllers.

## Fix

Added public API wrapper methods to `WorldStateController`:

1. `getEntity(entityId)` — Returns entity by ID
2. `getComponent(componentId)` — Returns component by ID
3. `getComponentStats(componentId)` — Returns component stats by ID

Refactored `actionController.js` to use `this.worldStateController.getEntity()` instead of `this.worldStateController.stateEntityController.getEntity()`.

Extracted the following logic into utility modules:
- `src/utils/PlaceholderResolver.js` — Placeholder resolution
- `src/utils/RequirementChecker.js` — Requirement validation
- `src/utils/RangeChecker.js` — Entity proximity calculations

## Prevention

- All controllers must use `WorldStateController` public API methods
- Business logic should be extracted to utility modules when shared across controllers
- Refer to `wiki/subMDs/controller_patterns.md` Section 5 for the architectural rules

## References

- Related wiki: `wiki/subMDs/controller_patterns.md` (Section 5)
- Related wiki: `wiki/map.md` (Available Public Methods)
- Related controller: `WorldStateController`, `ActionController`