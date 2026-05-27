# BUG-087: `getComponent` Missing from WorldStateController — Pick-Up Returns 500

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/WorldStateController.js`, `src/controllers/consequences/PickUpItemHandler.js`

## Symptoms

After fixing BUG-086 (property name mismatch), attempting to pick up a dropped item results in:

```
POST http://localhost:3000/pick-up-item 500 (Internal Server Error)
[ClientErrorController] [PICKUP_FAILED] Internal Server Error
```

Server-side error:
```
ERROR: /pick-up-item endpoint error | Context: {"error":"this.componentController.getComponent is not a function","entityId":"...","droppedItemId":"dropped-...","componentId":"..."}
```

## Root Cause

`PickUpItemHandler.js` at **line 62** calls:

```javascript
const component = worldStateController.getComponent(componentId);
```

However, `WorldStateController` did not have a `getComponent(componentId)` method. The previous implementation (BUG-086 fix) added `executePickUpItem()` but the existing `getComponent()` method at that time delegated to `this.componentController.getComponent(componentId)`, which also doesn't exist — `ComponentController` only provides `getComponentStats(instanceId)` and `getComponentDefinition(componentType)`.

Component data (with `id`, `type`, `traits`) is stored in `stateEntityController.entities[entityId].components[]` — an array embedded in each entity object. There was no public API to look up a component by its instance ID across all entities.

## Fix

Added a proper `getComponent(componentId)` method to `WorldStateController` that searches through all active entities' component arrays:

```javascript
/**
 * Retrieves a component by its instance ID, searching across all active entities.
 * Returns a defensive copy to prevent external mutation of internal state.
 */
getComponent(componentId) {
    const allEntities = this.stateEntityController.getAll();
    for (const [, entity] of Object.entries(allEntities)) {
        if (Array.isArray(entity.components)) {
            const component = entity.components.find(c => c.id === componentId);
            if (component) {
                return { ...component, entityId: entity.id };
            }
        }
    }
    return null;
}
```

Key design points:
- Uses `stateEntityController.getAll()` to access all active entities
- Iterates through each entity's `components[]` array looking for matching `id`
- Returns a **defensive copy** (`{ ...component, entityId: entity.id }`) — includes the `entityId` field needed by PickUpItemHandler's ownership check (`component.entityId !== entityId` on line 68)
- Returns `null` if not found, allowing PickUpItemHandler to produce a proper error message

## Prevention

1. **Component lookup is now a public API** — other parts of the codebase can use `worldStateController.getComponent(componentId)` for component lookups.
2. **Defensive copying** prevents external mutation of internal entity component data.
3. If component data structure changes in the future, this method centralizes the lookup logic in one place.

## References

- Related bug: [BUG-086](BUG-086-pickup-item-direct-consequence-handler-access-wrong-prop-name.md) — Previous fix for property name mismatch in `/pick-up-item`
- Related wiki: [Inventory System](../../subMDs/data/inventory_system.md)
- Related controller: `PickUpItemHandler`, `stateEntityController`