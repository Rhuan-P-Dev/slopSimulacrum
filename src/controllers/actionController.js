import Logger from '../utils/Logger.js';

/**
 * Component action binding roles — defines which body part participates in which action.
 * Enforces the "one body part, one action" rule: if you use your right leg to jump,
 * you cannot use it to attack simultaneously.
 *
 * @readonly
 * @enum {string}
 */
const BINDING_ROLES = {
    SOURCE: 'source',           // Component providing the action's power/stats (e.g., droidHand for punch)
    TARGET: 'target',           // Component being affected (e.g., enemy's droidArm taking damage)
    SPATIAL: 'spatial',         // Component driving movement (e.g., droidRollingBall for move/dash)
    SELF_TARGET: 'self_target'  // Component self-affecting (e.g., centralBall for selfHeal)
};

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
    'COMPONENT_BINDING_MISMATCH': { message: 'Selected component does not match the action\'s binding roles. Action "{actionName}" expects roles: {expectedRoles}. Selected role: {selectedRole}', level: 'ERROR' },
    'SYSTEM_RUNTIME_ERROR': { message: 'An unexpected system error occurred: {error}', level: 'CRITICAL' },
};

/**
 * ActionController handles game actions, checking requirements and
 * executing consequences through a decoupled handler system.
 *
 * Component capability management (scanning, caching, scoring, re-evaluation)
 * has been extracted to ComponentCapabilityController to adhere to the
 * Single Responsibility Principle.
 *
 * ActionController responsibilities:
 * - Action execution (executeAction)
 * - Entity-level requirement validation (checkRequirements, _checkRequirements)
 * - Consequence execution (_executeConsequences)
 * - Placeholder resolution (_resolvePlaceholders)
 * - Delegates capability cache queries to ComponentCapabilityController
 *
 * @example
 * // Architecture flow:
 * // Server -> WorldStateController -> ActionController (executeAction)
 * // Server -> WorldStateController -> ComponentCapabilityController (capability queries)
 */
class ActionController {
    /**
     * @param {WorldStateController} worldStateController - The main world state controller.
     * @param {ConsequenceHandlers} consequenceHandlers - The consequence handler system.
     * @param {Object} actionRegistry - The registry of available actions.
     * @param {ComponentCapabilityController} componentCapabilityController - The capability cache manager.
     * @param {SynergyController} [synergyController] - The synergy system controller (optional).
     * @param {ActionSelectController} [actionSelectController] - The component selection/locking controller (optional).
     */
    constructor(worldStateController, consequenceHandlers, actionRegistry, componentCapabilityController, synergyController, actionSelectController) {
        this.worldStateController = worldStateController;
        this.consequenceHandlers = consequenceHandlers;
        this.actionRegistry = actionRegistry || {};
        this.componentCapabilityController = componentCapabilityController;
        this.synergyController = synergyController || null;
        this.actionSelectController = actionSelectController || null;
    }

    // =========================================================================
    // PUBLIC API: CAPABILITY DELEGATION
    // =========================================================================
    // All capability cache operations are delegated to ComponentCapabilityController.
    // These wrapper methods maintain backward compatibility for existing callers.

    /**
     * Scans all entities and their components against all registered actions.
     * Delegates to ComponentCapabilityController.scanAllCapabilities().
     *
     * @param {Object} state - The current world state (contains entities).
     * @returns {Object<string, Array<ComponentCapabilityEntry>>} The updated capability cache.
     */
    scanAllCapabilities(state) {
        return this.componentCapabilityController.scanAllCapabilities(state);
    }

    /**
     * Returns the cached capability entries for all actions.
     * Delegates to ComponentCapabilityController.getCachedCapabilities().
     *
     * @returns {Object<string, Array<ComponentCapabilityEntry>>} The capability cache.
     */
    getCachedCapabilities() {
        return this.componentCapabilityController.getCachedCapabilities();
    }

    /**
     * Returns the best component entry for a specific action (highest score).
     * Delegates to ComponentCapabilityController.getBestComponentForAction().
     * @param {string} actionName - The action name.
     * @returns {ComponentCapabilityEntry|null} The best capability entry, or null if none.
     */
    getBestComponentForAction(actionName) {
        return this.componentCapabilityController.getBestComponentForAction(actionName);
    }

    /**
     * Returns all capability entries for a specific action.
     * Delegates to ComponentCapabilityController.getAllCapabilitiesForAction().
     * @param {string} actionName - The action name.
     * @returns {Array<ComponentCapabilityEntry>} Array of capability entries (sorted by score).
     */
    getAllCapabilitiesForAction(actionName) {
        return this.componentCapabilityController.getAllCapabilitiesForAction(actionName);
    }

    /**
     * Returns capability entries for a specific entity across all actions.
     * Delegates to ComponentCapabilityController.getCapabilitiesForEntity().
     *
     * @param {string} entityId - The entity ID.
     * @returns {Array<ComponentCapabilityEntry>} Array of capability entries for this entity.
     */
    getCapabilitiesForEntity(entityId) {
        return this.componentCapabilityController.getCapabilitiesForEntity(entityId);
    }

    /**
     * Retrieves only the actions that are relevant to a specific entity.
     * Delegates to ComponentCapabilityController.getActionsForEntity().
     *
     * @param {Object} state - The current world state.
     * @param {string} entityId - The ID of the entity to filter for.
     * @returns {Object.<string, {requirements: Array, canExecute: Array, cannotExecute: Array}>}
     * Map of actions and their capability status for the entity.
     */
    getActionsForEntity(state, entityId) {
        return this.componentCapabilityController.getActionsForEntity(state, entityId);
    }

    /**
     * Calculates which entities are capable of executing which actions based on the current world state.
     * Delegates to ComponentCapabilityController.getActionCapabilities().
     *
     * @param {Object} state - The current world state.
     * @returns {Object.<string, {requirements: Array, canExecute: Array, cannotExecute: Array}>}
     * Map of actions and their capability status.
     */
    getActionCapabilities(state) {
        return this.componentCapabilityController.getActionCapabilities(state);
    }

    /**
     * Re-evaluates ALL actions for a specific entity.
     * Delegates to ComponentCapabilityController.reEvaluateEntityCapabilities().
     *
     * @param {Object} state - The current world state.
     * @param {string} entityId - The entity to re-evaluate.
     * @returns {Array<ComponentCapabilityEntry>} List of updated capability entries.
     */
    reEvaluateEntityCapabilities(state, entityId) {
        return this.componentCapabilityController.reEvaluateEntityCapabilities(state, entityId);
    }

    /**
     * Removes all capability entries for an entity from all action caches.
     * Delegates to ComponentCapabilityController.removeEntityFromCache().
     *
     * @param {string} entityId - The entity ID to remove.
     */
    removeEntityFromCache(entityId) {
        this.componentCapabilityController.removeEntityFromCache(entityId);
    }

    // =========================================================================
    // PUBLIC API: ACTION EXECUTION
    // =========================================================================

    /**
     * Checks if an entity meets the requirements for an action.
     * Uses entity-level requirement checking (can combine multiple components).
     *
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
     * Executes an action on an entity with component binding enforcement.
     * 
     * Component Binding System:
     * Each action defines which component roles participate via `componentBinding`.
     * The selected component(s) MUST match the expected role — this prevents using
     * the wrong body part for an action (e.g., using your right leg to attack
     * when you selected a jump action that binds to legs).
     *
     * Multi-Component Support:
     * The `params.componentIds` field accepts an array of {componentId, role} objects,
     * allowing multiple components to participate in a single action. When provided,
     * all components are validated, passed to synergy computation, and released after execution.
     *
     * For actions with both attacker and target components (e.g., punch),
     * uses the attacker's component for requirement value resolution and
     * the target's component for consequence application.
     *
     * @param {string} actionName - The name of the action to execute.
     * @param {string} entityId - The ID of the entity to perform the action.
     * @param {Object} [params] - Additional action parameters.
     * @param {Array<{componentId: string, role: string}>} [params.componentIds] - Multiple components for this action.
     * @param {string} [params.attackerComponentId] - The component performing the action (used for damage value resolution).
     * @param {string} [params.targetComponentId] - The component being targeted (used for consequence application).
     * @param {string} [params.selectedBindingRole] - The role of the selected component (e.g., 'source', 'spatial').
     * @returns {Object} Result of the action execution.
     */
    executeAction(actionName, entityId, params = {}) {
        // Track which components need to be released after execution
        const componentsToRelease = [];

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

            // ─── Resolve Component List ──────────────────────────────────────
            // Support both legacy single-component (targetComponentId/attackerComponentId)
            // and new multi-component (componentIds array) parameter formats.
            let componentList = null;
            let sourceComponentId = null;
            let isSpatial = action.targetingType === 'spatial';

            if (params.componentIds && Array.isArray(params.componentIds) && params.componentIds.length > 0) {
                // Multi-component mode: componentIds = [{ componentId, role }, ...]
                componentList = params.componentIds;
                sourceComponentId = componentList[0]?.componentId;
            } else if (params?.attackerComponentId || params?.targetComponentId) {
                // Legacy single-component mode
                sourceComponentId = params.attackerComponentId || params.targetComponentId;
                componentList = [{ componentId: sourceComponentId, role: params.selectedBindingRole || 'source' }];
            }

            // ─── Component Selection Validation ──────────────────────────────
            // Validate component selection for non-spatial actions.
            // Spatial actions auto-resolve the component on the server via _resolveSourceComponent().
            if (this.actionSelectController && sourceComponentId && !isSpatial) {
                // Use batch validation if componentList is available, otherwise fall back to single
                const validationCheck = componentList
                    ? this.actionSelectController.validateSelections(actionName, componentList.map(c => c.componentId))
                    : this.actionSelectController.validateSelection(sourceComponentId, actionName);

                if (!validationCheck.valid) {
                    const errorMessage = Array.isArray(validationCheck.error)
                        ? validationCheck.error.join(' ')
                        : validationCheck.error || 'Component selection validation failed.';
                    return {
                        success: false,
                        error: errorMessage
                    };
                }

                // Track for release after execution
                const idsToRelease = componentList
                    ? componentList.map(c => c.componentId)
                    : [sourceComponentId];
                componentsToRelease.push(...idsToRelease);
            }

            // ─── Component Binding Enforcement ───────────────────────────────
            // Resolve the source component based on action binding + selected role.
            // This ensures the selected component matches the expected role.
            // NOTE: Only enforce binding when componentBinding is explicitly defined.
            // When componentBinding is NOT defined (legacy actions), fall back to
            // entity-wide requirement checking which properly triggers failure consequences.

            let resolvedSourceComponentId = this._resolveSourceComponent(action, entityId, params);

            if (!resolvedSourceComponentId) {
                // If the action has no explicit componentBinding, treat this as a
                // requirement failure (so failure consequences execute properly).
                // Only return COMPONENT_BINDING_MISMATCH when binding is explicitly defined.
                if (action.componentBinding) {
                    return {
                        success: false,
                        error: this._resolveError({
                            code: 'COMPONENT_BINDING_MISMATCH',
                            details: { 
                                actionName, 
                                expectedRoles: action.componentBinding?.roles,
                                selectedRole: params?.selectedBindingRole
                            }
                        })
                    };
                }
                // No binding defined — fall through to requirement checking below
                // which will properly trigger failure consequences on requirement failure.
                // resolvedSourceComponentId stays null; the requirement checking block below
                // handles this via the fallback path.
            }

            // Validate the selected component matches the expected role
            // (only when we have a resolved component and binding is defined)
            let bindingValidation = { valid: true, reason: '' };
            if (resolvedSourceComponentId) {
                bindingValidation = this._validateComponentBinding(action, entityId, resolvedSourceComponentId, params);
                if (!bindingValidation.valid) {
                    return {
                        success: false,
                        error: bindingValidation.reason
                    };
                }
            }

            // Get requirement values from the resolved source component
            let requirementValues = {};
            let fulfillingComponents = {};

            if (params && params.attackerComponentId) {
                // Punch: Use the attacker component's stats (e.g., droidHand for punch action)
                const attackerComponentId = params.attackerComponentId;
                const componentStats = this.worldStateController.componentController.getComponentStats(attackerComponentId);

                if (componentStats) {
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

            // Compute synergy if enabled for this action
            // Pass resolved source component ID and component list for role-filtered synergy computation
            let synergyResult = null;
            if (this.synergyController) {
                synergyResult = this.synergyController.computeSynergy(
                    actionName,
                    entityId,
                    {
                        providedComponentIds: componentList,
                        synergyGroups: params?.synergyGroups,
                        sourceComponentId: resolvedSourceComponentId
                    }
                );
            }

            // Execute success consequences (with synergy applied)
            const consequenceResult = this._executeConsequences(
                actionName,
                entityId,
                requirementValues,
                params,
                fulfillingComponents,
                synergyResult
            );

            const result = {
                success: true,
                action: actionName,
                entityId,
                synergy: synergyResult,
                ...consequenceResult
            };
            return result;
        } catch (error) {
            return {
                success: false,
                error: this._resolveError({
                    code: 'SYSTEM_RUNTIME_ERROR',
                    details: { error: error.message }
                })
            };
        } finally {
            // ─── Release component selections after execution ────────────────
            // Always release locked components regardless of success or failure
            if (this.actionSelectController && componentsToRelease.length > 0) {
                this.actionSelectController.releaseSelections(componentsToRelease);
            }
        }
    }

    // =========================================================================
    // PRIVATE: COMPONENT BINDING RESOLUTION
    // =========================================================================

    /**
     * Resolves the source component ID based on action binding configuration
     * and the parameters provided by the client.
     * 
     * This is the core method that enforces the "one body part, one action" rule.
     * It determines which specific component should provide the action's power/stats.
     *
     * Resolution priority:
     * 1. If attackerComponentId provided → use it (punch actions)
     * 2. If targetingType is 'spatial' → find component matching spatialRole
     * 3. If targetingType is 'none' → find component matching selfTargetRole
     * 4. If targetComponentId provided → use it (legacy)
     * 5. Fallback → entity-wide best component
     *
     * @private
     * @param {Object} action - The action definition.
     * @param {string} entityId - The entity ID.
     * @param {Object} params - The action parameters.
     * @returns {string|null} The resolved source component ID, or null if none found.
     */
    _resolveSourceComponent(action, entityId, params) {
        const binding = action.componentBinding;
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);

        if (!entity) return null;

        // Priority 1: Punch actions with explicit attackerComponentId
        if (params?.attackerComponentId) {
            return params.attackerComponentId;
        }

        // Priority 2: Explicit targetComponentId from client (spatial actions with selected component)
        // The client selected a specific component in the UI, so respect that choice.
        if (params?.targetComponentId) {
            return params.targetComponentId;
        }

        // Priority 3: Spatial actions (move, dash) — auto-find component matching spatialRole
        if (action.targetingType === 'spatial' && binding?.spatialRole) {
            const spatialComponent = this._findComponentByRole(entity, binding, 'spatial');
            if (spatialComponent) return spatialComponent.id;
        }

        // Priority 4: Self-targeting actions (selfHeal) — find component matching selfTargetRole
        // Handles both 'none' (legacy) and 'self_target' (explicit self-targeting) targetingType
        if ((action.targetingType === 'none' || action.targetingType === 'self_target') && binding?.selfTargetRole) {
            const selfComponent = this._findComponentByRole(entity, binding, 'self_target', action);
            if (selfComponent) return selfComponent.id;
        }

        // Priority 5: Fallback — entity-wide check (use best component)
        const result = this._checkRequirements(action.requirements, entityId);
        return result.passed ? result.componentId : null;
    }

    /**
     * Finds a component on an entity that matches a specific binding role.
     * @private
     * @param {Object} entity - The entity object.
     * @param {Object} binding - The action's componentBinding definition.
     * @param {string} role - The role to match ('spatial', 'self_target').
     * @param {Object} [action] - Optional action definition for self_target matching.
     * @returns {Object|null} The matching component, or null.
     */
    _findComponentByRole(entity, binding, role, action = null) {
        if (!entity?.components) return null;

        // Get component stats for each component
        for (const component of entity.components) {
            const componentStats = this.worldStateController.componentController.getComponentStats(component.id);
            if (!componentStats) continue;

            // For 'spatial' role: look for Movement traits
            if (role === 'spatial' && binding?.spatialRole) {
                if (componentStats.Movement && Object.keys(componentStats.Movement).length > 0) {
                    return component;
                }
            }

            // For 'self_target' role: look for Physical traits (or traits required by the action)
            if (role === 'self_target' && binding?.selfTargetRole) {
                // Check if component has traits required by the action
                if (action && this._componentSatisfiesActionRequirements(componentStats, action)) {
                    return component;
                }
                // Fallback: any Physical component can self-target
                if (!action && componentStats.Physical && Object.keys(componentStats.Physical).length > 0) {
                    return component;
                }
            }
        }

        return null;
    }

    /**
     * Validates that the selected component matches the expected binding role.
     * @private
     * @param {Object} action - The action definition.
     * @param {string} entityId - The entity ID.
     * @param {string} sourceComponentId - The resolved source component ID.
     * @param {Object} params - The action parameters.
     * @returns {{valid: boolean, reason: string}}
     */
    _validateComponentBinding(action, entityId, sourceComponentId, params) {
        const binding = action.componentBinding;
        
        // No binding defined — skip validation (backward compatibility)
        if (!binding) {
            return { valid: true, reason: '' };
        }

        const sourceComponent = this._findComponentById(entityId, sourceComponentId);
        if (!sourceComponent) {
            return { valid: false, reason: `Source component "${sourceComponentId}" not found on entity "${entityId}".` };
        }

        const sourceComponentStats = this.worldStateController.componentController.getComponentStats(sourceComponentId);

        // Validate source role: the component must have the traits required by the action
        if (binding.roles?.includes('source') || binding.spatialRole || binding.sourceRole) {
            if (!this._componentSatisfiesActionRequirements(sourceComponentStats, action)) {
                return { 
                    valid: false, 
                    reason: `Selected component "${sourceComponent.identifier}" does not have the required traits for "${action ? Object.keys(this.actionRegistry).find(k => this.actionRegistry[k] === action) : 'unknown'}". ` +
                            `Expected: ${action?.requirements?.map(r => `${r.trait}.${r.stat} >= ${r.minValue}`).join(', ')}.` 
                };
            }
        }

        // Validate that the resolved role matches what the client sent.
        // NOTE: Skip this check for spatial and 'none' targetingType actions because:
        // - Spatial actions: client sends 'spatial' role, but component resolves to 'source'
        // - None actions: client sends 'source' role, but component resolves to 'self_target'
        // In both cases, the client's role resolution differs from the server's, so we skip
        // role validation and rely on requirement checking instead.
        if (params?.selectedBindingRole && action.targetingType !== 'spatial' && action.targetingType !== 'none') {
            const resolvedRole = this._getComponentResolvedRole(sourceComponent, action);
            if (resolvedRole && params.selectedBindingRole !== resolvedRole) {
                return {
                    valid: false,
                    reason: `Component role mismatch: client selected role "${params.selectedBindingRole}" but component resolves to "${resolvedRole}".`
                };
            }
        }

        return { valid: true, reason: '' };
    }

    /**
     * Finds a component by ID within an entity.
     * @private
     * @param {string} entityId - The entity ID.
     * @param {string} componentId - The component ID.
     * @returns {Object|null}
     */
    _findComponentById(entityId, componentId) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity?.components) return null;
        return entity.components.find(c => c.id === componentId) || null;
    }

    /**
     * Checks if a component satisfies ALL of an action's requirements.
     * @private
     * @param {Object} componentStats - The component's stats.
     * @param {Object} action - The action definition.
     * @returns {boolean}
     */
    _componentSatisfiesActionRequirements(componentStats, action) {
        if (!componentStats || !action?.requirements || !Array.isArray(action.requirements)) return false;

        for (const req of action.requirements) {
            if (!componentStats[req.trait] ||
                componentStats[req.trait][req.stat] === undefined ||
                componentStats[req.trait][req.stat] < req.minValue) {
                return false;
            }
        }
        return true;
    }

    /**
     * Gets the resolved role for a component within an action's binding context.
     * @private
     * @param {Object} component - The component object.
     * @param {Object} action - The action definition.
     * @returns {string|null}
     */
    _getComponentResolvedRole(component, action) {
        return this.componentCapabilityController?._resolveComponentRole(action, component) || null;
    }

    // =========================================================================
    // PRIVATE: ENTITY-LEVEL REQUIREMENT CHECKING
    // =========================================================================

    /**
     * Checks if an entity meets the requirements for an action.
     * Requirements can be satisfied by multiple components.
     * Used during action execution for entity-wide checks.
     *
     * @param {Array<Object>} requirements - An array of requirement objects.
     * @param {string} entityId - The entity ID to check.
     * @returns {{passed: boolean, requirementValues?: Object, fulfillingComponents?: Object, componentId?: string, error?: {code: string, details: Object}}}
     * @private
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
     * Checks if a specific component meets ALL of the action's requirements.
     * Used during action execution when a specific component is targeted
     * (e.g., attackerComponentId or targetComponentId provided).
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

            if (!componentStats[req.trait] ||
                componentStats[req.trait][req.stat] === undefined ||
                componentStats[req.trait][req.stat] < req.minValue) {
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
     * @param {Object} [synergyResult] - Optional synergy computation result.
     * @returns {Object} Result of consequence execution.
     */
    _executeConsequences(actionName, entityId, requirementValues, params, fulfillingComponents = {}, synergyResult = null) {
        const action = this.actionRegistry[actionName];
        if (!action || !action.consequences) {
            return { success: false, error: `Action "${actionName}" has no consequences defined.` };
        }

        const results = [];
        const context = {
            requirementValues,
            actionParams: params,
            fulfillingComponents,
            synergyResult
        };

        for (const consequence of action.consequences) {
            const resolvedParams = this._resolvePlaceholders(consequence.params, requirementValues, params);

            const handler = this.consequenceHandlers.handlers[consequence.type];
            if (!handler) {
                results.push({ success: false, error: `Unknown consequence type: "${consequence.type}"` });
                continue;
            }

            try {
                // Apply synergy multiplier to numeric consequence values
                if (synergyResult && synergyResult.synergyMultiplier > 1.0 && typeof resolvedParams?.value === 'number') {
                    const baseValue = resolvedParams.value;
                    resolvedParams.value = this.synergyController
                        ? this.synergyController.applySynergyToResult(synergyResult, baseValue)
                        : baseValue;
                }

                // Spatial consequences (updateSpatial, deltaSpatial) always operate on the entity.
                // Component-level consequences (updateComponentStatDelta, damageComponent) resolve
                // their target from context.actionParams.targetComponentId inside the handler.
                const spatialTypes = ['updateSpatial', 'deltaSpatial'];
                const targetId = spatialTypes.includes(consequence.type)
                    ? entityId
                    : (params.targetComponentId || entityId);
                const result = handler(targetId, resolvedParams, context);

                results.push({ success: true, type: consequence.type, synergyApplied: synergyResult !== null, ...result });
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

    // =========================================================================
    // PUBLIC: REGISTRY ACCESS
    // =========================================================================

    /**
     * Returns all registered actions.
     * @returns {Object}
     */
    getRegistry() {
        return this.actionRegistry;
    }
}

export default ActionController;