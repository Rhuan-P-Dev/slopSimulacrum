# 🗂️ Action Capability Cache System

## 1. Overview

The **Action Capability Cache** is a core feature of the `ActionController` that maintains a persistent mapping of each action to its best fulfilling component across all entities. This enables real-time UI updates and efficient capability queries without redundant computation.

**Key Features:**
- **Persistent Cache**: Stores the best component for each action-entity pair
- **Automatic Re-evaluation**: Triggered when component stats change
- **Event-driven Notifications**: Subscribers are notified of capability changes
- **Reverse Index**: Efficient lookup of which actions depend on specific traits

---

## 2. Data Structure

### 2.1. Capability Cache Format

```javascript
/**
 * @type {Object<string, Object<string, ActionCapabilityEntry>>}
 * Format: { [actionName]: { [entityId]: ActionCapabilityEntry } }
 */
this._capabilityCache = {};
```

### 2.2. ActionCapabilityEntry Structure

```javascript
/**
 * @typedef {Object} ActionCapabilityEntry
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

### 2.3. Example Cache Entry

```json
{
  "move": {
    "entity-uuid-123": {
      "entityId": "entity-uuid-123",
      "componentId": "comp-uuid-456",
      "componentType": "droidRollingBall",
      "componentIdentifier": "default",
      "score": 1.0,
      "requirementValues": {
        "Movement.move": 20
      },
      "fulfillingComponents": {
        "Movement.move": "comp-uuid-456"
      },
      "requirementsStatus": [
        {
          "trait": "Movement",
          "stat": "move",
          "current": 20,
          "required": 5
        }
      ]
    }
  }
}
```

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

Defined in `src/controllers/actionController.js`:

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

The reverse index (`_componentActionIndex`) maps `trait.stat` combinations to the set of action names that depend on them. This enables efficient lookup when a stat changes.

### 4.2. Structure

```javascript
/**
 * @type {Map<string, Set<string>>}
 * Format: { "Movement.move": Set{"move", "dash"}, "Physical.durability": Set{"dash", "selfHeal"} }
 */
this._componentActionIndex = new Map();
```

### 4.3. Building the Index

The index is built automatically from the action registry during controller construction:

```javascript
_buildComponentActionIndex() {
    for (const [actionName, actionData] of Object.entries(this.actionRegistry)) {
        for (const req of actionData.requirements) {
            const indexKey = `${req.trait}.${req.stat}`;
            if (!this._componentActionIndex.has(indexKey)) {
                this._componentActionIndex.set(indexKey, new Set());
            }
            this._componentActionIndex.get(indexKey).add(actionName);
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
 * @param {ActionCapabilityEntry|null} capability - The new capability entry, or null if removed.
 */
```

### 5.4. When Notifications Fire

Notifications are triggered when:
1. A component stat changes (via `onStatChange`)
2. The re-evaluated component becomes the new best for an action
3. A component is removed from the cache (no longer qualifies)

---

## 6. Stat Change Flow

### 6.1. Notification Chain

```
ComponentController.updateComponentStatDelta()
    → _notifyStatChangeListeners()
        → ActionController.onStatChange()
            → _getActionsForTraitStat()
                → reEvaluateActionForComponent()
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
6. If the component no longer qualifies (durability < 30), it's removed from the cache
7. Subscribers are notified: `_notifySubscribers("dash", null)`

---

## 7. Server Endpoints

### 7.1. GET /action-capabilities

Returns the full cached capability data for all actions.

**Response:**
```json
{
  "capabilities": {
    "move": {
      "entity-uuid-123": { /* ActionCapabilityEntry */ }
    },
    "dash": {
      "entity-uuid-123": { /* ActionCapabilityEntry */ }
    }
  }
}
```

### 7.2. GET /action-capabilities/:actionName

Returns the best component for a specific action.

**Response:**
```json
{
  "actionName": "move",
  "bestComponent": {
    "entityId": "entity-uuid-123",
    "componentId": "comp-uuid-456",
    "componentType": "droidRollingBall",
    "componentIdentifier": "default",
    "score": 1.0,
    "requirementValues": { "Movement.move": 20 },
    "fulfillingComponents": { "Movement.move": "comp-uuid-456" },
    "requirementsStatus": [ /* ... */ ]
  }
}
```

### 7.3. GET /action-capabilities/entity/:entityId

Returns all capability entries for a specific entity.

**Response:**
```json
{
  "entityId": "entity-uuid-123",
  "capabilities": {
    "move": { /* ActionCapabilityEntry */ },
    "dash": { /* ActionCapabilityEntry */ }
  }
}
```

---

## 8. Performance Considerations

### 8.1. Full Scan Complexity

`scanAllCapabilities()` has O(E × C × A) complexity where:
- E = number of entities
- C = components per entity
- A = number of actions

For typical use cases (few entities, ~10 components each, ~10 actions), this is negligible.

### 8.2. Partial Re-evaluation

`reEvaluateActionForComponent()` has O(A) complexity where A = number of dependent actions.
This is the preferred method for stat changes.

### 8.3. Cache Invalidation

The cache is automatically invalidated when:
1. Entity is spawned/despawned (full scan on next `getActionCapabilities()` call)
2. Component stats change (partial re-evaluation)
3. Action registry changes (call `scanAllCapabilities()` manually)

---

## 9. Client-Side Integration

### 9.1. Fetching Capabilities

```javascript
// Fetch all capabilities
const response = await fetch('/action-capabilities');
const { capabilities } = await response.json();

// Fetch capabilities for a specific entity
const entityResponse = await fetch(`/action-capabilities/entity/${entityId}`);
const { capabilities } = await entityResponse.json();
```

### 9.2. Real-time Updates (Future)

To implement real-time UI updates, the server can broadcast capability changes via Socket.io:

```javascript
// In ActionController._notifySubscribers()
io.emit('action-capability-changed', { actionName, capability });
```

---

## 10. Best Practices

### 10.1. Use Cached Data

Always prefer `getCachedCapabilities()` over recomputing. The cache is automatically maintained.

### 10.2. Subscribe to Changes

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

### 10.3. Initial Scan

The initial capability scan is automatically performed after world initialization. No manual call is needed.

---

### 📢 Notice for Future Agents

**Language Requirement:** All source code in this project must be written in **JavaScript**.

**Single Source of Truth:** Always refer to the wiki and its `subMDs` before implementing or modifying code.
