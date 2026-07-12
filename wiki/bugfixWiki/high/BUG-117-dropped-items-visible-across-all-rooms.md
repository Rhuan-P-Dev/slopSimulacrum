# BUG-117: Dropped Items Visible Across All Rooms

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: [`DropItemHandler.js`](src/controllers/consequences/DropItemHandler.js), [`WorldStateController.js`](src/controllers/WorldStateController.js), [`PickUpItemHandler.js`](src/controllers/consequences/PickUpItemHandler.js), [`App.js`](public/js/App.js)

## Symptoms

Dropped items were visible on the spatial map in all rooms, regardless of which room the item was actually dropped in. When the player moved the droid to a different room, items from other rooms would still appear on the spatial map overlay.

## Root Cause

Dropped items stored in `WorldStateController._droppedItems` had no `roomId` property associated with them. When the client rendered dropped items on the spatial map, it displayed ALL dropped items without filtering by the droid's current room (`droid.location`).

The server-side `DropItemHandler` was storing dropped item coordinates (`x`, `y`) but not the room context, and the client-side `App.js` had no room-based filtering logic when iterating over `state.droppedItems`.

## Fix

### Server: `DropItemHandler.js` (line 102)

Now captures `roomId` from the entity's current location when creating dropped items:

```javascript
droppedItems[droppedItemId] = {
    id: droppedItemId,
    itemType: usedItemType,
    itemId: itemId,
    x: targetX,
    y: targetY,
    roomId: entity.location || null,  // NEW: room association
    ownerId: entityId,
    name: itemDef.name || usedItemType,
    description: itemDef.description || '',
    volume: itemDef.volume || 1
};
```

### Server: `PickUpItemHandler.js` (lines 82-88)

Added room validation before allowing item pickup — entity and item must be in the same room:

```javascript
const entityRoomId = entity.location || null;
const itemRoomId = droppedItem.roomId || null;
if (entityRoomId !== itemRoomId) {
    Logger.warn(`[PickUpItemHandler] Entity "${entityId}" is in room "${entityRoomId}" but item "${droppedItemId}" is in room "${itemRoomId}".`);
    return { success: false, message: `Item is in a different room. Entity is in "${entityRoomId}", item is in "${itemRoomId}".` };
}
```

### Server: `WorldStateController.js` (lines 1007-1018)

Added `getDroppedItemsByRoom(roomId)` for room-filtered queries:

```javascript
getDroppedItemsByRoom(roomId) {
    if (!this._droppedItems) {
        return {};
    }
    const filtered = {};
    for (const [id, item] of Object.entries(this._droppedItems)) {
        if (item.roomId === roomId) {
            filtered[id] = item;
        }
    }
    return structuredClone(filtered);
}
```

### Client: `App.js` (lines 413-419)

Client now filters dropped items by `droid.location` before rendering on the spatial map:

```javascript
const droppedItems = state.droppedItems || {};
const currentRoom = droid.location || null;
const roomFilteredItems = {};
for (const [id, item] of Object.entries(droppedItems)) {
    if (item.roomId === currentRoom) {
        roomFilteredItems[id] = item;
    }
}
this.ui.renderDroppedItemsOnSpatialMap(roomFilteredItems, ...);
```

## Prevention

- Always include room/context association (`roomId`) when storing spatial entities that should be room-scoped.
- Implement room-based filtering in client rendering logic — never render all spatial data without filtering by the droid's current location.
- Add server-side room validation in handlers that operate on spatial entities (pickup, interact, attack at position).

## References

- Related wiki: `wiki/subMDs/systems/item_drop_pickup.md`
- Related wiki: `wiki/subMDs/systems/item_positioning.md`
- Related controller: `DropItemHandler`, `PickUpItemHandler`, `WorldStateController`
