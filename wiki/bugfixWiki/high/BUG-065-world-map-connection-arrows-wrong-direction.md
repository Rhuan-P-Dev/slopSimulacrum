# BUG-065: World Map Connection Arrows Drawn with Wrong Direction (Center-to-Center Instead of Edge-to-Edge)

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `current_branch`
- **Related Files**: `public/js/WorldMapView.js` (lines 206-280), `public/js/RoomConnectionRenderer.js`

## Symptoms

On the world map overlay (🌐 button), connection arrows between rooms point from the **center** of one room to the **center** of another room, instead of from the **edge** of the source room to the **edge** of the target room. This makes arrows overlap room rectangles and appear visually incorrect. Users cannot click arrows to navigate.

## Root Cause

Three coordinate system mismatches caused arrows to render in wrong positions:

1. **The two renderers used different bases for the current room** — `_renderRoom()` centers the current room rect at the viewport center regardless of data coordinates, but `RoomConnectionRenderer` included `room.x`/`room.y` in its center calculations, so the connection renderer drew the current room from a different origin.

2. **Target room coordinates were absolute instead of relative** — target rooms were placed in absolute data coordinates rather than relative to the current room, so the direction vector was wrong.

3. **`_getEdgePoint()` clamping used the wrong coordinate space** — clamping used data coordinates (`room.x`/`room.y`) instead of SVG-space offsets, so edge points were clamped against the wrong bounds.
4. **Edge determination used strict `>` instead of `>=`** — tie cases (horizontal/vertical connections) hit corners instead of edges.

## Fix

Both renderers now agree on a single coordinate space: the current room center is computed the same way the room renderer draws it (viewport-centered, ignoring `room.x`/`room.y`), and all other rooms are positioned relative to the current room. Edge-point clamping moved to SVG-space bounds, and the edge-determination comparison changed from `>` to `>=` so horizontal/vertical tie cases resolve to an edge instead of a corner. Why: two renderers drawing the same visual element must share one coordinate space — the pre-fix mismatch (data coordinates vs. SVG coordinates) is exactly what made the arrows overlap room rectangles.

## Prevention

- When multiple components render the same visual element, establish a single source of truth for rendering.
- Ensure edge determination uses `>=` consistently across all renderers (RoomConnectionRenderer.js and WorldMapView.js) to handle horizontal/vertical connection tie cases.
- Always use `pointer-events: stroke` for SVG lines that need click interaction.
- Use invisible hit-area elements (wider stroke, zero opacity) for reliable click detection on thin SVG lines.

## References

- Related wiki: `wiki/subMDs/world_map.md`, `wiki/subMDs/movement_system.md`
- Related controller: `WorldMapView`, `RoomConnectionRenderer`, `UIManager`