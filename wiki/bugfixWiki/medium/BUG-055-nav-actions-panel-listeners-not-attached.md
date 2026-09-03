# BUG-055: NavActionsPanel Navigation Buttons Non-Functional (Listeners Never Attached)

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `public/js/NavActionsPanel.js` (lines 43-65, 171-182)

## Symptoms

- Clicking navigation buttons (e.g., "Go Entrance Hall") in the 👍 Nav/Actions panel does nothing
- No network requests are sent when clicking nav buttons
- The room never changes even when connections exist

## Root Cause

The `_attachNavListeners()` method was defined in `NavActionsPanel.js` but **never called** after the panel rendered. The `show()` method built the navigation buttons but did not invoke `_attachNavListeners()` to attach the click handlers, so the buttons existed without behavior. Additionally, the `toggle()` method did not accept or pass the `onActionClick` callback.

## Fix

**File:** `public/js/NavActionsPanel.js` — after DOM rendering, the panel now attaches both the navigation and action click listeners, and `show()`/`toggle()` accept an `onActionClick` callback so clicks are forwarded to the caller instead of dying in the panel.

## Prevention

1. **Verify listener attachment**: After building DOM elements, always verify that event listeners are attached
2. **Test interactivity**: Include interaction tests in addition to rendering tests
3. **Use consistent patterns**: Ensure all panel classes follow the same init/show/render/listeners pattern

## References
- Related wiki: `wiki/subMDs/client_ui.md`
- Related manager: `NavActionsPanel`, `ConfigBarManager`, `ActionExecutor`
- Server route: `src/routes/worldRoutes.js` (POST /move-entity)