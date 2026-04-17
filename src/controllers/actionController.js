import Logger from '../utils/Logger.js';
import { ACTION_SCORING, CLOSE_TO_THRESHOLD_FACTOR } from '../utils/ActionScoring.js';

/**
 * Error code registry for structured error handling.
 * @readonly
 * @enum {string}
 */
const ERROR_REGISTRY = {
    'ENTITY_NOT_FOUND': { message: 'Entity "{entityId}" not found.', level: 'ERROR' },
    'ACTION_NOT_FOUND': { message: 'Action "{actionName}" not found.', level: 'ERROR' },
    'MISSING_TRAIT_STAT': { message: 'No component possesses the required {trait}.{stat} (>= {minValue})', level: 'WARN' },
    'UNKNOWN_REQUIREMENT_FAILURE': { message: 'Action requirements were not met.', level: 'WARN' },
    'CONSEQUENCE_EXECUTION_FAILED': { message: 'Failed to execute consequence {type}: {error}', level: 'ERROR' },
    'SYSTEM_RUNTIME_ERROR': { message: 'An unexpected system error occurred: {error}', level: 'CRITICAL' },
};

/**
 * Capability entry representing one component's ability to perform a specific action.
 * Each component in the world that qualifies for an action gets its own entry.
 * Entries are sorted by score (best first) within each action's array.
 *
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

/**
 * ActionController handles game actions, checking requirements and
 * executing consequences through a decoupled handler system.
 *
 * It maintains a capability cache that maps each action to an array of
 * component capability entries. Every component that qualifies for an action
 * gets its own entry, sorted by score (best first). When component stats
 * change, the relevant actions are automatically re-evaluated.
 *
 * @example
 * // Cache structure:
 * // {
 * //   "pierce": [
 * //     { entityId: "e1", componentId: "knife-comp", componentType: "knife", componentIdentifier: "kitchen-knife", score: 95, ... },
 * //     { entityId: "e1", componentId: "hand-comp", componentType: "droidHand", componentIdentifier: "right", score: 30, ... },
 * //     { entityId: "e2", componentId: "blade-comp", componentType: "blade", componentIdentifier: "razor", score: 90, ... }
 * //   ]
 * // }
 */
class ActionController {
    /**
     * @param {WorldStateController} worldStateController - The main world state controller.
     * @param {ConsequenceHandlers} consequenceHandlers - The consequence handler system.
     * @param {Object} actionRegistry - The registry of available actions.
     */
    constructor(worldStateController, consequenceHandlers, actionRegistry) {
        this.worldStateController = worldStateController;
        this.consequenceHandlers = consequenceHandlers;
        this.actionRegistry = actionRegistry || {};

        /**
         * Capability cache: maps actionName → array of all component capability entries.
         * Each component that qualifies for an action gets its own entry.
         * Entries are sorted by score descending (best first).
         *
         * Format: { [actionName]: [ComponentCapabilityEntry, ...] }
         * @type {Object<string, Array<ComponentCapabilityEntry>>}
         */
        this._capabilityCache = {};

        /**
         * Action subscribers for event-driven capability change notifications.
         * Format: { [actionName]: [callback functions] }
         * @type {Map<string, Array<Function>>}
         */
        this._actionSubscribers = new Map();

        /**
         * Reverse index: maps trait.stat → Set of actionNames that depend on it.
         * Enables efficient lookup of which actions to re-evaluate when a stat changes.
         * @type {Map<string, Set<string>>}
         */
        this._traitStatActionIndex = new Map();

        // Build the reverse index from the action registry
        this._buildTraitStatActionIndex();
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    /**
     * Scans all entities and their components against all registered actions,
     * then updates the capability cache with ALL qualifying component entries.
     * Each component that meets an action's requirements gets its own entry.
     * This is the main method for performing a full capability re-evaluation.
     *
     * @param {Object} state - The current world state (contains entities).
     * @returns {Object<string, Array<ComponentCapabilityEntry>>} The updated capability cache.
     */
    scanAllCapabilities(state) {
        const entities = state.entities || {};
        const entityIds = Object.keys(entities);
        const actions = this.getRegistry();

        // Clear the cache for a fresh scan
        this._capabilityCache = {};

        // Initialize cache structure for each action
        for (const actionName of Object.keys(actions)) {
            this._capabilityCache[actionName] = [];
        }

        // Bottom-up scan: for each entity, for each component, evaluate all actions
        for (const entityId of entityIds) {
            const entity = entities[entityId];
            if (!entity || !entity.components) continue;

            for (const component of entity.components) {
                const componentStats = this.worldStateController.componentController.getComponentStats(component.id);
                if (!componentStats) continue;

                // Evaluate this component against every action
                for (const [actionName, actionData] of Object.entries(actions)) {
                    if (!actionData.requirements || actionData.requirements.length === 0) continue;

                    const score = this._calculateComponentScore(componentStats, actionData.requirements);
                    if (score <= 0) continue; // Component doesn't satisfy this action

                    // Check if this component meets all requirements
                    const requirementCheck = this._checkRequirementsForComponent(
                        actionData.requirements, entityId, component.id
                    );

                    if (requirementCheck.passed) {
                        const entry = {
                            entityId,
                            componentId: component.id,
                            componentType: component.type,
                            componentIdentifier: component.identifier || 'default',
                            score,
                            requirementValues: requirementCheck.requirementValues,
                            fulfillingComponents: requirementCheck.fulfillingComponents,
                            requirementsStatus: actionData.requirements.map(req => ({
                                trait: req.trait,
                                stat: req.stat,
                                current: requirementCheck.requirementValues[`${req.trait}.${req.stat}`] ?? 0,
                                required: req.minValue
                            }))
                        };
                        this._capabilityCache[actionName].push(entry);
                    }
                }
            }
        }

        // Sort each action's entries by score descending (best first)
        for (const actionName of Object.keys(this._capabilityCache)) {
            this._capabilityCache[actionName].sort((a, b) => b.score - a.score);
        }

        return this._capabilityCache;
    }

    /**
     * Re-evaluates a specific action for a specific component.
     * Called when a component stat changes. Finds the entry in the array and
     * updates or removes it. Only updates the affected action entry.
     *
     * @param {Object} state - The current world state.
     * @param {string} actionName - The action to re-evaluate.
     * @param {string} componentId - The component whose stats changed.
     * @returns {ComponentCapabilityEntry|null} The updated capability entry, or null if the component no longer qualifies.
     */
    reEvaluateActionForComponent(state, actionName, componentId) {
        const actionData = this.actionRegistry[actionName];
        if (!actionData || !actionData.requirements || actionData.requirements.length === 0) return null;

        const componentStats = this.worldStateController.componentController.getComponentStats(componentId);
        if (!componentStats) return null;

        const score = this._calculateComponentScore(componentStats, actionData.requirements);
        if (score <= 0) {
            // Component no longer qualifies — remove from cache
            this._removeComponentFromActionCache(actionName, componentId);
            return null;
        }

        // Find which entity this component belongs to
        const entities = state.entities || {};
        let targetEntityId = null;
        for (const [eid, entity] of Object.entries(entities)) {
            if (entity?.components?.some(c => c.id === componentId)) {
                targetEntityId = eid;
                break;
            }
        }

        if (!targetEntityId) return null;

        // Check if this component meets all requirements
        const requirementCheck = this._checkRequirementsForComponent(
            actionData.requirements, targetEntityId, componentId
        );

        if (!requirementCheck.passed) {
            this._removeComponentFromActionCache(actionName, componentId);
            return null;
        }

        const entity = entities[targetEntityId];
        const component = entity.components.find(c => c.id === componentId);
        const newEntry = {
            entityId: targetEntityId,
            componentId,
            componentType: component?.type || 'unknown',
            componentIdentifier: component?.identifier || 'default',
            score,
            requirementValues: requirementCheck.requirementValues,
            fulfillingComponents: requirementCheck.fulfillingComponents,
            requirementsStatus: actionData.requirements.map(req => ({
                trait: req.trait,
                stat: req.stat,
                current: requirementCheck.requirementValues[`${req.trait}.${req.stat}`] ?? 0,
                required: req.minValue
            }))
        };

        // Find existing entry in the action array and update it in place
        const actionEntries = this._capabilityCache[actionName];
        if (actionEntries) {
            const existingIndex = actionEntries.findIndex(e => e.componentId === componentId);
            if (existingIndex !== -1) {
                actionEntries[existingIndex] = newEntry;
            } else {
                // New entry — add to array
                actionEntries.push(newEntry);
            }
            // Re-sort by score descending
            actionEntries.sort((a, b) => b.score - a.score);
        }

        this._notifySubscribers(actionName, newEntry);
        return newEntry;
    }

    /**
     * Re-evaluates all actions that depend on a specific component's traits.
     * Called when a component stat changes.
     *
     * @param {Object} state - The current world state.
     * @param {string} componentId - The component whose stats changed.
     * @returns {Array<ComponentCapabilityEntry>} List of updated capability entries.
     */
    reEvaluateAllActionsForComponent(state, componentId) {
        const dependentActions = this._getActionsForTraitStatFromComponent(componentId);
        if (!dependentActions) return [];

        const updatedEntries = [];
        for (const actionName of dependentActions) {
            const entry = this.reEvaluateActionForComponent(state, actionName, componentId);
            if (entry) updatedEntries.push(entry);
        }

        return updatedEntries;
    }

    /**
     * Re-evaluates ALL actions for a specific entity.
     * Called when an entity's component set changes (e.g., picks up/drops an item, spawns).
     * Removes all entries for this entity from all actions, then re-scans.
     *
     * @param {Object} state - The current world state.
     * @param {string} entityId - The entity to re-evaluate.
     * @returns {Array<ComponentCapabilityEntry>} List of updated capability entries.
     */
    reEvaluateEntityCapabilities(state, entityId) {
        // Remove all entries for this entity from all action arrays
        this._removeEntityFromAllActionCaches(entityId);

        // Re-scan all components of this entity against all actions
        const entities = state.entities || {};
        const entity = entities[entityId];
        if (!entity || !entity.components) return [];

        const actions = this.getRegistry();
        const updatedEntries = [];

        for (const component of entity.components) {
            const componentStats = this.worldStateController.componentController.getComponentStats(component.id);
            if (!componentStats) continue;

            for (const [actionName, actionData] of Object.entries(actions)) {
                if (!actionData.requirements || actionData.requirements.length === 0) continue;

                // Ensure the action array exists (for initial entity spawn before full scan)
                if (!this._capabilityCache[actionName]) {
                    this._capabilityCache[actionName] = [];
                }

                const score = this._calculateComponentScore(componentStats, actionData.requirements);
                if (score <= 0) continue;

                const requirementCheck = this._checkRequirementsForComponent(
                    actionData.requirements, entityId, component.id
                );

                if (requirementCheck.passed) {
                    const entry = {
                        entityId,
                        componentId: component.id,
                        componentType: component.type,
                        componentIdentifier: component.identifier || 'default',
                        score,
                        requirementValues: requirementCheck.requirementValues,
                        fulfillingComponents: requirementCheck.fulfillingComponents,
                        requirementsStatus: actionData.requirements.map(req => ({
                            trait: req.trait,
                            stat: req.stat,
                            current: requirementCheck.requirementValues[`${req.trait}.${req.stat}`] ?? 0,
                            required: req.minValue
                        }))
                    };
                    this._capabilityCache[actionName].push(entry);
                    updatedEntries.push(entry);
                }
            }
        }

        // Re-sort each action's entries by score descending
        for (const actionName of Object.keys(this._capabilityCache)) {
            this._capabilityCache[actionName].sort((a, b) => b.score - a.score);
        }

        // Notify subscribers for actions that changed
        for (const entry of updatedEntries) {
            // Determine which action this entry belongs to by scanning the cache
            let actionName = null;
            for (const [actName, entries] of Object.entries(this._capabilityCache)) {
                if (entries.includes(entry)) {
                    actionName = actName;
                    break;
                }
            }
            if (actionName) {
                this._notifySubscribers(actionName, entry);
            }
        }

        return updatedEntries;
    }

    /**
     * Removes all capability entries for an entity from all action caches.
     * Called when an entity is despawned.
     *
     * @param {string} entityId - The entity ID to remove.
     */
    removeEntityFromCache(entityId) {
        this._removeEntityFromAllActionCaches(entityId);
    }

    /**
     * Returns the cached capability entries for all actions.
     * Optimized: returns the cached data directly without recomputation.
     *
     * @returns {Object<string, Array<ComponentCapabilityEntry>>} The capability cache.
     */
    getCachedCapabilities() {
        return this._capabilityCache;
    }

    /**
     * Returns the best component entry for a specific action (highest score).
     * @param {string} actionName - The action name.
     * @returns {ComponentCapabilityEntry|null} The best capability entry, or null if none.
     */
    getBestComponentForAction(actionName) {
        const actionEntries = this._capabilityCache[actionName];
        if (!actionEntries || actionEntries.length === 0) return null;
        return actionEntries[0]; // Already sorted by score descending
    }

    /**
     * Returns all capability entries for a specific action.
     * @param {string} actionName - The action name.
     * @returns {Array<ComponentCapabilityEntry>} Array of capability entries (sorted by score).
     */
    getAllCapabilitiesForAction(actionName) {
        const actionEntries = this._capabilityCache[actionName];
        if (!actionEntries) return [];
        return actionEntries;
    }

    /**
     * Returns capability entries for a specific entity across all actions.
     * Filters the cache to only entries belonging to the given entity.
     *
     * @param {string} entityId - The entity ID.
     * @returns {Array<ComponentCapabilityEntry>} Array of capability entries for this entity.
     */
    getCapabilitiesForEntity(entityId) {
        const result = [];
        for (const [actionName, entries] of Object.entries(this._capabilityCache)) {
            for (const entry of entries) {
                if (entry.entityId === entityId) {
                    result.push(entry);
                }
            }
        }
        return result;
    }

    /**
     * Retrieves only the actions that are relevant to a specific entity.
     * Uses the cached capability data and augments with action definitions.
     * Triggers a full capability scan if the cache is empty OR if the entity is not in the cache.
     *
     * @param {Object} state - The current world state.
     * @param {string} entityId - The ID of the entity to filter for.
     * @returns {Object.<string, {requirements: Array, canExecute: Array, cannotExecute: Array}>}
     * Map of actions and their capability status for the entity.
     */
    getActionsForEntity(state, entityId) {
        // Trigger full scan if cache is empty
        const cacheIsEmpty = Object.keys(this._capabilityCache).length === 0;
        // Also trigger scan if the entity is not in the cache (newly spawned entity)
        const entityInCache = this._entityExistsInCache(entityId);

        if (cacheIsEmpty || !entityInCache) {
            this.scanAllCapabilities(state);
        }

        const actions = this.getRegistry();
        const entityCache = this._capabilityCache;
        const filteredActions = {};

        for (const [actionName, actionData] of Object.entries(actions)) {
            // Filter entries for this entity only
            const cachedEntries = entityCache[actionName]
                ? entityCache[actionName].filter(e => e.entityId === entityId)
                : [];

            if (cachedEntries.length > 0) {
                filteredActions[actionName] = {
                    ...actionData,
                    canExecute: cachedEntries,
                    cannotExecute: []
                };
            } else {
                // Check if entity exists but can't execute this action
                if (state.entities?.[entityId]) {
                    filteredActions[actionName] = {
                        ...actionData,
                        canExecute: [],
                        cannotExecute: [{
                            entityId,
                            componentName: 'Entity',
                            componentIdentifier: entityId
                        }]
                    };
                }
            }
        }

        return filteredActions;
    }

    /**
     * Checks if an entity exists in the capability cache.
     * @param {string} entityId - The entity ID to check.
     * @returns {boolean} True if the entity exists in any action's cache.
     * @private
     */
    _entityExistsInCache(entityId) {
        for (const entries of Object.values(this._capabilityCache)) {
            for (const entry of entries) {
                if (entry.entityId === entityId) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Calculates which entities are capable of executing which actions based on the current world state.
     * Uses the cached capability data. If cache is stale or empty, performs a full scan.
     *
     * @param {Object} state - The current world state.
     * @returns {Object.<string, {requirements: Array, canExecute: Array, cannotExecute: Array}>}
     * Map of actions and their capability status.
     */
    getActionCapabilities(state) {
        const actions = this.getRegistry();
        const entities = state.entities || {};
        const entityIds = Object.keys(entities);

        // If cache is empty, perform a full scan
        const cacheIsEmpty = Object.keys(this._capabilityCache).length === 0;
        if (cacheIsEmpty) {
            this.scanAllCapabilities(state);
        }

        const actionStatus = {};

        for (const [actionName, actionData] of Object.entries(actions)) {
            const cache = this._capabilityCache[actionName] || [];
            const canExecute = cache; // All entries in the array
            const cannotExecute = entityIds
                .filter(eid => !cache.some(e => e.entityId === eid))
                .map(eid => ({ entityId: eid, componentName: 'Entity', componentIdentifier: eid }));

            actionStatus[actionName] = {
                ...actionData,
                canExecute,
                cannotExecute
            };
        }

        return actionStatus;
    }

    /**
     * Checks if an entity meets the requirements for an action.
     * @param {string} actionName - The name of the action to check.
     * @param {string} entityId - The entity ID to check.
     * @returns {{passed: boolean, error?: {code: string, details: Object}, componentId?: string, requirementValues?: Object, fulfillingComponents?: Object}}
     * Result indicating if requirements were passed and which components fulfilled them.
     */
    checkRequirements(actionName, entityId) {
        const action = this.actionRegistry[actionName];
        if (!action) {
            return {
                passed: false,
                error: { code: 'ACTION_NOT_FOUND', details: { actionName } }
            };
        }
        return this._checkRequirements(action.requirements, entityId);
    }

    /**
     * Executes an action on an entity.
     * For actions with both attacker and target components (e.g., punch),
     * uses the attacker's component for requirement value resolution and
     * the target's component for consequence application.
     * @param {string} actionName - The name of the action to execute.
     * @param {string} entityId - The ID of the entity to perform the action.
     * @param {Object} [params] - Additional action parameters.
     * @param {string} [params.attackerComponentId] - The component performing the action (used for damage value resolution).
     * @param {string} [params.targetComponentId] - The component being targeted (used for consequence application).
     * @returns {Object} Result of the action execution.
     */
    executeAction(actionName, entityId, params = {}) {
        try {
            const action = this.actionRegistry[actionName];

            if (!action) {
                return {
                    success: false,
                    error: this._resolveError({
                        code: 'ACTION_NOT_FOUND',
                        details: { actionName }
                    })
                };
            }

            // Determine which component's stats to use for requirement value resolution
            // Priority: attackerComponentId (for actions like punch) > targetComponentId > entity-wide check
            let requirementValues = {};
            let fulfillingComponents = {};

            if (params && params.attackerComponentId) {
                // Use the attacker component's stats (e.g., droidHand for punch action)
                const attackerComponentId = params.attackerComponentId;
                const componentStats = this.worldStateController.componentController.getComponentStats(attackerComponentId);

                if (componentStats) {
                    // Check that this component meets the requirements
                    const componentCheck = this._checkRequirementsForComponent(
                        action.requirements, entityId, attackerComponentId
                    );

                    if (!componentCheck.passed) {
                        const errorMessage = this._resolveError(componentCheck.error);
                        const failureResults = this._executeFailureConsequences(actionName, entityId);
                        return {
                            success: false,
                            error: `Requirement failed: ${errorMessage}`,
                            ...failureResults
                        };
                    }

                    requirementValues = componentCheck.requirementValues;
                    fulfillingComponents = componentCheck.fulfillingComponents;
                }
            } else if (params && params.targetComponentId) {
                // Legacy: Use the explicitly selected component's stats
                const selectedComponentId = params.targetComponentId;
                const componentStats = this.worldStateController.componentController.getComponentStats(selectedComponentId);

                if (componentStats) {
                    // Check that this component meets the requirements
                    const componentCheck = this._checkRequirementsForComponent(
                        action.requirements, entityId, selectedComponentId
                    );

                    if (!componentCheck.passed) {
                        const errorMessage = this._resolveError(componentCheck.error);
                        const failureResults = this._executeFailureConsequences(actionName, entityId);
                        return {
                            success: false,
                            error: `Requirement failed: ${errorMessage}`,
                            ...failureResults
                        };
                    }

                    requirementValues = componentCheck.requirementValues;
                    fulfillingComponents = componentCheck.fulfillingComponents;
                }
            } else {
                // Fallback: use entity-wide requirement checking
                const requirementCheck = this._checkRequirements(action.requirements, entityId);
                if (!requirementCheck.passed) {
                    const errorMessage = this._resolveError(requirementCheck.error);
                    const failureResults = this._executeFailureConsequences(actionName, entityId);
                    return {
                        success: false,
                        error: `Requirement failed: ${errorMessage}`,
                        ...failureResults
                    };
                }
                requirementValues = requirementCheck.requirementValues;
                fulfillingComponents = requirementCheck.fulfillingComponents;
            }

            // Execute success consequences
            const consequenceResult = this._executeConsequences(
                actionName,
                entityId,
                requirementValues,
                params,
                fulfillingComponents
            );

            return {
                success: true,
                action: actionName,
                entityId,
                ...consequenceResult
            };
        } catch (error) {
            return {
                success: false,
                error: this._resolveError({
                    code: 'SYSTEM_RUNTIME_ERROR',
                    details: { error: error.message }
                })
            };
        }
    }

    // =========================================================================
    // EVENT SUBSCRIPTION API
    // =========================================================================

    /**
     * Subscribes to capability change events for a specific action.
     * @param {string} actionName - The action name to subscribe to.
     * @param {Function} callback - Called with (actionName, capabilityEntry) when the capability changes.
     */
    on(actionName, callback) {
        if (typeof callback !== 'function') return;
        if (!this._actionSubscribers.has(actionName)) {
            this._actionSubscribers.set(actionName, []);
        }
        const subscribers = this._actionSubscribers.get(actionName);
        if (!subscribers.includes(callback)) {
            subscribers.push(callback);
        }
    }

    /**
     * Unsubscribes from capability change events for a specific action.
     * @param {string} actionName - The action name.
     * @param {Function} callback - The callback to remove.
     */
    off(actionName, callback) {
        const subscribers = this._actionSubscribers.get(actionName);
        if (subscribers) {
            const index = subscribers.indexOf(callback);
            if (index !== -1) {
                subscribers.splice(index, 1);
            }
        }
    }

    /**
     * Notifies all subscribers for a specific action.
     * @param {string} actionName - The action name.
     * @param {ComponentCapabilityEntry|null} capability - The new capability entry, or a RemovalMarker if removed.
     * @private
     */
    _notifySubscribers(actionName, capability) {
        const subscribers = this._actionSubscribers.get(actionName) || [];
        for (const callback of subscribers) {
            try {
                callback(actionName, capability);
            } catch (error) {
                Logger.error(`[ActionController] Error in subscriber callback for "${actionName}":`, error.message);
            }
        }
    }

    // =========================================================================
    // STAT CHANGE HANDLER
    // =========================================================================

    /**
     * Called when a component stat changes. Re-evaluates all dependent actions.
     * @param {string} componentId - The component instance ID that changed.
     * @param {string} traitId - The trait category that changed.
     * @param {string} statName - The stat name that changed.
     * @param {any} newValue - The new stat value.
     * @param {any} oldValue - The previous stat value.
     */
    onStatChange(componentId, traitId, statName, newValue, oldValue) {
        // Only re-evaluate if the value actually changed
        if (newValue === oldValue) return;

        // Find all actions that depend on this trait.stat
        const dependentActions = this._getActionsForTraitStat(traitId, statName);
        if (dependentActions.length === 0) return;

        // Get the current world state for re-evaluation
        const state = this.worldStateController.getAll();

        // Re-evaluate each dependent action for this component
        for (const actionName of dependentActions) {
            this.reEvaluateActionForComponent(state, actionName, componentId);
        }
    }

    // =========================================================================
    // PRIVATE: REQUIREMENT CHECKING
    // =========================================================================

    /**
     * Checks if an entity meets the requirements for an action.
     * Requirements can be satisfied by multiple components.
     * @param {Array<Object>} requirements - An array of requirement objects.
     * @param {string} entityId - The entity ID to check.
     * @returns {{passed: boolean, requirementValues?: Object, fulfillingComponents?: Object, componentId?: string, error?: {code: string, details: Object}}}
     */
    _checkRequirements(requirements, entityId) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) {
            return {
                passed: false,
                error: { code: 'ENTITY_NOT_FOUND', details: { entityId } }
            };
        }

        const reqList = Array.isArray(requirements) ? requirements : [requirements];

        // 1. Score components based on how many requirements they satisfy
        const componentScores = entity.components.map(component => {
            const stats = this.worldStateController.componentController.getComponentStats(component.id);
            let score = 0;
            const satisfiedReqs = [];

            for (const req of reqList) {
                if (stats && stats[req.trait] && stats[req.trait][req.stat] >= req.minValue) {
                    score++;
                    satisfiedReqs.push(req);
                }
            }
            return { id: component.id, score, satisfiedReqs };
        });

        // 2. Sort components by score descending to prioritize the most capable ones
        componentScores.sort((a, b) => b.score - a.score);

        const requirementValues = {};
        const fulfillingComponents = {};
        let primaryComponentId = null;

        // 3. Assign the best available component for each requirement
        for (const req of reqList) {
            const bestComponent = componentScores.find(cs =>
                cs.satisfiedReqs.some(r => r === req)
            );

            if (!bestComponent) {
                return {
                    passed: false,
                    error: {
                        code: 'MISSING_TRAIT_STAT',
                        details: { trait: req.trait, stat: req.stat, minValue: req.minValue }
                    }
                };
            }

            const stats = this.worldStateController.componentController.getComponentStats(bestComponent.id);
            const key = `${req.trait}.${req.stat}`;
            requirementValues[key] = stats[req.trait][req.stat];
            fulfillingComponents[key] = bestComponent.id;

            if (!primaryComponentId) primaryComponentId = bestComponent.id;
        }

        return { passed: true, requirementValues, fulfillingComponents, componentId: primaryComponentId };
    }

    /**
     * Checks if the specific component meets ALL of the action's requirements itself.
     * A component is only eligible for caching if it possesses ALL required traits.
     * This prevents components without the relevant traits from appearing in the capability list.
     *
     * @param {Array<Object>} requirements - An array of requirement objects.
     * @param {string} entityId - The entity ID (used for error logging).
     * @param {string} componentId - The specific component to evaluate.
     * @returns {{passed: boolean, requirementValues?: Object, fulfillingComponents?: Object, error?: {code: string, details: Object}}}
     * @private
     */
    _checkRequirementsForComponent(requirements, entityId, componentId) {
        const componentStats = this.worldStateController.componentController.getComponentStats(componentId);
        if (!componentStats) {
            return { passed: false, error: { code: 'ENTITY_NOT_FOUND', details: { entityId } } };
        }

        const reqList = Array.isArray(requirements) ? requirements : [requirements];

        const requirementValues = {};
        const fulfillingComponents = {};

        for (const req of reqList) {
            const key = `${req.trait}.${req.stat}`;

            // Strict check: this specific component MUST satisfy the requirement itself.
            // No fallback to other components — if the component doesn't have this trait,
            // it should NOT be cached as capable of this action.
            if (!componentStats[req.trait] ||
                componentStats[req.trait][req.stat] === undefined ||
                componentStats[req.trait][req.stat] < req.minValue) {
                // This component lacks a required trait — it cannot perform this action
                return {
                    passed: false,
                    error: {
                        code: 'MISSING_TRAIT_STAT',
                        details: { trait: req.trait, stat: req.stat, minValue: req.minValue }
                    }
                };
            }

            requirementValues[key] = componentStats[req.trait][req.stat];
            fulfillingComponents[key] = componentId;
        }

        return { passed: true, requirementValues, fulfillingComponents };
    }

    // =========================================================================
    // PRIVATE: SCORING
    // =========================================================================

    /**
     * Calculates a compatibility score for a component against a set of action requirements.
     * Higher scores indicate better compatibility.
     * @param {Object} componentStats - The component's stats.
     * @param {Array<Object>} requirements - The action's requirements.
     * @returns {number} The compatibility score.
     * @private
     */
    _calculateComponentScore(componentStats, requirements) {
        let score = 0;
        let satisfiedCount = 0;

        for (const req of requirements) {
            const traitData = componentStats[req.trait];
            if (!traitData || traitData[req.stat] === undefined) continue;

            const value = traitData[req.stat];

            if (value >= req.minValue) {
                satisfiedCount++;
                score += ACTION_SCORING.REQUIREMENT_MET;

                // Bonus for exceeding the threshold significantly
                const excessRatio = value / req.minValue;
                if (excessRatio > ACTION_SCORING.EXCEEDED_THRESHOLD_MULTIPLIER) {
                    score += ACTION_SCORING.REQUIREMENT_EXCEEDED_BONUS * (excessRatio - 1);
                }
            } else {
                // Penalize if close to threshold (within 25% of required value)
                const ratio = value / req.minValue;
                if (ratio > (1 / CLOSE_TO_THRESHOLD_FACTOR)) {
                    score += ACTION_SCORING.CLOSE_TO_THRESHOLD_PENALTY;
                }
            }
        }

        // Only return positive scores (component satisfies at least one requirement)
        return satisfiedCount > 0 ? score : 0;
    }

    // =========================================================================
    // PRIVATE: TRAIT-STAT ACTION INDEX
    // =========================================================================

    /**
     * Builds a reverse index mapping trait.stat → Set of action names.
     * Enables efficient lookup of which actions depend on specific traits.
     * @private
     */
    _buildTraitStatActionIndex() {
        this._traitStatActionIndex = new Map();

        for (const [actionName, actionData] of Object.entries(this.actionRegistry)) {
            if (!actionData.requirements) continue;

            for (const req of actionData.requirements) {
                const indexKey = `${req.trait}.${req.stat}`;
                if (!this._traitStatActionIndex.has(indexKey)) {
                    this._traitStatActionIndex.set(indexKey, new Set());
                }
                this._traitStatActionIndex.get(indexKey).add(actionName);
            }
        }
    }

    /**
     * Gets all action names that depend on a specific trait.stat combination.
     * @param {string} traitId - The trait category.
     * @param {string} statName - The stat name.
     * @returns {Array<string>} Array of action names.
     * @private
     */
    _getActionsForTraitStat(traitId, statName) {
        const indexKey = `${traitId}.${statName}`;
        const actions = this._traitStatActionIndex.get(indexKey);
        return actions ? Array.from(actions) : [];
    }

    /**
     * Gets all action names that depend on a specific component's traits.
     * Uses the component's stats to build the trait.stat keys.
     * @param {string} componentId - The component ID.
     * @returns {Array<string>|null} Array of action names, or null if component not found.
     * @private
     */
    _getActionsForTraitStatFromComponent(componentId) {
        const componentStats = this.worldStateController.componentController.getComponentStats(componentId);
        if (!componentStats) return null;

        const actionSet = new Set();

        // Iterate over all traits and stats for this component
        for (const [traitId, stats] of Object.entries(componentStats)) {
            for (const statName of Object.keys(stats)) {
                const dependentActions = this._getActionsForTraitStat(traitId, statName);
                for (const actionName of dependentActions) {
                    actionSet.add(actionName);
                }
            }
        }

        return Array.from(actionSet);
    }

    /**
     * Marker object indicating a capability entry was removed.
     * @typedef {Object} RemovalMarker
     * @property {string} _type - Always 'REMOVAL'.
     * @property {string} componentId - The removed component's ID.
     * @property {string} entityId - The removed entity's ID.
     */

    /**
     * Creates a removal marker for notification purposes.
     * @param {string} componentId - The removed component ID.
     * @param {string} entityId - The removed entity ID.
     * @returns {RemovalMarker}
     * @private
     */
    _createRemovalMarker(componentId, entityId) {
        return { _type: 'REMOVAL', componentId, entityId };
    }

    /**
     * Removes a component from the cache for a specific action.
     * Removes the entry from the action's array.
     * @param {string} actionName - The action name.
     * @param {string} componentId - The component ID to remove.
     * @private
     */
    _removeComponentFromActionCache(actionName, componentId) {
        const actionEntries = this._capabilityCache[actionName];
        if (!actionEntries) return;

        const initialLength = actionEntries.length;
        const filtered = actionEntries.filter(e => e.componentId !== componentId);

        if (filtered.length < initialLength) {
            // Find the removed entry to include its entity ID in the marker
            const removedEntry = actionEntries.find(e => e.componentId === componentId);
            this._capabilityCache[actionName] = filtered;
            this._notifySubscribers(actionName, this._createRemovalMarker(componentId, removedEntry?.entityId || 'unknown'));
        }
    }

    /**
     * Removes all entries for a specific entity from all action arrays.
     * @param {string} entityId - The entity ID to remove.
     * @private
     */
    _removeEntityFromAllActionCaches(entityId) {
        for (const [actionName, entries] of Object.entries(this._capabilityCache)) {
            const initialLength = entries.length;
            const filtered = entries.filter(e => e.entityId !== entityId);

            if (filtered.length < initialLength) {
                this._capabilityCache[actionName] = filtered;
                this._notifySubscribers(actionName, this._createRemovalMarker('multiple', entityId));
            }
        }
    }

    // =========================================================================
    // PRIVATE: CONSEQUENCE EXECUTION
    // =========================================================================

    /**
     * Resolves a structured error into a human-readable message and logs it.
     * @param {Object} error - The error object { code, details }.
     * @returns {string} Formatted error message.
     */
    _resolveError(error) {
        if (!error || !error.code) {
            Logger.error("An unknown error occurred.");
            return "An unknown error occurred.";
        }
        const registryEntry = ERROR_REGISTRY[error.code];
        if (!registryEntry) {
            Logger.error(`An undefined error occurred: ${error.code}`);
            return "An undefined error occurred.";
        }

        let message = registryEntry.message;
        if (error.details) {
            for (const [key, value] of Object.entries(error.details)) {
                message = message.replace(`{${key}}`, value);
            }
        }

        const logLevel = registryEntry.level || 'ERROR';
        Logger[logLevel.toLowerCase()](message, error.details);

        return message;
    }

    /**
     * Executes the success consequences of an action using the normalized handler interface.
     * @param {string} actionName - The name of the action to execute.
     * @param {string} entityId - The ID of the entity performing the action.
     * @param {Object} requirementValues - Map of trait.stat values for substitution.
     * @param {Object} params - Additional action parameters.
     * @param {Object} fulfillingComponents - Map of requirements to the components that satisfied them.
     * @returns {Object} Result of consequence execution.
     */
    _executeConsequences(actionName, entityId, requirementValues, params, fulfillingComponents = {}) {
        const action = this.actionRegistry[actionName];
        if (!action || !action.consequences) {
            return { success: false, error: `Action "${actionName}" has no consequences defined.` };
        }

            const results = [];
            const context = {
                requirementValues,
                actionParams: params,
                fulfillingComponents
            };

            for (const consequence of action.consequences) {
                const resolvedParams = this._resolvePlaceholders(consequence.params, requirementValues, params);

                const handler = this.consequenceHandlers.handlers[consequence.type];
                if (!handler) {
                    results.push({ success: false, error: `Unknown consequence type: "${consequence.type}"` });
                    continue;
                }

                try {
                    // Spatial consequences (updateSpatial, deltaSpatial) always operate on the entity.
                    // Component-level consequences (updateComponentStatDelta, damageComponent) resolve
                    // their target from context.actionParams.targetComponentId inside the handler.
                    const spatialTypes = ['updateSpatial', 'deltaSpatial'];
                    const targetId = spatialTypes.includes(consequence.type)
                        ? entityId
                        : (params.targetComponentId || entityId);
                    const result = handler(targetId, resolvedParams, context);

                results.push({ success: true, type: consequence.type, ...result });
            } catch (error) {
                results.push({
                    success: false,
                    error: this._resolveError({
                        code: 'CONSEQUENCE_EXECUTION_FAILED',
                        details: { type: consequence.type, error: error.message }
                    }),
                    type: consequence.type
                });
            }
        }

        return { success: true, executedConsequences: results.length, results };
    }

    /**
     * Resolves placeholders in params (e.g., ":Movement.move" -> actual value).
     * Now supports embedded placeholders within strings.
     * Includes numeric validation to prevent string concatenation bugs.
     * @private
     * @param {any} params - The value to resolve.
     * @param {Object} requirementValues - Map of "trait.stat" → numeric value.
     * @param {Object} actionParams - Parameters passed from the client.
     * @returns {any} The resolved value (number if placeholder resolved, original otherwise).
     */
    _resolvePlaceholders(params, requirementValues, actionParams) {
        if (params === null || params === undefined) return params;

        if (typeof params === 'string') {
            // If the string is EXACTLY a placeholder (with optional sign/multiplier), return as number
            const exactMatch = params.match(/^(-)?(:[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)(?:\*(-?\d+))?$/);
            if (exactMatch) {
                const sign = exactMatch[1] === '-' ? -1 : 1;
                const placeholder = exactMatch[2].substring(1);
                const multiplier = exactMatch[3] ? parseInt(exactMatch[3], 10) : 1;
                const value = requirementValues[placeholder];
                // Validate that the resolved value is numeric
                if (value !== undefined && typeof value === 'number') {
                    return sign * value * multiplier;
                }
                Logger.warn(`[ActionController] Placeholder "${placeholder}" resolved to non-numeric value:`, value);
                return params; // Return original string if not numeric
            }

            // Otherwise, treat as a template string and replace all embedded placeholders
            const resolved = params.replace(/(-)?(:[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)(\*(-?\d+))?/g, (match, sign, placeholder, multiplier) => {
                const pName = placeholder.substring(1);
                const val = requirementValues[pName];
                if (val === undefined) return match;

                // Validate numeric resolution
                if (typeof val !== 'number') {
                    Logger.warn(`[ActionController] Placeholder "${pName}" resolved to non-numeric value:`, val);
                    return match; // Keep original placeholder
                }

                const s = sign === '-' ? -1 : 1;
                const m = multiplier ? parseInt(multiplier.substring(1), 10) : 1;
                return s * val * m;
            });
            return resolved;
        }

        if (typeof params === 'number') return params;
        if (Array.isArray(params)) return params.map(p => this._resolvePlaceholders(p, requirementValues, actionParams));
        if (typeof params === 'object') {
            const result = {};
            for (const [key, value] of Object.entries(params)) {
                result[key] = this._resolvePlaceholders(value, requirementValues, actionParams);
            }
            return result;
        }
        return params;
    }

    /**
     * Executes the failure consequences of an action.
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Result of failure consequence execution.
     */
    _executeFailureConsequences(actionName, entityId) {
        const action = this.actionRegistry[actionName];
        if (!action || !action.failureConsequences) {
            return { success: false, error: `Action "${actionName}" has no failure consequences defined.` };
        }

        const results = [];
        for (const consequence of action.failureConsequences) {
            const resolvedParams = this._resolvePlaceholders(consequence.params, {}, {});
            const handler = this.consequenceHandlers.handlers[consequence.type];
            if (handler) {
                // Pass an empty context for failure consequences
                results.push({ success: true, type: consequence.type, ...handler(entityId, resolvedParams, {}) });
            }
        }

        return { success: false, executedFailureConsequences: results.length, results };
    }

    /**
     * Returns all registered actions.
     * @returns {Object}
     */
    getRegistry() {
        return this.actionRegistry;
    }
}

export default ActionController;
