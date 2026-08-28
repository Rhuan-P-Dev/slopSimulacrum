# BUG-114: Dash durability loss targets wrong component

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: —
- **Related Files**: `public/js/EventDispatcher.js` (lines ~90-110), `public/js/ActionManager.js` (lines ~80-95), `public/js/App.js` (lines ~70-75)

## Symptoms
When using `droidRollingBall` right to dash, the `droidRollingBall` left component loses 5 durability instead of the right one. The client correctly selects the right component, but the server drains durability from the left (first) component.

## Root Cause
A race condition in the spatial action execution flow lost the selected component ID before it reached the server: `EventDispatcher._handleSpatialClick()` captured the pending action (with the correct `componentId`) but immediately cleared all selections before calling `moveToTarget()`, so `ActionManager.moveToTarget()` re-read the already-cleared global state, got `null`, and the request arrived without a `targetComponentId`. The server's `ConsequenceDispatcher._resolveTargetForConsequence()` then fell back to `fulfillingComponents`, which defaults to the first available component (left).

## Fix
The captured `pending` object is now passed directly through the call chain (`EventDispatcher` → `App.js` callback → `ActionManager.moveToTarget()`, which accepts it as an optional parameter and falls back to `getPendingAction()` for backward compatibility) instead of re-reading the already-cleared global state — context must travel with the event, not be retrieved from shared state that is mutated mid-flow.

## Prevention
- Avoid relying on global state that is cleared mid-asynchronous flow.
- Capture required context at the event trigger point and pass it down the call stack.
- Use defensive fallbacks (`pending || this.getPendingAction()`) to prevent silent null-reference bugs.

## References
- Related wiki: `wiki/subMDs/frontend/client_action_execution.md`
- Related controller: `ActionManager`, `EventDispatcher`, `ConsequenceDispatcher`
