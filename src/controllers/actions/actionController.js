import Logger from '../../utils/Logger.js';
import { resolvePlaceholders } from '../../utils/PlaceholderResolver.js';
import { componentSatisfiesRequirements } from '../../utils/RequirementChecker.js';
import { SYNERGY_BONUS_THRESHOLD } from '../../utils/Constants.js';
import RangeValidator from './RangeValidator.js';
import ComponentResolver from './ComponentResolver.js';
import RequirementResolver from './RequirementResolver.js';
import ConsequenceDispatcher from '../consequences/ConsequenceDispatcher.js';
import IdResolver from '../../utils/IdResolver.js';
import { BINDING_ROLES, TARGETING_TYPES, TARGET_ANCHORS } from '../../../shared/ActionVocabulary.js';

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
     * FASE 5: the facade is no longer passed at construction. It is injected via
     * setWorldStateController() after the facade is fully built (this controller —
     * and its nested RangeValidator / ComponentResolver / RequirementResolver /
     * ConsequenceDispatcher — depend on the facade).
     *
     * @param {ConsequenceHandlers} consequenceHandlers - The consequence handler system.
     * @param {Object} actionRegistry - The registry of available actions.
     * @param {ComponentCapabilityController} componentCapabilityController - The capability cache manager.
     * @param {SynergyController} [synergyController] - The synergy system controller (optional).
     * @param {ActionSelectController} [actionSelectController] - The component selection/locking controller (optional).
     * @param {EquippedItemStatsController} [equippedItemStats] - Mutable equipped-item stats (named dep).
     */
    constructor(consequenceHandlers, actionRegistry, componentCapabilityController, synergyController, actionSelectController, equippedItemStats) {
        /** @type {WorldStateController|null} Injected post-construction. */
        this.worldStateController = null;
        this.consequenceHandlers = consequenceHandlers;
        this.actionRegistry = actionRegistry || {};
        this.componentCapabilityController = componentCapabilityController;
        this.synergyController = synergyController || null;
        this.actionSelectController = actionSelectController || null;

        this.componentResolver = new ComponentResolver();
        // Pass equippedItemStats so RequirementResolver can read current mutable stats
        this.requirementResolver = new RequirementResolver(equippedItemStats);
        // Inject extracted modules (each receives the facade later via setWorldStateController).
        // RangeValidator receives the RequirementResolver so range-expression resolution
        // shares the entity-level stat-map logic (Single Source of Truth, no duplication).
        this.rangeValidator = new RangeValidator(this, this.requirementResolver);
        this.consequenceDispatcher = new ConsequenceDispatcher(this, synergyController);
    }

    /**
     * Injects the world state facade (WorldStateController) after it is fully built,
     * and propagates it to the nested resolvers/validator/dispatcher. FASE 5: replaces
     * the constructor-time facade dependency (BUG-100 root cause).
     * @param {WorldStateController} worldStateController - The fully-built facade.
     */
    setWorldStateController(worldStateController) {
        this.worldStateController = worldStateController;
        if (this.rangeValidator) {
            this.rangeValidator.setWorldStateController(worldStateController);
        }
        if (this.componentResolver) {
            this.componentResolver.setWorldStateController(worldStateController);
        }
        if (this.requirementResolver) {
            this.requirementResolver.setWorldStateController(worldStateController);
        }
        if (this.consequenceDispatcher) {
            this.consequenceDispatcher.setWorldStateController(worldStateController);
        }
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
        if (!IdResolver.isEntityId(entityId) && !IdResolver.isLegacyEntityId(entityId)) {
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
            // Kept lean by extracting the range-gate into _validateRange() so the
            // param-shape branching (targetEntityId vs targetX/targetY) does not
            // bloat executeAction().
            const rangeResult = this._validateRange(actionName, action, entityId, params);
            if (!rangeResult.success) {
                return { success: false, error: rangeResult.error, ...rangeResult.failureResults };
            }

            // ─── Build Component List (delegated to ComponentResolver) ────────
            const { componentList, sourceComponentId } = this.componentResolver.buildComponentList(params);
            const isSpatial = action.targetingType === TARGETING_TYPES.SPATIAL;

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
                attackerComponentIds = params.componentIds.filter(c => c.role === BINDING_ROLES.SOURCE).map(c => c.componentId);
            } else if (params?.componentId) {
                // Singular componentId from LLM agent tool calls
                attackerComponentIds = [params.componentId];
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
                if (!IdResolver.isCompId(atkId) && !IdResolver.isEquippedId(atkId) && !IdResolver.isLegacyCompId(atkId)) {
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
                if (!IdResolver.isCompId(tgtId) && !IdResolver.isLegacyCompId(tgtId)) {
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
            if (action.targetingType === TARGETING_TYPES.COMPONENT && attackerComponentIds.length > 1 && params.targetComponentId) {
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
    // PRIVATE: RANGE GATE
    // =========================================================================

    /**
     * Runs the action's range gate, if any, by delegating to RangeValidator.
     *
     * Extracted from executeAction() so the param-shape branching (entity-targeted
     * vs. spatial) does not inflate the main execution pipeline. The method
     * determines which range path applies, calls the matching RangeValidator
     * method, and — on failure — executes the action's range-failure consequences
     * before returning a failure result. On success (or when the action has no
     * range constraint) it returns `{ success: true }`.
     *
     * @param {string} actionName - The name of the action (used to look up its range-failure consequences).
     * @param {Object} action - The action definition (may declare `range`).
     * @param {string} entityId - The ID of the entity performing the action.
     * @param {Object} params - Action parameters (may carry targetEntityId, or targetX/targetY).
     * @returns {{ success: boolean, error?: string, failureResults?: Object }}
     *   `{ success: true }` when the range check passes (or is not applicable);
     *   `{ success: false, error, failureResults }` when it fails and the failure
     *   consequences have been executed.
     * @private
     */
    _validateRange(actionName, action, entityId, params) {
        // Actions without a declared range have no gate to enforce.
        if (!action.range) {
            return { success: true };
        }

        // Entity-targeted range check (e.g. punch, cut): the client sent a
        // target entity ID.
        if (params.targetEntityId) {
            const rangeCheck = this.rangeValidator.checkGrabRange(entityId, params.targetEntityId, action.range);
            if (!rangeCheck.success) {
                const failureResults = this.consequenceDispatcher.executeFailure(actionName, entityId);
                return { success: false, error: rangeCheck.error, failureResults };
            }
            return { success: true };
        }

        // Spatial range check (e.g. dropItem): the client sent a target
        // coordinate. Enforce the SAME range the client displays so the actual
        // drop range matches the displayed range (single source of truth:
        // data/actions.json range, resolved via the shared RangeResolver).
        if (params.targetX !== undefined && params.targetY !== undefined) {
            const spatialCheck = this.rangeValidator.checkSpatialRange(entityId, params.targetX, params.targetY, action.range);
            if (!spatialCheck.success) {
                const failureResults = this.consequenceDispatcher.executeFailure(actionName, entityId);
                return { success: false, error: spatialCheck.error, failureResults };
            }
            return { success: true };
        }

        // No applicable range parameter — nothing to enforce.
        return { success: true };
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
            // Delegate to the central PlaceholderResolver (single source of truth).
            // requirementValues maps "Trait.stat" → number, which covers both
            // ":Trait.stat" and "-:Trait.stat" (sign prefix) placeholders; the
            // central resolver additionally supports "*:placeholder" multipliers,
            // embedded template strings and non-numeric :variables (superset of
            // the former local behavior — no data divergence in data/actions.json,
            // which only uses ":Trait.stat", "-:Trait.stat" and embedded :vars).
            const resolvedParams = resolvePlaceholders(consequence.params, requirementValues);
            resolvedConsequences[consequence.type] = resolvedParams;
        }
        return resolvedConsequences;
    }

    /**
     * Resolves a declarative `damageSource` path from live world state (BUG-036).
     * Data-driven replacement of the former shootT1-only `_getT1AmmoVolume` special
     * case: the path is declared in data/actions.json on the consequence (e.g.
     * "equippedItem.firstChild.volume") and interpreted generically here.
     *
     * Supported path grammar (dot-separated, first segment is the anchor):
     * - "equippedItem"           → the equipped item record for `componentId`
     * - "item"                   → the inventory item instance of the current record
     * - "firstChild"             → the first container child of the current item
     * - "children"               → all container children of the current item
     * - any other segment        → plain property access on the current object
     *
     * @param {string} damageSource - The declarative path (e.g., "equippedItem.firstChild.volume").
     * @param {string} entityId - The entity ID.
     * @param {string} componentId - The source component ID (eq-* ID, comp-* ID, or item ID).
     * @returns {number|null} The resolved numeric damage value, or null when unresolvable.
     * @private
     */
    _resolveDeclaredDamageSource(damageSource, entityId, componentId) {
        const segments = typeof damageSource === 'string' && damageSource !== ''
            ? damageSource.split('.').filter(Boolean)
            : [];
        if (segments.length === 0 || segments[0] !== TARGET_ANCHORS.EQUIPPED_ITEM) {
            Logger.warn(`[ActionController] Unsupported damageSource anchor "${damageSource}" (expected "equippedItem...").`);
            return null;
        }

        const entity = this.worldStateController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[ActionController] Entity "${entityId}" not found for damageSource "${damageSource}".`);
            return null;
        }

        // Resolve the equipped item record from the component/equipped-item ID
        let current = null;
        if (IdResolver.isEquippedId(componentId)) {
            current = this.worldStateController.getEquippedItem(entityId, componentId);
        } else {
            current = this.worldStateController.getEquippedItemByItemId(entityId, componentId);
            if (!current) {
                const found = this.worldStateController.getEquippedItems(entityId)?.find(eq => eq.itemId === componentId);
                if (found) current = found;
            }
        }

        for (const segment of segments.slice(1)) {
            if (!current) return null;

            if (segment === 'item') {
                current = this.worldStateController.inventoryManager.getItem(entity, current.itemId);
            } else if (segment === 'firstChild') {
                const children = this.worldStateController.inventoryManager.getContainerItems(entity, current.itemId ?? current.id);
                current = children?.[0] ?? null;
            } else if (segment === 'children') {
                current = this.worldStateController.inventoryManager.getContainerItems(entity, current.itemId ?? current.id);
            } else {
                current = current[segment];
            }
        }

        return typeof current === 'number' ? current : null;
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

        // Declarative damage override (BUG-036): any consequence that declares a
        // damageSource (data/actions.json) has its 'value' resolved from live world
        // state (e.g., shootT1: "equippedItem.firstChild.volume" → first ammo volume).
        if (resolveComponentId) {
            for (const consequence of actionDef.consequences) {
                if (!consequence.damageSource) continue;
                const resolvedDamage = this._resolveDeclaredDamageSource(consequence.damageSource, entityId, resolveComponentId);
                if (resolvedDamage !== null) {
                    resolvedValues = { ...resolvedValues };
                    resolvedValues[consequence.type] = {
                        ...(resolvedValues[consequence.type] || {}),
                        value: resolvedDamage
                    };
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