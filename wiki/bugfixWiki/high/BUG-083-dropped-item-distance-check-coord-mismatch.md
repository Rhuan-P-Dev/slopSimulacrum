# BUG-083: Drop Item Distance Check Fails — Droid Spatial vs SVG ViewBox Coordinate Mismatch

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/ActionExecutor.js` (lines 239-261)

## Symptoms

When dropping an item, the client shows:
```
[ClientErrorController] [DROP_OUT_OF_RANGE] An unknown system error occurred.
[ActionExecutor] Drop out of range: distance=458, range=53
```

The item is stored on the server with correct coordinates, but the drop fails the client-side range check. The distance calculation produces `458` when the range is only `53`.

## Root Cause

The distance check in `ActionExecutor.executeDropItem()` compared `targetX/targetY` (room-space SVG viewBox coordinates) against `droid.spatial.x/y` (canvas-relative offsets).

### Coordinate System Mismatch

| Coordinate | System | Reference Point | Example |
|------------|--------|-----------------|---------|
| `targetX/targetY` (SVG click) | Room-space | SVG viewBox origin (0, 0) | `150` |
| `droid.spatial.x/y` | Canvas-relative | Canvas center (400, 250) | `-5` |

### Math Breakdown

With droid at `spatial.x = -5`, `spatial.y = 3` in the start room (0, 0), user clicking SVG at `(150, 200)`:
```
OLD: distance = sqrt((150 - (-5))² + (200 - 3)²) = sqrt(155² + 197²) = sqrt(61409) ≈ 248
```

The 458 in the error log suggests even more extreme coordinate differences due to additional offsets.

## Fix

Convert droid's canvas-relative spatial position to room-space before comparison:
```javascript
droid room-space = (room.x + room.width/2 + spatial.x, room.y + room.height/2 + spatial.y)
```

The conversion accounts for:
1. Room origin on the SVG map: `room.x, room.y`
2. Room center offset: `room.width/2, room.height/2`
3. Droid offset within room: `spatial.x, spatial.y`

**Fallback:** If room not found in state, falls back to using `spatial.x/y` directly (preserving existing behavior for edge cases).

## Prevention

- Always ensure coordinate comparison uses the same coordinate system
- Document coordinate systems clearly in method JSDoc comments
- When comparing positions across different UI elements (game canvas vs world map), apply appropriate transformations

## References
- Related wiki: `wiki/subMDs/systems/world_map_pickup.md`
- Related controller: `ActionExecutor`, `UIManager`, `WorldMapView`