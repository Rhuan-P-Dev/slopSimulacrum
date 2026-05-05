# BUG-044: ActionSelectController missing getLockedComponentsForAction method

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/actionSelectController.js`, `src/controllers/SynergyComponentGatherer.js`

## Symptoms
- Server logs: `this.actionSelectController.getLockedComponentsForAction is not a function`
- Synergy component gathering fails with CRITICAL error
- Multi-component synergy actions fail

## Root Cause
`SynergyComponentGatherer.js` calls `this.actionSelectController.getLockedComponentsForAction(actionName)` to get locked components for synergy exclusion, but `ActionSelectController` only has `getSelectionsForAction(actionName)`. The method name mismatch occurred during the SRP refactor of synergy (BUG-042) when `SynergyComponentGatherer` was extracted.

## Fix
Added `getLockedComponentsForAction(actionName)` alias method to `ActionSelectController`:
```javascript
getLockedComponentsForAction(actionName) {
    return this.getSelectionsForAction(actionName);
}
```

## Prevention
- When extracting modules that depend on other controllers, verify all method names exist.
- Use TypeScript or JSDoc to catch interface mismatches.
- Run integration tests after module extraction refactors.

## References
- Related wiki: `wiki/subMDs/controller_patterns.md`
- Related bug: BUG-042 (SynergyController SRP refactoring)