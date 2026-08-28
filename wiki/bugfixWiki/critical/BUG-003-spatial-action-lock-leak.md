# BUG-003: Spatial Action Component Lock Leak

- **Severity**: CRITICAL
- **Status**: ✅ Fixed
- **Fixed In**: `2573bea` ("fix: resolve spatial action locks and handle refresh scenarios")
- **Related Files**: `src/controllers/actionController.js` (lines 286-317)

## Symptoms

When executing a spatial action (e.g., `move`, `dash`) on an entity with multiple components:
- The component lock was never released after the action completed
- Subsequent actions failed because the component was still "locked" to the previous action
- **Example**: After `move` with `droidRollingBall`, `selfHeal` failed because `droidRollingBall` was still locked to "move"

### Cascade Failure Pattern

```
1. Player selects droidRollingBall → executes `move` → lock acquired ✅
2. Player selects droidRollingBall → executes `selfHeal` → ❌ FAILS
   Error: "Component already locked to action: move"
```

## Root Cause

The `executeAction()` method tracked component locks in a `componentsToRelease` list, released in the `finally` block. However, **spatial actions skipped the validation block entirely** where component locks were normally tracked — so spatial locks were never tracked and consequently never released, leaving the component locked to the previous action forever.

## Fix

Spatial actions now explicitly track their resolved components for release as soon as source resolution completes, so the shared release path covers every action type. Rationale: the "one component, one action" invariant requires that every action type leaves no locks behind, and the release path must be aware of spatial components in order to release them.

## Prevention

- Always ensure component locks are tracked **before** the `finally` block executes
- When adding new action types, verify lock tracking is covered
- Write integration tests that execute sequential actions on the same component
- The `ActionSelectController` enforces the "one component, one action" rule — locks must be released

## References

- Related wiki: `wiki/subMDs/action_system.md`
- Related wiki: `wiki/subMDs/component_selection.md`
- Related controller: `ActionController`, `ActionSelectController`
- Git commit: `2573bea`
- Related bug: [BUG-004](../high/BUG-004-role-mismatch-skip.md)