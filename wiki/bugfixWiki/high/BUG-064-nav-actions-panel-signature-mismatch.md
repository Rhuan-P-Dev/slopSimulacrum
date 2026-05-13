# BUG-064: NavActionsPanel "function is not iterable" error after navigation refactor

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: —
- **Related Files**: `public/js/App.js` (lines 325-335), `public/js/NavActionsPanel.js` (lines 115-130, 165-180)

## Symptoms

```
TypeError: function is not iterable (cannot read property Symbol(Symbol.iterator))
    at new Set (<anonymous>)
    at NavActionsPanel._buildActionSection (NavActionsPanel.js:174:52)
    at NavActionsPanel.updateRoom (NavActionsPanel.js:121:22)
    at ClientApp._updateNavActionsPanelIfOpen (App.js:331:25)
```

Also: `TypeError: this._onActionClick is not a function`

## Root Cause

After removing the navigation section from NavActionsPanel, `App.js._updateNavActionsPanelIfOpen()` still passed `room` as the first argument to `updateRoom()`. The new signature expects `actions` first. This caused:

1. `room` (Object) → passed as `actions` (OK)
2. `this.availableActions` (Object) → passed as `entityId` (string) → OK
3. Callback function → passed as `onActionClick` (OK)
4. `this.worldState.getMyEntityId()` → passed as `activeActionName` (string|null) → OK
5. `callback function` → passed as `selectedComponentIds` → **FAIL**: `new Set(function)` throws

## Fix

1. Removed `room` parameter from `App.js._updateNavActionsPanelIfOpen()` call
2. Added defensive type checking in `NavActionsPanel._buildActionSection()`:
   ```javascript
   const selectedSet = selectedComponentIds instanceof Set
       ? selectedComponentIds
       : new Set(selectedComponentIds || []);
   ```

## Prevention

When changing method signatures, audit ALL call sites. Add defensive type checks for Set/Map parameters.

## References
- Related wiki: `wiki/subMDs/world_map.md`
- Related controller: `NavActionsPanel`, `ClientApp`