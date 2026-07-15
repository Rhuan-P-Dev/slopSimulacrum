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

Restored the `doorName` argument through the complete client-side data flow chain by ensuring each layer in the call chain passes the door parameter to the next:

1. **WorldMapView callback wrapper (`App.js`)** — The constructor callback for `onRoomClick` now includes the `door` argument so the door value reaches the navigation handler.
2. **Bidirectional click handler (`WorldMapView.js`)** — The click listener on curved connection paths passes `conn.door` to the room click callback, ensuring bidirectional connections carry door data.
3. **Unrestricted movement path (`App.js`)** — The `_handleDoorClick()` method's unrestricted branch (when movement range is null) now passes `doorName` to `executeMoveDroid()`.
4. **In-range movement path (`App.js`)** — The `_handleDoorClick()` method's in-range branch now passes `doorName` to `executeMoveDroid()`.

The design decision to pass the door through every layer of the client-side flow ensures the server receives accurate source door information, allowing it to compute the correct spawn position near the target room's door rather than defaulting to the room center.

## Prevention

- Verify that callback signatures match across the entire data flow chain, from the initial event source through all intermediate wrappers to the final consumer.
- When adding parameters to a callback, audit all layers that wrap or forward that callback to ensure the new parameter is propagated.
- Treat missing data at the server as a signal that a client-side data flow gap exists, not as a server-side validation issue.

## References

- Related wiki: `wiki/subMDs/systems/movement_system.md`
- Related controllers: `ActionExecutor`, `WorldStateManager`
