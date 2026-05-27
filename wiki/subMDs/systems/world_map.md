# World Map System

## Architecture

The world map system has two distinct components:

1. **Spatial Map (`#world-map`)** — In-game room-level map showing the current room, entities, components, and dropped items. Rendered in `UIManager.js` via `renderDroppedItemsOnSpatialMap()`.

2. **World Map Overlay (`#world-map-svg`)** — Full-screen overlay showing ALL rooms as nodes with connections. Managed by `WorldMapView.js`. No longer renders dropped items (moved to spatial map).

## Dropped Items Rendering

Dropped items are rendered on the **spatial map** (`#world-map`) via `UIManager.renderDroppedItemsOnSpatialMap()`, not on the world map overlay. This follows the Single Responsibility Principle — the spatial map is responsible for showing all entities and items within the current context.

**Data flow:**
- Server: `WorldStateController.getDroppedItems()` → `getAll()` includes dropped items in broadcast
- Socket: `world-state-update` event delivers dropped items to client
- Client: `App.refreshWorldAndActions()` → `UIManager.renderDroppedItemsOnSpatialMap()` renders items on spatial map
- Click: `UIManager.renderDroppedItemsOnSpatialMap()` callback → `App._handleDroppedItemClick()` → opens pick-up overlay

See also: [World Map Pick-Up System](world_map_pickup.md)

## 1. Overview

Two levels of spatial visualization exist to serve different cognitive needs:

- **In-room connection arrows**: Directional arrows on the spatial map showing adjacent rooms — supports navigation without leaving the current view
- **Full world map overlay**: Toggleable overlay showing all rooms as nodes — supports strategic planning and long-distance navigation

## 2. Design Rationale

### Why Spatial Visualization Is Decoupled

The room graph data lives on the server, but rendering is delegated to the client. This separation exists because:

- **Server is the source of truth**: Room connections are authoritative game state; rendering is a presentation concern
- **Multiple visualizations**: The same graph data can support different renderers (spatial map, world overlay, mini-map)
- **Network efficiency**: The server sends the graph once; the client handles all pan/zoom/interaction locally

### Why Room Graph Is Server-Side

The world graph builder constructs the room connectivity graph from `data/rooms.json` on the server. This exists because:

- **Consistency**: All clients receive the same graph, preventing visual desynchronization
- **Validation**: Room connections can be validated server-side before being exposed to clients
- **Single source**: The graph is derived from room data, not duplicated in a separate format

## 3. CSS Architecture

Room connection elements use CSS classes for styling. The class names follow a consistent pattern: `.room-connection-*` for in-map arrows and `.world-map-*` for the overlay.