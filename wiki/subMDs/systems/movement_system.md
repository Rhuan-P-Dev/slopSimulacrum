# Movement System

## 1. Overview

Movement is the primary means of entity traversal across the game world. It is driven by player-chosen actions rather than direct state mutation, ensuring that every movement event passes through a deterministic, server-authoritative pipeline.

## 2. Design Rationale

### Why Data-Driven Movement

Movement distances are derived from entity stats (e.g., the `movement` stat) rather than hardcoded values. This allows:

- **Balance tuning without code changes**: Adjusting movement range is a stat edit, not a logic edit
- **Dynamic modifiers**: Synergy effects, buffs, or debuffs can alter movement values at runtime by changing the underlying stat
- **Predictable player experience**: The same stat always produces the same proportional result, regardless of context

### Why Movement Is Decoupled From Actions

The action system selects *what* the player wants to do; the movement system handles *how* the entity relocates. This separation exists because:

- **Shared movement behavior**: Multiple action types (Move, Dash, forced reposition) use the same underlying movement logic
- **Single responsibility**: Actions define requirements and consequences; movement only interprets and executes them
- **Extensibility**: New movement-based actions require no changes to the movement pipeline

### Why Delta Spatial Exists

Delta spatial consequences represent *relative* movement (offsets) rather than *absolute* room transitions. This distinction exists because:

- **Within-room precision**: Entities can move partial distances within a room without triggering a room change
- **Dash vs Move differentiation**: Dash doubles movement distance but adds a durability cost — a trade-off expressed through consequences, not hardcoded logic

## 3. Between-Room Movement (Door-to-Door Spawn)

### Why Door-to-Door Spawn Exists

When an entity traverses a room connection through a door, it should spawn at the position of the *opposite* door in the destination room. This exists because:

- **Spatial continuity**: Entities retain stale spatial coordinates (usually `0,0`) after room transitions without explicit positioning
- **Intuitive navigation**: Exiting through a `right_door` should place the entity at the `left_door` of the next room, maintaining directional flow
- **Automatic calculation**: Door positions are calculated from room layout data rather than manually stored, eliminating data duplication and maintenance burden

### How Door Positions Are Calculated Automatically

Door positions are **calculated automatically** from room geometry using an edge-intersection algorithm. The server's [`RoomsController._calculateEdgeIntersection()`](src/controllers/core/RoomsController.js:197) mirrors the client-side [`RoomConnectionRenderer._getEdgePoint()`](public/js/RoomConnectionRenderer.js:214) to ensure client-server parity — the spawn position matches where the rendered connection line lands.

**Why automatic calculation over stored positions**:

- **Zero maintenance**: Positions update automatically when room geometry changes (x, y, width, height)
- **Single source of truth**: Room dimensions are the only data needed; positions are derived, not duplicated
- **Client-server parity**: Both sides use identical math, preventing visual mismatches between rendered connections and spawn points
- **No drift**: Stored positions can become stale when room layouts change; calculated positions cannot

**How the algorithm works**: Given two rooms, the algorithm draws a ray from the source room's center toward the target room's center, then finds where that ray first intersects the source room's boundary. The intersection point becomes the door's spawn position in room-relative coordinates.

### Optional Position Overrides

The `position` field in connection definitions is **optional** and used only for intentional overrides:

```json
"connections": {
  "right_door": {
    "target": "right_room"
    // No position needed — calculated automatically
  },
  "interior_portal": {
    "target": "secret_room",
    "position": { "x": 0, "y": 0 }
    // Override for non-edge placement (e.g., interior portals)
  }
}
```

When `position` is explicitly provided, it takes precedence over the calculated value. This supports non-standard doors like interior portals, floating entrances, or any door not on the geometric edge. At initialization, [`RoomsController._normalizePosition()`](src/controllers/core/RoomsController.js:213) converts the position to `{ x, y }` format once.

### How Spawn Position Is Resolved

[`RoomsController.getDoorPosition()`](src/controllers/core/RoomsController.js:163) uses a **two-tier resolution strategy**:

1. **Explicit position**: If a stored position exists (from an override in `data/rooms.json`), return it directly
2. **Automatic calculation**: Otherwise, find the target room from the connection map and compute the edge intersection via [`_calculateEdgeIntersection()`](src/controllers/core/RoomsController.js:197)

Then, [`RoomsController.getSpawnPositionForDoorTraversal()`](src/controllers/core/RoomsController.js:348) uses a **three-tier fallback**:

1. **Reverse connection lookup**: Find which door in the target room connects back to the source room, then resolve its position via `getDoorPosition()` (which now calculates automatically if no explicit position exists)
2. **Name convention inference** (degraded fallback): If the opposite door exists but the target room is missing geometry data, infer the entry edge from the source door name (`right` → `left`, `top` → `bottom`) and calculate the midpoint
3. **Room center default**: If no opposite door can be found, spawn at room center (`0,0`)

### Backward Compatibility

The system supports three position data formats:

| Format | Schema | Description |
|--------|--------|-------------|
| **Calculated** (default) | *(no position field)* | Automatically computed from room geometry via `_calculateEdgeIntersection()` |
| **Direct X/Y** (override) | `{ x: number, y: number }` | Explicit room-relative coordinates — takes precedence over calculation |
| **Edge/Offset** (legacy) | `{ edge: string, offset: number }` | Converted to X/Y at init via `_normalizePosition()` |

Legacy string connections (e.g., `{"right_door": "right_room"}`) continue to work and now benefit from automatic calculation. When no `sourceDoor` is provided to the move API, the entity spawns at room center, preserving existing behavior. The `sourceDoor` parameter is optional on the POST `/move-entity` endpoint.

### Data Flow

1. Client clicks a connection line → door name is captured by [`RoomConnectionRenderer`](public/js/RoomConnectionRenderer.js) or [`WorldMapView`](public/js/WorldMapView.js)
2. Door name flows through [`App._handleWorldMapRoomClick()`](public/js/App.js:182) → [`ActionExecutor.executeMoveDroid()`](public/js/ActionExecutor.js:302)
3. Client sends `POST /move-entity` with `{ entityId, targetRoomId, sourceDoor }`
4. Server calculates spawn position in [`WorldStateController.moveEntity()`](src/controllers/WorldStateController.js:357) via `RoomsController.getSpawnPositionForDoorTraversal()`
5. [`stateEntityController.moveEntity()`](src/controllers/core/stateEntityController.js:123) sets both `location` and `spatial` coordinates