# BUG-060: "➕ Add Stat" dialog not related to any entity component

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `uncommitted`
- **Related Files**: `public/js/StatBarsManager.js`, `public/js/ComponentViewer.js`, `public/js/ConfigBarManager.js`, `public/index.html`, `public/css/components.css`

## Symptoms

When clicking the "➕ Add Stat" button in the config bar, the dialog opened with only Trait and Stat dropdowns. The traits/stats came from ALL components combined in the active droid, making it impossible for the user to select which specific component's stats to add. The user had no way to pick a specific component.

## Root Cause

The "➕ Add Stat" feature was implemented as a global action not tied to any specific component:
- `ConfigBarManager._onAddStatClick()` called `StatBarsManager.openAddDialog()` with no component context
- `StatBarsManager.getAvailableTraitsAndStats()` scanned ALL components in `state.components.instances`
- The dialog had no component selector - only trait and stat dropdowns
- No component ID was stored in the `StatBarConfig`

## Fix

### 1. Added component selector dropdown to the dialog (`public/index.html`)
```html
<div class="form-group">
    <label for="add-stat-component-select">Component:</label>
    <select id="add-stat-component-select">
        <option value="">-- Select Component --</option>
    </select>
</div>
```

### 2. Updated StatBarsManager to populate component dropdown (`public/js/StatBarsManager.js`)
- Added `_populateTraitsForComponent()` - populates trait/stat dropdowns for a specific component
- Added `_populateTraitsAllComponents()` - legacy behavior when no component selected
- Added `_populateStatsFromTrait()` - populates stat dropdown for selected trait
- Updated `openAddDialog()` to populate component dropdown from active entity's components
- Updated `_confirmAddStat()` to read componentId from the dropdown at confirm time

### 3. Added ➕ button on each component card (`public/js/ComponentViewer.js`)
- Added "➕" button to each component card header
- Clicking the button opens the dialog pre-filtered to that component's traits/stats
- Added `_onAddStatFromComponent()` handler
- Added `_lastComponentId` tracking and `getActiveComponentId()` method

### 4. Updated ConfigBarManager to pass component context (`public/js/ConfigBarManager.js`)
- `_onAddStatClick()` now tries to get component from ComponentViewer or SelectionController
- Passes `{ componentId }` to `openAddDialog()`

### 5. Added CSS styles (`public/css/components.css`)
```css
.component-card-header { display: flex; align-items: center; margin-bottom: 6px; }
.component-add-stat-btn { background: var(--neon-green); color: var(--bg-black); ... }
```

## Prevention

When implementing UI features that interact with entity components, always ensure:
1. The UI provides a way to select which component to interact with
2. Component context is passed through the entire call chain
3. Stat bars store `componentId` for proper lookup during updates

## References
- Related wiki: `wiki/subMDs/client_ui.md`
- Related controllers: `ConfigBarManager`, `StatBarsManager`, `ComponentViewer`