# BUG-109: Knife Not Selected When Clicked in ⚔️ Actions Panel for "cut" Action

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: commit unknown
- **Related Files**: `src/controllers/core/HoldingCostController.js`, `src/routes/worldRoutes.js`, `src/services/WorldStateBroadcastService.js`

## Symptoms

When the user clicks on the knife item row under the "cut" action in the ⚔️ Actions panel:
- The knife row does NOT get a green highlight (selection state not shown)
- The action is NOT selected for cutting
- No console errors appear
- The click appears to silently do nothing

Console output shows: `[App DEBUG] → getEquippedItem: null`, `[App DEBUG] → Early exit: equippedItem not found`, `[App DEBUG] → entity.equipped: none`, `[App DEBUG] → state.entities[entityId]: {hasEquipped: false, keys: Array(8)}`.

## Root Cause

Three issues in the data flow chain caused this bug:

### Issue 1: HoldingCostController Missing `getAll()` Method

`WorldStateController.getAll()` aggregates global state by calling each sub-controller's `getAll()`. `holdingCostController` was registered in `subControllers` but **did not implement a `getAll()` method**, so `holdingCost` was never included in the global state and `worldState.holdingCost._equippedItems` was always undefined.

### Issue 2: _transformForBroadcast() Had Nothing to Transform

`WorldStateBroadcastService._transformForBroadcast()` only populates `entity.equipped` when `holdingCost._equippedItems` is present. Since `holdingCost` was never in the world state, that block was skipped and `entity.equipped` was never populated.

### Issue 3: HTTP /world-state Endpoint Bypassed Transformation (Partially Fixed Earlier)

The `/world-state` HTTP endpoint (used by `WorldStateManager.fetchState()`) was fixed in a previous attempt to call `_transformForBroadcast()`, but that fix was ineffective because the underlying data (`holdingCost._equippedItems`) still didn't exist.

## Fix

### Fix: Add `getAll()` to HoldingCostController

Added a `getAll()` method to `HoldingCostController` that exposes the equipped items data in the shape the broadcast transform expects, so holding cost is included in the global world state. Rationale: sub-controllers are only visible to the broadcast pipeline through their `getAll()` output — a registered controller without one is silently invisible.

### Why This Works

With `holdingCost` present in the global state, the broadcast transform populates `entity.equipped`, the client's state lookup finds the item, and the click handler proceeds to selection as designed.

## Prevention

1. **All sub-controllers in `WorldStateController.subControllers` must implement `getAll()`** — otherwise their data is silently excluded from the global state.
2. **Test the full data flow chain**: controller data → `getAll()` aggregation → broadcast transformation → client state lookup.
3. **Add integration tests for equipped item interactions** — test the full click → state lookup → selection flow.

## References
- Related wiki: `wiki/subMDs/controllers/controller_patterns.md`
- Related controller: `HoldingCostController`, `WorldStateController`, `ComponentCapabilityController`
- Related action: `cut` (data/actions.json)
- Related system: Component capability cache for equipped items (ComponentCapabilityController._scanEquippedItemsForActions)