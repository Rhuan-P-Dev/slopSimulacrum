# BUG-118: Entity Spawns at Room Center Instead of Door Position on World Map Navigation

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: —
- **Related Files**: `public/js/RoomConnectionRenderer.js` (lines 196, 201, 206)

## Symptoms

When clicking on a world map connection arrow to navigate to another room, the entity spawns at the room center `(0, 0)` instead of appearing at the door's top position of the target room. This breaks the expected door-to-door traversal behavior, making navigation feel disconnected from the visual door positions.

## Root Cause

The `_drawCurvedConnection()` method in `RoomConnectionRenderer.js` received the `door` parameter from the connection data but never passed it to the `onConnectionClick` callback. Since all rooms in the project use bidirectional connections (which exclusively use `_drawCurvedConnection()`), the `door` was always `undefined` when reaching the server.

The server's `moveEntity()` method checks `if (options.sourceDoor)` to decide whether to call `getSpawnPositionForDoorTraversal()`. With a falsy `sourceDoor`, it falls back to spawning at the room center `(0, 0)`.

This is a data flow gap: the door information existed in the renderer's scope but was dropped before being sent to the navigation handler. The `_drawStraightConnection()` method already passed the `door` correctly, but bidirectional connections use the curved path, leaving the door data stranded.

## Fix

Added `door` as the third argument to all `onConnectionClick` calls in `_drawCurvedConnection()` at lines 196, 201, and 206. This matches the callback signature pattern already established in `_drawStraightConnection()`.

## Prevention

- Ensure callback signatures are consistent across similar methods (straight vs. curved connection drawing).
- When a method receives data intended for downstream consumers, verify the data is actually forwarded.
- Add parameter validation in navigation handlers to detect when expected door data is missing.

## References

- Related wiki: `wiki/subMDs/systems/movement_system.md`
- Related controller: `RoomConnectionRenderer`, `WorldStateController`
