# 🤖 Entity Management System

## 1. Overview
The Entity Management System uses a hierarchical composition pattern to define and manage the "beings" and complex objects within the simulation. Instead of a flat structure, entities are composed of components, which can themselves be composed of sub-components.

## 2. Architecture Hierarchy
The system operates through a chain of specialized controllers:

`WorldStateController` $\rightarrow$ `stateEntityController` $\rightarrow$ `entityController` $\rightarrow$ `componentController` $\rightarrow$ `componentStatsController`

### 2.1. stateEntityController (`src/controllers/stateEntityController.js`)
- **Role**: Instance Manager.
- **Responsibility**: Manages all active entity instances currently present in the game world.
- **Functions**: Tracking entity positions (via `RoomsController`), handling entity lifecycles, and providing the current state of all active entities to the `WorldStateController`.

### 2.2. entityController (`src/controllers/entityController.js`)
- **Role**: Blueprint Registry.
- **Responsibility**: Stores the "DNA" or blueprints of entities.
- **Composition Logic**: Defines which components make up a specific entity type.
- **Example Blueprint**:
  - `"smallBallDroid"`: `["centralBall"]`
  - `"centralBall"`: `["droidHead", ["droidArm", "left"], ["droidArm", "right"], "droidRollingBall"]`
  - `"droidArm"`: `["droidHand"]`
  - `"droidHand"`: `[["humanoidDroidFinger", "left"], ["humanoidDroidFinger", "middle"], ["humanoidDroidFinger", "right"]]`

### 2.3. componentController (`src/controllers/componentController.js`)
- **Role**: Component Coordinator.
- **Responsibility**: Manages the logic and communication for all components.
- **Functions**: Translates component names into operational calls and interfaces with the `componentStatsController` to retrieve or update data.

### 2.4. componentStatsController (`src/controllers/componentStatsController.js`)
- **Role**: Data Store.
- **Responsibility**: Stores the raw stats, attributes, and current values for every component instance.
- **Data Structure**: Keyed by component instance ID, containing properties like health, energy, strength, or custom metadata.

## 3. Implementation Guidelines

### 3.1. Creating a New Entity
1. **Define the Blueprint**: Add the hierarchy to the `entityController` blueprint map.
2. **Define Components**: Ensure all components used in the blueprint are recognized by the `componentController`.
3. **Initialize Stats**: Define the base stats for the components in the `componentStatsController`.

### 3.2. Manipulating Entities
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
