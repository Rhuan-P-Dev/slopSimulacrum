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

In `App.js`, the `_updateNavActionsPanelIfOpen()` method checked for `this.navActions._overlay`, which is always `undefined`. The NavActionsPanel class stores the overlay reference in `this.overlay` (not `this._overlay`).

The property mismatch (`_overlay` vs `overlay`) caused the function to always return early, preventing the panel from being re-rendered when selections changed.

## Fix

The visibility check was corrected to reference the panel's actual public property (`overlay` instead of the non-existent `_overlay`), so the guard passes when the panel is open and the panel is updated in real time when selections change.

## Prevention

When integrating UI components, verify that property names match the component's public API. Use JSDoc `@public` tags to document accessible properties.

## References
- NavActionsPanel.js: exposes the overlay via the public `overlay` property
- SelectionController.js: `buildCrossMap()` builds the cross-action state