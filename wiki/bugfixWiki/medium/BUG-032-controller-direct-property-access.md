# BUG-032: Controllers Directly Access Sub-Controller Private Properties

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/actionController.js`, `src/controllers/WorldStateController.js`

## Symptoms

- ActionController directly accessed `stateEntityController` internals in multiple locations, bypassing the root controller's public API
- Tight coupling between ActionController and stateEntityController
- Changes to stateEntityController's internal API require modifications in ActionController
- Violates Controller Patterns wiki §5 (Controllers must communicate via public methods)

## Root Cause

Controllers were accessing internal properties of other controllers directly instead of using the public API methods defined in WorldStateController. This bypasses the loose coupling pattern and creates unnecessary dependencies between controllers.

## Fix

`WorldStateController` now exposes public API wrapper methods for entity, component, and component-stats lookups, and `actionController.js` uses the root controller's public API instead of reaching into `stateEntityController` internals. Logic shared across controllers (placeholder resolution, requirement validation, proximity checks) was extracted into dedicated utility modules so controllers depend on shared utilities rather than each other's internals.

## Prevention

- All controllers must use `WorldStateController` public API methods
- Business logic should be extracted to utility modules when shared across controllers
- Refer to `wiki/subMDs/controller_patterns.md` Section 5 for the architectural rules

## References

- Related wiki: `wiki/subMDs/controller_patterns.md` (Section 5)
- Related wiki: `wiki/map.md` (Available Public Methods)
- Related controller: `WorldStateController`, `ActionController`