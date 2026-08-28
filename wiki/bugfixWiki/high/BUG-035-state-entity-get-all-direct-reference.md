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
`getAll()` returned the internal entity store by direct reference instead of a defensive copy, so any caller held a live handle to the controller's private state.

## Fix
`getAll()` now returns a deep clone, so callers can no longer mutate the controller's internal store through the returned reference. This enforces the project's **Defensive Copying** constraint: state controllers must expose copies, never internal references.

## Prevention
- All public getter methods that return collections or objects must return deep clones
- Use `structuredClone()` instead of `JSON.parse(JSON.stringify())`
- Document which methods return defensive copies

## References
- Related wiki: `wiki/subMDs/world_state.md`
- Related controller: `stateEntityController`
- Also fixed: `componentController.js` line 158-164