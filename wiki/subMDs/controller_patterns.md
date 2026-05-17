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

 0. **Data Loading**: Use `DataLoader.loadJsonSafe()` to load JSON registries (e.g., `actions.json`, `components.json`, `rooms.json`, `internalComponents.json`).
     - **Standard Pattern**: All controllers that consume external data files must use `DataLoader.loadJsonSafe(filePath, fallback)` — never hardcode data literals in constructors.
     - **Validation**: Controllers must validate loaded data via `_validate*()` methods before initialization.
  1. **Data Store**: `ComponentStatsController`
 2. **Leaf Logic**: `ComponentController` (Injected with `ComponentStatsController` and `componentRegistry`)
 3. **Mid-Level Logic**: `EntityController` (Injected with `ComponentController`)
 4. **Instance Manager**: `stateEntityController` (Injected with `EntityController`)
 5. **Internal Component State**: `InternalComponentController` (Self-instantiating State Controller with logic — uses `setWorldStateController()` DI setter after initialization)
 6. **Coordinator**: `WorldStateController` (Owns all the above, starts repair system via `internalComponentController.startRepairSystem()` after initialization)

 ## 4. State Ownership vs. Logic Coordination
 To maintain the Single Responsibility Principle (SRP):

 - **State Controllers (Data Stores)**: (e.g., `ComponentStatsController`, `RoomsController`) 
     - Only store and retrieve raw data.
     - No complex game logic.
     - **Self-instantiate**: State Controllers do NOT use DI — they create their own internal storage and load data directly via `DataLoader.loadJsonSafe()`.
 - **Logic Controllers (Coordinators)**: (e.g., `ComponentController`, `EntityController`)
     - Process logic, perform calculations, and manipulate data stores.
     - They do not store state themselves; they use their injected state controllers.

  ### 4.1. State Controller Exception to DI Rule

  State Controllers are the **only** controllers permitted to instantiate internally without dependency injection. This is because they represent the foundational data layer — they have no dependencies on other controllers.

  **⚠️ Extended Exception for Logic-Enhanced State Controllers:** Some State Controllers (e.g., `InternalComponentController`) store data AND perform game logic (repair ticks, auto-installation). They still self-instantiate but must use DI via `setWorldStateController()` to access other controllers for inter-controller communication.

   **Example — RoomsController:**
  ```javascript
  import DataLoader from '../../utils/DataLoader.js';
  import Logger from '../../utils/Logger.js';

  class RoomsController {
      constructor() {
          // Allowed: State Controllers self-instantiate
          this.rooms = {};
          this.idMap = {};
          const roomDefinitions = DataLoader.loadJsonSafe('data/rooms.json', {});
          this._validateRoomDefinitions(roomDefinitions);
          // ... initialization
          Logger.info(`[RoomsController] Initialized with ${Object.keys(this.rooms).length} rooms`);
      }
  }
  ```

 **Example — ComponentStatsController:**
 ```javascript
 class ComponentStatsController {
     constructor() {
         // Allowed: State Controllers self-instantiate
         this.componentStats = {};
     }
 }
 ```

 **Rule**: If a controller is a State Controller (stores raw data, no game logic), it may self-instantiate. If it performs any game logic, calculations, or coordination, it MUST use DI.

 📖 For the full RoomsController documentation, see [rooms_controller](./rooms_controller.md).

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

### 7.5. Defensive Copying Pattern for State Controllers

State Controllers that expose data via public methods must return **defensive deep copies** to prevent external mutation of internal state. This is a mandatory pattern per `wiki/code_quality_and_best_practices.md` Section 1.2 (Loose Coupling).

**Example — RoomsController defensive copying:**
```javascript
// getAll() returns a deep copy via structuredClone()
getAll() {
    return structuredClone(this.rooms);
}

// getRoom() returns a deep copy of a single room
getRoom(roomId) {
    const room = this.rooms[roomId];
    return room ? structuredClone(room) : null;
}
```

**Defensive Copying Rules:**
| Rule | Implementation | Rationale |
|------|---------------|-----------|
| Return deep copies via `structuredClone()` | `return structuredClone(this.internalStore);` | Prevents external mutation of internal state |
| Never return direct references | Never `return this.rooms` — always clone | Maintains data encapsulation |
| Document defensive copying in method JSDoc | `@returns {Object} Deep copy of all rooms` | Consumers know the data is safe to modify |
| Clone at the boundary | Clone on every public method return | Internal state is never directly exposed |

🐛 For fix details on the direct mutation bug, see [BUG-014](../../bugfixWiki/medium/BUG-014-defensive-copying.md).

## 8. Maintaining the Root Injector
The `WorldStateController` constructor is the **only** place in the entire system where the `new` keyword should be used to instantiate controllers.

### Dependency Changes
When a new dependency is added to a sub-controller (e.g., `EntityController` now requires `PhysicsController`):
1. **Do NOT** instantiate the new dependency inside the `EntityController` constructor.
2. **Do** update the `WorldStateController` constructor to:
    - Instantiate the `PhysicsController` (following the bottom-up sequence).
    - Pass the `PhysicsController` instance into the `EntityController` constructor.

This ensures that the dependency graph remains transparent and the Single Source of Truth is preserved across the entire simulation.

  ## 8.1. RoomsController Pattern

  ### 8.1.1. State Controller — Self-Instantiating Data Store

  The `RoomsController` is the canonical example of a State Controller. It manages room definitions loaded from `data/rooms.json`.

  - **Role**: Spatial Data Store — single source of truth for world rooms and connections
  - **Instantiation**: Self-instantiated in `WorldStateController` (no DI — State Controller exception)
  - **Data Source**: `data/rooms.json` via `DataLoader.loadJsonSafe('data/rooms.json', {})`
  - **Responsibility**: Store room definitions, resolve logical IDs to UIDs, provide defensive copies
  - **Key Methods**: `getUidByLogicalId()`, `getAll()`, `getRoom()`
  - **Validation**: `_validateRoomDefinitions()` — validates name, description, connections, coordinates before init

  **Integration with WorldStateController:**
  ```javascript
  // In WorldStateController constructor:
  this.roomsController = new RoomsController();
  ```

  **WorldStateController Delegation Methods:**
  | WorldStateController Method | Delegates to |
  |-----------------------------|-------------|
  | `getRoomUidByLogicalId(logicalId)` | `this.roomsController.getUidByLogicalId(logicalId)` |
  | `moveEntity(entityId, targetRoomId)` | Resolves target via `this.roomsController.getUidByLogicalId()` |

  ---

  ## 8.2. InternalComponentController Pattern

  ### 8.2.1. State Controller — Self-Instantiating with Logic

  The `InternalComponentController` is a State Controller that stores internal component data AND performs game logic (repair ticks, auto-installation). It self-instantiates but uses DI via `setWorldStateController()` for inter-controller communication.

  - **Role**: Internal Component State — volume-based auto-installation, lifecycle management, 5-second repair system
  - **Instantiation**: Self-instantiated in `WorldStateController` (no DI in constructor — State Controller exception)
  - **Data Source**: `data/internalComponents.json` via `DataLoader.loadJsonSafe('data/internalComponents.json', {})`
  - **Responsibility**: Auto-install internal components on entity spawn, manage repair intervals, provide defensive copies
  - **Key Methods**: `autoInstallOnEntitySpawn()`, `addInternalComponent()`, `removeInternalComponent()`, `getInternalComponents()`, `getInternalComponentsForEntity()`, `hasInternalComponent()`, `cleanupEntity()`, `startRepairSystem()`, `stopRepairSystem()`, `_processRepairTick()`, `getAll()`
   - **Validation**: `_validateRegistry()` — throws `TypeError` if registry is null, undefined, or not an object. For each definition, logs `Logger.warn()` if `volume`, `repairInterval`, or `repairAmount` are missing or invalid (does NOT throw for missing fields). `traits` and `excludedComponentTypes` are optional and not validated.

  **Integration with WorldStateController:**
  ```javascript
  // In WorldStateController constructor:
  const internalComponentController = new InternalComponentController();
  this.internalComponentController = internalComponentController;

  // After initialization:
  internalComponentController.setWorldStateController(this);
  internalComponentController.startRepairSystem();
  ```

  **Registration in subControllers:**
  ```javascript
  this.subControllers = {
      // ...
      internalComponents: this.internalComponentController,
      // ...
  };
  ```

  ### 8.2.2. Constructor

  ```javascript
  class InternalComponentController {
      constructor(internalComponentRegistry = null) {
          // internalComponentRegistry: Optional pre-loaded registry for testing
          // If null, loads from data/internalComponents.json via DataLoader.loadJsonSafe()
      }
  }
  ```

  The constructor accepts an optional `internalComponentRegistry` parameter. When provided, it bypasses the `DataLoader.loadJsonSafe()` call and uses the injected registry directly — useful for unit testing.

  ---

   ### 8.2.3. Public API Methods

   | Method | Parameters | Returns | Description |
   |--------|-----------|---------|-------------|
   | `autoInstallOnEntitySpawn(entityId, components, componentVolumeProvider)` | `string`, `Array`, `Function\|null` | `Array` | Auto-installs spheres on eligible components based on volume + exclusions. Returns `Array` of installed internal component instances. `componentVolumeProvider` is an optional function `(componentType) => number` for volume lookup |
   | `addInternalComponent(entityId, hostComponentId, internalComponentType)` | `string`, `string`, `string` | `Object\|null` | Manually add an internal component; returns added component or null if rejected |
   | `removeInternalComponent(entityId, hostComponentId, internalComponentInstanceId)` | `string`, `string`, `string` | `boolean` | Remove a specific internal component instance |
   | `getInternalComponents(entityId, hostComponentId)` | `string`, `string` | `Array` | Get internal components for a specific host component (**defensive deep copy** via `structuredClone()`) |
   | `getInternalComponentsForEntity(entityId)` | `string` | `Object` | Get all internal components for an entity (**defensive deep copy** via `structuredClone()`) |
   | `hasInternalComponent(entityId, hostComponentId, internalComponentType)` | `string`, `string`, `string` | `boolean` | Check if host has a specific internal component type |
  | `cleanupEntity(entityId)` | `string` | `boolean` | Clean up all internal components when entity despawns |
   | `startRepairSystem()` | — | `void` | Start the 5-second repair interval via `setInterval` |
   | `stopRepairSystem()` | — | `void` | Stop the repair interval |
   | `setWorldStateController(worldStateController)` | `WorldStateController` | `void` | DI setter — called by WorldStateController after initialization |
  | `getAll()` | — | `Object` | Return defensive deep copy of all internal components |

  ---

   ### 8.2.4. Private Methods

   | Method | Parameters | Returns | Description |
   |--------|-----------|---------|-------------|
   | `_validateRegistry(registry)` | `Object` | `void` | Validates registry structure — throws `TypeError` if not an object; logs warnings for missing/invalid required fields |
   | `_processRepairTick()` | — | `void` | Execute one repair cycle across all entities |
   | `_syncToEntityStore()` | — | `void` | Syncs internal components back to entity store for world-state broadcasts |
   | `_processDefinitions(definitions)` | `Object` | `void` | Processes registry definitions from JSON into internal structure |

   ---

   ### 8.2.5. WorldStateController Delegation Methods

  These methods delegate to `InternalComponentController` and are available on `WorldStateController`:
       

  | WorldStateController Method | Delegates to |
  |-----------------------------|-------------|
  | `addInternalComponent(entityId, hostComponentId, internalComponentType)` | `this.internalComponentController.addInternalComponent(...)` |
  | `getInternalComponents(entityId, hostComponentId)` | `this.internalComponentController.getInternalComponents(...)` |
  | `getInternalComponentsForEntity(entityId)` | `this.internalComponentController.getInternalComponentsForEntity(...)` |
  | `removeInternalComponent(entityId, hostComponentId, internalComponentInstanceId)` | `this.internalComponentController.removeInternalComponent(...)` |
  | `hasInternalComponent(entityId, hostComponentId, internalComponentType)` | `this.internalComponentController.hasInternalComponent(...)` |
  | `cleanupInternalComponents(entityId)` | `this.internalComponentController.cleanupEntity(...)` |
  | `startInternalComponentRepairSystem()` | `this.internalComponentController.startRepairSystem()` |
  | `stopInternalComponentRepairSystem()` | `this.internalComponentController.stopRepairSystem()` |

  ---

  ### 8.2.6. Volume-Based Capacity Checking

  Internal components are installed only when:
  1. `hostComponent.Physical.volume >= internalComponentType.volume`
  2. `hostComponent.type` is NOT in `internalComponentType.excludedComponentTypes`

  ```javascript
  // In autoInstallOnEntitySpawn():
  const internalDef = this.registry[type];
  const hostVolume = hostComponent.traits?.Physical?.volume || 0;
  if (hostVolume < internalDef.volume) {
      Logger.warn(`[InternalComponent] Host ${hostComponent.type} volume ${hostVolume} < required ${internalDef.volume}`);
      return false;
  }
  if (internalDef.excludedComponentTypes?.includes(hostComponent.type)) {
      Logger.info(`[InternalComponent] Skipping excluded type ${hostComponent.type}`);
      return false;
  }
  ```

  ### 8.2.7. Defensive Copying Pattern

  All public data-exposing methods return deep copies via `structuredClone()`:
  ```javascript
  getAll() {
      return structuredClone(this.internalComponents);
  }

  getInternalComponents(entityId, hostId) {
      const components = this.internalComponents[entityId]?.[hostId] || [];
      return structuredClone(components);
  }
  ```

  ### 8.2.8. Repair System Lifecycle

  The repair system runs every 5 seconds (`setInterval(5000)`):
  1. `startRepairSystem()` is called by `WorldStateController` after initialization
  2. `_processRepairTick()` iterates all entities
  3. For each entity's internal components, calls `ComponentController.updateComponentStatDelta()` on the host
  4. Increases `Physical.durability` by `repairAmount` (1 for durabilityRepairSphere)
  5. Stat change triggers broadcast automatically via existing listener system
  6. `stopRepairSystem()` clears the interval on shutdown

  ### 8.2.9. Data Loading Pattern

  Following the standard State Controller pattern:
  ```javascript
  import DataLoader from '../../utils/DataLoader.js';
  import Logger from '../../utils/Logger.js';

  class InternalComponentController {
      constructor() {
          this.internalComponents = {};
          this.registry = {};
          this.worldStateController = null;
          this.repairIntervalId = null;

          const definitions = DataLoader.loadJsonSafe('data/internalComponents.json', {});
          this._validateRegistry(definitions);
          this._processDefinitions(definitions);

          Logger.info(`[InternalComponentController] Initialized with ${Object.keys(this.registry).length} internal component types`);
      }
  }
  ```

  ---

  ## 8.1.2. Data Loading Pattern for State Controllers

 All State Controllers follow this mandatory pattern:

  ```javascript
  import DataLoader from '../../utils/DataLoader.js';
  import Logger from '../../utils/Logger.js';

  class SomeController {
      constructor() {
          this.store = {};
          const definitions = DataLoader.loadJsonSafe('data/some.json', {});
          this._validateSomeDefinitions(definitions);  // Name specific to controller's data type
          // ... process definitions
          Logger.info(`[SomeController] Initialized with ${count} entries`);
      }

      _validateSomeDefinitions(defs) {  // Use _validate[ControllerName]Definitions() pattern
          // Throw TypeError for invalid data
      }
  }
  ```

 **Rules:**
 1. Always use `DataLoader.loadJsonSafe(filePath, fallback)` — never use `require()` or `fs.readFileSync()` directly
 2. Always provide a fallback value (e.g., `{}` or `[]`) for the second argument
 3. Always validate with a `_validate*()` method before processing
 4. Always log initialization via `Logger.info()`

 ---

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
      "x": 0, "y": 0, "width": 300, "height": 200,
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

## 10. Client-Side Callback Patterns

### 10.1. Connection Click Callback Pattern

The connection click callback pattern allows UI interactions on map connections to trigger navigation or other actions. The callback flows through: `UIManager → RoomConnectionRenderer → WorldMapView`.

**Pattern:**
```javascript
// UIManager.renderRoomConnections() accepts optional callback
renderRoomConnections(room, rooms, onConnectionClick = null, entityId = null) {
    RoomConnectionRenderer.renderRoomConnections(room, rooms, this._currentRoomLayer, onConnectionClick, entityId);
}

// WorldMapView._drawConnection() attaches click handler
line.addEventListener('click', (e) => {
    e.stopPropagation();
    if (this._onRoomClick) {
        this._onRoomClick(conn.targetId);
    }
});
```

**Callback Chain:**
1. `UIManager.updateWorldView()` passes `onMoveCallback` as `onConnectionClick`
2. `RoomConnectionRenderer.renderRoomConnections()` passes callback to `_drawConnection()`
3. `_drawConnection()` creates invisible hit-area line with click listener
4. Click calls `onConnectionClick(entityId, targetRoomId)` where `targetRoomId` is a string ID, with `e.stopPropagation()` to prevent pan

**Hit-Area Pattern:** Invisible hit-area lines (`stroke-width: 15`, `stroke: 'transparent'`) enable reliable click detection on thin SVG lines. This is the standard approach for making SVG elements interactive.

**Prevention:** See BUG-065 and BUG-066 in `wiki/bugfixWiki/high/` for fixes on connection direction and clickability.
