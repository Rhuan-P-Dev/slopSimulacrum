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

### 1. App.js — onSelectionChange() now updates NavActionsPanel

```javascript
// BEFORE: onSelectionChange() — only updated UIManager panel
onSelectionChange() {
    this.updateActionList();
    // NavActionsPanel never updated!
    ...
}

// AFTER: onSelectionChange() — updates BOTH panels
onSelectionChange() {
    this.updateActionList();
    this._updateNavActionsPanelIfOpen();  // ← NEW: re-renders NavActionsPanel with fresh data
    ...
}
```

### 2. NavActionsPanel.js — Added `onGrayedComponentClick` parameter and handler

```javascript
// Added private properties
this._onGrayedComponentClick = null;
this._crossActionSelections = null;

// Updated _attachActionListeners() to detect and handle grayed components
_attachActionListeners() {
    const componentToActionMap = new Map();
    if (this._crossActionSelections) {
        for (const [actionName, compSet] of this._crossActionSelections) {
            for (const compId of compSet) {
                componentToActionMap.set(compId, actionName);
            }
        }
    }

    this._content.querySelectorAll('.nav-component-row').forEach((row) => {
        row.onclick = () => {
            const componentId = row.dataset.compId;
            const grayedByAction = componentToActionMap.get(componentId);

            // If grayed (locked to another action), handle conflict resolution
            if (grayedByAction && this._onGrayedComponentClick) {
                this._onGrayedComponentClick(grayedByAction, componentId);
                return;
            }

            // Normal toggle for non-grayed capable components
            if (canExecute) {
                this._onActionClick(actionName, entityId, componentId, componentIdentifier);
            }
        };
    });
}
```

### 3. SelectionController.js — Clean stale entries when switching actions

```javascript
// BEFORE: no stale entry cleanup
if (this.activeActionName && this.activeActionName !== actionName) {
    if (this.selectedComponentIds.size > 0) {
        this.crossActionSelections.set(this.activeActionName, new Set(this.selectedComponentIds));
    }
    this.selectedComponentIds.clear();
    this.activeActionName = actionName;
}

// AFTER: stale entry cleanup added
if (this.activeActionName && this.activeActionName !== actionName) {
    if (this.selectedComponentIds.size > 0) {
        this.crossActionSelections.set(this.activeActionName, new Set(this.selectedComponentIds));
    }
    this.selectedComponentIds.clear();
    this.crossActionSelections.delete(actionName);  // ← NEW: clear stale entries
    this.activeActionName = actionName;
}
```

### 4. App.js — Wire grayed component callback through ConfigBarManager

```javascript
this.configBar = new ConfigBarManager({
    onGetSelectionState: () => ({
        activeActionName: this.selection.getActiveActionName(),
        selectedComponentIds: this.selection.getSelectedComponentIds(),
        crossActionSelections: this.selection.crossActionSelections
    }),
    onGrayedComponentCallback: (lockedActionName, componentId) => {
        this.selection.removeGrayedComponent(lockedActionName, componentId);
    },
});
```

### 5. ConfigBarManager.js — Accept and propagate callbacks

```javascript
constructor(options) {
    this._onGetSelectionState = options.onGetSelectionState || null;
    this._onGrayedComponentCallback = options.onGrayedComponentCallback || null;
}
```

## Data Flow After Fix

```
User clicks component for "dash" action
  → SelectionController.toggleComponent() updates selection state
  → app.onSelectionChange() called
  → updateActionList() updates UIManager panel
  → _updateNavActionsPanelIfOpen() updates NavActionsPanel ← KEY FIX
  → NavActionsPanel shows:
     - Selected component highlighted green in "dash" row
     - Same component grayed out in all other action rows

User clicks grayed component in NavActionsPanel
  → _attachActionListeners detects grayed state via componentToActionMap
  → calls _onGrayedComponentClick(lockedActionName, componentId)
  → SelectionController.removeGrayedComponent(lockedActionName, componentId)
  → Removes from crossActionSelections
  → app.onSelectionChange() → NavActionsPanel re-renders
  → Component is now available in its original action
```

## Prevention

1. **Always wire click handlers for all interactive UI states**: When adding visual indicators (like grayed/locked), ensure the corresponding click handler exists.
2. **Clean stale cross-action state on action switch**: When an action becomes active, remove any stale entries from `crossActionSelections` for that action.
3. **Update ALL UI panels on selection change**: When selection state changes, ensure all panels that display selection state are updated — not just one.
4. **Test rapid action switching**: Verify A→B→A transitions don't leave stale entries.

## References
- Related wiki: `wiki/subMDs/component_selection.md`
- Related controllers: `SelectionController`, `NavActionsPanel`, `ActionSelectController`