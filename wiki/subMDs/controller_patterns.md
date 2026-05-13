# 🛠️ Controller Patterns and Dependency Management

## 1. Overview
To ensure the simulation maintains a **single source of truth** and avoids state desynchronization, all controllers must adhere to the **Dependency Injection (DI)** pattern. This prevents the creation of duplicate controller instances and ensures that state is shared correctly across the system.

## 2. The Dependency Injection (DI) Standard
Controllers must **never** instantiate their dependencies internally using the `new` keyword within the constructor. Instead, dependencies must be passed as arguments to the constructor.

### ❌ Prohibited Pattern (Internal Instantiation)
```javascript
class EntityController {
    constructor() {
        // BAD: Creates a unique instance that might not be shared with other controllers
        this.componentController = new ComponentController(); 
    }
}
```

### ✅ Mandatory Pattern (Constructor Injection)
```javascript
class EntityController {
    constructor(componentController) {
        // GOOD: Uses the shared instance provided by the Root Injector
        this.componentController = componentController;
    }
}
```

## 3. The Root Injector Pattern
The `WorldStateController` acts as the **Root Injector** for the entire system. It is the only controller responsible for the `new` keyword during the system initialization phase.

### Initialization Sequence
The Root Injector must follow this strict sequence to ensure all dependencies are available before they are injected:

0. **Data Loading**: Use `DataLoader` to load JSON registries (e.g., `actions.json`, `components.json`).
1. **Data Store**: `ComponentStatsController`
2. **Leaf Logic**: `ComponentController` (Injected with `ComponentStatsController` and `componentRegistry`)
3. **Mid-Level Logic**: `EntityController` (Injected with `ComponentController`)
4. **Instance Manager**: `stateEntityController` (Injected with `EntityController`)
5. **Coordinator**: `WorldStateController` (Owns all the above)

## 4. State Ownership vs. Logic Coordination
To maintain the Single Responsibility Principle (SRP):

- **State Controllers (Data Stores)**: (e.g., `ComponentStatsController`, `RoomsController`) 
    - Only store and retrieve raw data.
    - No complex game logic.
- **Logic Controllers (Coordinators)**: (e.g., `ComponentController`, `EntityController`)
    - Process logic, perform calculations, and manipulate data stores.
    - They do not store state themselves; they use their injected state controllers.

## 5. Communication Protocol
- **Public APIs**: Controllers must communicate via public methods.
- **No Direct Access**: One controller must never directly modify the internal variables (e.g., `this.entities` or `this.componentStats`) of another controller.
- **Flow**: `WorldStateController` $\rightarrow$ `Sub-Controller` $\rightarrow$ `Dependency Controller`.

## 5.1. WorldStateController Public API

The `WorldStateController` provides public API wrapper methods that the server (`server.js`) should use instead of directly accessing sub-controllers. This maintains loose coupling and the Single Source of Truth principle.

**Available Public Methods:**

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `spawnEntity(blueprintName, roomId)` | `string`, `string` | `string` | Spawns an entity from a blueprint into a room |
| `despawnEntity(entityId)` | `string` | `boolean` | Despawns an entity and cleans up capabilities |
| `moveEntity(entityId, targetRoomId)` | `string`, `string` | `boolean` | Moves an entity to a different room |
| `getRoomUidByLogicalId(logicalId)` | `string` | `string\|null` | Resolves a logical room name to its UUID |
| `getWorldGraph()` | — | `Object` | Returns the world graph with resolved room names for all connections (used by `GET /world-map` endpoint) |

🐛 For fix details on the direct access pattern, see [BUG-009](../../bugfixWiki/high/BUG-009-server-direct-access.md).

**✅ Mandatory — Use public API:**
```javascript
// GOOD: Use public API wrappers
worldStateController.spawnEntity('droid', roomId);
worldStateController.getRoomUidByLogicalId('start_room');
```

---

## 6. ActionController Pattern

### 6.1. Specialized Action Coordinator

The `ActionController` follows the Dependency Injection pattern. After an SRP refactor, it now focuses **strictly on action execution** and delegates capability cache management to `ComponentCapabilityController`.

- **Role**: Action Execution Coordinator
- **Dependencies**: `WorldStateController`, `ConsequenceHandlers`, `actionRegistry`, `ComponentCapabilityController`, `SynergyController`, `ActionSelectController`
- **Responsibility**: Execute game actions, validate requirements, execute consequences
- **Key Methods**: `executeAction()`, `_checkRequirements()`, `_executeConsequences()`, `_resolvePlaceholders()`
- **Delegation**: All capability cache queries are delegated to `ComponentCapabilityController`

#### 6.1.1. Component Lock Tracking

The `executeAction()` method tracks component locks in `componentsToRelease` array, released in the `finally` block:

- **Non-spatial actions**: Components tracked during validation (lines 286-289)
- **Spatial actions** (`move`, `dash`): Components explicitly tracked after `_resolveSourceComponent()` (lines 301-317):
  - Multi-component spatial: Each component from `componentList` is added to `componentsToRelease`
  - Single-component spatial: The resolved `resolvedSourceComponentId` is added
- **Self-targeting actions** (`selfHeal`): Components from `targetComponentId` tracked during validation

🐛 For fix details, see [BUG-003](../../bugfixWiki/critical/BUG-003-spatial-action-lock-leak.md).

**Component Binding Resolution Priority:**
1. `attackerComponentId` from params → punch actions
2. `targetComponentId` from params → spatial/self_target actions with explicit selection
3. `targetingType: 'spatial'` → auto-find Movement component
4. `targetingType: 'none'` or `'self_target'` → auto-find Physical self-target component
5. Fallback → entity-wide requirement check

**Self-Targeting Actions (selfHeal):**
Actions with `targetingType: 'self_target'` execute instantly on the client. The client sends `targetComponentId` in params, and the server resolves it via Priority 2 (explicit targetComponentId).

### 6.2. Constructor Injection Pattern

**✅ Mandatory Pattern (Constructor Injection):**
```javascript
class ActionController {
    constructor(worldStateController, consequenceHandlers, actionRegistry, componentCapabilityController, synergyController, actionSelectController) {
        this.worldStateController = worldStateController;
        this.consequenceHandlers = consequenceHandlers;
        this.actionRegistry = actionRegistry || {};
        this.componentCapabilityController = componentCapabilityController;
        this.synergyController = synergyController || null;
        this.actionSelectController = actionSelectController || null;
    }
}
```

**Parameter Descriptions:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `worldStateController` | `WorldStateController` | Yes | Reference to the root controller for accessing sub-controllers |
| `consequenceHandlers` | `ConsequenceHandlers` | Yes | The consequence handler dispatcher system |
| `actionRegistry` | `Object` | Yes | Parsed JSON configuration of available actions |
| `componentCapabilityController` | `ComponentCapabilityController` | Yes | Capability cache manager (delegates all cache queries) |
| `synergyController` | `SynergyController` | No | Synergy system for multi-component bonus computation |
| `actionSelectController` | `ActionSelectController` | No | Component selection/locking controller (enforces one component, one action rule) |

### 6.3. Root Injector Updates

When adding `ActionController`:

1. Import: `import ActionController from './actionController.js';`
2. Load Data: `const actionRegistry = DataLoader.loadJsonSafe('data/actions.json');`
3. Instantiate `ComponentCapabilityController` FIRST (step 4)
4. Instantiate Handlers: `const consequenceHandlers = new ConsequenceHandlers({ worldStateController: this });`
5. Instantiate: `const actionController = new ActionController(this, consequenceHandlers, actionRegistry, componentCapabilityController, synergyController, actionSelectController);`
6. Assign: `this.actionController = actionController;`
7. Register: Add to `subControllers` map: `actions: this.actionController`

---

## 7. ComponentCapabilityController Pattern

### 7.1. Capability Cache Manager

The `ComponentCapabilityController` was extracted from `ActionController` to adhere to the **Single Responsibility Principle** (SRP). It manages the capability cache that maps each action to an array of component capability entries.

- **Role**: Capability Cache Manager
- **Dependencies**: `WorldStateController`, `actionRegistry`
- **Responsibility**: Scan, score, cache, and re-evaluate component capabilities
- **Key Methods**: `scanAllCapabilities()`, `reEvaluateActionForComponent()`, `_calculateComponentScore()`
- **Event System**: `on(actionName, callback)` / `off(actionName, callback)` for capability change notifications

### 7.2. Constructor Injection Pattern

```javascript
class ComponentCapabilityController {
    constructor(worldStateController, actionRegistry) {
        this.worldStateController = worldStateController;
        this.actionRegistry = actionRegistry || {};
        this._capabilityCache = {};
        this._actionSubscribers = new Map();
        this._traitStatActionIndex = new Map();
        this._buildTraitStatActionIndex();
    }
}
```

### 7.3. Stat Change Listener Integration

The `ComponentCapabilityController` subscribes to stat change events from `ComponentController` to enable automatic capability re-evaluation:

```javascript
// In WorldStateController constructor:
this.componentController.registerStatChangeListener((componentId, traitId, statName, newValue, oldValue) => {
    this.componentCapabilityController.onStatChange(componentId, traitId, statName, newValue, oldValue);
});
```

**How it works:**
1. `ComponentController.updateComponentStat()` / `updateComponentStatDelta()` notifies registered listeners
2. `ComponentCapabilityController.onStatChange()` receives the change notification
3. A reverse index (`_traitStatActionIndex`) maps `trait.stat` → dependent actions
4. Only dependent actions are re-evaluated via `reEvaluateActionForComponent()`
5. Subscribers are notified via `on(actionName, callback)` / `off(actionName, callback)`

### 7.4. Root Injector Updates

When adding `ComponentCapabilityController`:

1. Import: `import ComponentCapabilityController from './componentCapabilityController.js';`
2. Instantiate (step 4, BEFORE ActionController): `const componentCapabilityController = new ComponentCapabilityController(this, actionRegistry);`
3. Assign: `this.componentCapabilityController = componentCapabilityController;`
4. Inject into ActionController: Pass as 4th constructor argument
5. Register: Add to `subControllers` map: `capabilities: this.componentCapabilityController`

## 8. Maintaining the Root Injector
The `WorldStateController` constructor is the **only** place in the entire system where the `new` keyword should be used to instantiate controllers.

### Dependency Changes
When a new dependency is added to a sub-controller (e.g., `EntityController` now requires `PhysicsController`):
1. **Do NOT** instantiate the new dependency inside the `EntityController` constructor.
2. **Do** update the `WorldStateController` constructor to:
    - Instantiate the `PhysicsController` (following the bottom-up sequence).
    - Pass the `PhysicsController` instance into the `EntityController` constructor.

This ensures that the dependency graph remains transparent and the Single Source of Truth is preserved across the entire simulation.

## 9. Utility Classes: Exception to the DI Pattern

### 9.1. WorldGraphBuilder Utility Class
**File:** `src/utils/WorldGraphBuilder.js`

`WorldGraphBuilder` is a pure utility class that constructs a navigable graph structure from room data. Unlike controllers, utility classes **do not** use dependency injection — they take raw data directly as constructor arguments and are instantiated on-demand.

#### Pattern
```javascript
class WorldGraphBuilder {
    constructor(rooms) {
        // Takes raw data from RoomsController.getAll(), not a controller reference
        this.rooms = rooms;
        this.roomsById = new Map();
        this.roomOrder = [];
        this._buildIndex();
    }

    build() {
        // Returns defensive copy via structuredClone()
        return structuredClone({ rooms: graphRooms });
    }
}
```

#### Key Characteristics
- **No DI**: Constructor takes a `rooms` object directly from `RoomsController.getAll()`, not a `RoomsController` instance.
- **On-Demand Instantiation**: Created fresh via `new WorldGraphBuilder(rooms)` each time `WorldStateController.getWorldGraph()` is called.
- **Defensive Copying**: Returns a deep copy via `structuredClone()` to prevent external mutation of internal state.
- **No State Persistence**: Each instance is ephemeral — the result is a snapshot of the graph at the time of construction.

#### Integration with WorldStateController
```javascript
// In WorldStateController.getWorldGraph():
getWorldGraph() {
    const rooms = this.roomsController.getAll();
    const builder = new WorldGraphBuilder(rooms);
    return builder.build();
}
```

#### Data Structure
The `build()` method returns a graph object with this structure:
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

#### Private Methods
| Method | Description |
|--------|-------------|
| `_buildIndex()` | Creates a reverse lookup map from room IDs to room data; populates `roomsById` Map and `roomOrder` array |

#### Constructor Validation
- Throws `TypeError` if rooms parameter is null, undefined, or not an object

### 9.2. Guidelines for Future Utility Classes
Utility classes follow a different pattern than controllers:
1. **No Dependency Injection**: Take raw data directly as constructor arguments.
2. **No State Persistence**: Each instance is ephemeral — compute and return results.
3. **Pure Functions**: Avoid side effects; use the centralized `Logger` utility for logging.
4. **Defensive Copying**: Return deep copies of data to prevent external mutation.
5. **Placement**: Located in `src/utils/` directory, not in `src/controllers/`.
6. **Instantiation**: Created on-demand wherever needed, not wired through the Root Injector.
