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

The `executeAction()` method tracked component locks in a `componentsToRelease` array, released in the `finally` block. However, **spatial actions skipped the validation block entirely** where component locks were normally tracked:

```javascript
// ❌ BEFORE (buggy flow)
executeAction() {
    try {
        // Validation block (lines 280-289) — tracks locks for NON-spatial actions
        if (targetingType !== 'spatial') {
            // Component locks tracked here
            componentsToRelease.push(componentId);
        }
        // Spatial actions skip this block entirely → locks never tracked → locks never released!
    } finally {
        // Release tracked locks — but spatial actions had nothing to release
        this.actionSelectController.releaseSelections(componentsToRelease);
    }
}
```

## Fix

Added explicit spatial component tracking after `_resolveSourceComponent()` resolves the component:

```javascript
// ✅ AFTER (fixed flow)
executeAction() {
    try {
        // Resolve source component for spatial actions
        if (targetingType === 'spatial') {
            const resolvedSourceComponentId = this._resolveSourceComponent(...);
            // Explicitly track spatial components for release
            if (componentList) {
                componentList.forEach(comp => componentsToRelease.push(comp));
            } else {
                componentsToRelease.push(resolvedSourceComponentId);
            }
        }
        // ... rest of action execution
    } finally {
        // Now spatial components are tracked and released properly
        this.actionSelectController.releaseSelections(componentsToRelease);
    }
}
```

### Component Lock Tracking Summary

| Action Type | Lock Tracking Location | Details |
|-------------|----------------------|---------|
| **Non-spatial** | Validation block (lines 286-289) | Components tracked during `validateSelection()` |
| **Spatial (multi-component)** | After `_resolveSourceComponent()` (lines 301-317) | Each component from `componentList` added |
| **Spatial (single-component)** | After `_resolveSourceComponent()` (lines 301-317) | Resolved `resolvedSourceComponentId` added |
| **Self-target** | Validation block | Components from `targetComponentId` tracked |

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