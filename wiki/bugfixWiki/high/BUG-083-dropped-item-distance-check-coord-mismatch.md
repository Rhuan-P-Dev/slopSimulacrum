# BUG-083: Drop Item Distance Check Fails — Droid Spatial vs SVG ViewBox Coordinate Mismatch

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `public/js/ActionExecutor.js` (lines 239-261)

## Symptoms

When dropping an item, the client shows `[ClientErrorController] [DROP_OUT_OF_RANGE] An unknown system error occurred.` and `[ActionExecutor] Drop out of range: distance=458, range=53`. The item is stored on the server with correct coordinates, but the drop fails the client-side range check — the computed distance is an order of magnitude larger than the allowed range.

## Root Cause

The distance check in `ActionExecutor.executeDropItem()` compared two values from different coordinate systems: `targetX/targetY` are room-space SVG viewBox coordinates (referenced to the viewBox origin), while `droid.spatial.x/y` are canvas-relative offsets (referenced to the canvas center). Comparing them directly makes the distance meaningless, so even a click next to the droid reads as hundreds of units away.

### Coordinate System Mismatch

| Coordinate | System | Reference Point |
|------------|--------|-----------------|
| `targetX/targetY` (SVG click) | Room-space | SVG viewBox origin (0, 0) |
| `droid.spatial.x/y` | Canvas-relative | Canvas center |

## Fix

The droid's canvas-relative spatial position is converted to room-space before comparison, so both operands share one coordinate system. Why: a range check is only valid when both endpoints live in the same space; converting at the comparison site (rather than changing what the client stores) keeps the fix local to the drop flow. **Fallback:** if the room is not found in state, the raw `spatial.x/y` values are used directly, preserving existing behavior for edge cases.

## Prevention

- Always ensure coordinate comparison uses the same coordinate system
- Document coordinate systems clearly in method JSDoc comments
- When comparing positions across different UI elements (game canvas vs world map), apply appropriate transformations

## References
- Related wiki: `wiki/subMDs/systems/world_map_pickup.md`
- Related controller: `ActionExecutor`, `UIManager`, `WorldMapView`