# 🗺️ System Architecture Map

## 1. Controller Hierarchy (The Injection Chain)
The system follows a strict top-down dependency injection pattern to ensure a Single Source of Truth.

```mermaid
graph TD
    WSC[WorldStateController] --> SEC[stateEntityController]
    SEC --> EC[entityController]
    EC --> CC[componentController]
    CC --> CSC[componentStatsController]
    CC --> TC[traitsController]
    
    style WSC fill:#f9f,stroke:#333,stroke-width:4px
    style CSC fill:#bbf,stroke:#333,stroke-width:2px
    style TC fill:#bbf,stroke:#333,stroke-width:2px
```

**Injection Order (Root Injector):**
`ComponentStatsController` $\rightarrow$ `TraitsController` $\rightarrow$ `ComponentController` $\rightarrow$ `EntityController` $\rightarrow$ `stateEntityController` $\rightarrow$ `WorldStateController`

---

## 2. Responsibility Matrix

| Controller | Role | Key Responsibility | Primary Data Managed |
| :--- | :--- | :--- | :--- |
| **WorldStateController** | Root Coordinator | Root Injection & Global State Aggregation | `subControllers` map |
| **RoomsController** | Room Manager | Room definitions, coordinates, and connections | `rooms` (with x, y, width, height) |
| **stateEntityController** | Instance Manager | Lifecycle (Spawn/Move/Despawn) of active entities | `entities` (active instances with spatial) |
| **entityController** | Blueprint Registry | Defining entity "DNA" and composition | `blueprints` (entity types) |
| **componentController** | Logic Coordinator | Translating blueprints into stats via trait merging | `componentRegistry` (blueprint traits) |
| **componentStatsController** | Data Store | Persisting raw stats for every component instance | `componentStats` (instance IDs $\rightarrow$ values) |
| **traitsController** | Data Store/Molds | Maintaining global attribute defaults | `globalTraits` (molds including Spatial) |

---

## 2.1. Spatial Data Schema

### Rooms
Rooms now include spatial information for rendering:
```json
{
  "x": 200,
  "y": 250,
  "width": 300,
  "height": 200
}
```

### Entities
Entities store position relative to their room:
```json
{
  "spatial": {
    "x": 0,
    "y": 0
  }
}
```

### Components
Components have Spatial trait with position offsets:
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

---

## 3. Operational Flows

### 3.1. Entity Spawning Flow
When `WorldStateController` spawns an entity:
1. `stateEntityController.spawnEntity(blueprintName, roomId)`
2. $\rightarrow$ `entityController.createEntityFromBlueprint(blueprintName)`
3. $\rightarrow$ `entityController.expandBlueprint(blueprintName)` (Recursive expansion)
4. $\rightarrow$ For each component: `componentController.initializeComponent(type, instanceId)`
5. $\rightarrow$ `traitsController.mergeTraits(blueprintTraits)` (Merge: Blueprint Overrides $\cup$ Global Defaults)
6. $\rightarrow$ `componentStatsController.setStats(instanceId, finalStats)`
7. $\rightarrow$ `stateEntityController` stores the final entity object with its component IDs and location.

### 3.2. Stat Update Flow
When a component stat changes:
1. Request $\rightarrow$ `componentController.updateComponentStat(instanceId, traitId, statName, value)`
2. $\rightarrow$ `componentStatsController.getStats(instanceId)`
3. $\rightarrow$ Modify value in the local object.
4. $\rightarrow$ `componentStatsController.setStats(instanceId, updatedStats)`

---

## 4. ⚠️ Critical Constraints for Agents
- **No `new` Keywords**: Do not instantiate controllers inside other controllers. Only `WorldStateController` may use `new` for controller setup.
- **One-Way Flow**: State modifications should generally flow from top to bottom.
- **Single Source of Truth**: Always use the injected controllers to access data; never cache state in a way that could desynchronize with the `componentStatsController`.

### 📢 Notice for Future Agents
**Language Requirement:** All source code in this project must be written in **JavaScript**.
