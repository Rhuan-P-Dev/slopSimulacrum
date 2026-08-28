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

Dropped item records now capture `roomId` from the entity's current location, so each dropped item carries its room context.

### Server: `PickUpItemHandler.js` (lines 82-88)

Pickup now validates that the entity and the item are in the same room, rejecting cross-room pickups with a warning log.

### Server: `WorldStateController.js` (lines 1007-1018)

Added a `getDroppedItemsByRoom(roomId)` query so dropped items can be fetched already filtered to a single room.

### Client: `App.js` (lines 413-419)

The spatial map renderer now filters dropped items by the droid's current room before drawing, so items from other rooms never appear.

## Prevention

- Always include room/context association (`roomId`) when storing spatial entities that should be room-scoped.
- Implement room-based filtering in client rendering logic — never render all spatial data without filtering by the droid's current location.
- Add server-side room validation in handlers that operate on spatial entities (pickup, interact, attack at position).

## References

- Related wiki: `wiki/subMDs/systems/item_drop_pickup.md`
- Related wiki: `wiki/subMDs/systems/item_positioning.md`
- Related controller: `DropItemHandler`, `PickUpItemHandler`, `WorldStateController`
