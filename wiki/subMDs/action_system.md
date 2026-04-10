# 🎮 Action System

## 1. Overview

The Action System provides a centralized mechanism for executing game actions on entities. It handles requirement validation, action execution, and consequence management through a modular registry-based architecture.

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
        requirements: {
            trait: "Movimentation",
            stat: "move",
            minValue: 5
        },
        consequences: {
            // Success consequence implementation
        },
        consequencesDeFalha: {
            // Failure consequence implementation (TODO)
        }
    }
}
```

---

## 3. Action Requirements

### 3.1. Requirement Structure

Requirements define what an entity must have to perform an action:

| Property | Type | Description |
|----------|------|-------------|
| `trait` | string | The trait category (e.g., "Movimentation") |
| `stat` | string | The specific stat within the trait (e.g., "move") |
| `minValue` | number | The minimum value required (exclusive >) |

### 3.2. Requirement Checking

The `ActionController` checks each entity's components for the required trait and stat. The action only executes if at least one component meets the requirement.

**Example:** Move action requires `Movimentation.move > 5`

---

## 4. Consequences

### 4.1. Success Consequences

When requirements are met, the action executes its success consequences. For the move action:

- **Spatial Update**: Entity moves upward by decreasing the `y` coordinate
- **Controller Call**: Uses `stateEntityController.updateEntitySpatial()` to modify position
- **Return Value**: Includes move amount and new spatial coordinates

### 4.2. Failure Consequences (consequencesDeFalha)

When requirements fail, the failure consequences are executed:

```javascript
// TODO: Implement failure consequences
// Possible implementations:
// - Log the failure
// - Apply penalties (energy cost, cooldown, etc.)
// - Trigger failure animations
// - Notify client of failure reason
```

---

## 5. Controller Methods

### 5.1. ActionController.executeAction()

Executes an action on an entity.

```javascript
/**
 * @param {string} actionName - The name of the action to execute.
 * @param {string} entityId - The ID of the entity to perform the action.
 * @param {Object} [params] - Additional action parameters.
 * @returns {Object} Result of the action execution.
 */
```

**Returns:**
```javascript
{
    success: true,
    action: "move",
    entityId: "uuid-123",
    message: "Entity moved upward",
    moveValue: 20,
    newSpatial: { x: 0, y: -20 }
}
```

### 5.2. stateEntityController.updateEntitySpatial()

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

## 6. HTTP API

### 6.1. POST /execute-action

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
        "message": "Entity moved upward",
        "moveValue": 20,
        "newSpatial": { "x": 0, "y": -20 }
    }
}
```

**Failure Response (Requirements not met):**
```json
{
    "result": {
        "success": false,
        "error": "Requirement failed: No component has \"Movimentation.move\" > 5",
        "message": "Action failed - failure consequences not yet implemented",
        "failedAction": "move",
        "entityId": "uuid-entity-123"
    }
}
```

---

## 7. Adding New Actions

### 7.1. Register a New Action

Add to `ActionController.actionRegistry`:

```javascript
"attack": {
    requirements: {
        trait: "Physical",
        stat: "strength",
        minValue: 10
    },
    consequences: {
        // Attack success consequences
    },
    consequencesDeFalha: {
        // Attack failure consequences (TODO)
    }
}
```

### 7.2. Update Requirements

1. Define requirements in the registry
2. Implement `_checkRequirements()` logic if needed
3. Implement success consequences
4. Implement failure consequences (TODO placeholders exist)

---

## 8. Best Practices

### 8.1. Dependency Injection

Always inject `WorldStateController` into `ActionController`. Never create new controller instances inside `ActionController`.

### 8.2. Single Source of Truth

Use injected controllers to access and modify state. Do not cache state in the action controller.

### 8.3. Extensibility

Keep actions in the registry pattern. Each action should be self-contained with clear requirements and consequences.

### 8.4. Error Handling

Always validate inputs and return descriptive error messages when actions fail.

---

## 9. Current Implementation Status

| Action | Requirements | Success Consequences | Failure Consequences |
|--------|-------------|---------------------|---------------------|
| move | ✅ Implemented | ✅ Implemented | ⚠️ TODO |

---

### 📢 Notice for Future Agents

**Language Requirement:** All source code in this project must be written in **JavaScript**.

**Controller Pattern:** The `ActionController` follows the Dependency Injection pattern and should never instantiate its own controllers.
