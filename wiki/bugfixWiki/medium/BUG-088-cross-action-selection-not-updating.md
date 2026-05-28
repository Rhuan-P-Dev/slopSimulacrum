# BUG-088: Cross-Action Component Graying Not Updating in Real-Time

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/App.js` (line 382)

## Symptoms

When a user clicks a component to select it for an action:
- The selected component correctly turns **green** in the current action
- The same component does **NOT** appear grayed out in other action lists
- The gray-out only appears after closing and reopening the NavActionsPanel

## Root Cause

In `App.js` line 382, the `_updateNavActionsPanelIfOpen()` method checked for `this.navActions._overlay` which is always `undefined`. The NavActionsPanel class stores the overlay reference in `this.overlay` (not `this._overlay`).

```javascript
// BEFORE (buggy)
_updateNavActionsPanelIfOpen() {
    if (!this.navActions._overlay || this.navActions._overlay.style.display !== 'block') {
        return;  // Always returns here because _overlay is undefined
    }
    // ... never reached
}

// AFTER (fixed)
_updateNavActionsPanelIfOpen() {
    if (!this.navActions.overlay || this.navActions.overlay.style.display !== 'block') {
        return;
    }
    // ... now proceeds to update the panel
}
```

The property mismatch (`_overlay` vs `overlay`) caused the function to always return early, preventing `navActions.updateRoom()` from being called when selections changed.

## Fix

Changed `this.navActions._overlay` to `this.navActions.overlay` in `App.js` line 382. This single-character fix (`_overlay` → `overlay`) ensures the method correctly checks if the panel is visible and proceeds to update it.

## Prevention

When integrating UI components, verify that property names match the component's public API. Use JSDoc `@public` tags to document accessible properties.

## References
- NavActionsPanel.js: declares `this.overlay = null` (line 29) and sets it in `init()` (line 50)
- SelectionController.js: `buildCrossMap()` builds the cross-action state
- actions.css: `.nav-selected` (green) and `.nav-locked` (gray) CSS classes