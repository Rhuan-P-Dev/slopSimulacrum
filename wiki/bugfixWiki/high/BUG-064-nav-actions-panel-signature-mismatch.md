# BUG-064: NavActionsPanel "function is not iterable" error after navigation refactor

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: —
- **Related Files**: `public/js/App.js` (lines 325-335), `public/js/NavActionsPanel.js` (lines 115-130, 165-180)

## Symptoms

`TypeError: function is not iterable (cannot read property Symbol(Symbol.iterator))` thrown from `NavActionsPanel._buildActionSection` via `NavActionsPanel.updateRoom` and `ClientApp._updateNavActionsPanelIfOpen`. Also: `TypeError: this._onActionClick is not a function`.

## Root Cause

After the navigation refactor changed `updateRoom()`'s signature (actions first), the call site in `App.js._updateNavActionsPanelIfOpen()` was not updated and kept passing the old argument list. The arguments shifted positions, so a trailing callback function landed where a `selectedComponentIds` set was expected, and `new Set()` on a function throws because a function is not iterable.

## Fix

1. Removed the stale `room` argument from the call site so its arguments match the new signature.
2. Added defensive normalization of the selected-component argument in `NavActionsPanel._buildActionSection()`. Why: the panel should not crash with an opaque iterator error when a caller passes a non-Set value; normalizing it makes future caller/panel signature drift degrade gracefully instead of breaking the whole panel.

## Prevention

When changing method signatures, audit ALL call sites. Add defensive type checks for Set/Map parameters.

## References
- Related wiki: `wiki/subMDs/world_map.md`
- Related controller: `NavActionsPanel`, `ClientApp`