# 🏠 RoomsController

## 1. Overview

`RoomsController` is the **State Controller** responsible for storing and managing room definitions and their connections. It serves as the single source of truth for the world's spatial data.

**File:** `src/controllers/core/RoomsController.js`

**Pattern:** State Controller (data store only, per `wiki/subMDs/controller_patterns.md` Section 4)

## 2. Architecture

### 2.1. Data Loading Pattern

Rooms are loaded from `data/rooms.json` via `DataLoader.loadJsonSafe()`, following the same data-driven design pattern used by all other game data in the project.

**Data File:** `data/rooms.json`
```json
{
  "start_room": {
    "name": "The Entrance Hall",
    "description": "A dimly lit hall. To your right, there is an open corridor.",
    "connections": {
      "right_door": "right_room"
    },
    "x": 200,
    "y": 250,
    "width": 300,
    "height": 200
  }
}
```

**Data Schema per Room:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Display name of the room (must be non-empty) |
| `description` | `string` | Yes | Room description text |
| `connections` | `Object` | Yes | Map of door names to target room logical IDs |
| `connections.<door>` | `string` | Yes | Door identifier (must be non-empty string) |
| `connections.<door>` target | `string` | Yes | Target room logical ID (references another room's key) |
| `x` | `number` | Yes | X coordinate for spatial rendering |
| `y` | `number` | Yes | Y coordinate for spatial rendering |
| `width` | `number` | Yes | Room width for spatial rendering |
| `height` | `number` | Yes | Room height for spatial rendering |

### 2.2. Internal Storage Format

After initialization, rooms are stored with generated UIDs and expanded schema:

```javascript
{
  [roomId]: {
    id: "uid-xxx",
    name: "The Entrance Hall",
    description: "A dimly lit hall...",
    connections: { right_door: "uid-yyy" },  // Logical IDs resolved to UIDs
    x: 200, y: 250, width: 300, height: 200,
    objects: [],    // Reserved for future room objects
    entities: []    // Reserved for future entity references
  }
}
```

### 2.3. ID Mapping

- **Logical IDs** (e.g., `'start_room'`) are keys in `data/rooms.json`
- **Generated UIDs** are created via `generateUID()` and stored in `this.idMap[logicalId]`
- Connections are resolved from logical IDs to UIDs during initialization

## 3. Constructor

```javascript
constructor()
```

**Behavior:**
1. Initializes empty `this.rooms` store and `this.idMap` mapping
2. Loads room definitions from `data/rooms.json` via `DataLoader.loadJsonSafe()`
3. Validates all definitions via `_validateRoomDefinitions()`
4. Generates UIDs for each logical room ID
5. Initializes room objects with expanded schema (including `objects` and `entities` arrays)
6. Resolves connection door names to target room UIDs
7. Logs initialization count via `Logger.info()`

## 4. Public Methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `getUidByLogicalId(logicalId)` | `string` logicalId | `string\|null` | Resolves a logical room name to its generated UUID |
| `getAll()` | — | `Object<string, Object>` | Returns a deep copy of all rooms (defensive copy via `structuredClone()`) |
| `getRoom(roomId)` | `string` roomId | `Object\|null` | Returns a deep copy of a specific room by UID, or null if not found |

### `getUidByLogicalId(logicalId)`

Resolves a logical room name (from `data/rooms.json`) to its generated UUID.

**Example:**
```javascript
const uid = roomsController.getUidByLogicalId('start_room');
// Returns: "a1b2c3d4-..."
```

### `getAll()`

Returns a defensive deep copy of all rooms. This prevents external mutation of internal state.

**Example:**
```javascript
const rooms = roomsController.getAll();
// rooms is a clone — modifying it does not affect internal state
```

### `getRoom(roomId)`

Returns a deep copy of a specific room by its UID.

**Example:**
```javascript
const room = roomsController.getRoom('a1b2c3d4-...');
// Returns: { id, name, description, connections, x, y, width, height, objects, entities }
```

## 5. Private Methods

| Method | Description |
|--------|-------------|
| `_validateRoomDefinitions(defs)` | Validates loaded room definitions before initialization |

### `_validateRoomDefinitions(defs)`

Validates all room definitions loaded from `data/rooms.json`. Throws `TypeError` if validation fails.

**Validation Rules:**
- `defs` must be a non-null object
- Each room must have:
  - `name`: non-empty string
  - `description`: string
  - `connections`: non-null object with non-empty string keys and string values
  - `x`, `y`: numbers
  - `width`, `height`: numbers

**Example Error:**
```javascript
throw new TypeError("Room 'start_room' must have a non-empty name");
```

## 6. Integration

### 6.1. WorldStateController

`RoomsController` is instantiated directly in `WorldStateController` (no DI needed — it has no dependencies):

```javascript
// In WorldStateController constructor:
this.roomsController = new RoomsController();
```

### 6.2. WorldStateController Public API

`WorldStateController` exposes these wrapper methods that delegate to `RoomsController`:

| Method | Delegates to |
|--------|-------------|
| `getRoomUidByLogicalId(logicalId)` | `this.roomsController.getUidByLogicalId(logicalId)` |
| `moveEntity(entityId, targetRoomId)` | Uses `this.roomsController.getUidByLogicalId()` to resolve target room |
| `getWorldGraph()` | Uses `this.roomsController.getAll()` to pass to `WorldGraphBuilder` |

### 6.3. WorldGraphBuilder

`WorldGraphBuilder` (utility class) consumes room data via `RoomsController.getAll()`:

```javascript
// In WorldStateController.getWorldGraph():
getWorldGraph() {
    const rooms = this.roomsController.getAll();
    const builder = new WorldGraphBuilder(rooms);
    return builder.build();
}
```

### 6.4. ActionController

`ActionController` accesses room data via `WorldStateController` (never directly):

```javascript
// Via WorldStateController:
const targetRoomUid = this.worldStateController.getRoomUidByLogicalId(targetRoomId);
```

### 6.5. NavActionsPanel (Client) — No Longer Uses Room Data

**Note:** Navigation functionality was removed from `NavActionsPanel`. Per `public/js/NavActionsPanel.js` line 72: "Actions section only (navigation removed — arrows now appear on the map)." Navigation arrows are now rendered on the spatial map via `RoomConnectionRenderer.js` and `WorldMapView.js`. The `NavActionsPanel` now only renders action buttons, not room navigation.

### 6.6. WorldMapView (Client)

The `WorldMapView` component renders the spatial world map overlay with pan/zoom. It receives room data from the server via `GET /world-map` endpoint, which internally calls `WorldStateController.getWorldGraph()`. The map uses room coordinates (`x`, `y`, `width`, `height`) to position room rectangles on the canvas.

**Data Flow:**
```
WorldMapView → GET /world-map → WorldStateController.getWorldGraph()
    → this.roomsController.getAll() → WorldGraphBuilder → graph JSON
    → Response sent to client → WorldMapView renders rooms and connections
```

### 6.7. RoomConnectionRenderer

`RoomConnectionRenderer` draws connection arrows between rooms on the spatial map. It receives room data (including connections) from the world map API response and renders arrows between connected rooms based on room coordinates and connection data.

## 7. Spatial Rendering

### 7.1. Room Coordinate System

Each room definition includes spatial coordinates for rendering on the world map:

| Field | Type | Purpose |
|-------|------|---------|
| `x` | `number` | Top-left X coordinate on the 2D canvas |
| `y` | `number` | Top-left Y coordinate on the 2D canvas |
| `width` | `number` | Room rectangle width in pixels |
| `height` | `number` | Room rectangle height in pixels |

### 7.2. Spatial Data Usage

Room spatial data is consumed by:

1. **`WorldMapView.js`** — Renders room rectangles at specified coordinates with pan/zoom support
2. **`RoomConnectionRenderer.js`** — Draws directional arrows between connected rooms based on their spatial positions
3. **`WorldGraphBuilder.js`** — Uses coordinates to compute arrow positioning and connection geometry

### 7.3. Adding New Rooms

When adding new rooms to `data/rooms.json`:

1. Add the room object with all required fields (name, description, connections, x, y, width, height)
2. Ensure coordinates do not overlap with existing rooms (unless intentional for visual grouping)
3. Connections reference other rooms by their **logical ID** (the JSON key), not UID
4. The system auto-resolves connections to UIDs during initialization

**Example:**
```json
{
  "new_room": {
    "name": "The Vault",
    "description": "A secure chamber.",
    "connections": {
      "exit": "start_room"
    },
    "x": 100,
    "y": 100,
    "width": 280,
    "height": 200
  }
}
```

## 8. Data Flow Diagram

```mermaid
graph TD
    subgraph "Data Source"
        RF[data/rooms.json]
    end

    subgraph "Controller"
        RC[RoomsController]
    end

    subgraph "Consumers"
        WSC[WorldStateController]
        WGB[WorldGraphBuilder]
    end

    RF -->|DataLoader.loadJsonSafe| RC
    RC -->|getAll()| WSC
    RC -->|getAll()| WGB
    RC -->|getUidByLogicalId()| WSC
```

## 9. Recent Changes

| Date | Change |
|------|--------|
| 2026-05-13 | **Refactor:** Externalized hardcoded room definitions to `data/rooms.json`, added `_validateRoomDefinitions()` validation, and Logger integration. See [BUG-063](../bugfixWiki/medium/BUG-063-hardcoded-room-definitions.md). |

## 10. Related Documentation

- `wiki/subMDs/controller_patterns.md` — State Ownership vs. Logic Coordination pattern
- `wiki/subMDs/world_map.md` — World Map system (consumes room data)
- `wiki/CORE.md` — Core wiki (logging standard, data files)
- `wiki/bugfixWiki/medium/BUG-063-hardcoded-room-definitions.md` — Bug fix documentation
- `src/utils/DataLoader.js` — DataLoader utility
- `src/utils/WorldGraphBuilder.js` — World graph builder utility