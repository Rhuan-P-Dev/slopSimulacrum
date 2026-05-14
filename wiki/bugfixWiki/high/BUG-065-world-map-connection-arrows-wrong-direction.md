# BUG-065: World Map Connection Arrows Drawn with Wrong Direction (Center-to-Center Instead of Edge-to-Edge)

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `current_branch`
- **Related Files**: `public/js/WorldMapView.js` (lines 206-280), `public/js/RoomConnectionRenderer.js`

## Symptoms

On the world map overlay (🌐 button), connection arrows between rooms point from the **center** of one room to the **center** of another room, instead of from the **edge** of the source room to the **edge** of the target room. This makes arrows overlap room rectangles and appear visually incorrect. Users cannot click arrows to navigate.

## Root Cause

Three coordinate system mismatches caused arrows to render in wrong positions:

1. **`_renderRoom()` ignores `room.x`/`room.y`** — it centers the current room rect at `(CENTER_X, CENTER_Y)` regardless of data coordinates. But `RoomConnectionRenderer` included `room.x`/`room.y` in its center calculations, making the current room's SVG center at `(CENTER_X + room.x, CENTER_Y + room.y)`.

2. **Target room coordinates were absolute instead of relative** — `targetCX = offsetX + targetRoom.x + width/2` used absolute data coordinates, not relative to the current room. This meant the direction vector was wrong.

3. **`_getEdgePoint()` clamping used wrong coordinate space** — clamping used `room.x`/`room.y` (data coords) instead of `offsetX`/`offsetY` (SVG coords).
4. **Edge determination used strict `>` instead of `>=`** — tie cases (horizontal/vertical connections) hit corners instead of edges.

### Code Before Fix (inconsistent coordinates):
```javascript
// _renderRoom() — centers at viewport center, ignores room.x/room.y
const roomX = AppConfig.VIEW.CENTER_X - room.width / 2;

// RoomConnectionRenderer — included room.x/room.y
const roomCX = offsetX + room.x + room.width / 2;  // = 275 + 400 + 125 = 800!
const targetCX = offsetX + targetRoom.x + targetRoom.width / 2;  // = 275 + 0 + 150 = 425
// Clamping: edgeX = Math.max(offsetX + room.x, ...) — wrong base!
```

### Code After Fix (consistent coordinates):
```javascript
// Current room: no room.x/room.y (matches _renderRoom)
const roomCX = offsetX + room.width / 2;  // = 275 + 125 = 400

// Target room: relative to current room
const targetCX = offsetX + (targetRoom.x - room.x) + targetRoom.width / 2;  // = 275 + (0-400) + 150 = 25

// Edge point uses same relative coordinates
const otherCX = offsetX + (otherRoom.x - room.x) + otherRoom.width / 2;

// Clamping: SVG-space bounds
edgeX = Math.max(offsetX, Math.min(offsetX + room.width, edgeX));
```

## Fix

1. **`renderRoomConnections()`**: Calculates `offsetX = CENTER_X - room.width / 2` to match `_renderRoom()`.

2. **`_drawConnection()`**: Current room center excludes `room.x/room.y`. Target room uses relative coordinates `(targetRoom.x - room.x)`. Added `targetOffsetX/Y` for end-point clamping.

3. **`_getEdgePoint()` in RoomConnectionRenderer.js**: Uses `(otherRoom.x - room.x)` for relative positioning. Uses `offsetX/offsetY` (not `offsetX + room.x`) for clamping. Changed `>` to `>=` in edge determination to handle tie cases correctly.

## Prevention

- When multiple components render the same visual element, establish a single source of truth for rendering.
- Ensure edge determination uses `>=` consistently across all renderers (RoomConnectionRenderer.js and WorldMapView.js) to handle horizontal/vertical connection tie cases.
- Always use `pointer-events: stroke` for SVG lines that need click interaction.
- Use invisible hit-area elements (wider stroke, zero opacity) for reliable click detection on thin SVG lines.

## References

- Related wiki: `wiki/subMDs/world_map.md`, `wiki/subMDs/movement_system.md`
- Related controller: `WorldMapView`, `RoomConnectionRenderer`, `UIManager`