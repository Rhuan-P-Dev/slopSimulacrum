# 🌍 World State Management

## 1. Overview
The World State Management system is responsible for maintaining the "physical" state of the simulation, including locations, spatial relationships, and environmental data. It follows a hierarchical controller pattern to ensure that state is centralized and accessible.

## 2. Architecture
The system is structured as a coordinator-subcontroller hierarchy:

`Server` $\rightarrow$ `WorldStateController` $\rightarrow$ `[Sub-Controllers]` (e.g., `RoomsController`, `stateEntityController`, `componentController`, `componentStatsController`)

### 2.0. ComponentStatsController (`src/controllers/componentStatsController.js`)
The `ComponentStatsController` stores and manages the statistics of all component instances.
- **Role**: Persistent Data Store for component stats.
- **Data Structure**: `{ [componentInstanceId]: { [traitId]: { [statName]: value, ... }, ... }, ... }`
- **Deep Trait-Level Merge**: The `setStats()` method merges incoming updates within each trait category, ensuring that updating a single stat (e.g., `Physical.durability`) does not erase other stats in the same trait (e.g., `Physical.mass`, `Physical.strength`). See `wiki/subMDs/traits.md` Section 5 for details.
- **Defensive Copying**: `getStats()` and `getAll()` return deep clones to prevent external mutation of internal state.

### 2.1. WorldStateController (`src/controllers/WorldStateController.js`)
The `WorldStateController` acts as the primary entry point for all state-related queries and the **Root Injector** for the system.
- **Role**: Coordinator and Root Injector.
- **Primary Method**: `getAll()` - Aggregates the state from all registered sub-controllers into a single JSON object.
- **Extensibility**: New sub-controllers (e.g., `InventoryController`, `NPCController`) should be registered in the `subControllers` map within the constructor. 
- **Dependency Injection**: As the Root Injector, `WorldStateController` is responsible for instantiating all sub-controllers in the correct order (bottom-up) and passing dependencies via constructors to ensure a single source of truth.
- **Maintenance Responsibility**: Because it is the Root Injector, `WorldStateController` is the **only** place where the `new` keyword is used for controller instantiation. If a sub-controller's dependencies change, the wiring must be updated here, not within the sub-controller itself.
- **Entity Integration**: The `stateEntityController` handles the current state of all entities in memory, delegating blueprint and component logic to the Entity-Component-Stats hierarchy.
- **World Graph**: `getWorldGraph()` — Instantiates `WorldGraphBuilder` with rooms data and returns the constructed graph (used by `GET /world-map` endpoint).

### 2.2. RoomsController (`src/controllers/RoomsController.js`)
The `RoomsController` manages the spatial layout of the world.
- **Role**: Spatial Data Provider.
- **Data Structure**: Uses a keyed object (map) where each key is a unique `roomId` (UUID v4).
- **IDs**: Room IDs are dynamically generated using `generateUID()` upon initialization to ensure global uniqueness.
- **Spatial Coordinates**: Each room has position and size data for rendering:
  - `x`, `y`: Screen coordinates for the room center.
  - `width`, `height`: Room dimensions in pixels.
- **Connections**: Each room defines its exits via a `connections` object:
  - **Key**: The identifier of the door or path (e.g., `"north_door"`).
  - **Value**: The `roomId` (UUID) of the destination room.
- **Containment**: Rooms track the IDs of elements within them via:
  - `objects`: An array of unique IDs for items/objects in the room.
  - `entities`: An array of unique IDs for NPCs or players in the room.

### 2.2.1. WorldGraphBuilder (`src/utils/WorldGraphBuilder.js`)
A utility class that constructs a navigable graph structure from room data:
- Takes a rooms object from `RoomsController.getAll()`
- Resolves connection door names to destination room names
- Returns a defensive copy via `structuredClone()`
- Used by `WorldStateController.getWorldGraph()`

### 2.3. stateEntityController (`src/controllers/stateEntityController.js`)
The `stateEntityController` manages active entity instances in memory.
- **Role**: Instance Manager.
- **Spatial Data**: Each entity stores position relative to its room via `spatial: { x, y }`.
- **Entity Lifecycle**: Methods include `spawnEntity()`, `moveEntity()`, `despawnEntity()`, and `getEntity()`.

## 3. Implementation Guidelines for Agents

### 3.1. Adding New Rooms
When adding rooms to the `RoomsController`, ensure that:
1. Each room has a unique `id`.
2. Connections are bidirectional if the path is meant to be two-way (e.g., if Room A north leads to Room B, Room B south should lead to Room A).
3. Room descriptions are descriptive and maintain the atmosphere of the simulation.

**Logical ID Resolution**: To maintain synchronization between controllers (e.g., spawning an entity in a specific room during initialization), use `RoomsController.getUidByLogicalId(logicalId)` to resolve human-readable room names to their generated UUIDs.

### 3.2. Adding New State Categories
If you need to track a new type of global state (e.g., Global Weather, Game Time, Quest Progress):
1. Create a new controller in `src/controllers/` (e.g., `QuestController.js`).
2. Implement a `getAll()` method in the new controller.
3. Instantiate and add the new controller to the `subControllers` map in `WorldStateController.js`.

## 4. Data Schema Example
```json
{
  "rooms": {
    "uuid-1234-5678": {
      "id": "uuid-1234-5678",
      "name": "Room Name",
      "description": "Detailed description of the room.",
      "connections": {
        "door_id": "uuid-8765-4321"
      },
      "objects": ["obj_uuid_1", "obj_uuid_2"],
      "entities": ["ent_uuid_1"]
    }
  }
}
```