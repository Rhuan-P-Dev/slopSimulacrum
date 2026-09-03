# BUG-077: Drop Item — Map Click Silent Failure (Pending Drop Action Never Dispatched)

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `public/js/EventDispatcher.js`, `public/js/App.js`

## Symptoms

When the user clicks on an equipped item (🔪 knife icon), a red dashed circle appears showing the drop range. However, clicking within the circle does nothing — the item is never dropped.

## Root Cause

The map click handler in `EventDispatcher.setupMapClickListener()` uses `getPendingAction()` to check if there's an active targeting action. For drop items, the pending state is stored in `App._pendingDropItem` (not in `ActionManager.pendingMovementAction`), so `getPendingAction()` returns `null` and the handler exits early without ever processing the drop click.

## Fix

The map click listener now checks the pending drop state **before** the default `getPendingAction()` check: `App` injects drop-aware callbacks into `EventDispatcher`, so a map click made during drop targeting is routed to drop execution instead of being silently discarded. The drop check runs first, ensuring drop-item clicks are prioritized over regular spatial targeting.

## Prevention

When adding new targeting modes that use separate pending state (outside of `ActionManager.pendingMovementAction`), the `setupMapClickListener` callback must be updated to check and route to those states before the default `getPendingAction()` check.

## References

- Related wiki: `wiki/subMDs/frontend/client_action_execution.md`
- Related controller: `ActionManager`, `EventDispatcher`
- Related feature: `ActionExecutor.executeDropItem()`