import Logger from '../utils/Logger.js';

/**
 * Default time-to-live (in milliseconds) for selections before they expire.
 * Selections older than this threshold are considered stale and automatically released.
 */
const DEFAULT_SELECTION_TTL_MS = 30000;

/**
 * Component action binding roles — mirrors the roles defined in ActionController.
 * Defines which body part participates in which action context.
 *
 * @readonly
 * @enum {string}
 */
const BINDING_ROLES = {
    SOURCE: 'source',
    TARGET: 'target',
    SPATIAL: 'spatial',
    SELF_TARGET: 'self_target'
};

/**
 * Validates that a given role string is one of the recognized binding roles.
 *
 * @param {string} role - The role to validate.
 * @returns {boolean} True if the role is recognized.
 */
function isValidBindingRole(role) {
    const validRoles = Object.values(BINDING_ROLES);
    return validRoles.includes(role);
}

/**
 * ActionSelectController — Manages component selection and locking.
 * Enforces "one component, one action" rule: if a component is selected
 * for action A, it cannot be used for action B simultaneously.
 *
 * Responsibilities (SRP):
 * - Track which components are locked to which actions
 * - Validate that a component is available for a requested action
 * - Release locks after action completion or on entity despawn
 * - Expire stale selections to prevent permanent locks
 *
 * Internal state uses a Map keyed by componentId:
 *   componentId → { actionName, entityId, role, lockedAt }
 *
 * @example
 * // Architecture flow:
 * // Client → Server → ActionSelectController.registerSelection()
 * // Server → ActionController.executeAction() → ActionSelectController.validateSelection()
 * // After execution → ActionSelectController.releaseSelection()
 */
class ActionSelectController {
    /**
     * Creates a new ActionSelectController.
     *
     * @param {WorldStateController} worldStateController - The root state controller (injected).
     * @param {number} [selectionTtlMs=DEFAULT_SELECTION_TTL_MS] - Time-to-live for selections in ms.
     */
    constructor(worldStateController, selectionTtlMs = DEFAULT_SELECTION_TTL_MS) {
        /**
         * @type {WorldStateController}
         */
        this.worldStateController = worldStateController;

        /**
         * Time-to-live for selections in milliseconds.
         * @type {number}
         */
        this.selectionTtlMs = selectionTtlMs;

        /**
         * Internal selection registry: componentId → SelectionEntry.
         * @type {Map<string, SelectionEntry>}
         * @private
         */
        this._selectionRegistry = new Map();

        Logger.info('[ActionSelectController] Initialized', {
            selectionTtlMs: this.selectionTtlMs
        });
    }

    // =========================================================================
    // PUBLIC API: SELECTION MANAGEMENT
    // =========================================================================

    /**
     * Lock a component to a specific action.
     * If the component is already locked to a different action, the request is rejected.
     * If the component is already locked to the same action, the lock is refreshed.
     *
     * @param {string} actionName - The action the component is selected for.
     * @param {string} componentId - The unique ID of the component to lock.
     * @param {string} entityId - The ID of the entity owning the component.
     * @param {string} role - The binding role ('source', 'target', 'spatial', 'self_target').
     * @returns {{ success: boolean, error?: string }} Result of the registration.
     */
    registerSelection(actionName, componentId, entityId, role) {
        // Validate inputs
        if (!actionName || !componentId || !entityId || !role) {
            const error = 'All parameters (actionName, componentId, entityId, role) are required.';
            Logger.warn('[ActionSelectController] Registration failed: missing parameters', {
                actionName, componentId, entityId, role
            });
            return { success: false, error };
        }

        if (!isValidBindingRole(role)) {
            const error = `Invalid binding role "${role}". Must be one of: ${Object.values(BINDING_ROLES).join(', ')}.`;
            Logger.warn('[ActionSelectController] Registration failed: invalid role', { role });
            return { success: false, error };
        }

        // Verify the component exists on the entity
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) {
            const error = `Entity "${entityId}" not found.`;
            Logger.warn('[ActionSelectController] Registration failed: entity not found', { entityId });
            return { success: false, error };
        }

        const component = entity.components.find((c) => c.id === componentId);
        if (!component) {
            const error = `Component "${componentId}" not found on entity "${entityId}".`;
            Logger.warn('[ActionSelectController] Registration failed: component not found', {
                componentId, entityId
            });
            return { success: false, error };
        }

        // Check if already locked
        const existing = this._selectionRegistry.get(componentId);
        if (existing) {
            if (existing.actionName === actionName && existing.entityId === entityId) {
                // Same action — refresh the lock timestamp
                existing.lockedAt = Date.now();
                Logger.info('[ActionSelectController] Lock refreshed', {
                    componentId, actionName, entityId
                });
                return { success: true };
            }

            // Locked to a different action — reject
            const error = `Component "${componentId}" is already locked to action "${existing.actionName}" (entity: ${existing.entityId}). Cannot lock to "${actionName}".`;
            Logger.warn('[ActionSelectController] Registration rejected: component locked to different action', {
                componentId,
                currentAction: existing.actionName,
                requestedAction: actionName
            });
            return { success: false, error };
        }

        // Register new lock
        this._selectionRegistry.set(componentId, {
            actionName,
            entityId,
            role,
            lockedAt: Date.now()
        });

        Logger.info('[ActionSelectController] Component locked', {
            componentId,
            actionName,
            entityId,
            role
        });

        return { success: true };
    }

    /**
     * Verify a component is locked to the correct action.
     * Returns valid=true if the component is locked to the given action,
     * or if no selection system is enforced (component is free).
     *
     * @param {string} componentId - The component ID to validate.
     * @param {string} actionName - The expected action name.
     * @returns {{ valid: boolean, error?: string }} Validation result.
     */
    validateSelection(componentId, actionName) {
        const selection = this._selectionRegistry.get(componentId);

        if (!selection) {
            // Component is not locked — allow execution (backward compatible mode)
            Logger.info('[ActionSelectController] No active selection for component (backward compatible)', {
                componentId, actionName
            });
            return { valid: true };
        }

        if (selection.actionName === actionName) {
            Logger.info('[ActionSelectController] Selection validated', {
                componentId, actionName
            });
            return { valid: true };
        }

        // Locked to a different action
        const error = `Component "${componentId}" is locked to action "${selection.actionName}", not "${actionName}".`;
        Logger.warn('[ActionSelectController] Validation failed: action mismatch', {
            componentId,
            lockedAction: selection.actionName,
            requestedAction: actionName
        });
        return { valid: false, error };
    }

    /**
     * Release (unlock) a component after action completion.
     *
     * @param {string} componentId - The component ID to release.
     * @returns {boolean} True if the component was released, false if it wasn't locked.
     */
    releaseSelection(componentId) {
        if (!this._selectionRegistry.has(componentId)) {
            Logger.info('[ActionSelectController] Release skipped: not locked', { componentId });
            return false;
        }

        const selection = this._selectionRegistry.get(componentId);
        this._selectionRegistry.delete(componentId);

        Logger.info('[ActionSelectController] Component released', {
            componentId,
            actionName: selection.actionName,
            entityId: selection.entityId
        });

        return true;
    }

    /**
     * Get all locked components for an entity.
     *
     * @param {string} entityId - The entity ID.
     * @returns {Array<{componentId: string, actionName: string, role: string, lockedAt: number}>}
     * Array of selection entries for the entity.
     */
    getLockedComponents(entityId) {
        const result = [];

        for (const [componentId, selection] of this._selectionRegistry) {
            if (selection.entityId === entityId) {
                result.push({
                    componentId: selection.componentId || componentId,
                    actionName: selection.actionName,
                    role: selection.role,
                    lockedAt: selection.lockedAt
                });
            }
        }

        return result;
    }

    /**
     * Check if a component can perform a given action.
     * A component can perform an action if it is NOT locked to a different action.
     *
     * @param {string} componentId - The component ID to check.
     * @param {string} actionName - The action to check against.
     * @returns {boolean} True if the component is available for the action.
     */
    canComponentPerformAction(componentId, actionName) {
        const selection = this._selectionRegistry.get(componentId);

        if (!selection) {
            // Not locked — available for any action
            return true;
        }

        // Locked to the same action — still available
        if (selection.actionName === actionName) {
            return true;
        }

        // Locked to a different action — not available
        Logger.info('[ActionSelectController] Component unavailable: locked to different action', {
            componentId,
            requestedAction: actionName,
            lockedAction: selection.actionName
        });
        return false;
    }

    /**
     * Get all locked component IDs, optionally excluding those locked to a specific action.
     * Used by SynergyController to exclude locked-out components from synergy pools.
     *
     * @param {string} [excludeActionName] - If provided, exclude locks for this action
     *   (i.e., components locked to this action are NOT in the returned set).
     * @returns {Set<string>} Set of locked component IDs.
     */
    getLockedComponentIds(excludeActionName) {
        const lockedIds = new Set();

        for (const [componentId, selection] of this._selectionRegistry) {
            if (excludeActionName && selection.actionName === excludeActionName) {
                // Components locked to the current action are allowed to participate
                continue;
            }
            lockedIds.add(componentId);
        }

        return lockedIds;
    }

    /**
     * Expire stale selections that have exceeded the TTL.
     * Should be called periodically or before action execution.
     *
     * @returns {number} Number of expired selections.
     */
    expireStaleSelections() {
        const now = Date.now();
        let expiredCount = 0;

        for (const [componentId, selection] of this._selectionRegistry) {
            const age = now - selection.lockedAt;
            if (age > this.selectionTtlMs) {
                this._selectionRegistry.delete(componentId);
                Logger.info('[ActionSelectController] Stale selection expired', {
                    componentId,
                    actionName: selection.actionName,
                    ageMs: age
                });
                expiredCount++;
            }
        }

        if (expiredCount > 0) {
            Logger.info('[ActionSelectController] Expired stale selections', {
                expiredCount,
                remaining: this._selectionRegistry.size
            });
        }

        return expiredCount;
    }

    /**
     * Release all selections for a given entity.
     * Called when an entity is despawned or removed.
     *
     * @param {string} entityId - The entity ID.
     * @returns {number} Number of released selections.
     */
    releaseEntitySelections(entityId) {
        let releasedCount = 0;

        for (const [componentId, selection] of this._selectionRegistry) {
            if (selection.entityId === entityId) {
                this._selectionRegistry.delete(componentId);
                releasedCount++;
            }
        }

        if (releasedCount > 0) {
            Logger.info('[ActionSelectController] Entity selections released', {
                entityId,
                releasedCount
            });
        }

        return releasedCount;
    }

    /**
     * Get the current selection for a component.
     *
     * @param {string} componentId - The component ID.
     * @returns {SelectionEntry|null} The selection entry, or null if not locked.
     */
    getSelection(componentId) {
        return this._selectionRegistry.get(componentId) || null;
    }

    /**
     * Get the total number of active selections.
     *
     * @returns {number}
     */
    getActiveSelectionCount() {
        return this._selectionRegistry.size;
    }

    // =========================================================================
    // PUBLIC API: BATCH SELECTION MANAGEMENT
    // =========================================================================

    /**
     * Lock multiple components to a specific action in a single operation.
     * All components must be on the same entity and locked to the same action.
     * If any component fails to lock, the entire batch is rejected (atomic).
     *
     * @param {string} actionName - The action the components are selected for.
     * @param {string} entityId - The ID of the entity owning the components.
     * @param {Array<{componentId: string, role: string}>} componentList - Array of {componentId, role} pairs.
     * @returns {{ success: boolean, lockedCount?: number, errors?: string[] }} Result of the batch registration.
     */
    registerSelections(actionName, entityId, componentList) {
        if (!Array.isArray(componentList) || componentList.length === 0) {
            const error = 'componentList must be a non-empty array of {componentId, role}.';
            Logger.warn('[ActionSelectController] Batch registration failed: invalid componentList', { componentList });
            return { success: false, errors: [error] };
        }

        if (!actionName || !entityId) {
            const error = 'actionName and entityId are required.';
            Logger.warn('[ActionSelectController] Batch registration failed: missing parameters', { actionName, entityId });
            return { success: false, errors: [error] };
        }

        // Verify the entity exists
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) {
            const error = `Entity "${entityId}" not found.`;
            Logger.warn('[ActionSelectController] Batch registration failed: entity not found', { entityId });
            return { success: false, errors: [error] };
        }

        // Validate all components exist on the entity first (atomic check)
        const missingComponents = [];
        for (const { componentId } of componentList) {
            const component = entity.components.find((c) => c.id === componentId);
            if (!component) {
                missingComponents.push(componentId);
            }
        }

        if (missingComponents.length > 0) {
            const error = `Components not found on entity "${entityId}": ${missingComponents.join(', ')}`;
            Logger.warn('[ActionSelectController] Batch registration failed: missing components', { missingComponents, entityId });
            return { success: false, errors: [error] };
        }

        // Check if any component is already locked to a DIFFERENT action
        const conflicts = [];
        for (const { componentId, role } of componentList) {
            const existing = this._selectionRegistry.get(componentId);
            if (existing && existing.actionName !== actionName) {
                conflicts.push({ componentId, lockedAction: existing.actionName, lockedEntity: existing.entityId });
            }
            // If locked to the same action, that's fine — will be refreshed
        }

        if (conflicts.length > 0) {
            const errorMessages = conflicts.map((c) =>
                `Component "${c.componentId}" is already locked to action "${c.lockedAction}" (entity: ${c.lockedEntity}).`
            );
            Logger.warn('[ActionSelectController] Batch registration failed: component conflicts', { conflicts });
            return { success: false, errors: errorMessages };
        }

        // All validations passed — lock all components
        for (const { componentId, role } of componentList) {
            const existing = this._selectionRegistry.get(componentId);
            if (existing && existing.actionName === actionName) {
                // Same action — refresh the lock timestamp
                existing.lockedAt = Date.now();
            } else {
                // Register new lock
                this._selectionRegistry.set(componentId, {
                    actionName,
                    entityId,
                    role,
                    lockedAt: Date.now()
                });
            }
        }

        Logger.info('[ActionSelectController] Batch selection registered', {
            actionName,
            entityId,
            componentCount: componentList.length,
            componentIds: componentList.map((c) => c.componentId)
        });

        return { success: true, lockedCount: componentList.length };
    }

    /**
     * Validate that multiple components are all locked to the given action.
     *
     * @param {string} actionName - The expected action name.
     * @param {Array<string>} componentIds - Array of component IDs to validate.
     * @returns {{ valid: boolean, error?: string, invalidComponents?: string[] }} Validation result.
     */
    validateSelections(actionName, componentIds) {
        if (!Array.isArray(componentIds) || componentIds.length === 0) {
            return { valid: false, error: 'componentIds must be a non-empty array.' };
        }

        const invalidComponents = [];

        for (const componentId of componentIds) {
            const selection = this._selectionRegistry.get(componentId);

            if (!selection) {
                // Component is not locked — allow execution (backward compatible mode)
                continue;
            }

            if (selection.actionName !== actionName) {
                invalidComponents.push({
                    componentId,
                    lockedAction: selection.actionName
                });
            }
        }

        if (invalidComponents.length > 0) {
            const errorMessages = invalidComponents.map((c) =>
                `Component "${c.componentId}" is locked to action "${c.lockedAction}", not "${actionName}".`
            );
            Logger.warn('[ActionSelectController] Batch validation failed', {
                actionName,
                invalidComponents
            });
            return { valid: false, error: errorMessages, invalidComponents };
        }

        Logger.info('[ActionSelectController] Batch selections validated', {
            actionName,
            componentCount: componentIds.length
        });

        return { valid: true };
    }

    /**
     * Release multiple components after action completion.
     *
     * @param {Array<string>} componentIds - Array of component IDs to release.
     * @returns {{ released: boolean, releasedCount: number }} Result.
     */
    releaseSelections(componentIds) {
        if (!Array.isArray(componentIds)) {
            componentIds = [componentIds];
        }

        let releasedCount = 0;

        for (const componentId of componentIds) {
            if (this._selectionRegistry.has(componentId)) {
                const selection = this._selectionRegistry.get(componentId);
                this._selectionRegistry.delete(componentId);

                Logger.info('[ActionSelectController] Component released (batch)', {
                    componentId,
                    actionName: selection.actionName,
                    entityId: selection.entityId
                });

                releasedCount++;
            }
        }

        if (releasedCount > 0) {
            Logger.info('[ActionSelectController] Batch release completed', {
                releasedCount,
                remaining: this._selectionRegistry.size
            });
        }

        return { released: releasedCount > 0, releasedCount };
    }

    /**
     * Get all locked components for a specific action.
     *
     * @param {string} actionName - The action name.
     * @returns {Array<{componentId: string, entityId: string, role: string, lockedAt: number}>}
     * Array of selection entries for the action.
     */
    getSelectionsForAction(actionName) {
        const result = [];

        for (const [componentId, selection] of this._selectionRegistry) {
            if (selection.actionName === actionName) {
                result.push({
                    componentId: selection.componentId || componentId,
                    entityId: selection.entityId,
                    role: selection.role,
                    lockedAt: selection.lockedAt
                });
            }
        }

        return result;
    }

    /**
     * Alias for getSelectionsForAction — used by SynergyComponentGatherer.
     * @param {string} actionName - The action name.
     * @returns {Array} Locked component entries.
     */
    getLockedComponentsForAction(actionName) {
        return this.getSelectionsForAction(actionName);
    }
}

/**
 * @typedef {Object} SelectionEntry
 * @property {string} actionName - The action the component is locked to.
 * @property {string} entityId - The entity owning the component.
 * @property {string} role - The binding role.
 * @property {number} lockedAt - Unix timestamp when the lock was set.
 */

export default ActionSelectController;
export { BINDING_ROLES, DEFAULT_SELECTION_TTL_MS };