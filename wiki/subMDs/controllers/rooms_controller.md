# 🏠 RoomsController

## 1. Overview

A **State Controller** that stores room definitions and manages spatial data. It self-instantiates without dependency injection.

## 2. Data Schema

Rooms are loaded from a JSON data file. Definitions describe the space itself — where each room sits and how it connects to its neighbors — while each room also carries the live occupancy of entities and objects currently inside it, so the controller answers both authored-layout questions and runtime-occupancy questions from a single store.

**ID Strategy**: Room data uses human-readable logical names, which are mapped to internal unique identifiers at initialization, and connections are resolved to those identifiers up front. This keeps authored data readable and stable while the runtime operates purely on unique IDs, decoupling content authoring from runtime identity.

### Why Connections Support Both String and Object Formats

Connections originally used a simple string format (`"door": "target_room"`) representing an unrestricted transition. The object format (`"door": { "target": "target_room" }`) was introduced to allow future per-connection metadata without breaking existing room definitions. Supporting both formats ensures gradual migration — rooms using string format continue functioning while new rooms can adopt the object format. The current implementation treats both formats identically, as range is computed from the entity's `Movement.move` stat client-side rather than stored on the connection.

### Why Range Does Not Live in Connection Definitions

Range is intentionally not stored on door connections. The ability to traverse space is a property of the entity, not the environment. A droid with `Movement.move: 20` can travel 20 units regardless of which door it approaches. Keeping range on the entity side (via component traits) means door definitions remain simple target references, and movement capability changes only require updating the entity's stats.

## 2.5. Door Position System

### Why Door Positions Exist

Spatial traversal requires precise entry and exit points, not just topological connections. When an entity moves through a door, it must spawn at a specific location in the target room — not at the room center. Without explicit door positions, entities would always appear at (0,0) regardless of which door they entered through, breaking spatial immersion and making room layout meaningless for movement mechanics. Door positions provide the precise coordinates needed for realistic spatial transitions.

### Why a Two-Tier Resolution Strategy

The system uses a two-tier approach to resolve door positions: explicit stored positions take priority, with an automatic calculated fallback for doors lacking position data. This strategy exists because the room data went through multiple format evolutions — some rooms have explicit position coordinates defined, while others rely on the original edge-based naming conventions. The explicit tier provides precision where designers intend specific placement, while the calculated tier ensures backward compatibility with existing room definitions that predate the position system. Without this fallback, rooms without position data would break traversal entirely.

### Why Server-Side Calculation Mirrors the Client Algorithm

The server's edge-intersection calculation mirrors the client's [`RoomConnectionRenderer._getEdgePoint()`](public/js/RoomConnectionRenderer.js) algorithm to ensure client-server parity. The spawn position computed on the server must match the visual connection endpoint rendered on the client. If the server used a different algorithm, entities would appear to teleport between the rendered door endpoint and the actual spawn position, creating a jarring visual discontinuity. Mirroring the algorithm eliminates this desynchronization without requiring additional position data to be transmitted.

## 3. Public API

The public surface answers identity and spatial questions about the room graph: resolving logical room names to internal identifiers, fetching room definitions, and looking up both where a door leads and where an entity appears when it traverses. All getters return defensive deep copies to prevent external mutation of internal state.

### Why Multiple Connection Accessors Exist

`getConnectionTarget` provides topological data (which room a door leads to), while `getDoorPosition` and `getSpawnPositionForDoorTraversal` provide spatial data (where exactly the door is located and where entities spawn). The separation reflects the distinction between connectivity questions ("where does this door go?") and positioning questions ("where do I appear when I walk through?"). Range-related accessors were removed because range is no longer stored on connections — it is computed client-side from the entity's `Movement.move` stat.

## 4. Integration

Consumed by the root state controller, world graph builder utility, and rendering systems.
