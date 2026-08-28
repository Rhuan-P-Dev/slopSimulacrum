# BUG-045: Synergy Excludes Components Locked to Current Action

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/SynergyComponentGatherer.js`, `src/controllers/actionSelectController.js`

## Symptoms
- Preview shows synergy multiplier 1.95 with 2 components (correct)
- Execution shows synergy multiplier 1.0 with 0 components (broken)
- Server logs: `SynergyController] Synergy computed | Context: {"actionName":"dash","multiplier":1,"capped":false,"capKey":null,"componentCount":0}`

## Root Cause
`SynergyComponentGatherer.getLockedComponentIds()` called `getLockedComponentsForAction(actionName)` which returns components locked **TO** the current action. Then the gather methods filter OUT those component IDs. Result: components locked to the current action get excluded from the synergy pool, resulting in 0 contributing components.

The original `ActionSelectController.getLockedComponentIds(actionName)` method accepts an `excludeActionName` parameter that EXCLUDES components locked to that action from the returned set — exactly what synergy needs.

## Fix
Switched `SynergyComponentGatherer.getLockedComponentIds()` to call `ActionSelectController.getLockedComponentIds(actionName)` instead of `getLockedComponentsForAction(actionName)`. The two similarly named methods have inverted semantics: one returns the components locked **to** the given action, the other returns locked components with those locked to that action **excluded**. Synergy needs the latter — the components locked to the current action are exactly the ones that must remain in the pool to produce the multiplier, not the ones to filter out.

## Prevention
- When extracting modules that interact with selection controllers, verify the semantic meaning of method names.
- `getLockedComponentIds(excludeActionName)` returns IDs **except** those locked to `excludeActionName`.
- `getSelectionsForAction(actionName)` returns all selections **for** `actionName`.
- Run integration tests after module extraction refactors.

## References
- Related wiki: `wiki/subMDs/synergy_system.md`
- Related bug: BUG-042 (SynergyController SRP refactoring)