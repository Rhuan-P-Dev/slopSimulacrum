# BUG-082: Dropped Items Render Off-Screen — SVG Coordinate Mismatch

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/EventDispatcher.js` (lines 127-144)

## Symptoms

After dropping an item, the server log shows valid coordinates:
```
ℹ️ INFO: [DropItemHandler] Dropped item "knife" (item-11) at (-11.36, -42.61).
```

But the blue square marker does not appear on the world map. The item is stored correctly in `_droppedItems` but renders at incorrect positions (or off-screen) because client-side click coordinates were transformed incorrectly.

## Root Cause

The `setupMapClickListener()` method in `EventDispatcher.js` applied a **center-relative coordinate offset** to drop item coordinates:

```javascript
// BEFORE (broken):
const targetX = svgP.x - this.config.VIEW.CENTER_X;  // 800/2 = 400
const targetY = svgP.y - this.config.VIEW.CENTER_Y;  // 500/2 = 250
```

This produces coordinates like `(-11.36, -42.61)` which are relative to an 800×500 canvas center — but the **SVG world map viewBox uses room-space coordinates directly** (rooms at `x=0..1220, y=0..470`).

When `_renderDroppedItems()` applies `offsetX/offsetY` (calculated from room bounds), the dropped items end up at completely wrong positions:
```
item.x + offsetX = -11.36 + 100 = 88.64    (way off from room at x=0+)
item.y + offsetY = -42.61 + 100 = 57.39   (way off from room at y=0+)
```

## Fix

Use raw SVG viewBox coordinates (room-space) for drop item clicks, without subtracting CENTER_X/Y:

```javascript
// AFTER (fixed):
const targetX = svgP.x;  // Raw SVG viewBox coordinate = room-space
const targetY = svgP.y;  // Raw SVG viewBox coordinate = room-space
```

This ensures dropped item coordinates match the same room-space coordinate system that `_renderDroppedItems()` expects.

**Note:** The center-relative coordinates are still used for spatial targeting (move/dash) and component targeting (punch), which operate on the main game canvas where the `(CENTER_X + spatial.x, CENTER_Y + spatial.y)` rendering convention applies. Only drop item clicks on the SVG world map need raw room-space coordinates.

## Prevention

- Document the coordinate systems used by each subsystem clearly
- World Map SVG → room-space coordinates (0-based, positive, matches room definitions)
- Game Canvas → center-relative coordinates (center at CENTER_X/CENTER_Y)
- When converting screen coordinates, verify the target coordinate system matches the consumer's expectations

## References
- Related wiki: `wiki/subMDs/systems/world_map_pickup.md`
- Related controller: `WorldMapView`, `EventDispatcher`, `DropItemHandler`