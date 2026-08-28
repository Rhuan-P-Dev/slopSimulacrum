# BUG-066: Map Connection Arrows Not Clickable (CSS pointer-events: none Blocks All Interaction)

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/css/navigation.css` (lines 143-157), `public/js/WorldMapView.js` (lines 330-395), `public/js/RoomConnectionRenderer.js`

## Symptoms

Users cannot click on connection arrows/lines on either the spatial map (current room view) or the world map overlay to navigate between rooms. Clicking on a connection line always starts panning the map instead of triggering room navigation. The arrows are purely decorative — no click handler exists and CSS explicitly blocks pointer events.

## Root Cause

Three independent issues prevented clicking on map connections:

### 1. CSS `pointer-events: none` Blocks All Clicks

The connection lines and arrowheads in `public/css/navigation.css` were styled with `pointer-events: none`, which made the elements completely ignore all mouse events, including clicks.

### 2. No Click Handlers on Connection Elements

Neither `WorldMapView._drawConnection()` nor `RoomConnectionRenderer._drawConnection()` attached any event listeners to the connection `<line>` or `<polyline>` elements. The elements were purely visual with no interactive behavior.

### 3. Pan/Mousedown Handler Captures All Clicks

The SVG canvas `mousedown` handler in `WorldMapView._setupPanZoom()` started panning immediately on every left mousedown, including clicks on room nodes and connection lines, so the `click` event never had a chance to fire on interactive elements. There was also no `mouseup`/movement threshold to distinguish short clicks from drag pans.

## Fix

Addressed all three causes:

### 1. CSS: Enable pointer-events on connections (`navigation.css`)

Connection lines and arrowheads now receive pointer events and show hover affordance (line thickens, arrow brightens), so users get visible feedback that they are interactive.

### 2. WorldMapView: Skip panning on interactive elements + add click handler

The pan handler now checks the mousedown target and skips panning when it is a room node or a connection element, and a small movement threshold before panning starts distinguishes short clicks from drag pans. Connection lines got a click handler via a wide, invisible hit-area line: thin SVG strokes are unreliable click targets, so an invisible, wider, zero-opacity stroke provides a dependable hit area.

### 3. RoomConnectionRenderer: Add click handler + callback parameter

The renderer now accepts an optional connection-click callback and entity ID, and draws an invisible wide hit-area line (spatial map) that invokes the callback with the target room ID. The world map overlay instead attaches pointer events directly on the visible connection line with a click handler — it does not use a separate hit-area line.

### 4. UIManager: Wire click handler through

`UIManager` now passes the move callback and the entity ID through to the connection renderer, so a connection click triggers room navigation for that entity.

## Prevention

- Never use `pointer-events: none` on elements that need to be interactive.
- Always attach explicit click handlers to SVG elements that represent interactive targets.
- When using pan/drag handlers on SVG canvases, check `e.target.className` to skip interactive elements.
- Use a movement threshold (e.g., 3px) to distinguish clicks from drag pans.
- Use invisible hit-area elements (wider stroke, zero opacity) for reliable click detection on thin SVG lines.

## References

- Related wiki: `wiki/subMDs/world_map.md`, `wiki/subMDs/movement_system.md`
- Related controller: `WorldMapView`, `RoomConnectionRenderer`, `UIManager`
