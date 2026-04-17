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
 * Capability entry representing the best component for an action on an entity.
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

/**
 * ActionController handles game actions, checking requirements and
 * executing consequences through a decoupled handler system.
 * 
 * It maintains a capability cache that maps each action to its best
 * fulfilling component across all entities. When component stats change,
 * the relevant actions are automatically re-evaluated.
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
         * Capability cache: maps actionName → ActionCapabilityEntry (best component per entity).
         * Format: { [actionName]: { [entityId]: ActionCapabilityEntry } }
         * @type {Object<string, Object<string, ActionCapabilityEntry>>}
         */
        this._capabilityCache = {};

        /**
         * Action subscribers for event-driven capability change notifications.
         * Format: { [actionName]: [callback functions] }
         * @type {Map<string, Array<Function>>}
         */
        this._actionSubscribers = new Map();

        /**
         * Reverse index: maps componentId → Set of actionNames that depend on its traits.
         * Enables efficient re-evaluation on stat changes.
         * @type {Map<string, Set<string>>}
         */
        this._componentActionIndex = new Map();

        // Build the reverse index from the action registry
        this._buildComponentActionIndex();
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    /**
     * Scans all entities and their components against all registered actions,
     * then updates the capability cache with the best component for each action-entity pair.
     * This is the main method for performing a full capability re-evaluation.
     * @param {Object} state - The current world state (contains entities).
     * @returns {Object<string, Object<string, ActionCapabilityEntry>>} The updated capability cache.
     */
    scanAllCapabilities(state) {
        const entities = state.entities || {};
        const entityIds = Object.keys(entities);
        const actions = this.getRegistry();

        // Clear the cache for a fresh scan
        this._capabilityCache = {};

        // Initialize cache structure for each action
        for (const actionName of Object.keys(actions)) {
            this._capabilityCache[actionName] = {};
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

                    // Check if this component is the best for this action on this entity
                    const currentBest = this._capabilityCache[actionName]?.[entityId];
                    if (!currentBest || score > currentBest.score) {
                        const requirementCheck = this._checkRequirementsForComponent(
                            actionData.requirements, entityId, component.id
                        );

                        if (requirementCheck.passed) {
                            this._capabilityCache[actionName][entityId] = {
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
                        }
                    }
                }
            }
        }

        return this._capabilityCache;
    }

    /**
     * Re-evaluates a specific action for a specific component.
     * Called when a component stat changes. Only updates the affected action entry.
     * @param {Object} state - The current world state.
     * @param {string} actionName - The action to re-evaluate.
     * @param {string} componentId - The component whose stats changed.
     * @returns {ActionCapabilityEntry|null} The updated capability entry, or null if the component no longer qualifies.
     */
    reEvaluateActionForComponent(state, actionName, componentId) {
        const actionData = this.actionRegistry[actionName];
        if (!actionData || !actionData.requirements || actionData.requirements.length === 0) return null;

        const componentStats = this.worldStateController.componentController.getComponentStats(componentId);
        if (!componentStats) return null;

        const score = this._calculateComponentScore(componentStats, actionData.requirements);
        if (score <= 0) {
            // Component no longer qualifies — remove from cache for all entities
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

        // Check if this component is now the best for this action on this entity
        const requirementCheck = this._checkRequirementsForComponent(
            actionData.requirements, targetEntityId, componentId
        );

        if (!requirementCheck.passed) {
            this._capabilityCache[actionName]?.[targetEntityId] &&
                delete this._capabilityCache[actionName][targetEntityId];
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

        // Compare against current best
        const currentBest = this._capabilityCache[actionName]?.[targetEntityId];
        if (!currentBest || score > currentBest.score) {
            this._capabilityCache[actionName][targetEntityId] = newEntry;
            this._notifySubscribers(actionName, newEntry);
            return newEntry;
        }

        return currentBest;
    }

    /**
     * Re-evaluates all actions that depend on a specific component's traits.
     * Called when a component stat changes.
     * @param {Object} state - The current world state.
     * @param {string} componentId - The component whose stats changed.
     * @returns {Array<ActionCapabilityEntry>} List of updated capability entries.
     */
    reEvaluateAllActionsForComponent(state, componentId) {
        const dependentActions = this._componentActionIndex.get(componentId);
        if (!dependentActions) return [];

        const updatedEntries = [];
        for (const actionName of dependentActions) {
            const entry = this.reEvaluateActionForComponent(state, actionName, componentId);
            if (entry) updatedEntries.push(entry);
        }

        return updatedEntries;
    }

    /**
     * Returns the cached capability entries for all actions.
     * Optimized: returns the cached data directly without recomputation.
     * @returns {Object<string, Object<string, ActionCapabilityEntry>>} The capability cache.
     */
    getCachedCapabilities() {
        return this._capabilityCache;
    }

    /**
     * Returns the best component for a specific action.
     * @param {string} actionName - The action name.
     * @returns {ActionCapabilityEntry|null} The best capability entry, or null if none.
     */
    getBestComponentForAction(actionName) {
        const actionCache = this._capabilityCache[actionName];
        if (!actionCache) return null;

        let bestEntry = null;
        for (const entry of Object.values(actionCache)) {
            if (!bestEntry || entry.score > bestEntry.score) {
                bestEntry = entry;
            }
        }
        return bestEntry;
    }

    /**
     * Returns all capability entries for a specific action.
     * @param {string} actionName - The action name.
     * @returns {Array<ActionCapabilityEntry>} Array of capability entries.
     */
    getAllCapabilitiesForAction(actionName) {
        const actionCache = this._capabilityCache[actionName];
        if (!actionCache) return [];
        return Object.values(actionCache);
    }

    /**
     * Returns capability entries for a specific entity across all actions.
     * @param {string} entityId - The entity ID.
     * @returns {Object<string, ActionCapabilityEntry>} Map of actionName → capability entry.
     */
    getCapabilitiesForEntity(entityId) {
        const result = {};
        for (const [actionName, entityCache] of Object.entries(this._capabilityCache)) {
            if (entityCache[entityId]) {
                result[actionName] = entityCache[entityId];
            }
        }
        return result;
    }

    /**
     * Retrieves only the actions that are relevant to a specific entity.
     * Uses the cached capability data and augments with action definitions.
     * Triggers a full capability scan if the cache is empty OR if the entity is not in the cache.
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
            const cachedEntry = entityCache[actionName]?.[entityId];

            if (cachedEntry) {
                filteredActions[actionName] = {
                    ...actionData,
                    canExecute: [cachedEntry],
                    cannotExecute: []
                };
            } else {
                // Check if entity exists but can't execute
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
        for (const actionCache of Object.values(this._capabilityCache)) {
            if (actionCache[entityId]) {
                return true;
            }
        }
        return false;
    }

    /**
     * Calculates which entities are capable of executing which actions based on the current world state.
     * Uses the cached capability data. If cache is stale or empty, performs a full scan.
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
            const cache = this._capabilityCache[actionName] || {};
            const canExecute = Object.values(cache);
            const cannotExecute = entityIds
                .filter(eid => !cache[eid])
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
     * @param {string} actionName - The name of the action to execute.
     * @param {string} entityId - The ID of the entity to perform the action.
     * @param {Object} [params] - Additional action parameters.
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
            
            // Check requirements
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
            
            // Execute success consequences
            const consequenceResult = this._executeConsequences(
                actionName, 
                entityId, 
                requirementCheck.requirementValues,
                params,
                requirementCheck.fulfillingComponents
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
     * @param {ActionCapabilityEntry} capability - The new capability entry.
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
     * Fixed: Requirements can now be satisfied by multiple components.
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
     * Checks if an entity meets the requirements, specifically for the given component.
     * Used during capability caching to evaluate a specific component's contribution.
     * @param {Array<Object>} requirements - An array of requirement objects.
     * @param {string} entityId - The entity ID.
     * @param {string} componentId - The specific component to evaluate.
     * @returns {{passed: boolean, requirementValues?: Object, fulfillingComponents?: Object}}
     * @private
     */
    _checkRequirementsForComponent(requirements, entityId, componentId) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) {
            return { passed: false, error: { code: 'ENTITY_NOT_FOUND', details: { entityId } } };
        }

        const reqList = Array.isArray(requirements) ? requirements : [requirements];
        const componentStats = this.worldStateController.componentController.getComponentStats(componentId);

        const requirementValues = {};
        const fulfillingComponents = {};

        for (const req of reqList) {
            const key = `${req.trait}.${req.stat}`;
            
            // Check if this specific component satisfies the requirement
            if (componentStats && componentStats[req.trait] && 
                componentStats[req.trait][req.stat] >= req.minValue) {
                requirementValues[key] = componentStats[req.trait][req.stat];
                fulfillingComponents[key] = componentId;
            } else {
                // Look for another component that satisfies this requirement
                let found = false;
                for (const comp of entity.components) {
                    const compStats = this.worldStateController.componentController.getComponentStats(comp.id);
                    if (compStats && compStats[req.trait] && 
                        compStats[req.trait][req.stat] >= req.minValue) {
                        requirementValues[key] = compStats[req.trait][req.stat];
                        fulfillingComponents[key] = comp.id;
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    return { 
                        passed: false, 
                        error: { 
                            code: 'MISSING_TRAIT_STAT', 
                            details: { trait: req.trait, stat: req.stat, minValue: req.minValue } 
                        } 
                    };
                }
            }
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
    // PRIVATE: COMPONENT-ACTION INDEX
    // =========================================================================

    /**
     * Builds a reverse index mapping component trait.stat → Set of action names.
     * Enables efficient lookup of which actions depend on specific traits.
     * @private
     */
    _buildComponentActionIndex() {
        this._componentActionIndex = new Map();

        for (const [actionName, actionData] of Object.entries(this.actionRegistry)) {
            if (!actionData.requirements) continue;

            for (const req of actionData.requirements) {
                const indexKey = `${req.trait}.${req.stat}`;
                if (!this._componentActionIndex.has(indexKey)) {
                    this._componentActionIndex.set(indexKey, new Set());
                }
                this._componentActionIndex.get(indexKey).add(actionName);
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
        const actions = this._componentActionIndex.get(indexKey);
        return actions ? Array.from(actions) : [];
    }

    /**
     * Removes a component from the cache for a specific action across all entities.
     * @param {string} actionName - The action name.
     * @param {string} componentId - The component ID to remove.
     * @private
     */
    _removeComponentFromActionCache(actionName, componentId) {
        const actionCache = this._capabilityCache[actionName];
        if (!actionCache) return;

        for (const [entityId, entry] of Object.entries(actionCache)) {
            if (entry.componentId === componentId) {
                delete actionCache[entityId];
                this._notifySubscribers(actionName, null);
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
                // The handler manages its own targetId resolution (entity vs component) using the context
                const targetId = params.targetComponentId || entityId;
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
