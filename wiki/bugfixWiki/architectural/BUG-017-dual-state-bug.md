# BUG-017: Dual State Bug — Internal Controller Instantiation

- **Severity**: ARCHITECTURAL
- **Status**: ✅ Fixed
- **Fixed In**: — (enforced via architectural pattern)
- **Related Files**: All controllers

## Symptoms

The system maintained two different views of the same state:
- `WorldStateController` had one set of entities
- A sub-controller had a completely different set of entities
- Operations on one controller didn't affect the other
- Save/Load produced inconsistent results

### Example: The "Ghost Entity" Bug

```javascript
// WorldStateController has entity 'e1'
worldStateController.spawnEntity('droid', 'room1');  // Creates entity 'e1'

// But EntityController has its own separate instance
const entityController = new EntityController();  // ❌ New instance!
entityController.entities = {};  // Empty! Entity 'e1' not visible here.
```

## Root Cause

Controllers were instantiating their dependencies internally using the `new` keyword:

```javascript
// ❌ BEFORE (buggy - internal instantiation)
class EntityController {
    constructor() {
        this.componentController = new ComponentController();  // Creates unique instance!
    }
}

class WorldStateController {
    constructor() {
        this.entityController = new EntityController();  // Has its OWN ComponentController!
        this.componentController = new ComponentController();  // Different instance!
    }
}
```

This created **dual state** — two `ComponentController` instances with different `this.components` objects, both supposed to manage the same game state.

## Fix

Enforced the **Dependency Injection** pattern across all controllers:

```javascript
// ✅ AFTER (fixed - constructor injection)
class EntityController {
    constructor(componentController) {  // Receives shared instance
        this.componentController = componentController;
    }
}

class WorldStateController {
    constructor() {
        const componentController = new ComponentController();  // Single instance
        this.entityController = new EntityController(componentController);  // Injected
        this.componentController = componentController;  // Shared
    }
}
```

### Dependency Injection Chain

```
WorldStateController (Root Injector)
    ├── ComponentStatsController (step 1)
    ├── ComponentController (step 2, injected with ComponentStatsController)
    ├── EntityController (step 3, injected with ComponentController)
    ├── stateEntityController (step 4, injected with EntityController)
    ├── ActionController (step 5, injected with WorldStateController)
    └── ComponentCapabilityController (step 4, injected with WorldStateController)
```

## Prevention

- **Never** instantiate dependencies inside controllers using `new`
- All dependencies must be passed via constructor arguments
- `WorldStateController` is the **only** place where `new Controller()` is called
- Follow the **Dependency Injection** pattern from `wiki/subMDs/controller_patterns.md` Section 2
- Follow the **Root Injector Pattern** from `wiki/subMDs/controller_patterns.md` Section 3

## References

- Related wiki: `wiki/subMDs/controller_patterns.md` Sections 2, 3
- Related wiki: `wiki/map.md` Section 1
- Related controller: All controllers
- Related bug: [BUG-009](../high/BUG-009-server-direct-access.md)