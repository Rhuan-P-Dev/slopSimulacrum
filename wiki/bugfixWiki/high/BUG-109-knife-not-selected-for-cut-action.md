# BUG-109: Knife Not Selected When Clicked in ⚔️ Actions Panel for "cut" Action

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: pending
- **Related Files**: `src/controllers/core/HoldingCostController.js`, `src/routes/worldRoutes.js`, `src/services/WorldStateBroadcastService.js`

## Symptoms

When the user clicks on the knife item row under the "cut" action in the ⚔️ Actions panel:
- The knife row does NOT get a green highlight (selection state not shown)
- The action is NOT selected for cutting
- No console errors appear
- The click appears to silently do nothing

Console output shows:
```
[App DEBUG] → getEquippedItem: null
[App DEBUG] → Early exit: equippedItem not found
[App DEBUG] → entity.equipped: none
[App DEBUG] → state.entities[entityId]: {hasEquipped: false, keys: Array(8)}
```

## Root Cause

Three issues in the data flow chain caused this bug:

### Issue 1: HoldingCostController Missing `getAll()` Method

`WorldStateController.getAll()` (line 319-323) iterates over `this.subControllers` and calls `controller.getAll()` on each to aggregate state:

```javascript
for (const [key, controller] of Object.entries(this.subControllers)) {
    if (typeof controller.getAll === 'function') {
        globalState[key] = controller.getAll();
    }
}
```

`holdingCostController` was registered in `subControllers` but **did not implement a `getAll()` method**. This meant `holdingCost` was never included in the global state, so `worldState.holdingCost._equippedItems` was always undefined.

### Issue 2: _transformForBroadcast() Had Nothing to Transform

`WorldStateBroadcastService._transformForBroadcast()` checks `transformed.holdingCost._equippedItems` (line 87):

```javascript
if (transformed.holdingCost && transformed.holdingCost._equippedItems) {
    // Process and attach to entity.equipped
}
```

Since `holdingCost` was never in the world state, this entire block was skipped — `entity.equipped` was never populated.

### Issue 3: HTTP /world-state Endpoint Bypassed Transformation (Partially Fixed Earlier)

The `/world-state` HTTP endpoint (used by `WorldStateManager.fetchState()`) was fixed in a previous attempt to call `_transformForBroadcast()`, but that fix was ineffective because the underlying data (`holdingCost._equippedItems`) still didn't exist.

## Fix

### Fix: Add `getAll()` to HoldingCostController

Added a `getAll()` method that returns the equipped items data in the format expected by `_transformForBroadcast()`:

```javascript
/**
 * Returns the holding cost state for serialization/broadcast.
 * Called by WorldStateController.getAll() to include holding cost data
 * in the global world state. The format must match what
 * WorldStateBroadcastService._transformForBroadcast() expects:
 * holdingCost._equippedItems.
 */
getAll() {
    return {
        _equippedItems: this.getAllEquippedItems()
    };
}
```

### Why This Works

1. `WorldStateController.getAll()` now includes `holdingCost: { _equippedItems: {...} }` in the global state
2. `_transformForBroadcast()` receives this data and iterates through `_equippedItems`
3. For each entity with equipped items, `entity.equipped` is populated as an array of `{eqId, itemId, itemType, componentId}`
4. The client's `WorldStateManager.getEquippedItem(entityId, eqId)` finds the item in `entity.equipped`
5. `_handleEquippedItemClick()` proceeds to call `selection.toggleComponent()`

## Prevention

1. **All sub-controllers in `WorldStateController.subControllers` must implement `getAll()`** — otherwise their data is silently excluded from the global state.
2. **Test the full data flow chain**: controller data → `getAll()` aggregation → broadcast transformation → client state lookup.
3. **Add integration tests for equipped item interactions** — test the full click → state lookup → selection flow.

## References
- Related wiki: `wiki/subMDs/controllers/controller_patterns.md`
- Related controller: `HoldingCostController`, `WorldStateController`, `ComponentCapabilityController`
- Related action: `cut` (data/actions.json)
- Related system: Component capability cache for equipped items (ComponentCapabilityController._scanEquippedItemsForActions)