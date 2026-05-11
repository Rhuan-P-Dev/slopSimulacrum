# BUG-057: NavActionsPanel Missing Multi-Component Selection UI

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/NavActionsPanel.js`, `public/js/App.js`, `public/js/ConfigBarManager.js`, `public/css/actions.css`

## Symptoms

1. **Navigation display not updated after room change**: When the user navigates to a new room via the NavActionsPanel, the panel continues showing the old room's name, description, connections, and actions. The panel content becomes stale until manually toggled closed and reopened.

2. **No multi-component selection in NavActionsPanel**: Action items in the NavActionsPanel were rendered as plain text spans. Clicking an action item immediately executed the action with the first capable component — no multi-component selection was possible, no visual highlighting of selected components, and no indication of locked components.

3. **No visual feedback for cross-action conflicts**: Components selected in other actions were not highlighted or grayed out in the NavActionsPanel, making it impossible for users to see which components were locked to which actions.

## Root Cause

1. **Navigation**: `NavActionsPanel` had no `updateRoom()` method. The `show()` method only rendered on initial display. When `refreshWorldAndActions()` was called after a room change, it updated UIManager and the action list but never updated the NavActionsPanel content.

2. **Selection UI**: `_buildActionSection()` rendered actions as flat text lists with non-interactive spans. `_attachActionListeners()` executed actions immediately on click rather than toggling component selection. No selection state parameters were passed to the nav panel.

3. **ConfigBarManager**: `_onNavActionsClick()` always called `show()` regardless of whether the panel was already open, preventing content updates.

## Fix

### 1. Added `updateRoom()` method to `NavActionsPanel.js`

```javascript
updateRoom(room, actions, entityId, onNavClick, onActionClick, activeActionName, selectedComponentIds, crossActionSelections) {
    // Re-renders panel content without closing the overlay
    // Re-attaches DOM listeners after innerHTML replacement
}
```

### 2. Rewrote `_buildActionSection()` for multi-component selection

- Renders interactive component rows with CSS classes: `nav-component-row`, `nav-selected`, `nav-locked`
- Builds `componentToActionMap` for cross-action conflict detection
- Displays lock icons (🔒) with tooltips on locked components
- Highlights active action with `nav-active` class (yellow border)
- Shows capable/incapable component counts

### 3. Rewrote `_attachActionListeners()` for selection toggle

- Click on component row → calls `_onActionClick(actionName, entityId, compId, compIdentifier)` to toggle selection
- Does NOT auto-execute on component click
- Only allows toggling capable components (`canExecute === 'true'`)

### 4. Updated `App.js` with `_updateNavActionsPanelIfOpen()`

Called after `refreshWorldAndActions()` and `updateActionList()` to keep the panel in sync when open.

### 5. Updated `ConfigBarManager._onNavActionsClick()`

Checks `isPanelOpen` state:
- Panel open → calls `updateRoom()` instead of `show()`
- Panel closed → calls `show()` as before

### 6. Added CSS styles to `actions.css`

- `.nav-action-item` — panel action container
- `.nav-action-name` — action name header (hoverable)
- `.nav-component-row` — interactive component row
- `.nav-component-row.nav-selected` — green highlight for selected
- `.nav-component-row.nav-locked` — grayed out with red tint for locked
- `.nav-lock-icon` — lock icon
- `.nav-comp-type` / `.nav-comp-identifier` — component labels
- `.nav-capable-count` — capability count badge
- `.nav-action-item.nav-active` — active action yellow highlight

## Prevention

- When adding new panel methods that modify displayed content, ensure there's both a `show()` (initial render) and an `updateRoom()` or similar (refresh) method.
- After any `innerHTML` replacement in a panel, re-attach DOM listeners.
- Pass selection state parameters through panel methods for consistent UI rendering.
- Test panel content updates after navigation without closing/reopening the panel.

## References

- Related wiki: `wiki/subMDs/client_ui.md`
- Related wiki: `wiki/subMDs/action_system.md`
- Related controller: `NavActionsPanel`
- Related controller: `SelectionController`
- Related bug: [BUG-016](low/BUG-016-ui-selection-state.md) — UI Selection State (previous selection highlighting fix)
- Related bug: [BUG-055](medium/BUG-055-nav-actions-panel-listeners-not-attached.md) — NavActionsPanel listeners not attached
- Related bug: [BUG-056](medium/BUG-056-action-execution-callback-missing.md) — Action execution callback missing