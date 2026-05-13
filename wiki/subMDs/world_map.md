# 🌐 World Map System

## 1. Overview
The World Map system provides two levels of spatial visualization:
1. **In-room connection arrows**: Directional arrows on the spatial map showing connections to adjacent rooms, labeled with the destination room name.
2. **Full world map overlay**: A 🌐-toggled overlay showing ALL rooms as nodes with connection edges, pan/zoom support, and the current room highlighted.

## 2. Server-Side Architecture

### 2.1. WorldGraphBuilder
**File:** `src/utils/WorldGraphBuilder.js`

A pure utility class that constructs a navigable graph structure from room data:
- Takes a rooms object from `RoomsController.getAll()`
- Builds an internal `roomsById` Map and `roomOrder` array via `_buildIndex()`
- Resolves connection door names to destination room names
- Returns a defensive copy via `structuredClone()`

**Data structure:**
```json
{
  "rooms": [
    {
      "id": "uid-xxx",
      "name": "The Entrance Hall",
      "x": 200, "y": 250, "width": 300, "height": 200,
      "connections": [
        { "door": "right_door", "targetId": "uid-yyy", "targetName": "The Eastern Corridor" }
      ]
    }
  ]
}
```

**Private Methods:**
| Method | Description |
|--------|-------------|
| `_buildIndex()` | Creates a reverse lookup map from room IDs to room data; populates `roomsById` Map and `roomOrder` array |

**Constructor Validation:**
- Throws `TypeError` if rooms parameter is null, undefined, or not an object

### 2.2. API Endpoint
**File:** `src/routes/worldRoutes.js`

New endpoint: `GET /world-map`
- Calls `WorldStateController.getWorldGraph()`
- Returns the world graph JSON

### 2.3. WorldStateController
**File:** `src/controllers/WorldStateController.js`

New method: `getWorldGraph()`
- Instantiates `WorldGraphBuilder` with rooms data
- Returns the built graph

## 3. Client-Side Architecture

### 3.1. Room Connection Arrows (In-Map)
**File:** `public/js/RoomConnectionRenderer.js`

Static utility class that draws SVG arrows between the current room and connected rooms:
- Edge-to-edge line calculation based on room coordinates
- Arrowhead at the destination edge
- Label at midpoint showing `→ Destination Room Name`
- Semi-transparent dashed lines for visual clarity
- **AppConfig Dependency:** Uses `AppConfig.VIEW.CENTER_X` and `AppConfig.VIEW.CENTER_Y` to offset room coordinates for SVG viewBox positioning

**Methods:**
| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `renderRoomConnections(room, rooms, roomLayer)` | `Object room`, `Object rooms`, `SVGElement roomLayer` | `void` | Renders connection lines, arrowheads, and labels for all connections of the given room |

**Private Methods:**
| Method | Description |
|--------|-------------|
| `_drawConnection(room, targetRoom, door, offsetX, offsetY, layer)` | Draws a single connection with line, arrowhead, and label |
| `_drawArrowhead(startX, startY, endX, endY, layer)` | Draws a 3-point polyline arrowhead at the destination edge, oriented toward the incoming line direction |
| `_getEdgePoint(room, otherRoom, roomCX, roomCY)` | Calculates the edge point on a room's boundary toward another room |

**Integration:** Called from `UIManager.renderRoomConnections()` which is invoked from `UIManager.updateWorldView()`.

### 3.2. World Map Overlay
**File:** `public/js/WorldMapView.js`

Full-screen overlay with interactive SVG world map:
- Fetches data from `GET /world-map` endpoint
- Renders all rooms as labeled rectangles on an SVG canvas
- Draws directed connection arrows with door name labels
- Highlights the current room with neon-green border + glow filter
- Supports pan (drag) and zoom (mouse wheel) for large maps
- Clicking a room node moves the droid there via `_handleWorldMapRoomClick()` in App.js
- **AppConfig Dependency:** Uses `AppConfig.VIEW.CENTER_X` and `AppConfig.VIEW.CENTER_Y` for viewBox coordinate transformation

**Constructor:**
```javascript
constructor(deps = {}) {
    this._onRoomClick = deps.onRoomClick || null;
    this._overlay = null;
    this._svg = null;
    this._mapGroup = null;
    this._worldData = null;
    this._currentRoomId = null;
    // Pan/zoom state
    this._panX = 0;
    this._panY = 0;
    this._scale = 1;
    this._isPanning = false;
    this._lastMouseX = 0;
    this._lastMouseY = 0;
}
```

**Dependency Injection:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `deps.onRoomClick` | `Function` | Callback when a room node is clicked (receives `roomId`) |

**Public Methods:**
| Method | Returns | Description |
|--------|---------|-------------|
| `init()` | `void` | Initialize DOM references (`#world-map-overlay`) |
| `fetchAndRender()` | `Promise<boolean>` | Fetches data from `GET /world-map` and prepares world data. Returns `true` if successful. |
| `setCurrentRoomId(roomId)` | `void` | Sets the current room ID for highlighting |
| `show()` | `Promise<void>` | Fetches data and renders the overlay. Displays as flex. |
| `hide()` | `void` | Hides the overlay (sets display to 'none') |
| `toggle()` | `void` | Toggles overlay visibility |

**Private Methods:**
| Method | Description |
|--------|-------------|
| `_renderMap()` | Renders the full SVG world map: calculates bounds for auto-scaling, creates SVG with `<defs>` for arrow markers, draws connections then room nodes, sets up pan/zoom |
| `_drawConnection(group, room, conn, allRooms)` | Draws a single connection: edge-to-edge line with dashed stroke, SVG arrow marker, door name label at midpoint |
| `_drawRoomNode(group, room)` | Draws a room rectangle with name label. Current room gets neon-green border, glow filter, and higher opacity. Non-current rooms get dim border. Click handler wired to `_onRoomClick` callback. |
| `_getEdgePoint(room, otherRoom, roomCX, roomCY)` | Calculates the edge point on a room's boundary toward another room (same logic as RoomConnectionRenderer but without center offset) |
| `_setupPanZoom(svg, group)` | Sets up pan (mousedown + mousemove + mouseup) and zoom (wheel event) interactions. Pan modifies the `transform` attribute; zoom adjusts the SVG `viewBox` |

**SVG Rendering Details:**
- **Arrow Marker:** `<marker id="world-map-arrow">` defined in `<defs>` with `orient="auto"`
- **Auto-scaling:** ViewBox calculated from room bounds + 100px padding on each side
- **Transform:** Main group uses `translate(${offsetX}, ${offsetY})` to position rooms within the viewBox
- **Room Highlighting:** Current room uses `fill="rgba(0, 255, 0, 0.15)"`, `stroke="var(--neon-green)"`, `stroke-width="3"`, and `filter="url(#glow)"`

**CSS Classes Used:**
| Class | Element | Description |
|-------|---------|-------------|
| `world-map-overlay` | `#world-map-overlay` | Overlay container (flex display, z-index: 200) |
| `world-map-content` | `#world-map-content` | Content area inside overlay |
| `world-map-svg` | `#world-map-svg` | SVG element |
| `world-map-group` | `#world-map-group` | Main transform group |
| `world-map-room-node` | `.world-map-room-node` | Room rectangle node |

**Data Flow:**
1. User clicks 🌐 button → `ConfigBarManager._onWorldMapClick()` → `onToggleWorldMap` callback
2. `WorldMapView.toggle()` → calls `show()` if hidden
3. `show()` calls `fetchAndRender()` → `GET /world-map` → stores `_worldData`
4. `_renderMap()` creates SVG with rooms, connections, and pan/zoom
5. User clicks room node → `_onRoomClick(roomId)` → `App._handleWorldMapRoomClick()` → `executor.executeMoveDroid()`

### 3.3. UI Integration

**Config Bar Button:** 🌐 button (`#btn-world-map`) in `public/index.html`
- Toggled via `ConfigBarManager._onWorldMapClick()`
- Wires to `WorldMapView.toggle()` via `onToggleWorldMap` callback

**Actions Panel:** `NavActionsPanel` no longer includes navigation section
- Navigation arrows now appear on the spatial map
- Panel title changed from "👍 Navigation & Actions" to "⚔️ Actions"

## 4. Data Flow Diagram

```mermaid
graph TD
    subgraph "Server"
        RC[RoomsController] --> WGB[WorldGraphBuilder]
        WGB -->|build()| API[GET /world-map]
    end

    subgraph "Client"
        API -->|world graph JSON| WSM[WorldStateManager]
        WSM -->|state.rooms| RCR[RoomConnectionRenderer]
        WSM -->|/world-map fetch| WMV[WorldMapView]
    end

    subgraph "UI"
        RCR -->|SVG arrows| MAP[SVG Spatial Map]
        WMV -->|SVG overlay| WORLD_MAP[🌐 World Map Overlay]
    end
```

## 5. CSS Styles
**File:** `public/css/navigation.css`

- `.room-connection-line`: Dashed line for room connections
- `.room-connection-label`: Text label styling
- `.room-connection-label-bg`: Background for text readability
- `.room-connection-arrow`: Arrowhead styling
- `.world-map-room-node`: Room node hover effects
- `.world-map-overlay`: Overlay container styling

## 6. Recent Changes
| Date | Change |
|------|--------|
| 2026-05-13 | **Feature:** Added room connection arrows to spatial map and 🌐 world map overlay. Removed navigation section from NavActionsPanel. |