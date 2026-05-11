# BUG-061: Stat Bar Shows 0% After Adding (updateAll() Not Called)

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/StatBarsManager.js`

## Symptoms

After adding a stat bar via the "➕ Add Stat" dialog (e.g., "Mind.think_level" of a component), the bar appears in the stat bar section but shows 0% and never updates. The user can select the component, trait, and stat correctly, but the bar remains at 0% with value "0 / 5".

## Root Cause

The `updateAll()` method in `StatBarsManager` is only called during `refreshWorldAndActions()`, which happens on:
- Initial page load (via `ClientApp.init()` → `refreshWorldAndActions()`)
- `incarnate` socket event
- `world-state-update` socket event (after actions/moves)

**After adding a stat bar via the dialog, `refreshWorldAndActions()` is never called**, so `updateAll()` is never triggered. The bar is created visually via `_renderAllBars()` but its fill value is never updated.

## Fix

Modified three methods in `StatBarsManager.js` to immediately call `updateAll()` after bar manipulation:

### 1. `addBar()` - Immediately update bar value after creation
```javascript
addBar(trait, stat, max, color, label, componentId) {
    // ... existing bar creation code ...
    this._bars.set(barId, barConfig);
    this._ensureContainer();
    this._renderAllBars();
    // Immediately update bar value with current state
    const state = this._worldStateManager.getState();
    if (state) {
        this.updateAll(state);
    }
    return barId;
}
```

### 2. `removeBar()` - Update remaining bars after removal
```javascript
removeBar(barId) {
    this._bars.delete(barId);
    this._renderAllBars();
    // Update remaining bars with current state
    const state = this._worldStateManager.getState();
    if (state) {
        this.updateAll(state);
    }
}
```

### 3. `editBar()` - Update bar values after edits
```javascript
editBar(barId, updates) {
    // ... existing edit code ...
    this._renderAllBars();
    // Update bar values with current state after edits
    const state = this._worldStateManager.getState();
    if (state) {
        this.updateAll(state);
    }
}
```

## Prevention

When modifying stat bars dynamically (add/remove/edit), always ensure `updateAll()` is called to set the initial value. The `updateAll()` method should be called:
1. After `addBar()` - to set the initial bar fill
2. After `removeBar()` - to update remaining bars
3. After `editBar()` - to refresh bar values after config changes

## References
- Related wiki: `wiki/subMDs/client_ui.md`
- Related controller: `StatBarsManager`