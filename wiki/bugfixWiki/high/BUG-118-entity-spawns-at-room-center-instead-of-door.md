# BUG-118: Entity Spawns at Room Center Instead of Door Position on World Map Navigation

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: —
- **Related Files**: `public/js/App.js` (lines 62, 241, 258), `public/js/WorldMapView.js` (line 286)

## Symptoms

When clicking on a world map connection arrow to navigate to another room, the entity spawns at the room center `(0, 0)` instead of appearing at the door position of the target room. This breaks the expected door-to-door traversal behavior, making navigation feel disconnected from the visual door positions.

## Root Cause

The `doorName` parameter was dropped at multiple points in the client-side data flow chain between the world map click handler and the move execution. While `RoomConnectionRenderer` correctly passed the door through its callback, the downstream wrappers and handlers in `App.js` and `WorldMapView.js` failed to forward the door argument through the complete chain.

The server's `moveEntity()` method relies on `options.sourceDoor` to determine whether to call `getSpawnPositionForDoorTraversal()`. When the door value arrives as `undefined`, the server falls back to the room center as the spawn position. The issue was not in the renderer itself, but in the intermediate layers that consumed the renderer's output without preserving the door data.

Specifically, four points in the data flow failed to pass the door argument:
- The WorldMapView callback wrapper in the App constructor discarded the `door` parameter from the callback signature
- The bidirectional connection click handler in WorldMapView passed the door but the receiving callback was not wired to accept it
- Both the unrestricted and in-range code paths in `_handleDoorClick()` were not forwarding `doorName` to `executeMoveDroid()`

## Fix

The `doorName` argument was restored at every broken link in the client-side chain — the `onRoomClick` callback wrapper in the `App.js` constructor, the bidirectional connection click handler in `WorldMapView.js` (which now forwards `conn.door`), and both movement branches (unrestricted and in-range) of `_handleDoorClick()`. Passing the door through every layer is deliberate: the server needs accurate source-door information to compute the spawn position next to the target room's door instead of defaulting to the room center.

## Prevention

- Verify that callback signatures match across the entire data flow chain, from the initial event source through all intermediate wrappers to the final consumer.
- When adding parameters to a callback, audit all layers that wrap or forward that callback to ensure the new parameter is propagated.
- Treat missing data at the server as a signal that a client-side data flow gap exists, not as a server-side validation issue.

## References

- Related wiki: `wiki/subMDs/systems/movement_system.md`
- Related controllers: `ActionExecutor`, `WorldStateManager`
