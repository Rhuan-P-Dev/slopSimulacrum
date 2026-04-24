# 🧩 ComponentCapabilityController

## 1. Overview

The **ComponentCapabilityController** is a dedicated controller responsible for managing the capability cache that maps each action to an array of component capability entries. It was extracted from the `ActionController` to adhere to the **Single Responsibility Principle** (SRP) as defined in `wiki/code_quality_and_best_practices.md` §1.1.

**Location**: `src/controllers/componentCapabilityController.js`

### Responsibilities
- **Capability Scanning** - Scanning all entities/components against all registered actions
- **Capability Caching** - Maintaining a sorted capability cache (`_capabilityCache`)
- **Component Scoring** - Calculating compatibility scores (`_calculateComponentScore`)
- **Component Requirement Checking** - Validating individual components against action requirements (`_checkRequirementsForComponent`)
- **Re-evaluation** - Updating cache entries when component stats change
- **Stat Change Handling** - Subscribing to stat changes and re-evaluating dependent actions
- **Event System** - Notifying subscribers of capability changes via `on()`/`off()`
- **Cache Cleanup** - Removing entries when entities are despawned

### What it does NOT do
- Action execution (delegated to `ActionController.executeAction()`)
- Entity-level multi-component requirement checking (delegated to `ActionController._checkRequirements()`)
- Consequence execution (delegated to `ConsequenceHandlers`)

---

## 2. Architecture Position

### Dependency Injection
The controller follows the mandatory Dependency Injection pattern (`wiki/subMDs/controller_patterns.md`):

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

### Instantiation in WorldStateController
```javascript
// In WorldStateController constructor (step 4):
const componentCapabilityController = new ComponentCapabilityController(this, actionRegistry);
this.componentCapabilityController = componentCapabilityController;

// Injected into ActionController (step 5):
const actionController = new ActionController(
    this, consequenceHandlers, actionRegistry, componentCapabilityController
);
```

### Relationship Map
```
WorldStateController
    ├── ComponentCapabilityController (owns capability cache)
    │       ├── ComponentController (reads stats via getComponentStats())
    │       └── ActionController (receives capability queries via delegation)
    └── ActionController (executes actions, delegates capability queries)
            └── ComponentCapabilityController (delegated to)
```

---

## 3. Data Structures

### 3.1. Capability Cache
```javascript
/**
 * @type {Object<string, Array<ComponentCapabilityEntry>>}
 * Format: { [actionName]: [ComponentCapabilityEntry, ...] }
 */
this._capabilityCache = {};
```

### 3.2. ComponentCapabilityEntry
```javascript
/**
 * @typedef {Object} ComponentCapabilityEntry
 * @property {string} entityId - The entity ID.
 * @property {string} componentId - The component instance ID.
 * @property {string} componentType - The component type (e.g., "droidArm").
 * @property {string} componentIdentifier - The component identifier (e.g., "left").
 * @property {number} score - The compatibility score.
 * @property {Object} requirementValues - Map of "trait.stat" → value.
 * @property {Object} fulfillingComponents - Map of "trait.stat" → componentId.
 * @property {Array} requirementsStatus - Array of per-requirement status objects.
 */
```

### 3.3. Removal Marker
```javascript
/**
 * @typedef {Object} RemovalMarker
 * @property {string} _type - Always 'REMOVAL'.
 * @property {string} componentId - The removed component's ID.
 * @property {string} entityId - The removed entity's ID.
 */
```

### 3.4. Reverse Index
```javascript
/**
 * @type {Map<string, Set<string>>}
 * Maps "trait.stat" → Set of action names that depend on it.
 */
this._traitStatActionIndex = new Map();
```

---

## 4. Public API

### 4.1. Scanning

| Method | Description |
|--------|-------------|
| `scanAllCapabilities(state)` | Full bottom-up scan of all entities/components against all actions |
| `reEvaluateActionForComponent(state, actionName, componentId)` | Update single entry in an action's array |
| `reEvaluateAllActionsForComponent(state, componentId)` | Re-evaluate all actions for one component |
| `reEvaluateEntityCapabilities(state, entityId)` | Re-scan all components of one entity against all actions |

### 4.2. Cache Queries

| Method | Description |
|--------|-------------|
| `getCachedCapabilities()` | Return the full capability cache |
| `getBestComponentForAction(actionName)` | Return the best (highest score) entry for an action |
| `getAllCapabilitiesForAction(actionName)` | Return all entries for an action |
| `getCapabilitiesForEntity(entityId)` | Return all entries for one entity across all actions |
| `getActionsForEntity(state, entityId)` | Return filtered actions for one entity (with canExecute/cannotExecute) |
| `getActionCapabilities(state)` | Return action status for all entities |

### 4.3. Lifecycle

| Method | Description |
|--------|-------------|
| `removeEntityFromCache(entityId)` | Remove all entries for an entity (called on despawn) |
| `onStatChange(componentId, traitId, statName, newValue, oldValue)` | Handle stat change event |

### 4.4. Event Subscription

| Method | Description |
|--------|-------------|
| `on(actionName, callback)` | Subscribe to capability changes for an action |
| `off(actionName, callback)` | Unsubscribe |

### 4.5. Registry Access

| Method | Description |
|--------|-------------|
| `getActionRegistry()` | Return the action registry |

---

## 5. Stat Change Flow

```
ComponentController.updateComponentStatDelta()
    → _notifyStatChangeListeners()
        → ComponentCapabilityController.onStatChange()
            → _getActionsForTraitStat()
                → reEvaluateActionForComponent()
                    → find entry in array → update/remove → re-sort
                    → _notifySubscribers(actionName, entryOrRemovalMarker)
```

**Registration** (in `WorldStateController`):
```javascript
this.componentController.registerStatChangeListener((componentId, traitId, statName, newValue, oldValue) => {
    this.componentCapabilityController.onStatChange(componentId, traitId, statName, newValue, oldValue);
});
```

---

## 6. Event Subscription

### Callback Signature
```javascript
/**
 * @param {string} actionName - The action name that changed.
 * @param {ComponentCapabilityEntry|RemovalMarker|null} capability - New entry, RemovalMarker, or null.
 */
componentCapabilityController.on('move', (actionName, capability) => {
    if (capability && capability._type === 'REMOVAL') {
        // Handle removal
    } else if (capability) {
        // Handle new/updated capability
    }
});
```

### When Notifications Fire
1. Component stat changes (via `onStatChange` → `reEvaluateActionForComponent`)
2. Entity spawns (via `reEvaluateEntityCapabilities`)
3. Entity despawns (via `removeEntityFromCache`)
4. Component no longer qualifies (entry removed from array)

---

## 7. Server Endpoints

The server (`src/server.js`) accesses the controller directly for capability endpoints:

| Endpoint | Method | Controller Call |
|----------|--------|----------------|
| `GET /action-capabilities` | `getCachedCapabilities()` | `worldStateController.componentCapabilityController.getCachedCapabilities()` |
| `GET /action-capabilities/:actionName` | `getBestComponentForAction()` | `worldStateController.componentCapabilityController.getBestComponentForAction()` |
| `GET /action-capabilities/entity/:entityId` | `getCapabilitiesForEntity()` | `worldStateController.componentCapabilityController.getCapabilitiesForEntity()` |
| `POST /refresh-entity-capabilities` | `reEvaluateEntityCapabilities()` | `worldStateController.componentCapabilityController.reEvaluateEntityCapabilities()` |

---

## 8. Performance

| Operation | Complexity | When Used |
|-----------|-----------|-----------|
| `scanAllCapabilities()` | O(E × C × A) | Initial load, full refresh |
| `reEvaluateActionForComponent()` | O(A) | Stat changes (preferred) |
| `reEvaluateEntityCapabilities()` | O(C × A) | Component add/remove |

Where E = entities, C = components per entity, A = actions.

---

## 9. Testing

Unit tests are located in `test/componentCapabilityController.test.js` covering:
- Constructor & initialization
- Scoring system
- Capability cache management
- Component requirement checking
- Re-evaluation
- Event subscriptions
- Stat change handler
- Cache cleanup
- Reverse index utilities

---

### 📢 Notice for Future Agents

**Language Requirement:** All source code must be written in **JavaScript**.

**Single Source of Truth:** Always refer to the wiki and its `subMDs` before implementing or modifying code.

**SRP Compliance:** Do NOT add action execution logic to this controller. Action execution belongs in `ActionController`. This controller is strictly responsible for capability cache management.