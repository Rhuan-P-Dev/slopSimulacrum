import Logger from '../../utils/Logger.js';
import { resolvePlaceholders } from '../../utils/PlaceholderResolver.js';
import { componentSatisfiesRequirements } from '../../utils/RequirementChecker.js';
import { SYNERGY_BONUS_THRESHOLD } from '../../utils/Constants.js';
import RangeValidator from './RangeValidator.js';
import ComponentResolver from './ComponentResolver.js';
import RequirementResolver from './RequirementResolver.js';
import ConsequenceDispatcher from '../consequences/ConsequenceDispatcher.js';
import IdResolver from '../../utils/IdResolver.js';

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
 * Component capability management has been extracted to ComponentCapabilityController.
 * Range validation, component resolution, requirement checking, and consequence
 * execution have been extracted to their own modules.
 *
 * ActionController responsibilities:
 * - Action execution orchestration (executeAction)
 * - Delegates capability cache queries to ComponentCapabilityController
 * - Delegates range validation to RangeValidator
 * - Delegates component resolution to ComponentResolver
 * - Delegates requirement checking to RequirementResolver
 * - Delegates consequence execution to ConsequenceDispatcher
 *
 * @example
 * // Architecture flow:
 * // Server -> WorldStateController -> ActionController (executeAction)
 * // ActionController -> RangeValidator, ComponentResolver, RequirementResolver, ConsequenceDispatcher
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
    constructor(worldStateController, consequenceHandlers, actionRegistry, componentCapabilityController, synergyController, actionSelectController, equippedItemStats) {
        this.worldStateController = worldStateController;
        this.consequenceHandlers = consequenceHandlers;
        this.actionRegistry = actionRegistry || {};
        this.componentCapabilityController = componentCapabilityController;
        this.synergyController = synergyController || null;
        this.actionSelectController = actionSelectController || null;

        // Inject extracted modules
        this.rangeValidator = new RangeValidator(worldStateController, this);
        this.componentResolver = new ComponentResolver(worldStateController);
        // Pass equippedItemStats so RequirementResolver can read current mutable stats
        this.requirementResolver = new RequirementResolver(worldStateController, equippedItemStats);
        this.consequenceDispatcher = new ConsequenceDispatcher(worldStateController, this, synergyController);
    }

    // =========================================================================
    // PUBLIC API: CAPABILITY DELEGATION
    // =========================================================================
    // All capability cache operations are delegated to ComponentCapabilityController.

    /**
     * Scans all entities and their components against all registered actions.
     * Delegates to ComponentCapabilityController.scanAllCapabilities().
     * @param {Object} state - The current world state.
     * @returns {Object<string, Array<ComponentCapabilityEntry>>} The updated capability cache.
     */
    scanAllCapabilities(state) {
        return this.componentCapabilityController.scanAllCapabilities(state);
    }

    /**
     * Returns the cached capability entries for all actions.
     * Delegates to ComponentCapabilityController.getCachedCapabilities().
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
     * @param {string} entityId - The entity ID.
     * @returns {Array<ComponentCapabilityEntry>} Array of capability entries for this entity.
     */
    getCapabilitiesForEntity(entityId) {
        return this.componentCapabilityController.getCapabilitiesForEntity(entityId);
    }

    /**
     * Retrieves only the actions that are relevant to a specific entity.
     * Delegates to ComponentCapabilityController.getActionsForEntity().
     * @param {Object} state - The current world state.
     * @param {string} entityId - The ID of the entity to filter for.
     * @returns {Object.<string, {requirements: Array, canExecute: Array, cannotExecute: Array}>}
     */
    getActionsForEntity(state, entityId) {
        return this.componentCapabilityController.getActionsForEntity(state, entityId);
    }

    /**
     * Calculates which entities are capable of executing which actions.
     * Delegates to ComponentCapabilityController.getActionCapabilities().
     * @param {Object} state - The current world state.
     * @returns {Object.<string, {requirements: Array, canExecute: Array, cannotExecute: Array}>}
     */
    getActionCapabilities(state) {
        return this.componentCapabilityController.getActionCapabilities(state);
    }

    /**
     * Re-evaluates ALL actions for a specific entity.
     * Delegates to ComponentCapabilityController.reEvaluateEntityCapabilities().
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
     * Delegates to RequirementResolver.checkEntityRequirements().
     *
     * @param {string} actionName - The name of the action to check.
     * @param {string} entityId - The entity ID to check.
     * @returns {{passed: boolean, error?: {code: string, details: Object}, componentId?: string, requirementValues?: Object, fulfillingComponents?: Object}}
     */
    checkRequirements(actionName, entityId) {
        if (typeof actionName !== 'string' || actionName.trim() === '') {
            throw new TypeError('Invalid actionName: must be a non-empty string.');
        }
        if (typeof entityId !== 'string' || entityId.trim() === '') {
            throw new TypeError('Invalid entityId: must be a non-empty string.');
        }

        const action = this.actionRegistry[actionName];
        if (!action) {
            return { passed: false, error: { code: 'ACTION_NOT_FOUND', details: { actionName } } };
        }
        return this.requirementResolver.checkEntityRequirements(action.requirements, entityId);
    }

    /**
     * Executes an action on an entity with component binding enforcement.
     * Delegates to RangeValidator, ComponentResolver, RequirementResolver, and ConsequenceDispatcher.
     *
     * @param {string} actionName - The name of the action to execute.
     * @param {string} entityId - The ID of the entity to perform the action.
     * @param {Object} [params] - Additional action parameters.
     * @returns {Object} Result of the action execution.
     */
    executeAction(actionName, entityId, params = {}) {
        if (typeof actionName !== 'string' || actionName.trim() === '') {
            throw new TypeError('Invalid actionName: must be a non-empty string.');
        }
        if (typeof entityId !== 'string' || entityId.trim() === '') {
            throw new TypeError('Invalid entityId: must be a non-empty string.');
        }

        // Validate entityId is a typed entity ID
        if (!IdResolver.isEntityId(entityId) && !this._isLegacyEntityId(entityId)) {
            Logger.warn(`[ActionController] Invalid entity ID format: "${entityId}". Must be a typed ent-... ID or raw UUID.`);
            return {
                success: false,
                error: `Invalid entity ID format: ${entityId}`,
                code: 'INVALID_ENTITY_ID'
            };
        }

        if (typeof params !== 'object' || params === null || Array.isArray(params)) {
            throw new TypeError('Invalid params: must be an object.');
        }

        const componentsToRelease = [];

        if (this.actionSelectController) {
            this.actionSelectController.expireStaleSelections();
        }

        try {
            const action = this.actionRegistry[actionName];
            if (!action) {
                return { success: false, error: `Action "${actionName}" not found.` };
            }

            // ─── Range Check (delegated to RangeValidator) ────────────────────
            if (action.range && params.targetEntityId) {
                const rangeCheck = this.rangeValidator.checkGrabRange(entityId, params.targetEntityId, action.range);
                if (!rangeCheck.success) {
                    const failureResults = this.consequenceDispatcher.executeFailure(actionName, entityId);
                    return { success: false, error: rangeCheck.error, ...failureResults };
                }
            }

            // ─── Build Component List (delegated to ComponentResolver) ────────
            const { componentList, sourceComponentId } = this.componentResolver.buildComponentList(params);
            const isSpatial = action.targetingType === 'spatial';

            // ─── Component Selection Validation ───────────────────────────────
            if (this.actionSelectController && sourceComponentId && !isSpatial) {
                const validationCheck = componentList
                    ? this.actionSelectController.validateSelections(actionName, componentList.map(c => c.componentId), entityId)
                    : this.actionSelectController.validateSelection(sourceComponentId, actionName, entityId);

                if (!validationCheck.valid) {
                    const errorMessage = Array.isArray(validationCheck.error)
                        ? validationCheck.error.join(' ')
                        : validationCheck.error || 'Component selection validation failed.';
                    return { success: false, error: errorMessage };
                }

                const idsToRelease = componentList
                    ? componentList.map(c => c.componentId)
                    : [sourceComponentId];
                componentsToRelease.push(...idsToRelease);
            }

            // ─── Resolve Requirements First (for fallback) ──────────────────
            let requirementValues = {};
            let fulfillingComponents = {};
            let requirementCheckResult = null;

            // Collect attacker component IDs
            let attackerComponentIds = [];
            if (params?.attackerComponentId) {
                attackerComponentIds = [params.attackerComponentId];
            } else if (params?.componentIds && Array.isArray(params.componentIds)) {
                attackerComponentIds = params.componentIds.filter(c => c.role === 'source').map(c => c.componentId);
            }

            // Resolve requirements per-attacker or entity-wide
            if (attackerComponentIds.length > 0) {
                const primaryAttackerId = attackerComponentIds[0];
                requirementCheckResult = this.requirementResolver.checkComponentRequirements(
                    action.requirements, entityId, primaryAttackerId
                );

                if (!requirementCheckResult.passed) {
                    const errorMessage = this._resolveError(requirementCheckResult.error);
                    const failureResults = this.consequenceDispatcher.executeFailure(actionName, entityId);
                    return { success: false, error: `Requirement failed: ${errorMessage}`, ...failureResults };
                }

                requirementValues = requirementCheckResult.requirementValues;
                fulfillingComponents = requirementCheckResult.fulfillingComponents;
            } else {
                requirementCheckResult = this.requirementResolver.checkEntityRequirements(action.requirements, entityId);
                if (!requirementCheckResult.passed) {
                    const errorMessage = this._resolveError(requirementCheckResult.error);
                    const failureResults = this.consequenceDispatcher.executeFailure(actionName, entityId);
                    return { success: false, error: `Requirement failed: ${errorMessage}`, ...failureResults };
                }
                requirementValues = requirementCheckResult.requirementValues;
                fulfillingComponents = requirementCheckResult.fulfillingComponents;
            }

            // ─── Handle Equipped Item Actions ───────────────────────────────
            // Equipped items now use typed eqId (eq-${uuid}).
            // Track the eqId separately so consequence handlers can route to EquippedItemStatsController.
            // The resolvedSourceComponentId is preserved as the eqId for consequence routing,
            // while a separate hostComponentId is used for validation/lookup purposes.
            let resolvedSourceComponentId = this.componentResolver.resolveSourceComponent(
                action, entityId, params, requirementCheckResult
            );
            let hostComponentId = null;

            if (resolvedSourceComponentId && IdResolver.isEquippedId(resolvedSourceComponentId)) {
                // Resolve eqId to the actual equipped item data
                const allEquipped = this.worldStateController.getAllEquippedItems();
                let foundEquipped = null;

                if (allEquipped && Array.isArray(allEquipped)) {
                    for (const eq of allEquipped) {
                        if (eq.eqId === resolvedSourceComponentId) {
                            foundEquipped = eq;
                            break;
                        }
                    }
                }

                if (!foundEquipped) {
                    Logger.warn(`[ActionController] Equipped item "${resolvedSourceComponentId}" not found on entity "${entityId}" for action "${actionName}".`);
                    return {
                        success: false,
                        error: `Item not equipped: ${resolvedSourceComponentId}`,
                        code: 'ITEM_NOT_EQUIPPED'
                    };
                }

                // Store the host component ID separately for validation purposes
                hostComponentId = foundEquipped.componentId;

                // Re-validate with the host component (but DO NOT overwrite resolvedSourceComponentId)
                // The eqId is preserved so consequence handlers can route to EquippedItemStatsController
                if (action.componentBinding) {
                    const bindingValidation = this.componentResolver.validateComponentBinding(
                        action, entityId, hostComponentId, params
                    );
                    if (!bindingValidation.valid) {
                        return { success: false, error: bindingValidation.reason };
                    }
                }
            }

            // ─── Track Spatial Components for Release ────────────────────────
            if (isSpatial && componentList && componentList.length > 0) {
                for (const comp of componentList) {
                    if (!componentsToRelease.includes(comp.componentId)) {
                        componentsToRelease.push(comp.componentId);
                    }
                }
            } else if (isSpatial && resolvedSourceComponentId && !componentList) {
                componentsToRelease.push(resolvedSourceComponentId);
            }

            // ─── Validate Component IDs are properly formatted ──────────────
            // Validate attackerComponentId is a typed component ID or equipped item ID
            if (params?.attackerComponentId) {
                const atkId = params.attackerComponentId;
                if (!IdResolver.isCompId(atkId) && !IdResolver.isEquippedId(atkId) && !this._isLegacyCompId(atkId)) {
                    Logger.warn(`[ActionController] Invalid attacker component ID: "${atkId}"`);
                    return {
                        success: false,
                        error: `Invalid attacker component ID: ${atkId}`,
                        code: 'INVALID_COMPONENT_ID'
                    };
                }
            }

            // Validate targetComponentId is a typed component ID
            if (params?.targetComponentId) {
                const tgtId = params.targetComponentId;
                if (!IdResolver.isCompId(tgtId) && !this._isLegacyCompId(tgtId)) {
                    Logger.warn(`[ActionController] Invalid target component ID: "${tgtId}"`);
                    return {
                        success: false,
                        error: `Invalid target component ID: ${tgtId}`,
                        code: 'INVALID_COMPONENT_ID'
                    };
                }
            }

            // ─── Validate Component Binding ─────────────────────────────────
            if (!resolvedSourceComponentId && action.componentBinding) {
                return {
                    success: false,
                    error: this._resolveError({
                        code: 'COMPONENT_BINDING_MISMATCH',
                        details: { actionName, expectedRoles: action.componentBinding?.roles, selectedRole: params?.selectedBindingRole }
                    })
                };
            }

            // Validate with eqId for equipped items (the eqId IS the valid source for consequence routing)
            // For non-equip items, validate with hostComponentId
            if (resolvedSourceComponentId) {
                const validationTarget = IdResolver.isEquippedId(resolvedSourceComponentId)
                    ? resolvedSourceComponentId  // eqId is the valid source for consequence routing
                    : (hostComponentId || resolvedSourceComponentId);
                const bindingValidation = this.componentResolver.validateComponentBinding(action, entityId, validationTarget, params);
                if (!bindingValidation.valid) {
                    return { success: false, error: bindingValidation.reason };
                }
            }

            // ─── Compute Synergy ────────────────────────────────────────────
            let synergyResult = null;
            if (this.synergyController) {
                synergyResult = this.synergyController.computeSynergy(actionName, entityId, {
                    providedComponentIds: componentList,
                    synergyGroups: params?.synergyGroups,
                    sourceComponentId: resolvedSourceComponentId
                });
            }

            // ─── Execute Consequences (delegated to ConsequenceDispatcher) ──
            // For equipped item actions, pass hostComponentId so the dispatcher can
            // resolve 'self' targets correctly (route to EquippedItemStatsController).
            if (resolvedSourceComponentId && IdResolver.isEquippedId(resolvedSourceComponentId) && hostComponentId) {
                // Attach hostComponentId to params for consequence routing
                params.hostComponentId = hostComponentId;
                Logger.info(`[ActionController] Equipped item action "${actionName}": eqId="${resolvedSourceComponentId}", hostComponentId="${hostComponentId}"`);
            }

            // Data-driven: ANY component-targeted action supports multi-attacker synergy
            let consequenceResult;
            if (action.targetingType === 'component' && attackerComponentIds.length > 1 && params.targetComponentId) {
                consequenceResult = this.consequenceDispatcher.executeMultiAttacker(
                    actionName, entityId, attackerComponentIds, params, synergyResult
                );
            } else {
                consequenceResult = this.consequenceDispatcher.execute(
                    actionName, entityId, requirementValues, params, fulfillingComponents, synergyResult, requirementCheckResult.componentId
                );
            }

            return {
                success: true,
                action: actionName,
                entityId,
                synergy: synergyResult,
                ...consequenceResult
            };
        } catch (error) {
            const errorMsg = error?.message ?? String(error) ?? 'Unknown error';
            return {
                success: false,
                error: this._resolveError({ code: 'SYSTEM_RUNTIME_ERROR', details: { error: errorMsg } })
            };
        } finally {
            if (this.actionSelectController && componentsToRelease.length > 0) {
                this.actionSelectController.releaseSelections(componentsToRelease, entityId);
            }
        }
    }

    // =========================================================================
    // PRIVATE: LEGACY ID HELPERS
    // =========================================================================

    /**
     * Checks if an ID looks like a legacy (pre-typed) entity ID (raw UUID format).
     * @param {string} id - The ID to check.
     * @returns {boolean}
     * @private
     */
    _isLegacyEntityId(id) {
        return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    }

    /**
     * Checks if an ID looks like a legacy (pre-typed) component ID (raw UUID format).
     * @param {string} id - The ID to check.
     * @returns {boolean}
     * @private
     */
    _isLegacyCompId(id) {
        return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    }

    // =========================================================================
    // PRIVATE: ERROR RESOLUTION
    // =========================================================================

    /**
     * Resolves a structured error into a human-readable message.
     * @param {Object} error - The error object { code, details }.
     * @returns {string} Formatted error message.
     * @private
     */
    _resolveError(error) {
        if (!error || !error.code) {
            Logger.error('An unknown error occurred.');
            return 'An unknown error occurred.';
        }
        const registryEntry = ERROR_REGISTRY[error.code];
        if (!registryEntry) {
            Logger.error(`An undefined error occurred: ${error.code}`);
            return 'An undefined error occurred.';
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

    // =========================================================================
    // PUBLIC: ACTION DATA PREVIEW
    // =========================================================================

    /**
     * Resolves placeholder values in action consequences for a given component.
     * @param {string} actionName - The action name.
     * @param {string} componentId - The component ID to resolve values against.
     * @param {string} entityId - The entity ID (for error context).
     * @returns {Object} Object mapping consequence types to their resolved values.
     */
    resolveActionValues(actionName, componentId, entityId) {
        const action = this.actionRegistry[actionName];
        if (!action || !action.consequences) return {};

        const requirementValues = this.requirementResolver.resolveRequirementValues(componentId);
        if (!requirementValues) return {};

        const resolvedConsequences = {};
        for (const consequence of action.consequences) {
            const resolvedParams = this._resolvePlaceholders(consequence.params, requirementValues, {});
            resolvedConsequences[consequence.type] = resolvedParams;
        }
        return resolvedConsequences;
    }

    /**
     * Resolves placeholder values in an object using requirement values.
     * @param {Object} params - The object with placeholder values (e.g., { damage: ":Physical.strength" }).
     * @param {Object} requirementValues - Mapping of placeholders to resolved values.
     * @param {Object} context - Additional context (unused, kept for API compatibility).
     * @returns {Object} Object with placeholders resolved.
     * @private
     */
    _resolvePlaceholders(params, requirementValues, context) {
        if (!params) return params;
        const resolved = {};
        for (const [key, value] of Object.entries(params)) {
            if (typeof value === 'string' && value.startsWith(':')) {
                const placeholder = value.slice(1);
                resolved[key] = requirementValues[placeholder] ?? value;
            } else if (typeof value === 'string' && value.startsWith('-:')) {
                const placeholder = value.slice(2);
                const resolvedValue = requirementValues[placeholder] ?? 0;
                resolved[key] = -resolvedValue;
            } else if (typeof value === 'string' && value.startsWith('*:')) {
                const placeholder = value.slice(2);
                const resolvedValue = requirementValues[placeholder] ?? 1;
                resolved[key] = resolvedValue;
            } else {
                resolved[key] = value;
            }
        }
        return resolved;
    }

    /**
     * Gets the damage value for a shootT1 action by looking up the first ammo item
     * in the T1 weapon's internal inventory.
     * @param {string} entityId - The entity ID.
     * @param {string} componentId - The component ID (may be eq- ID or direct component ID).
     * @returns {number|null} The volume of the first ammo item, or null if no ammo found.
     * @private
     */
    _getT1AmmoVolume(entityId, componentId) {
        const entity = this.worldStateController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[ActionController] Entity "${entityId}" not found for T1 ammo lookup.`);
            return null;
        }

        // Resolve the T1 item ID from the component/equipped-item ID
        let t1ItemId = null;
        let t1ItemType = null;

        if (IdResolver.isEquippedId(componentId)) {
            const equippedItem = this.worldStateController.getEquippedItem(entityId, componentId);
            if (equippedItem) {
                t1ItemId = equippedItem.itemId;
                t1ItemType = equippedItem.itemType;
            }
        } else {
            // Try to find equipped item by itemId
            const equippedItem = this.worldStateController.getEquippedItemByItemId(entityId, componentId);
            if (equippedItem && equippedItem.itemType) {
                t1ItemType = equippedItem.itemType;
                t1ItemId = equippedItem.itemId;
            } else {
                // Try direct lookup
                const allEquipped = this.worldStateController.getEquippedItems(entityId);
                const found = allEquipped?.find(eq => eq.itemId === componentId);
                if (found) {
                    t1ItemType = found.itemType;
                    t1ItemId = found.itemId;
                }
            }
        }

        if (t1ItemType !== 't1' || !t1ItemId) {
            return null;
        }

        // Get the children (ammo items) from the T1's internal inventory
        const ammoItems = this.worldStateController.inventoryManager.getContainerItems(entity, t1ItemId);

        if (!ammoItems || ammoItems.length === 0) {
            return null;
        }

        return ammoItems[0].volume || 0;
    }

    /**
     * Previews action data including resolved values and synergy.
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID.
     * @param {Object} [context] - Optional context.
     * @returns {Object} Preview data including actionData, resolvedValues, and synergyResult.
     */
    previewActionData(actionName, entityId, context = {}) {
        const actionDef = this.actionRegistry[actionName];
        if (!actionDef) {
            Logger.warn(`[ActionController] Action "${actionName}" not found for preview`);
            return null;
        }

        let resolveComponentId = null;
        if (context.providedComponentIds && context.providedComponentIds.length > 0) {
            resolveComponentId = context.providedComponentIds[0].componentId;
        } else {
            const best = this.getBestComponentForAction(actionName);
            if (best) resolveComponentId = best.componentId;
        }

        let resolvedValues = resolveComponentId
            ? this.resolveActionValues(actionName, resolveComponentId, entityId)
            : {};

        // Special handling for shootT1: resolve damage from first ammo item volume
        if (actionName === 'shootT1' && resolveComponentId) {
            const ammoVolume = this._getT1AmmoVolume(entityId, resolveComponentId);
            if (ammoVolume !== null) {
                // Update the consumeItemAndDamage consequence value with the actual ammo volume
                resolvedValues = { ...resolvedValues };
                if (resolvedValues.consumeItemAndDamage) {
                    resolvedValues.consumeItemAndDamage = {
                        ...resolvedValues.consumeItemAndDamage,
                        value: ammoVolume
                    };
                } else {
                    resolvedValues.consumeItemAndDamage = { value: ammoVolume };
                }
            }
        }

        let synergyResult = null;
        if (this.synergyController) {
            synergyResult = this.synergyController.computeSynergy(actionName, entityId, {
                ...context,
                sourceComponentId: resolveComponentId
            });
        }

        return {
            actionData: { ...actionDef, _name: actionName },
            resolvedValues,
            synergyResult
        };
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