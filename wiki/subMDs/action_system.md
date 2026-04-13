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
Server → WorldStateController → ActionController
```

The `ActionController` receives a reference to `WorldStateController` via constructor injection, enabling it to access all other sub-controllers (entities, components, rooms) without creating its own instances.

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
| `trait` | string | The trait category (e.g., "Movimentation") |
| `stat` | string | The specific stat within the trait (ee.g., "move") |
| `minValue` | number | The minimum value required (exclusive >) |

### 3.2. Requirement Checking

The `ActionController` checks each entity's components for the required traits and stats. The action only executes if there is at least one component that satisfies **all** the listed requirements.

**Example:** Move action requires `Movimentation.move > 5`. Droid dash requires both `Movimentation.move > 5` AND `Physical.durability > 30`.

---

## 4. Consequences

### 4.1. Success Consequences

When requirements are met, the action executes its success consequences. Consequences are defined as an array of objects with two properties:

| Property | Type | Description |
|----------|------|-------------|
| `type` | string | The consequence type (e.g., "updateSpatial", "log") |
| `params` | object | Parameters for the consequence, supports placeholder substitution |

**Consequence Types:**
- `updateSpatial` - Sets absolute spatial coordinates
- `deltaSpatial` - Adds delta values to current position (relative movement)
- `log` - Logs a message to console
- `updateStat` - Updates a component stat for all components with the trait
- `updateComponentStatDelta` - Updates a specific stat for the specific component that satisfied the action's requirements
- `triggerEvent` - Triggers a server event

**Placeholder Substitution:**
- `:trait.stat` - Replaced with the actual value of the specified trait and stat (e.g., `:Movimentation.move`)
- `" -:trait.stat"` - Replaced with the negative value of the specified trait and stat (e.g., "-:Movimentation.move")

**Example:** Move upward by the move value (using deltaSpatial for relative movement):
```javascript
consequences: [
    {
        type: "deltaSpatial",
        params: { y: "-:Movimentation.move" }  // Moves relative to current position
    }
]
```

### 4.1.1. Choosing the Right Spatial Handler

| Handler | Use Case | Example |
|---------|----------|---------|
| `updateSpatial` | Set absolute coordinates | `{ y: 100 }` sets y to exactly 100 |
| `deltaSpatial` | Move relative to current | `{ y: -20 }` moves up by 20 pixels |

**Example:** Move upward by the move value (using deltaSpatial for relative movement):
```javascript
consequences: [
    {
        type: "deltaSpatial",
        params: { y: "-:Movimentation.move" }  // Moves relative to current position
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
            type: "updateSpatial",
            message: "Spatial coordinates updated",
            spatialUpdate: { y: -20 },
            newSpatial: { x: 0, y: -20 }
        }
    ]
}
```

**Returns (Failure):**
```j
{
    "success": false,
    "error": "Requirement failed: No component has \"Movimentation.move\" > 5",
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

Executes success consequences by reading from the action registry and dispatching to handlers.

```javascript
/**
 * @param {string} actionName - The name of the action.
 * @param {string} entityId - The ID of the entity.
 * @param {number} traitValue - The trait value for placeholder substitution.
 * @param {Object} params - Additional action parameters.
 * @returns {Object} Result of consequence execution.
 */
```

### 5.2.1. ActionController.getActionCapabilities()

Calculates which entities are capable of executing which actions based on the current world state.

```javascript
/**
 * @param {Object} state - The current world state.
 * @returns {Object} Map of actions and their capability status.
 */
```

### 5.4. ActionController._executeFailureConsequences()

Executes failure consequences using the same dispatcher pattern.

```javascript
/**
 * @param {string} actionName - The name of the action.
 * @param {string} entityId - The ID of the entity.
 * @returns {Object} Result of failure consequence execution.
 */
```

### 5.5. ActionController._dispatchConsequence()

Dispatches a consequence to the appropriate handler based on its type.

```javascript
/**
 * @param {string} type - The consequence type (e.g., "updateSpatial", "log").
 * @param {string} entityId - The ID of the entity.
 * @param {Object} params - The consequence parameters.
 * @param {number} traitValue - The trait value for parameter substitution.
 * @param {Object} actionParams - Additional action parameters.
 * @returns {Object} Result from the handler.
 */
```

### 5.6. stateEntityController.updateEntitySpatial()

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

### 6.1. updateSpatial

Sets an entity's spatial coordinates to absolute values.

**Parameters:**
| Property | Type | Description |
|----------|------|-------------|
| `x` | number | Optional. New absolute x coordinate |
| `y` | number | Optional. New absolute y coordinate |

**Example:**
```javascript
{ type: "updateSpatial", params: { y: 100 } }  // Sets y to exactly 100
```

### 6.2. deltaSpatial

Adds delta values to current spatial position for relative movement.

**Parameters:**
| Property | Type | Description |
|----------|------|-------------|
| `x` | number | Optional. Delta x to add to current position |
| `y` | number | Optional. Delta y to add to current position |

**Example:**
```javascript
{ type: "deltaSpatial", params: { y: "-:Movimentation.move" } }  // Move up by trait value
```

**Note:** This handler is used for actions like `move` where the movement should be relative to the current position, not an absolute coordinate.

### 6.3. log

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

### 6.4. updateStat

Updates a specific stat for all components with the specified trait.

**Parameters:**
| Property | Type | Description |
|----------|------|-------------|
| `trait` | string | The trait category (e.g., "Physical") |
| `stat` | string | The stat name to update |
| `value` | number | The new value |

**Example:**
```javascript
{ type: "updateStat", trait: "Physical", stat: "durability", value: 50 }
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

Add to `ActionController.actionRegistry`:

```javascript
"attack": {
    requirements: [
        {
            trait: "Physical",
            stat: "strength",
            minValue: 10
        }
    ],
    consequences: [
        {
            type: "log",
            level: "info",
            message: "Entity attacked with strength :traitValue"
        },
        {
            type: "updateStat",
            trait: "Physical",
            stat: "durability",
            value: ":traitValue"
        }
    ],
    failureConsequences: [
        {
            type: "log",
            level: "warn",
            message: "Attack failed - strength too low"
        }
    ]
}
```

### 7.2. Adding New Consequence Types

To add a new consequence type:

1. Add a new handler method: `_handleNewType(entityId, params)`
2. Add the handler to the dispatchers in `_dispatchConsequence()`:

```javascript
const handlers = {
    updateSpatial: () => this._handleUpdateSpatial(entityId, resolvedParams),
    log: () => this._handleLog(resolvedParams),
    // ... existing handlers
    newType: () => this._handleNewType(entityId, resolvedParams)
};
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

Use the `:trait.stat` syntax (e.g., `:Movimentation.move`) to reference specific requirement values. Combine with arithmetic in strings for calculations:
- `" -:trait.stat"` - Negative value
- `"+:trait.stat"` - Positive value
- `"x:trait.stat"` - Prefix with 'x'

---

## 9. Complete Action Registry Example

```javascript
this.actionRegistry = {
    "move": {
        requirements: [
            {
                trait: "Movimentation",
                stat: "move",
                minValue: 5
            }
        ],
        consequences: [
            {
                type: "deltaSpatial",
                params: { speed: ":Movimentation.move" }
            }
        ],
        failureConsequences: [
            {
                type: "log",
                level: "warn",
                message: "Action 'move' failed - requirement not met"
            }
        ]
    },
    "dash": {
        requirements: [
            {
                trait: "Movimentation",
                stat: "move",
                minValue: 5
            },
            {
                trait: "Physical",
                stat: "durability",
                minValue: 30
            }
        ],
        consequences: [
            {
                type: "deltaSpatial",
                params: { speed: ":Movimentation.move*2" }
            },
            {
                type: "updateComponentStatDelta",
                params: { trait: "Physical", stat: "durability", value: -5 }
            }
        ],
        failureConsequences: [
            {
                type: "log",
                level: "warn",
                message: "Action 'dash' failed - requirement not met"
            }
        ]
    },
    "attack": {
        requirements: [
            {
                trait: "Physical",
                stat: "strength",
                minValue: 10
            }
        ],
        consequences: [
            {
                type: "log",
                level: "info",
                message: "Entity attacked with strength :Physical.strength"
            },
            {
                type: "updateStat",
                trait: "Physical",
                stat: "durability",
                value: ":Physical.strength"
            }
        ],
        failureConsequences: [
            {
                type: "log",
                level: "warn",
                message: "Attack failed - strength too low"
            }
        ]
    }
};
```

---

## 10. HTTP API

### 10.1. POST /execute-action

Executes an action on an entity.

**Request:**
```json
{
    "actionName": "move",
    "entityId": "uuid-entity-123",
    "params": {}
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
                "type": "updateSpatial",
                "message": "Spatial coordinates updated",
                "spatialUpdate": { "y": -20 },
                "newSpatial": { "x": 0, "y": -20 }
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
        "error": "Requirement failed: No component possesses the required Movimentation.move (> 5)",
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
*Note: Error messages are now generated using a centralized `ERROR_REGISTRY` for consistency.*

---

## 11. Current Implementation Status

| Action | Requirements | Success Consequences | Failure Consequences |
|--------|-------------|---------------------|---------------------|
| move - up | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| move - down | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| move - left | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| move - right | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| move - up-left | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| move - up-right | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| move - down-left | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| move - down-right | ✅ Implemented | ✅ Implemented | ✅ Implemented |
| attack | ⚠️ Ready to add | ⚠️ Ready to add | ⚠️ Ready to add |

---

### 📢 Notice for Future Agents

**Language Requirement:** All source code in this project must be written in **JavaScript**.

**Controller Pattern:** The `ActionController` follows the Dependency Injection pattern and should never instantiate its own controllers.

**Consequence Dispatcher:** All consequences are handled through the dispatcher pattern. To add a new consequence type:
1. Add a handler method `_handle<Type>()`
2. Register it in `_dispatchConsequence()` handlers object
3. Document it in this wiki

---

## 12. Placeholder Substitution Logic

### 12.1. Implementation
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

### 12.2. Supported Patterns
The system supports signs and multipliers, allowing for flexible action definitions:

| Pattern | Description | Example (Movimentation.move=20) | Result |
|---------|-------------|--------------------------------|-------------------|
| `:trait.stat` | Base value | `":Movimentation.move"` | `20` |
| `-:trait.stat` | Negative value | `"-:Movimentation.move"` | `-20` |
| `:trait.stat*2` | Multiplied value | `":Movimentation.move*2"` | `40` |
| `-:trait.stat*2` | Negative multiplied | `"-:Movimentation.move*2"` | `-40` |

### 12.3. Integration
These resolved values are passed directly to consequence handlers (like `deltaSpatial`), ensuring correct mathematical operations on the entity's state.
