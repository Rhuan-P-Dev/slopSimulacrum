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

In `public/css/navigation.css` (lines 143-157):
```css
.room-connection-line {
    pointer-events: none;
}

.room-connection-arrow {
    pointer-events: none;
}
```

This CSS rule made connection lines and arrowheads completely ignore all mouse events, including clicks.

### 2. No Click Handlers on Connection Elements

Neither `WorldMapView._drawConnection()` nor `RoomConnectionRenderer._drawConnection()` attached any event listeners to the connection `<line>` or `<polyline>` elements. The elements were purely visual with no interactive behavior.

### 3. Pan/Mousedown Handler Captures All Clicks

In `WorldMapView._setupPanZoom()` (line 331):
```javascript
svg.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    this._isPanning = true;  // Always starts panning on left-click
    this._lastMouseX = e.clientX;
    this._lastMouseY = e.clientY;
    svg.style.cursor = 'grabbing';
});
```

This handler fires on ALL `mousedown` events on the SVG canvas, including clicks on room nodes and connection lines. Since it starts panning immediately, the `click` event never has a chance to fire on interactive elements. There was also no `mouseup` handler to distinguish short clicks from drag pans.

## Fix

### 1. CSS: Enable pointer-events on connections (`navigation.css`)
```css
.room-connection-line {
    pointer-events: stroke;
    cursor: pointer;
    transition: stroke-opacity 0.2s ease;
}

.room-connection-line:hover {
    stroke-opacity: 1;
    stroke-width: 3;
}

.room-connection-arrow {
    pointer-events: fill;
    cursor: pointer;
    transition: opacity 0.2s ease;
}

.room-connection-arrow:hover {
    opacity: 1;
}
```

### 2. WorldMapView: Skip panning on interactive elements + add click handler

**`_setupPanZoom()`**: Added target class checking to skip panning when clicking on room nodes or connections:
```javascript
svg.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const targetClass = e.target.className?.baseVal || '';
    if (targetClass.includes('world-map-room-node') ||
        targetClass.includes('world-map-connection-line') ||
        targetClass.includes('room-connection-line') ||
        targetClass.includes('room-connection-arrow')) {
        return;  // Skip panning for interactive elements
    }
    // ... rest of pan logic
});
```

Also added a 3-pixel movement threshold before panning starts to distinguish clicks from drags.

**`_drawConnection()`**: Added a wide transparent hit-area line with click handler:
```javascript
const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
line.setAttribute('stroke-width', '15'); // Wide hit area
line.setAttribute('opacity', '0');       // Transparent
line.style.pointerEvents = 'stroke';
line.style.cursor = 'pointer';

line.addEventListener('click', (e) => {
    e.stopPropagation();
    if (this._onRoomClick) {
        this._onRoomClick(conn.targetId);
    }
});
```

### 3. RoomConnectionRenderer: Add click handler + callback parameter

**`renderRoomConnections()`**: Added optional `onConnectionClick` and `entityId` parameters:
```javascript
static renderRoomConnections(room, rooms, roomLayer, onConnectionClick = null, entityId = null) {
    // ... passes onConnectionClick and entityId to _drawConnection
}
```

**`_drawConnection()`**: Added invisible wide hit-area line with click handler (spatial map only):
```javascript
const hitLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
hitLine.setAttribute('stroke-width', '15');
hitLine.setAttribute('opacity', '0');
hitLine.addEventListener('click', (e) => {
    e.stopPropagation();
    if (onConnectionClick) onConnectionClick(entityId, targetRoom.id);
});
```

**Note:** The hit-area line pattern is used in `RoomConnectionRenderer.js` (spatial map). The `WorldMapView.js` (world map overlay) uses inline `pointer-events: 'stroke'` directly on the connection `<line>` element with a click handler — it does not use a separate hit-area line.

### 4. UIManager: Wire click handler through

**`renderRoomConnections()`**: Now accepts and passes `onConnectionClick` and `entityId`:
```javascript
renderRoomConnections(room, rooms, onConnectionClick = null, entityId = null) {
    RoomConnectionRenderer.renderRoomConnections(room, rooms, this._currentRoomLayer, onConnectionClick, entityId);
}
```

**`updateWorldView()`**: Passes `onMoveCallback` as the connection click handler and `droid.id` as entityId:
```javascript
this.renderRoomConnections(room, state.rooms, onMoveCallback, droid?.id);
```

## Prevention

- Never use `pointer-events: none` on elements that need to be interactive.
- Always attach explicit click handlers to SVG elements that represent interactive targets.
- When using pan/drag handlers on SVG canvases, check `e.target.className` to skip interactive elements.
- Use a movement threshold (e.g., 3px) to distinguish clicks from drag pans.
- Use invisible hit-area elements (wider stroke, zero opacity) for reliable click detection on thin SVG lines.

## References

- Related wiki: `wiki/subMDs/world_map.md`, `wiki/subMDs/movement_system.md`
- Related controller: `WorldMapView`, `RoomConnectionRenderer`, `UIManager`