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

## 6. ActionController Pattern

### 6.1. Specialized Action Coordinator

The `ActionController` follows the same Dependency Injection pattern but with a unique role:

- **Role**: Specialized Action Coordinator
- **Dependency**: Receives `WorldStateController` reference via constructor injection
- **Responsibility**: Execute game actions through the action registry pattern
- **Key Methods**: `executeAction()`, `_checkRequirements()`, `_executeConsequences()`

### 6.2. Constructor Injection Pattern

**❌ Prohibited Pattern (Internal Instantiation):**
```javascript
class ActionController {
    constructor() {
        // BAD: Creates new instances or loads files internally
        this.worldStateController = new WorldStateController();
        this._loadActionRegistry(); 
    }
}
```

**✅ Mandatory Pattern (Constructor Injection):**
```javascript
class ActionController {
    constructor(worldStateController, consequenceHandlers, actionRegistry) {
        // GOOD: All dependencies are injected from the Root Injector
        this.worldStateController = worldStateController;
        this.consequenceHandlers = consequenceHandlers;
        this.actionRegistry = actionRegistry;
    }
}
```

### 6.3. ActionController Stat Change Listener Integration

The `ActionController` subscribes to stat change events from `ComponentController` to enable automatic capability re-evaluation:

```javascript
// In WorldStateController constructor:
this.componentController.registerStatChangeListener((componentId, traitId, statName, newValue, oldValue) => {
    this.actionController.onStatChange(componentId, traitId, statName, newValue, oldValue);
});
```

**How it works:**
1. `ComponentController.updateComponentStat()` / `updateComponentStatDelta()` notifies registered listeners
2. `ActionController.onStatChange()` receives the change notification
3. A reverse index (`_componentActionIndex`) maps `trait.stat` → dependent actions
4. Only dependent actions are re-evaluated via `reEvaluateActionForComponent()`
5. Subscribers are notified via `on(actionName, callback)` / `off(actionName, callback)`

**ComponentController Listener API:**
```javascript
// Register a listener
componentController.registerStatChangeListener(listener);

// Unregister a listener
componentController.unregisterStatChangeListener(listener);

// Listener signature: (componentId, traitId, statName, newValue, oldValue)
```

**ActionController Event API:**
```javascript
// Subscribe to capability changes
actionController.on(actionName, (actionName, capabilityEntry) => {
    // capabilityEntry is an ActionCapabilityEntry or null
});

// Unsubscribe
actionController.off(actionName, callback);
```

### 6.4. Root Injector Updates

When adding `ActionController`:

1. Import: `const ActionController = require('./actionController');`
2. Load Data: `const actionRegistry = DataLoader.loadJsonSafe('data/actions.json');`
3. Instantiate Handlers: `const consequenceHandlers = new ConsequenceHandlers({ worldStateController: this });`
4. Instantiate: `const actionController = new ActionController(this, consequenceHandlers, actionRegistry);`
5. Assign: `this.actionController = actionController;`
6. Register: Add to `subControllers` map: `actions: this.actionController`

## 7. Maintaining the Root Injector
The `WorldStateController` constructor is the **only** place in the entire system where the `new` keyword should be used to instantiate controllers.

### Dependency Changes
When a new dependency is added to a sub-controller (e.g., `EntityController` now requires `PhysicsController`):
1. **Do NOT** instantiate the new dependency inside the `EntityController` constructor.
2. **Do** update the `WorldStateController` constructor to:
    - Instantiate the `PhysicsController` (following the bottom-up sequence).
    - Pass the `PhysicsController` instance into the `EntityController` constructor.

This ensures that the dependency graph remains transparent and the Single Source of Truth is preserved across the entire simulation.

---

### 📢 Notice for Future Agents
**Language Requirement:** All source code in this project must be written in **JavaScript**.
**Single Source of Truth:** Always refer to the wiki and its `subMDs` before implementing or modifying code.
