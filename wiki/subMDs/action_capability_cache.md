# 🗂️ Action Capability Cache System

## 1. Overview

The **Action Capability Cache** is a core feature of the `ActionController` that maintains a mapping of each action to an array of component capability entries. Every component in the world that qualifies for an action gets its own entry, sorted by score (best first).

**Key Features:**
- **All-Component Tracking**: Every qualifying component gets its own entry (not just the best one)
- **Automatic Re-evaluation**: Triggered when component stats change, entities spawn/despawn
- **Event-driven Notifications**: Subscribers are notified of capability changes
- **Reverse Index**: Efficient lookup of which actions depend on specific traits

---

## 2. Data Structure

### 2.1. Capability Cache Format

```javascript
/**
 * @type {Object<string, Array<ComponentCapabilityEntry>>}
 * Format: { [actionName]: [ComponentCapabilityEntry, ...] }
 */
this._capabilityCache = {};
```

### 2.2. ComponentCapabilityEntry Structure

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

### 2.3. Example Cache State

```json
{
  "_capabilityCache": {
    "pierce": [
      {
        "entityId": "entity-uuid-1",
        "componentId": "knife-comp-123",
        "componentType": "knife",
        "componentIdentifier": "kitchen-knife",
        "score": 95,
        "requirementValues": { "Physical.strength": 15, "Manipulation.dexterity": 12 },
        "fulfillingComponents": { "Physical.strength": "knife-comp-123", "Manipulation.dexterity": "knife-comp-123" },
        "requirementsStatus": [
          { "trait": "Physical", "stat": "strength", "current": 15, "required": 5 },
          { "trait": "Manipulation", "stat": "dexterity", "current": 12, "required": 8 }
        ]
      },
      {
        "entityId": "entity-uuid-1",
        "componentId": "hand-comp-456",
        "componentType": "droidHand",
        "componentIdentifier": "right",
        "score": 30,
        "requirementValues": { "Manipulation.dexterity": 8 },
        "fulfillingComponents": { "Manipulation.dexterity": "hand-comp-456" },
        "requirementsStatus": [
          { "trait": "Manipulation", "stat": "dexterity", "current": 8, "required": 8 }
        ]
      }
    ],
    "move": [
      {
        "entityId": "entity-uuid-1",
        "componentId": "wheel-comp-001",
        "componentType": "droidRollingBall",
        "componentIdentifier": "default",
        "score": 100,
        "requirementValues": { "Movement.move": 20 },
        "fulfillingComponents": { "Movement.move": "wheel-comp-001" },
        "requirementsStatus": [
          { "trait": "Movement", "stat": "move", "current": 20, "required": 5 }
        ]
      }
    ]
  }
}
```

### 2.4. Entity-Specific View

When querying `getActionsForEntity(state, entityId)`, entries are **filtered by entityId**:

```json
{
  "pierce": {
    "canExecute": [
      { "componentId": "knife-comp-123", "score": 95, "entityId": "entity-uuid-1", ... },
      { "componentId": "hand-comp-456", "score": 30, "entityId": "entity-uuid-1", ... }
    ],
    "cannotExecute": []
  }
}
```

Entity-uuid-2's components are stored in the cache but **never shown** when querying entity-uuid-1's actions.

---

## 3. Scoring Algorithm

### 3.1. Score Calculation

Each component receives a score based on how well it satisfies an action's requirements:

| Condition | Score |
|-----------|-------|
| Requirement satisfied (value >= minValue) | +1.0 |
| Requirement exceeded by >2x threshold | +0.1 × (excessRatio - 1) |
| Close to threshold (>80% of minValue) | -0.2 |
| Requirement not met | +0 |

### 3.2. Scoring Constants

Defined in `src/utils/ActionScoring.js`:

```javascript
const ACTION_SCORING = {
    REQUIREMENT_MET: 1.0,
    REQUIREMENT_EXCEEDED_BONUS: 0.1,
    CLOSE_TO_THRESHOLD_PENALTY: -0.2,
    EXCEEDED_THRESHOLD_MULTIPLIER: 2.0
};
```

### 3.3. Example Scores

| Component | Action | Score | Reason |
|-----------|--------|-------|--------|
| droidRollingBall (move=20) | move (min=5) | 1.0 | Satisfies 1 requirement |
| droidRollingBall (move=20) | dash (move>5, dur>30) | 1.0 | Satisfies 1 of 2 requirements |
| droidHand (strength=25) | droid punch (strength>15) | 1.0 | Satisfies 1 requirement |

---

## 4. Reverse Index

### 4.1. Purpose

The reverse index (`_traitStatActionIndex`) maps `trait.stat` combinations to the set of action names that depend on them. This enables efficient lookup when a stat changes.

### 4.2. Structure

```javascript
/**
 * @type {Map<string, Set<string>>}
 * Format: { "Movement.move": Set{"move", "dash"}, "Physical.durability": Set{"dash", "selfHeal"} }
 */
this._traitStatActionIndex = new Map();
```

### 4.3. Building the Index

The index is built automatically from the action registry during controller construction:

```javascript
_buildTraitStatActionIndex() {
    for (const [actionName, actionData] of Object.entries(this.actionRegistry)) {
        for (const req of actionData.requirements) {
            const indexKey = `${req.trait}.${req.stat}`;
            if (!this._traitStatActionIndex.has(indexKey)) {
                this._traitStatActionIndex.set(indexKey, new Set());
            }
            this._traitStatActionIndex.get(indexKey).add(actionName);
        }
    }
}
```

---

## 5. Event Subscription System

### 5.1. Purpose

The event subscription system allows dependent systems (e.g., UI) to be notified when action capabilities change.

### 5.2. API

```javascript
// Subscribe to capability changes for a specific action
actionController.on('move', (actionName, capabilityEntry) => {
    console.log(`Capability for "${actionName}" changed:`, capabilityEntry);
});

// Unsubscribe
actionController.off('move', callbackFunction);
```

### 5.3. Callback Signature

```javascript
/**
 * @param {string} actionName - The action name that changed.
 * @param {ComponentCapabilityEntry|RemovalMarker|null} capability - The new capability entry, a RemovalMarker if removed, or null.
 */
```

### 5.4. Removal Marker

When a capability entry is removed from the cache, subscribers receive a `RemovalMarker` object instead of `null`:

```javascript
/**
 * @typedef {Object} RemovalMarker
 * @property {string} _type - Always 'REMOVAL'.
 * @property {string} componentId - The removed component's ID (or 'multiple' for entity-wide removal).
 * @property {string} entityId - The removed entity's ID.
 */
```

Subscribers should check for removal markers:

```javascript
actionController.on('dash', (actionName, capability) => {
    if (capability && capability._type === 'REMOVAL') {
        console.log(`Component ${capability.componentId} removed from ${actionName}`);
        disableDashButton();
    } else if (capability) {
        enableDashButton();
    }
});
```

### 5.5. When Notifications Fire

Notifications are triggered when:
1. A component stat changes (via `onStatChange`)
2. An entity is spawned or its components change (via `reEvaluateEntityCapabilities`)
3. An entity is despawned (via `removeEntityFromCache`)
4. A component is removed from the cache (no longer qualifies)

---

## 6. Stat Change Flow

### 6.1. Notification Chain

```
ComponentController.updateComponentStatDelta()
    → _notifyStatChangeListeners()
        → ActionController.onStatChange()
            → _getActionsForTraitStat()
                → reEvaluateActionForComponent()
                    → find entry in array → update/remove → re-sort
                    → _notifySubscribers()
```

### 6.2. Registration

The subscription is registered in `WorldStateController`:

```javascript
this.componentController.registerStatChangeListener((componentId, traitId, statName, newValue, oldValue) => {
    this.actionController.onStatChange(componentId, traitId, statName, newValue, oldValue);
});
```

### 6.3. Example: Durability Loss

When a component's durability decreases:

1. `ComponentController.updateComponentStatDelta(compId, "Physical", "durability", -5)` is called
2. `_notifyStatChangeListeners(compId, "Physical", "durability", 75, 80)` fires
3. `ActionController.onStatChange(compId, "Physical", "durability", 75, 80)` is called
4. `_getActionsForTraitStat("Physical", "durability")` returns `["dash", "selfHeal"]`
5. Each action is re-evaluated: `reEvaluateActionForComponent(state, "dash", compId)`
6. If the component no longer qualifies (durability < 30), it's removed from the action's array
7. Subscribers are notified: `_notifySubscribers("dash", null)`

**Important**: The underlying `ComponentStatsController.setStats()` method performs a **deep trait-level merge** when updating stats. This ensures that modifying `Physical.durability` does not erase other Physical traits like `Physical.mass`, `Physical.strength`, etc. See `wiki/subMDs/traits.md` Section 5 for details on the merge algorithm.

---

## 7. Entity Lifecycle Integration

### 7.1. Entity Spawn

When `stateEntityController.spawnEntity()` creates a new entity:

```javascript
// In stateEntityController.spawnEntity():
const entityId = generateUID();
// ... create entity ...
// Trigger capability cache re-evaluation for the newly spawned entity
if (this.actionController) {
    const state = this.actionController.worldStateController.getAll();
    this.actionController.reEvaluateEntityCapabilities(state, entityId);
}
```

This evaluates all components of the new entity against all actions and adds qualifying entries to the cache.

### 7.2. Entity Despawn

When `stateEntityController.despawnEntity()` removes an entity:

```javascript
// Before entity is removed:
if (this.actionController) {
    this.actionController.removeEntityFromCache(entityId);
}
delete this.entities[entityId];
```

This removes all capability entries for the entity from all action arrays.

### 7.3. Component Addition/Removal (e.g., "entity picks up a knife")

When an entity's component set changes (e.g., picks up/drops an item):

```javascript
// Via POST /refresh-entity-capabilities API:
const state = worldStateController.getAll();
const updatedEntries = worldStateController.actionController.reEvaluateEntityCapabilities(state, entityId);
```

This removes all entries for the entity from all actions, then re-scans all components against all actions.

---

## 8. Server Endpoints

### 8.1. GET /action-capabilities

Returns the full cached capability data for all actions.

**Response:**
```json
{
  "capabilities": {
    "pierce": [
      { "entityId": "e1", "componentId": "knife-comp", "score": 95, ... },
      { "entityId": "e1", "componentId": "hand-comp", "score": 30, ... }
    ],
    "move": [
      { "entityId": "e1", "componentId": "wheel-comp", "score": 100, ... }
    ]
  }
}
```

### 8.2. GET /action-capabilities/:actionName

Returns all entries for a specific action (sorted by score).

**Response:**
```json
{
  "actionName": "pierce",
  "bestComponent": {
    "entityId": "e1",
    "componentId": "knife-comp",
    "componentType": "knife",
    "componentIdentifier": "kitchen-knife",
    "score": 95,
    "requirementValues": { "Physical.strength": 15, "Manipulation.dexterity": 12 },
    "fulfillingComponents": { "Physical.strength": "knife-comp", "Manipulation.dexterity": "knife-comp" },
    "requirementsStatus": [ ... ]
  }
}
```

### 8.3. GET /action-capabilities/entity/:entityId

Returns all capability entries for a specific entity across all actions.

**Response:**
```json
{
  "entityId": "entity-uuid-1",
  "capabilities": [
    { "actionName": "pierce", "componentId": "knife-comp", "score": 95, ... },
    { "actionName": "pierce", "componentId": "hand-comp", "score": 30, ... },
    { "actionName": "move", "componentId": "wheel-comp", "score": 100, ... }
  ]
}
```

### 8.4. POST /refresh-entity-capabilities

Re-evaluates all action capabilities for a specific entity.

**Request:**
```json
{ "entityId": "entity-uuid-1" }
```

**Response:**
```json
{
  "entityId": "entity-uuid-1",
  "updatedEntries": [
    { "actionName": "pierce", "componentId": "knife-comp", "score": 95, ... },
    { "actionName": "move", "componentId": "wheel-comp", "score": 100, ... }
  ]
}
```

---

## 9. Performance Considerations

### 9.1. Full Scan Complexity

`scanAllCapabilities()` has O(E × C × A) complexity where:
- E = number of entities
- C = components per entity
- A = number of actions

For typical use cases (few entities, ~10 components each, ~10 actions), this is negligible.

### 9.2. Partial Re-evaluation

`reEvaluateActionForComponent()` has O(A) complexity where A = number of dependent actions.
This is the preferred method for stat changes.

### 9.3. Entity Re-evaluation

`reEvaluateEntityCapabilities()` has O(C × A) complexity where C = components of the entity, A = number of actions.
This is used when an entity's component set changes.

### 9.4. Cache Invalidation

The cache is automatically invalidated when:
1. Entity is spawned (full re-evaluation via `reEvaluateEntityCapabilities`)
2. Entity is despawned (cleanup via `removeEntityFromCache`)
3. Component stats change (partial re-evaluation via `onStatChange`)
4. Entity components change (full re-evaluation via `reEvaluateEntityCapabilities`)

---

## 10. Client-Side Integration

### 10.1. Fetching Capabilities

```javascript
// Fetch all capabilities
const response = await fetch('/action-capabilities');
const { capabilities } = await response.json();

// Fetch capabilities for a specific entity
const entityResponse = await fetch(`/action-capabilities/entity/${entityId}`);
const { capabilities } = await entityResponse.json();

// Refresh capabilities after picking up/dropping an item
await fetch('/refresh-entity-capabilities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entityId })
});
```

### 10.2. Real-time Updates (Future)

To implement real-time UI updates, the server can broadcast capability changes via Socket.io:

```javascript
// In ActionController._notifySubscribers()
io.emit('action-capability-changed', { actionName, capability });
```

---

## 11. Public API Methods

### 11.1. scanAllCapabilities(state)

Performs a full bottom-up scan of all entities and their components against all registered actions.

```javascript
/**
 * @param {Object} state - The current world state (contains entities).
 * @returns {Object<string, Array<ComponentCapabilityEntry>>} The updated capability cache.
 */
```

### 11.2. reEvaluateActionForComponent(state, actionName, componentId)

Re-evaluates a specific action for a specific component. Finds the entry in the array and updates or removes it.

```javascript
/**
 * @param {Object} state - The current world state.
 * @param {string} actionName - The action to re-evaluate.
 * @param {string} componentId - The component whose stats changed.
 * @returns {ComponentCapabilityEntry|null} The updated capability entry, or null.
 */
```

### 11.3. reEvaluateEntityCapabilities(state, entityId)

Re-evaluates ALL actions for a specific entity. Called when the entity's component set changes.

```javascript
/**
 * @param {Object} state - The current world state.
 * @param {string} entityId - The entity to re-evaluate.
 * @returns {Array<ComponentCapabilityEntry>} List of updated capability entries.
 */
```

### 11.4. removeEntityFromCache(entityId)

Removes all capability entries for an entity from all action caches.

```javascript
/**
 * @param {string} entityId - The entity ID to remove.
 */
```

### 11.5. getCachedCapabilities()

Returns the cached capability entries for all actions.

```javascript
/**
 * @returns {Object<string, Array<ComponentCapabilityEntry>>} The capability cache.
 */
```

### 11.6. getBestComponentForAction(actionName)

Returns the best entry for a specific action (highest score, first in array).

```javascript
/**
 * @param {string} actionName - The action name.
 * @returns {ComponentCapabilityEntry|null} The best capability entry, or null.
 */
```

### 11.7. getAllCapabilitiesForAction(actionName)

Returns all capability entries for a specific action.

```javascript
/**
 * @param {string} actionName - The action name.
 * @returns {Array<ComponentCapabilityEntry>} Array of capability entries.
 */
```

### 11.8. getCapabilitiesForEntity(entityId)

Returns capability entries for a specific entity across all actions.

```javascript
/**
 * @param {string} entityId - The entity ID.
 * @returns {Array<ComponentCapabilityEntry>} Array of capability entries for this entity.
 */
```

### 11.9. getActionsForEntity(state, entityId)

Retrieves only the actions that are relevant to a specific entity.

```javascript
/**
 * @param {Object} state - The current world state.
 * @param {string} entityId - The ID of the entity to filter for.
 * @returns {Object.<string, {requirements: Array, canExecute: Array, cannotExecute: Array}>}
 * Map of actions and their capability status for the entity.
 */
```

### 11.10. getActionCapabilities(state)

Calculates which entities are capable of executing which actions.

```javascript
/**
 * @param {Object} state - The current world state.
 * @returns {Object.<string, {requirements: Array, canExecute: Array, cannotExecute: Array}>}
 * Map of actions and their capability status.
 */
```

### 11.11. onStatChange(componentId, traitId, statName, newValue, oldValue)

Called when a component stat changes. Re-evaluates all dependent actions.

```javascript
/**
 * @param {string} componentId - The component instance ID that changed.
 * @param {string} traitId - The trait category that changed.
 * @param {string} statName - The stat name that changed.
 * @param {any} newValue - The new stat value.
 * @param {any} oldValue - The previous stat value.
 */
```

### 11.12. on(actionName, callback) / off(actionName, callback)

Subscribe/unsubscribe to capability change events for a specific action.

```javascript
/**
 * @param {string} actionName - The action name to subscribe to.
 * @param {Function} callback - Called with (actionName, capabilityEntry).
 */
```

---

## 12. Best Practices

### 12.1. Use Cached Data

Always prefer `getCachedCapabilities()` over recomputing. The cache is automatically maintained.

### 12.2. Subscribe to Changes

For UI components, subscribe to capability changes rather than polling:

```javascript
actionController.on('dash', (actionName, capability) => {
    if (capability) {
        enableDashButton();
    } else {
        disableDashButton();
    }
});
```

### 12.3. Refresh on Component Changes

When an entity picks up or drops an item, trigger a refresh:

```javascript
await fetch('/refresh-entity-capabilities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entityId })
});
```

---

### 📢 Notice for Future Agents

**Language Requirement:** All source code in this project must be written in **JavaScript**.

**Single Source of Truth:** Always refer to the wiki and its `subMDs` before implementing or modifying code.
