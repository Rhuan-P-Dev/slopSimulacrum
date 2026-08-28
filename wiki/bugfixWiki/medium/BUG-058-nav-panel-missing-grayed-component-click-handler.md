# BUG-058: NavActionsPanel Missing Grayed Component Click Handler and Stale Cross-Action State

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/NavActionsPanel.js`, `public/js/SelectionController.js`, `public/js/App.js`, `public/js/ConfigBarManager.js`

## Symptoms

When selecting a component for action "dash" (e.g., `droidRollingBall (right)`), the component was NOT highlighted green in the "dash" action row, and the same component did NOT appear grayed out in other actions like "move", "punch", or "selfHeal".

However, `selfHeal` (which has `targetingType: 'self_target'`) worked correctly — components were highlighted and grayed out properly across actions.

The root cause was that `onSelectionChange()` only called `updateActionList()` which updates the legacy UIManager action panel, but **did NOT update the NavActionsPanel**. Since the NavActionsPanel is the primary UI for action/component selection, users never saw selection highlighting or cross-action graying.

Additionally, when rapidly switching between actions (A → B → A), stale entries could remain in the `crossActionSelections` map, causing components to appear grayed in their own action even though they were actively selected there.

## Root Cause

Three root causes:

1. **NavActionsPanel._attachActionListeners() did not handle grayed component clicks**: The listener only called `_onActionClick` for capable components. Grayed components were never processed because there was no `onGrayedComponentClick` callback wired up.

2. **SelectionController.toggleComponent() did not clean stale cross-action entries**: When switching from action A to action B, the current selections moved to `crossActionSelections` for A. But if the user then switched back to A, `crossActionSelections` still had the old entry for A.

3. **App.onSelectionChange() did NOT update NavActionsPanel**: After `toggleComponent()` updated selection state, `onSelectionChange()` only called `updateActionList()` (which updates the legacy UIManager panel). The NavActionsPanel was never re-rendered with fresh cross-action selection data, so users never saw highlights or grayed components.

## Fix

### 1. App.js — `onSelectionChange()` now updates NavActionsPanel

Selection changes now refresh the NavActionsPanel in addition to the legacy action list, so the primary UI immediately reflects highlights and cross-action graying.

### 2. NavActionsPanel.js — grayed components are now clickable

The panel accepts an `onGrayedComponentClick` callback: clicking a component grayed out (locked to another action) triggers conflict resolution — releasing it from the other action — instead of being silently ignored.

### 3. SelectionController.js — stale cross-action entries are cleaned up

When an action becomes active, any stale entry for that action in `crossActionSelections` is removed, so A→B→A switching no longer leaves components appearing locked to their own active action.

### 4. App.js + ConfigBarManager.js — callbacks wired through the manager

`ConfigBarManager` now accepts a selection-state provider and a grayed-component callback, and `App.js` supplies them, so a click on a grayed component can actually reach `SelectionController` to clear the lock.

## Prevention

1. **Always wire click handlers for all interactive UI states**: When adding visual indicators (like grayed/locked), ensure the corresponding click handler exists.
2. **Clean stale cross-action state on action switch**: When an action becomes active, remove any stale entries from `crossActionSelections` for that action.
3. **Update ALL UI panels on selection change**: When selection state changes, ensure all panels that display selection state are updated — not just one.
4. **Test rapid action switching**: Verify A→B→A transitions don't leave stale entries.

## References
- Related wiki: `wiki/subMDs/component_selection.md`
- Related controllers: `SelectionController`, `NavActionsPanel`, `ActionSelectController`