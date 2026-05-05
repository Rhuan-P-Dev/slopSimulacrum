/**
 * Custom error classes for the slopSimulacrum project.
 * Provides structured error handling with meaningful messages.
 */

/**
 * Base error for the application with cause support.
 */
class GameError extends Error {
    /**
     * @param {string} message - Human-readable error message.
     * @param {string} code - Machine-readable error code.
     * @param {Error|null} cause - The underlying error that caused this.
     */
    constructor(message, code = 'UNKNOWN_ERROR', cause = null) {
        super(message, { cause });
        this.name = 'GameError';
        this.code = code;
    }
}

/**
 * Thrown when input validation fails (e.g., invalid action name, missing entityId).
 */
class ValidationError extends GameError {
    /**
     * @param {string} message - Human-readable error message.
     * @param {Error|null} cause - The underlying error.
     */
    constructor(message, cause = null) {
        super(message, 'VALIDATION_ERROR', cause);
        this.name = 'ValidationError';
    }
}

/**
 * Thrown when an action cannot be executed (e.g., requirements not met).
 */
class ActionExecutionError extends GameError {
    /**
     * @param {string} message - Human-readable error message.
     * @param {string} actionName - The action that failed.
     * @param {Error|null} cause - The underlying error.
     */
    constructor(message, actionName = null, cause = null) {
        super(message, 'ACTION_EXECUTION_ERROR', cause);
        this.name = 'ActionExecutionError';
        this.actionName = actionName;
    }
}

/**
 * Thrown when a component is not found in the entity registry.
 */
class ComponentNotFoundError extends GameError {
    /**
     * @param {string} componentId - The missing component ID.
     * @param {Error|null} cause - The underlying error.
     */
    constructor(componentId, cause = null) {
        super(`Component not found: ${componentId}`, 'COMPONENT_NOT_FOUND', cause);
        this.name = 'ComponentNotFoundError';
        this.componentId = componentId;
    }
}

/**
 * Thrown when an entity is not found in the world state.
 */
class EntityNotFoundError extends GameError {
    /**
     * @param {string} entityId - The missing entity ID.
     * @param {Error|null} cause - The underlying error.
     */
    constructor(entityId, cause = null) {
        super(`Entity not found: ${entityId}`, 'ENTITY_NOT_FOUND', cause);
        this.name = 'EntityNotFoundError';
        this.entityId = entityId;
    }
}

/**
 * Thrown when a blueprint is not found in the blueprint registry.
 */
class BlueprintNotFoundError extends GameError {
    /**
     * @param {string} blueprintName - The missing blueprint name.
     * @param {Error|null} cause - The underlying error.
     */
    constructor(blueprintName, cause = null) {
        super(`Blueprint not found: ${blueprintName}`, 'BLUEPRINT_NOT_FOUND', cause);
        this.name = 'BlueprintNotFoundError';
        this.blueprintName = blueprintName;
    }
}

/**
 * Thrown when a room is not found.
 */
class RoomNotFoundError extends GameError {
    /**
     * @param {string} roomId - The missing room ID.
     * @param {Error|null} cause - The underlying error.
     */
    constructor(roomId, cause = null) {
        super(`Room not found: ${roomId}`, 'ROOM_NOT_FOUND', cause);
        this.name = 'RoomNotFoundError';
        this.roomId = roomId;
    }
}

export {
    GameError,
    ValidationError,
    ActionExecutionError,
    ComponentNotFoundError,
    EntityNotFoundError,
    BlueprintNotFoundError,
    RoomNotFoundError
};