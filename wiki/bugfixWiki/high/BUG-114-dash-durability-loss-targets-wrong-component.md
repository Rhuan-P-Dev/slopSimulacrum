# BUG-114: Dash durability loss targets wrong component

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: —
- **Related Files**: `public/js/EventDispatcher.js` (lines ~90-110), `public/js/ActionManager.js` (lines ~80-95), `public/js/App.js` (lines ~70-75)

## Symptoms
When using `droidRollingBall` right to dash, the `droidRollingBall` left component loses 5 durability instead of the right one. The client correctly selects the right component, but the server drains durability from the left (first) component.

## Root Cause
A race condition in the spatial action execution flow caused the selected component ID to be lost before reaching the server:
1. User clicks a component → `SelectionController.toggleComponent()` → `ActionManager._handleTargetingSelection()` sets `pendingMovementAction` with the correct `componentId`.
2. User clicks the map → `EventDispatcher._handleSpatialClick()` captures `pending` (containing the correct component ID).
3. `_handleSpatialClick()` immediately calls `this.handlers._clearAllSelections()`, which triggers `this.actions.clearPendingAction()`, setting `pendingMovementAction` to `null`.
4. `_handleSpatialClick()` then calls `this.handlers.moveToTarget()`.
5. `ActionManager.moveToTarget()` calls `this.getPendingAction()` to retrieve `pending?.componentId`, but since it was just cleared, it returns `null`.
6. `targetComponentId` becomes `undefined`, causing the server's `ConsequenceDispatcher._resolveTargetForConsequence()` to fall back to `fulfillingComponents`, which defaults to the first available component (left).

## Fix
Modified the spatial click execution flow to pass the captured `pending` object directly to `moveToTarget`, bypassing the now-cleared global state:
1. `EventDispatcher._handleSpatialClick()` now passes `pending` as a 5th argument to `moveToTarget`.
2. `App.js` dispatcher callback forwards the `pending` parameter.
3. `ActionManager.moveToTarget()` accepts `pending` as an optional 5th parameter and uses it if provided, falling back to `getPendingAction()` for backward compatibility.

```javascript
// EventDispatcher.js
_handleSpatialClick(pending, targetX, targetY) {
    // ...
    this.handlers._clearAllSelections?.();
    // ...
    if (this.handlers.moveToTarget) {
        this.handlers.moveToTarget(pending.actionName, pending.entityId, targetX, targetY, pending);
    }
}

// ActionManager.js
async moveToTarget(actionName, entityId, targetX, targetY, pending = null) {
    const effectivePending = pending || this.getPendingAction();
    // ...
    params: { targetComponentId: effectivePending?.componentId, ... }
}
```

## Prevention
- Avoid relying on global state that is cleared mid-asynchronous flow.
- Capture required context at the event trigger point and pass it down the call stack.
- Use defensive fallbacks (`pending || this.getPendingAction()`) to prevent silent null-reference bugs.

## References
- Related wiki: `wiki/subMDs/frontend/client_action_execution.md`
- Related controller: `ActionManager`, `EventDispatcher`, `ConsequenceDispatcher`
