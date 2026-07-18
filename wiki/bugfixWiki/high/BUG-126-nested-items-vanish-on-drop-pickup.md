# BUG-126: Nested Items Vanish When Container is Dropped and Picked Up

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: Current implementation
- **Related Files**: `src/utils/InventoryManager.js`, `src/controllers/consequences/DropItemHandler.js`, `src/controllers/consequences/PickUpItemHandler.js`

## Symptoms
When a container item (e.g., metal box with 5 knives inside) is dropped from inventory onto the ground and then picked up again, the container is restored but all nested items (knives) are gone.

## Root Cause
When a container item was dropped, `_removeItemAndDescendants()` permanently deleted all nested items from `entity.items`. The dropped item record stored only the container — no nested items were preserved. When the container was picked up, `PickUpItemHandler` only re-added the container, with no knowledge of the destroyed nested items.

## Fix
Three changes were made:

1. **[`src/utils/InventoryManager.js`](src/utils/InventoryManager.js:471)** — Added `_collectNestedItems(entity, parentId)` method that collects all direct and indirect nested items from a container without modifying the inventory. Returns a defensive deep copy with circular reference prevention.

2. **[`src/controllers/consequences/DropItemHandler.js`](src/controllers/consequences/DropItemHandler.js:82)** — Before removing the container, collects all nested items using `_collectNestedItems()` and stores them in the `nestedItems` field of the dropped item record.

3. **[`src/controllers/consequences/PickUpItemHandler.js`](src/controllers/consequences/PickUpItemHandler.js:136)** — After re-adding the container to the entity, iterates through `droppedItem.nestedItems` and re-adds each nested item into the container using `addItemToContainer()`.

## Prevention
When implementing any system that removes items which may contain nested items, always collect and preserve nested items before removal. Dropped item records should track nested items to enable restoration on pickup.

## Edge Cases Handled
- Non-container items: `nestedItems` will be `[]`
- Old dropped items (no `nestedItems` field): Falls back to `[]` via `||`
- Container too full on pickup: Failed nested item restores are logged as warnings, container still picked up
- Circular references: Prevented by `visited` set in `_collectNestedItems()`
