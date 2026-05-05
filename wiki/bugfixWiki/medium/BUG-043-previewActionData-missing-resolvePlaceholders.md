# BUG-043: ActionController.previewActionData calls missing _resolvePlaceholders

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/actionController.js`

## Symptoms
- `POST /synergy/preview-data` returns HTTP 500
- Server logs: `this._resolvePlaceholders is not a function`
- Client logs: `ActionManager.js:496 [ActionManager] Preview data HTTP error: 500`

## Root Cause
The SRP refactor of `actionController.js` (BUG-039) extracted `_resolvePlaceholders` logic but the method was completely removed instead of being preserved as a private delegation method. `resolveActionValues()` and `previewActionData()` call `this._resolvePlaceholders()` which no longer exists.

## Fix
Added `_resolvePlaceholders(params, requirementValues, context)` private method back to `ActionController`:
```javascript
_resolvePlaceholders(params, requirementValues, context) {
    // Resolves :placeholder, -:placeholder, *:placeholder patterns
}
```

## Prevention
- When extracting code during SRP refactoring, ensure all calling sites are updated to use the extracted module OR preserve a delegation wrapper method.
- Run integration tests after SRP refactors to catch missing method references.

## References
- Related wiki: `wiki/subMDs/controller_patterns.md`
- Related bug: BUG-039 (ActionController SRP refactoring)