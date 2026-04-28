# BUG-016: UI Actions Incorrectly Marked as Selected

- **Severity**: LOW
- **Status**: ✅ Fixed
- **Fixed In**: `bf19079` ("fix(ui): only mark actions as selected when currently active")
- **Related Files**: `public/js/App.js`

## Symptoms

When browsing the action list:
- Actions were marked as "selected" even when they were not currently active
- The UI showed green highlighting for actions the player hadn't selected
- Confusing visual feedback — selected state didn't match actual selection

## Root Cause

The UI selection logic in `App.js` marked an action as selected whenever its component was selected, regardless of whether that action was currently active:

```javascript
// ❌ BEFORE (buggy - marks ALL matching actions as selected)
function isActionSelected(actionName, componentId) {
    return selectedComponentIds.includes(componentId);  // Wrong!
}
```

## Fix

Changed the selection logic to only mark actions as selected when they are the currently active action:

```javascript
// ✅ AFTER (fixed - only active action is marked selected)
function isActionSelected(actionName, componentId) {
    return actionName === activeActionName && selectedComponentIds.includes(componentId);
}
```

### Selection State Rules

| Condition | UI State |
|-----------|----------|
| Action is active AND component is selected | Green highlight (selected) |
| Action is active but component not selected | Gray highlight (available) |
| Action is not active | No highlight (deselected) |

## Prevention

- UI state should always reflect actual game state
- Follow the **Single Source of Truth** principle — the game state is the source, not the UI
- Write UI tests that verify state synchronization

## References

- Related wiki: `wiki/subMDs/client_ui.md`
- Related controller: `App` (client-side)
- Git commit: `bf19079`