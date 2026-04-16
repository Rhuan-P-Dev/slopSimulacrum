# 🎮 Action System

## 1. Overview

The Action System provides a centralized, extensible mechanism for executing game actions on entities. It handles requirement validation, action execution, and consequence management through a modular registry-based architecture with a dispatcher pattern.

**Key Controllers:**
- `ActionController`: Main coordinator for all actions
- `WorldStateController`: Root injector providing access to all sub-controllers

---

## 2. Architecture

### 2.1. Dependency Injection Chain

```
Server → WorldStateController → (ConsequenceHandlers, actionRegistry) → ActionController
```

The `ActionController` is fully decoupled from data loading and handler instantiation. It receives the following via constructor injection from the `WorldStateController`:
- `WorldStateController`: Reference to the root controller for accessing sub-controllers.
- `ConsequenceHandlers`: The system responsible for executing action effects.
- `actionRegistry`: The parsed JSON configuration of available actions.

**Logging:** The system utilizes a centralized `Logger` utility (`src/utils/Logger.js`) for all system events, ensuring standardized severity levels (`INFO`, `WARN`, `ERROR`, `CRITICAL`).

### 2.2. Action Registry Structure

Each action is defined with three main components:

```javascript
{
    "actionName": {
        requirements: [
            {
                trait: "TraitName",
                stat: "statName",
                minValue: 5
            }
        ],
        consequences: [
            {
                type: "consequenceType",
                params: { /* parameters */ }
            }
        ],
        failureConsequences: [
            {
                type: "consequenceType",
                params: { /* parameters */ }
            }
        ]
    }
}
```

---

## 3. Action Requirements

### 3.1. Requirement Structure

Requirements define what an entity must have to perform an action. An action can have multiple requirements, which must all be satisfied.

| Property | Type | Description |
|----------|------|-------------|
| `trait` | string | The trait category (e.g., "Movement") |
| `stat` | string | The specific stat within the trait (e.g., "move") |
| `minValue` | number | The minimum value required (exclusive >) |

### 3.2. Requirement Checking

The `ActionController` checks each entity's components for the required traits and stats. The action only executes if there is at least one component that satisfies **all** the listed requirements.

**Component Tracking:** When requirements are met, the system identifies and tracks which specific components satisfied each requirement using a `fulfillingComponents` map (e.g., `{"Physical.durability": "component_id"}`). This map is passed to consequence handlers via a `context` object.

To ensure the "most capable" component is prioritized (e.g., avoiding the case where a general-purpose body component takes a penalty for an action performed by a specialized limb), the system uses a **Priority Scoring Mechanism**:
1. **Scoring**: Every component is scored based on how many of the action's total requirements it satisfies.
2. **Prioritization**: Components are sorted by score in descending order.
3. **Assignment**: Requirements are assigned to the highest-scoring compatible component.

This ensures that consequences targeting a trait/stat (like durability loss) are applied to the actual component that drove the action's success, rather than simply the first component found possessing that trait.

**Example:** Move action requires `Movement.move > 5`. Droid dash requires both `Movement.move > 5` AND `Physical.durability > 30`.

---

## 4. Consequences

### 4.1. Success Consequences

When requirements are met, the action executes its success consequences. Consequences are defined as an array of objects with two properties:

| Property | Type | Description |
|----------|------|-------------|
| `type` | string | The consequence type (e.g., "deltaSpatial", "log") |
| `params` | object | Parameters for the consequence, supports placeholder substitution |

**Consequence Types:**
- `deltaSpatial` - Adds delta values to current position (relative movement)
- `log` - Logs a message to console
- `updateStat` - Updates a component stat for all components with the trait
- `updateComponentStatDelta` - Updates a specific stat for a component. 
    - If `targetComponentId` is provided, it updates that component.
    - If no target is provided (self-targeting), the system first checks if a specific component fulfilled a requirement for the trait/stat being modified. If so, that component is targeted. Otherwise, it falls back to finding the first component on the entity that possesses the required trait/stat.
- `triggerEvent` - Triggers a server event
- `damageComponent` - Deals damage to a specific target component

**Placeholder Substitution:**
- `:trait.stat` - Replaced with the actual value of the specified trait and stat (e.g., `:Movement.move`).
- **Embedded Support**: Placeholders can now be embedded within strings (e.g., `"Power is :Physical.strength"`) and will be automatically resolved.
- **Arithmetic**: Supports signs and multipliers (e.g., `"-:Movement.move*2"`).

**Example:** Move using deltaSpatial for relative movement:
```javascript
consequences: [
    {
        type: "deltaSpatial",
        params: { speed: ":Movement.move" }  // Moves relative to current position
    }
]
```

### 4.2. Failure Consequences (failureConsequences)

When requirements fail, the failure consequences are executed using the same dispatcher pattern:

```javascript
failureConsequences: [
    {
        type: "log",
        level: "warn",
        message: "Action failed - requirement not met"
    }
]
```

**Common Failure Consequence Types:**
- `log` - Log the failure with specified level (info, warn, error)
- `triggerEvent` - Notify clients of failure

---

## 5. Controller Methods

### 5.1. ActionController.getActionsForEntity()

Retrieves only the actions that are relevant to a specific entity.

```javascript
/**
 * @param {Object} state - The current world state.
 * @param {string} entityId - The ID of the entity to filter for.
 * @returns {Object} Map of actions relevant to the entity.
 */
```

### 5.2. ActionController.executeAction()

Executes an action on an entity.

```javascript
/**
 * @param {string} actionName - The name of the action to execute.
 * @param {string} entityId - The ID of the entity to perform the action.
 * @param {Object} [params] - Additional action parameters.
 * @returns {Object} Result of the action execution.
 */
```

**Returns (Success):**
```javascript
{
    success: true,
    action: "move",
    entityId: "uuid-123",
    executedConsequences: 1,
    results: [
        {
            success: true, 
            type: "deltaSpatial", 
            message: "Entity moved", 
            data: { deltaUpdate: { x: 0, y: -20 }, newSpatial: { x: 0, y: -20 } }
        }
    ]
}
```

**Returns (Failure):**
```javascript
{
    "success": false,
    "error": "Requirement failed: No component possesses the required Movement.move (>= 5)",
    "executedFailureConsequences": 1,
    "results": [
        {
            "success": true,
            "type": "log",
            "message": "Logged: Action 'move' failed - requirement not met",
            "level": "warn"
        }
    ]
}
```

### 5.3. ActionController._executeConsequences()

Executes success consequences by reading from the action registry and dispatching to the injected `ConsequenceHandlers`.

```javascript
/**
 * @param {string} actionName - The name of the action.
 * @param {string} entityId - The ID of the entity.
 * @param {Object} requirementValues - Map of trait.stat values for substitution.
 * @param {Object} params - Additional action parameters.
 * @returns {Object} Result of consequence execution.
 */
```

### 5.4. ActionController.getActionCapabilities()

Calculates which entities are capable of executing which actions based on the current world state.

```javascript
/**
 * @param {Object} state - The current world state.
 * @returns {Object} Map of actions and their capability status.
 * Each entry in canExecute now includes:
 * - componentName: The type of the satisfying component.
 * - componentIdentifier: The identifier of the satisfying component.
 */
```

### 5.5. ActionController._executeFailureConsequences()

Executes failure consequences using the same dispatcher pattern.

```javascript
/**
 * @param {string} actionName - The action name.
 * @param {string} entityId - The entity ID.
 * @returns {Object} Result of failure consequence execution.
 */
```

### 5.6. ConsequenceHandlers.handlers

Instead of an internal dispatcher, the `ActionController` now uses a strategy map provided by the `ConsequenceHandlers` class. This allows handlers to be updated or replaced without modifying the `ActionController` logic.

### 5.7. stateEntityController.updateEntitySpatial()

Updates an entity's spatial coordinates.

```javascript
/**
 * @param {string} entityId - The ID of the entity.
 * @param {Object} spatialUpdate - Object with x and/or y values to update.
 * @returns {boolean} True if update was successful.
 */
```

**Usage:**
```javascript
worldStateController.stateEntityController.updateEntitySpatial(
    entityId,
    { y: newYValue }
);
```

---

## 6. Built-in Consequence Handlers

### 6.1. deltaSpatial

Adds delta values to current spatial position for relative movement.

**Parameters:**
| Property | Type | Description |
|----------|------|-------------|
| `speed` | number | Optional. Speed/distance to move towards target |
| `x` | number | Optional. Delta x to add to current position |
| `y` | number | Optional. Delta y to add to current position |

**Example:**
```javascript
{ type: "deltaSpatial", params: { speed: ":Movement.move" } }  // Move by trait value
```

**Note:** This handler is used for actions like `move` where the movement should be relative to the current position, not an absolute coordinate. When `targetX` and `targetY` are provided in `actionParams`, the handler calculates the direction and moves the entity towards the target by `speed` distance.

### 6.2. log

Logs a message to console with optional level.

**Parameters:**
| Property | Type | Description |
|----------|------|-------------|
| `message` | string | The message to log |
| `level` | string | Optional. Log level: "info", "warn", "error". Default: "info" |

**Example:**
```javascript
{ type: "log", level: "warn", message: "Action failed" }
```

### 6.3. updateStat

Updates a specific stat for an entity's component.

**Parameters**
| Property | Type | Description |
|----------|------|-------------|
| `trait` | string | The trait category (e.g., "Physical") |
| `stat` | string | The stat name to update |
| `value` | number | The new value |

**Example:**
```javascript
{ type: "updateStat", trait: "Physical", stat: "durability", value: 50 }
```

### 6.4. damageComponent

Deals damage to a specific component of a target entity.

**Parameters**
| Property | Type | Description |
|----------|------|-------------|
| `trait` | string | The trait to modify (e.g., "Physical") |
| `stat` | string | The stat to reduce (e.g., "durability") |
| `value` | number | The delta value (usually negative) |

**Note:** This handler requires `targetComponentId` to be passed in the `actionParams` from the client.

**Example:**
```javascript
{ type: "damageComponent", params: { trait: "Physical", stat: "durability", value: -25 } }
```

### 6.5. updateComponentStatDelta

Updates a specific stat for the component that triggered the action (the "calling component"). This is used for costs associated with specific equipment (e.g., durability loss on legs during a dash).

**Parameters:**
| Property | Type | Description |
|----------|------|-------------|
| `trait` | string | The trait category (e.g., "Physical") |
| `stat` | string | The stat name to modify |
| `value` | number | The delta value to add (use negative for reduction) |

**Example:**
```javascript
{ type: "updateComponentStatDelta", params: { trait: "Physical", stat: "durability", value: -5 } }
```

### 6.6. triggerEvent

Triggers a server event for client notifications.

**Parameters:**
| Property | Type | Description |
|----------|------|-------------|
| `eventType` | string | The event type name |
| `data` | object | Optional. Additional data to send |

**Example:**
```javascript
{ type: "triggerEvent", eventType: "action_complete", data: { action: "move" } }
```

---

## 7. Adding New Actions

### 7.1. Register a New Action

Add to `data/actions.json`:

```json
"attack": {
    "requirements": [
        {
            "trait": "Physical",
            "stat": "strength",
            "minValue": 10
        }
    ],
    "consequences": [
        {
            "type": "log",
            "level": "info",
            "message": "Entity attacked with strength :Physical.strength"
        }
    ],
    "failureConsequences": [
        {
            "type": "log",
            "level": "warn",
            "message": "Attack failed - strength too low"
        }
    ]
}
```

### 7.2. Adding New Consequence Types

To add a new consequence type:

1. Add a new handler method in `ConsequenceHandlers` class
2. Add the handler to the `handlers` getter in `ConsequenceHandlers`

```javascript
get handlers() {
    return {
        // ... existing handlers
        newType: (targetId, params, context) => this._handleNewType(targetId, params, context)
    };
}
```

---

## 8. Best Practices

### 8.1. Dependency Injection

Always inject `WorldStateController` into `ActionController`. Never create new controller instances inside `ActionController`.

### 8.2. Single Source of Truth

Use injected controllers to access and modify state. Do not cache state in the action controller.

### 8.3. Data-Driven Design

Keep actions in the registry pattern. Each action should be self-contained with clear requirements and consequences.

### 8.4. Extensibility

Use the dispatcher pattern for new consequence types. Keep handlers focused on single responsibilities.

### 8.5. Error Handling

Always validate inputs and return descriptive error messages when actions fail.

### 8.6. Placeholder Naming

Use the `:trait.stat` syntax (e.g., `:Movement.move`) to reference specific requirement values. Combine with arithmetic in strings for calculations:
- `":trait.stat"` - Positive value
- `" -:trait.stat"` - Negative value
- `":trait.stat*2"` - Multiplied value

---

## 9. Current Implementation Status

| Action | Requirements | Success Consequences | Failure Consequences |
|--------|-------------|---------------------|---------------------|
| move | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| dash | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| selfHeal | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| droid punch | ✅ Implemented | ✅ Implemented | ✅ Implemented |

---

## 10. HTTP API

### 10.1. POST /execute-action

Executes an action on an entity.

**Request:**
```json
{
    "actionName": "move",
    "entityId": "uuid-entity-123",
    "params": { "targetX": 50, "targetY": -30 }
}
```

**Success Response:**
```json
{
    "result": {
        "success": true,
        "action": "move",
        "entityId": "uuid-entity-123",
        "executedConsequences": 1,
        "results": [
            {
                "success": true,
                "type": "deltaSpatial",
                "message": "Entity moved",
                "data": { "deltaUpdate": { "x": 10, "y": -20 }, "newSpatial": { "x": 10, "y": -20 } }
            }
        ]
    }
}
```

**Failure Response (Requirements not met):**
```json
{
    "result": {
        "success": false,
        "error": "Requirement failed: No component possesses the required Movement.move (>= 5)",
        "executedFailureConsequences": 1,
        "results": [
            {
                "success": true,
                "type": "log",
                "message": "Logged: Action 'move' failed - requirement not met",
                "level": "warn"
            }
        ]
    }
}
```

---

## 11. Placeholder Substitution Logic

### 11.1. Implementation
The `_resolvePlaceholders` method uses a regular expression to identify and resolve `:trait.stat` markers within strings. This ensures that the resulting value is a **number**, preventing string concatenation bugs during spatial calculations.

**Current Logic:**
```javascript
const match = params.match(/^(-)?(:[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)(?:\*(-?\d+))?$/);
if (match) {
    const sign = match[1] === '-' ? -1 : 1;
    const placeholder = match[2].substring(1);
    const multiplier = match[3] ? parseInt(match[3], 10) : 1;
    const value = requirementValues[placeholder];
    if (value !== undefined) {
        return sign * value * multiplier;
    }
}
```

### 11.2. Supported Patterns
The system supports signs and multipliers, allowing for flexible action definitions:

| Pattern | Description | Example (Movement.move=20) | Result |
|---------|-------------|---------------------------|--------|
| `:trait.stat` | Base value | `":Movement.move"` | `20` |
| `-:trait.stat` | Negative value | `"-:Movement.move"` | `-20` |
| `:trait.stat*2` | Multiplied value | `":Movement.move*2"` | `40` |
| `-:trait.stat*2` | Negative multiplied | `"-:Movement.move*2"` | `-40` |

### 11.3. Integration
These resolved values are passed directly to consequence handlers (like `deltaSpatial`), ensuring correct mathematical operations on the entity's state.

---

### 📢 Notice for Future Agents

**Language Requirement:** All source code in this project must be written in **JavaScript**.

**Controller Pattern:** The `ActionController` follows the Dependency Injection pattern and should never instantiate its own controllers.

**Consequence Dispatcher:** All consequences are handled through the `ConsequenceHandlers` class. To add a new consequence type:
1. Add a handler method `_handle<Type>()` in `ConsequenceHandlers`
2. Register it in the `handlers` getter
3. Document it in this wiki
