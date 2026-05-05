# BUG-035: stateEntityController.getAll() Returns Direct Internal Reference

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/stateEntityController.js` (line 129-131)

## Symptoms
- Any code calling `getAll()` can directly mutate internal entity state
- `structuredClone(this.entities)` was not being used, allowing external reference sharing
- State mutations from capability cache or consequence handlers could corrupt internal store

## Root Cause
```javascript
getAll() {
    return this.entities; // ❌ Returns direct reference to internal state
}
```
The method returned the internal `this.entities` object directly instead of a deep clone.

## Fix
Changed to return a deep clone:
```javascript
getAll() {
    return structuredClone(this.entities);
}
```

## Prevention
- All public getter methods that return collections or objects must return deep clones
- Use `structuredClone()` instead of `JSON.parse(JSON.stringify())`
- Document which methods return defensive copies

## References
- Related wiki: `wiki/subMDs/world_state.md`
- Related controller: `stateEntityController`
- Also fixed: `componentController.js` line 158-164