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
The Root Injector must instantiate controllers from the "bottom" (data stores) to the "top" (coordinators):
1. **Data Store**: `ComponentStatsController`
2. **Leaf Logic**: `ComponentController` (Injected with `ComponentStatsController`)
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

## 6. Maintaining the Root Injector
The `WorldStateController` constructor is the **only** place in the entire system where the `new` keyword should be used to instantiate controllers.

### Dependency Changes
When a new dependency is added to a sub-controller (e.g., `EntityController` now requires `PhysicsController`):
1. **Do NOT** instantiate the new dependency inside the `EntityController` constructor.
2. **Do** update the `WorldStateController` constructor to:
    - Instantiate the `PhysicsController` (following the bottom-up sequence).
    - Pass the `PhysicsController` instance into the `EntityController` constructor.

This ensures that the dependency graph remains transparent and the Single Source of Truth is preserved across the entire simulation.
