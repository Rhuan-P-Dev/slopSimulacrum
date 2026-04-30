# BUG-021: Multi-Component Spatial Action Race Condition

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `22bf5dc`
- **Related Files**: `public/js/App.js` (lines 383-406)

## Symptoms

When selecting 'dash' and choosing both droid balls (2 `droidRollingBall` components), **4 droid balls** appeared in the synergy preview instead of 2. The action was effectively executed multiple times due to a race condition in the map click handler.

## Root Cause

The map click handler in `App.js` had a race condition:

```javascript
// Original broken code
if (pending.targetingType === 'spatial') {
    if (this.selectedComponentIds.size >= 2 && this.activeActionName === pending.actionName) {
        this._executeMultiComponentSpatial(...);  // Multi-component execution
    } else {
        this.actions.moveToTarget(...);  // Single-component execution
    }
    this.actions.clearPendingAction();
    this._clearAllSelections();
    this.updateActionList();
}
```

When the user selected components and clicked the map:
1. The stale `pending` action could trigger `moveToTarget()` (single-component) on first click
2. Then `_executeMultiComponentSpatial()` (multi-component) on subsequent clicks
3. This caused duplicate executions — each component was "moved" multiple times

## Fix

Clear the pending action FIRST, capture selection state BEFORE clearing, then execute with captured state:

```javascript
// Fixed code
if (pending.targetingType === 'spatial') {
    // Clear pending action FIRST to prevent stale state triggering
    // a second execution (race condition causing extra droid balls)
    this.actions.clearPendingAction();
    
    // Capture selection state BEFORE clearing
    const isMultiComponent = this.selectedComponentIds.size >= 2 && this.activeActionName === pending.actionName;
    const componentIdsToExecute = isMultiComponent
        ? Array.from(this.selectedComponentIds)
        : [];

    // Clear selections to prevent duplicate execution
    this._clearAllSelections();
    this.updateActionList();

    // Execute with captured state
    if (isMultiComponent) {
        this._executeMultiComponentSpatial(
            pending.actionName, pending.entityId,
            componentIdsToExecute,
            { targetX, targetY }
        );
    } else {
        this.actions.moveToTarget(pending.actionName, pending.entityId, targetX, targetY);
    }
}
```

## Prevention

When handling async user interactions, always capture state before modifying it. Clear triggers (pending actions) before state mutations to prevent stale state from triggering duplicate actions.

## References

- Related wiki: `wiki/subMDs/client_action_execution.md`
- Related controller: `ClientApp`