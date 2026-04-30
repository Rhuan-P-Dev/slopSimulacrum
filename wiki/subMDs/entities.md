# 🤖 Entity Management System

## 1. Overview
The Entity Management System uses a hierarchical composition pattern to define and manage the "beings" and complex objects within the simulation. Instead of a flat structure, entities are composed of components, which can themselves be composed of sub-components.

## 2. Entity vs Component Distinction

### 2.1. What is an Entity?
An **Entity** represents a complete game object or character that exists in the simulation world. Entities are the primary interactive objects that players or other entities can interact with.

**Entity Characteristics:**
- **Unique Identity**: Each entity has a unique UUID identifier (`id`).
- **Blueprint**: Entities are created from a blueprint (e.g., "smallBallDroid", "human") that defines their composition.
- **Location**: Entities exist in a specific room (`location` property).
- **Spatial Position**: Entities have a `spatial` property (`x`, `y`) defining their position relative to the room center.
- **Composition**: Entities are made up of one or more components stored in the `components` array.

**Example Entity:**
```json
{
  "id": "uuid-abc123-def456",
  "blueprint": "smallBallDroid",
  "location": "uuid-room-xyz",
  "spatial": { "x": 0, "y": 0 },
  "status": "active",
  "components": [
    {
      "type": "centralBall",
      "identifier": "default",
      "id": "uuid-comp-1"
    }
  ]
}
```

### 2.2. What is a Component?
A **Component** is a modular part or attribute that makes up an entity. Components define the entity's properties, appearance, and capabilities.

**Component Characteristics:**
- **Type**: The component type (e.g., "droidHead", "droidArm", "centralBall").
- **Identifier**: A distinguishing label for multiple instances of the same type (e.g., "left", "right").
- **Unique ID**: Each component instance gets its own UUID (`id`).
- **Traits**: Components have traits (Physical, Spatial, Mind) that define their properties.
- **Hierarchical**: Components can be simple (leaf nodes) or complex (contain sub-components).

**Example Component:**
```json
{
  "type": "droidArm",
  "identifier": "left",
  "id": "uuid-comp-abc",
  "traits": {
    "Physical": { "durability": 50, "mass": 10 },
    "Spatial": { "x": 20, "y": 10 }
  }
}
```

### 2.3. Key Differences

| Aspect | Entity | Component |
|--------|--------|-----------|
| **Purpose** | Complete game object | Building block of an entity |
| **Identity** | Has a unique ID | Has a unique ID per instance |
| **Blueprint** | Has a `blueprint` property | Defined in `componentController` registry |
| **Location** | Has a `location` (which room) | No location - exists within entity |
| **Composition** | Contains components | May contain sub-components |
| **Lifecycle** | Spawns/despawns in world | Created when entity is spawned |

### 2.4. Relationship Example
```
Entity: smallBallDroid
├── Component: centralBall (body center)
│   ├── Component: droidHead (x:0, y:-20 - above center)
│   ├── Component: droidArm (left) (x:20, y:10 - right side)
│   ├── Component: droidArm (right) (x:20, y:10 - right side)
│   └── Component: droidRollingBall (x:0, y:20 - below center)
```

## 3. Architecture Hierarchy
The system operates through a chain of specialized controllers:

`WorldStateController` $\rightarrow$ `stateEntityController` $\rightarrow$ `entityController` $\rightarrow$ `componentController` $\rightarrow$ `componentStatsController`

### 2.1. stateEntityController (`src/controllers/stateEntityController.js`)
- **Role**: Instance Manager.
- **Responsibility**: Manages all active entity instances currently present in the game world.
- **Functions**: Tracking entity positions (via `RoomsController`), handling entity lifecycles (including dynamic "Incarnation" upon client connection), and providing the current state of all active entities to the `WorldStateController`.

### 2.2. entityController (`src/controllers/entityController.js`)
- **Role**: Blueprint Registry.
- **Responsibility**: Loads and manages entity blueprints from `data/blueprints.json` via the `DataLoader` utility.
- **Composition Logic**: Defines which components make up a specific entity type.
- **Data-Driven**: Blueprints are loaded from JSON at runtime, not hardcoded in source code.
- **Constructor Injection**: Accepts optional `blueprints` parameter for testing; falls back to `DataLoader.loadJsonSafe('data/blueprints.json', {})`.
- **Example Blueprints** (from `data/blueprints.json`):
  - `"smallBallDroid"`: `["centralBall"]`
  - `"centralBall"`: `["droidHead", ["droidArm", "left"], ["droidArm", "right"], "droidRollingBall"]`
  - `"droidArm"`: `["droidHand"]`
  - `"droidHand"`: `[["humanoidDroidFinger", "left"], ["humanoidDroidFinger", "middle"], ["humanoidDroidFinger", "right"]]`
  - `"knife"`: `["knife"]` (standalone item entity)

### 2.3. componentController (`src/controllers/componentController.js`)
- **Role**: Component Coordinator.
- **Responsibility**: Manages the logic and communication for all components.
- **Functions**: Translates component names into operational calls and interfaces with the `componentStatsController` to retrieve or update data.

### 2.4. componentStatsController (`src/controllers/componentStatsController.js`)
- **Role**: Data Store.
- **Responsibility**: Stores the raw stats, attributes, and current values for every component instance.
- **Data Structure**: Keyed by component instance ID, containing properties like health, energy, strength, or custom metadata.

## 3. Implementation Guidelines

### 3.1. Creating a New Entity (Data-Driven)
1. **Define the Component**: Add the component definition to `data/components.json` with traits (Physical, Spatial, Mind, Movement).
2. **Define the Blueprint**: Add the blueprint entry to `data/blueprints.json` specifying the component hierarchy.
3. **Initialize Stats**: Stats are automatically initialized via `ComponentStatsController` when the entity spawns (uses deep trait-level merge).

**Example — Adding a New Item (Knife):**
```json
// data/components.json
"knife": {
  "traits": {
    "Physical": { "durability": 60, "strength": 15, "mass": 2, "sharpness": 20 },
    "Spatial": { "x": 0, "y": 0 }
  }
}

// data/blueprints.json
"knife": ["knife"]
```

To spawn in the world, call `stateEntityController.spawnEntity('knife', roomId)` from `WorldStateController`.

### 3.2. Entity Spatial Coordinates
Entities now have a `spatial` property that stores their position relative to their current room:
```json
{
  "spatial": {
    "x": 0,
    "y": 0
  }
}
```
- Entity position is calculated as: `screenX = room.x + entity.spatial.x`
- Entity position is calculated as: `screenY = room.y + entity.spatial.y`
- To move an entity within a room, update its `spatial.x` and `spatial.y` values.
- When an entity moves to a different room, only the `location` changes; the spatial offset remains relative to the room origin.

### 3.3. Component Spatial Coordinates
Components also have `Spatial` trait with `x` and `y` values that define their position relative to their parent entity:
```json
{
  "traits": {
    "Spatial": {
      "x": 20,
      "y": 10
    }
  }
}
```
- Component positions are relative to the entity's center (0,0).
- Example: `droidHead` at `x: 0, y: -20` appears above the entity center.
- Example: `droidArm` at `x: 20, y: 10` appears to the right and below the center.

### 3.4. Creating a New Entity with Spatial Traits
1. **Define the Component**: Add the component to `data/components.json` with `Spatial` trait (`x`, `y` offsets).
2. **Define the Blueprint**: Add the hierarchy to `data/blueprints.json`.
3. **Spawn Entity**: Use `stateEntityController.spawnEntity(blueprintName, roomId)` and optionally `updateEntitySpatial(entityId, {x, y})` for placement.

### 3.5. Manipulating Entities
All manipulations must flow through the `stateEntityController` to ensure that changes are reflected in the global world state and that the correct components are updated.

## 4. Dependency Management
To prevent state desynchronization (where an entity is created in one controller but its stats are invisible to another), the Entity Management System must use **Dependency Injection (DI)**.

### The Injection Chain
Controllers must not use the `new` keyword to create their dependencies. Instead, they must receive them in the constructor:
`WorldStateController` $\rightarrow$ passes `entityController` $\rightarrow$ `stateEntityController` $\rightarrow$ passes `componentController` $\rightarrow$ `entityController` $\rightarrow$ passes `componentStatsController` $\rightarrow$ `componentController`.

This ensures that every controller in the chain is referencing the exact same instance of the `componentStatsController` data store.

---

### 📢 Notice for Future Agents
**Language Requirement:** All source code in this project must be written in **JavaScript**.
**Single Source of Truth:** Always refer to the wiki and its `subMDs` before implementing or modifying code.
