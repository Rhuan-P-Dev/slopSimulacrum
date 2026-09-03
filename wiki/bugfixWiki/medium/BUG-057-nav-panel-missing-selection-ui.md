# BUG-057: NavActionsPanel Missing Multi-Component Selection UI

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
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

### 1. Added `updateRoom()` refresh method to `NavActionsPanel.js`

Re-renders the panel content without closing the overlay, so an open panel can be refreshed in place.

### 2. Rewrote the action section for multi-component selection

Action items now render interactive component rows that support multi-selection, with visual states for selected and locked components, lock icons with tooltips, highlighting of the active action, and capable/incapable component counts — including cross-action conflict detection.

### 3. Rewrote action click handling for selection toggle

Clicking a component row now toggles its selection (no auto-execution on click), limited to capable components.

### 4. `App.js` keeps the open panel in sync

When world state or the action list is refreshed, the panel is updated while open so its content never goes stale after a room change.

### 5. `ConfigBarManager` refreshes an already-open panel

Clicking the nav/actions button while the panel is open refreshes its content instead of only (re)showing the panel.

### 6. Added the selection-UI styles to `actions.css`

Styles for the new component rows and their selected/locked/active visual states were added so the selection state is legible at a glance.

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