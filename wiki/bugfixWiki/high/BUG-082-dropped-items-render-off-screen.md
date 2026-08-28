# BUG-082: Dropped Items Render Off-Screen — SVG Coordinate Mismatch

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/EventDispatcher.js` (lines 127-144)

## Symptoms

After dropping an item, the server log shows valid coordinates (`INFO: [DropItemHandler] Dropped item "knife" (item-11) at (-11.36, -42.61).`), but the blue square marker does not appear on the world map. The item is stored correctly in `_droppedItems` but renders at incorrect positions (or off-screen) because client-side click coordinates were transformed incorrectly.

## Root Cause

The `setupMapClickListener()` method in `EventDispatcher.js` applied a **center-relative coordinate offset** (subtracting the canvas center) to drop item coordinates. That produced values relative to an 800×500 canvas center — but the **SVG world map viewBox uses room-space coordinates directly** (rooms at `x=0..1220, y=0..470`). The item was therefore stored in one coordinate space and rendered in another: when `_renderDroppedItems()` applied its room-bounds offset to center-relative values, the markers landed far away from where they were dropped (or off-screen entirely).

## Fix

Drop item clicks now use the raw SVG viewBox (room-space) coordinates, without subtracting the canvas center. Why: the coordinates are stored in the same room-space system that `_renderDroppedItems()` renders in, so storage and rendering agree on one coordinate space.

**Note:** The center-relative coordinates are still used for spatial targeting (move/dash) and component targeting (punch), which operate on the main game canvas where the `(CENTER_X + spatial.x, CENTER_Y + spatial.y)` rendering convention applies. Only drop item clicks on the SVG world map need raw room-space coordinates.

## Prevention

- Document the coordinate systems used by each subsystem clearly
- World Map SVG → room-space coordinates (0-based, positive, matches room definitions)
- Game Canvas → center-relative coordinates (center at CENTER_X/CENTER_Y)
- When converting screen coordinates, verify the target coordinate system matches the consumer's expectations

## References
- Related wiki: `wiki/subMDs/systems/world_map_pickup.md`
- Related controller: `WorldMapView`, `EventDispatcher`, `DropItemHandler`