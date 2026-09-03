# BUG-087: `getComponent` Missing from WorldStateController — Pick-Up Returns 500

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `src/controllers/WorldStateController.js`, `src/controllers/consequences/PickUpItemHandler.js`

## Symptoms

After fixing BUG-086 (property name mismatch), attempting to pick up a dropped item results in a **500 Internal Server Error** (`[ClientErrorController] [PICKUP_FAILED] Internal Server Error`), with the server logging `this.componentController.getComponent is not a function`.

## Root Cause

`PickUpItemHandler.js` calls `worldStateController.getComponent(componentId)`, but `WorldStateController` did not have a `getComponent(componentId)` method. The previous implementation (BUG-086 fix) added `executePickUpItem()`, but the `getComponent()` that existed at the time delegated to `this.componentController.getComponent(componentId)` — which also doesn't exist; `ComponentController` only provides stat and definition lookups, not instance lookups. Component data (with `id`, `type`, `traits`) is stored in per-entity `components[]` arrays inside `stateEntityController`, and there was no public API to look up a component by instance ID across all entities.

## Fix

Added a proper `getComponent(componentId)` method to `WorldStateController` that searches all active entities' component arrays for a matching instance ID. Key design rationale:

- Returns a **defensive copy** (per the defensive-copying standard) — and enriches it with the owning `entityId`, because the pick-up handler's ownership check needs to know which entity owns the component
- Returns `null` when not found, so the handler can produce a proper error message instead of crashing
- Centralizes the cross-entity lookup in one public method, so if the component data structure changes, only this one place needs to change

## Prevention

1. **Component lookup is now a public API** — other parts of the codebase can use `worldStateController.getComponent(componentId)` for component lookups.
2. **Defensive copying** prevents external mutation of internal entity component data.
3. If component data structure changes in the future, this method centralizes the lookup logic in one place.

## References

- Related bug: [BUG-086](BUG-086-pickup-item-direct-consequence-handler-access-wrong-prop-name.md) — Previous fix for property name mismatch in `/pick-up-item`
- Related wiki: [Inventory System](../../subMDs/data/inventory_system.md)
- Related controller: `PickUpItemHandler`, `stateEntityController`