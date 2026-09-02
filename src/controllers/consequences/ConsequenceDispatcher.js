/**
 * ConsequenceDispatcher — Executes action consequences via the handler system.
 * Single Responsibility: Resolve placeholders, apply synergy, and dispatch consequences to handlers.
 *
 * Extracted from ActionController to adhere to the Single Responsibility Principle.
 *
 * Target Resolution:
 * - Each consequence MUST have a 'target' field: 'self', 'target', or 'entity'.
 * - 'self'    → The source component that fulfilled the action's requirements.
 * - 'target'  → The explicitly targeted component/entity (from actionParams).
 * - 'entity'  → The entire entity performing the action.
 *
 * @module ConsequenceDispatcher
 */

import Logger from '../../utils/Logger.js';
import { resolvePlaceholders } from '../../utils/PlaceholderResolver.js';
import { SYNERGY_BONUS_THRESHOLD, PUBLISHED_CHANNEL_LOSS_KEY } from '../../utils/Constants.js';
import IdResolver from '../../utils/IdResolver.js';
import { BINDING_ROLES } from '../../../shared/ActionVocabulary.js';

class ConsequenceDispatcher {
    /**
     * @param {ActionController} actionController - Reference to ActionController.
     * @param {SynergyController} [synergyController] - The synergy system controller.
     *
     * FASE 5: the facade is no longer passed at construction; it is injected via
     * setWorldStateController() (called by ActionController.setWorldStateController()).
     */
    constructor(actionController, synergyController) {
        /** @type {WorldStateController|null} Injected post-construction. */
        this.worldStateController = null;
        this.actionController = actionController;
        this.synergyController = synergyController;
    }

    /**
     * Injects the world state facade (WorldStateController) after it is fully built.
     * @param {WorldStateController} worldStateController - The fully-built facade.
     */
    setWorldStateController(worldStateController) {
        this.worldStateController = worldStateController;
    }

    /**
     * Executes success consequences for an action.
     *
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity performing the action.
     * @param {Object} requirementValues - Map of trait.stat values.
     * @param {Object} params - Action parameters.
     * @param {Object} fulfillingComponents - Map of requirements to components.
     * @param {Object} [synergyResult] - Optional synergy computation result.
     * @returns {Object} Result of consequence execution.
     */
    execute(actionName, entityId, requirementValues, params, fulfillingComponents = null, synergyResult = null, primaryComponentId = null) {
        const action = this.actionController.actionRegistry[actionName];
        if (!action || !action.consequences) {
            return { success: false, error: `Action "${actionName}" has no consequences defined.` };
        }

        // Phase 4 dedup: the per-consequence loop was extracted into
        // _dispatchConsequences() (shared with executeMultiAttacker). Options keep
        // this path's exact semantics:
        // - targetParams: the ORIGINAL params are used for target resolution (the
        //   entityId-carrying context params are only used for placeholder
        //   resolution, so :entityId, :itemId, :itemType resolve correctly).
        // - propagateParams: handler-modified actionParams flow into later
        //   consequences in the same pipeline (e.g., itemVolume set by
        //   ConsumeItemHandler).
        // - includeResolvedSourceId: equipped-item 'self' targets carry their eqId
        //   as resolvedSourceId so handlers can route stat changes to
        //   EquippedItemStatsController instead of the host component.
        const { results } = this._dispatchConsequences(action.consequences, {
            action,
            actionName,
            entityId,
            requirementValues,
            targetParams: params,
            initialContextParams: { ...params, entityId },
            fulfillingComponents,
            synergyResult,
            primaryComponentId,
            propagateParams: true,
            includeResolvedSourceId: true
        });

        return { success: true, executedConsequences: results.length, results };
    }

    /**
     * Executes consequences for multi-attacker punch actions.
     * Each attacker deals its own separate damage.
     *
     * @param {string} actionName - The action name.
     * @param {string} entityId - The attacking entity ID.
     * @param {Array<string>} attackerComponentIds - Array of attacker component IDs.
     * @param {Object} params - Action parameters.
     * @param {Object} [synergyResult] - Optional synergy computation result.
     * @returns {Object} Result of consequence execution.
     */
    executeMultiAttacker(actionName, entityId, attackerComponentIds, params, synergyResult = null) {
        const action = this.actionController.actionRegistry[actionName];
        if (!action || !action.consequences) {
            return { success: false, error: `Action "${actionName}" has no consequences defined.` };
        }

        const allResults = [];

        for (const attackerId of attackerComponentIds) {
            // Resolve equipment IDs (eq-*) to host component IDs (comp-*) for stats lookup
            let resolvedAttackerId = attackerId;
            let attackerStats = null;

            if (IdResolver.isEquippedId(attackerId)) {
                // For equipped items, try to get stats from EquippedItemStatsController first
                const equippedItemStats = this.actionController.equippedItemStats;
                if (equippedItemStats && equippedItemStats.hasStats(attackerId)) {
                    const itemStats = equippedItemStats.getStats(attackerId);
                    if (itemStats && itemStats.Physical && itemStats.Physical.strength !== undefined) {
                        attackerStats = itemStats;
                    }
                }

                // If not found in equipped item stats, resolve to host component
                if (!attackerStats) {
                    const equipped = this.worldStateController.getEquippedItem(entityId, attackerId);
                    if (equipped && equipped.componentId) {
                        resolvedAttackerId = equipped.componentId;
                        attackerStats = this.worldStateController.componentController.getComponentStats(resolvedAttackerId);
                    }
                }
            } else {
                // For regular components, get stats directly
                attackerStats = this.worldStateController.componentController.getComponentStats(attackerId);
            }

            if (!attackerStats || !attackerStats.Physical || attackerStats.Physical.strength === undefined) {
                Logger.warn(`[ConsequenceDispatcher] Attacker "${attackerId}" has no Physical.strength — skipping`);
                continue;
            }

            const attackerStrength = attackerStats.Physical.strength;
            const perAttackerReqValues = { 'Physical.strength': attackerStrength };
            const perAttackerFulfilling = { 'Physical.strength': attackerId };
            const perAttackerParams = { ...params, attackerComponentId: attackerId };

            // The shared dispatch loop keeps the strength-only requirementValues. The
            // per-attacker consequence builder instead receives the FULL per-attacker stat
            // context so it can resolve the declared `value` placeholder per attacker (same
            // PlaceholderResolver mechanism the single-attacker execute() path uses) instead
            // of assuming strength for every channel — e.g. a cut declaring
            // ':Physical.sharpness' now scales by sharpness.
            const perAttackerStatContext = this._flattenStatsToTraitStatMap(attackerStats);

            const perAttackerConsequences = this._buildPerAttackerConsequences(action, perAttackerStatContext);

            // Phase 4 dedup: shared per-consequence loop (see _dispatchConsequences).
            // Options preserve this path's exact semantics:
            // - resultMeta: every per-result entry is tagged with attackerComponentId
            //   (the metadata the multi-attacker path has always produced).
            // - extraHandlerContext: attackerComponentId is also passed inside the
            //   handler context (preserved from the original implementation).
            // - propagateParams: false — this path never merges the handler-modified
            //   params back into its context (no aggregation of any handler output
            //   across consequences, e.g. ConsumeItemHandler's itemVolume still does
            //   not flow forward here).
            // - propagateKeys: the one deliberate exception (spec D11, revised):
            //   the reserved published-loss key written by the damage handler is
            //   carried forward so THIS attacker's own dropMaterialChunk consequence
            //   consumes THIS attacker's applied loss. Each attacker gets a fresh
            //   dispatch context, so the loss never crosses attacker boundaries —
            //   two independent per-fist rolls, never an aggregate.
            // - includeResolvedSourceId: false — the original loop did not add
            //   resolvedSourceId to the handler context.
            const { results } = this._dispatchConsequences(perAttackerConsequences, {
                action,
                actionName,
                entityId,
                requirementValues: perAttackerReqValues,
                targetParams: perAttackerParams,
                initialContextParams: perAttackerParams,
                fulfillingComponents: perAttackerFulfilling,
                synergyResult,
                primaryComponentId: null,
                resultMeta: { attackerComponentId: attackerId },
                extraHandlerContext: { attackerComponentId: attackerId },
                propagateParams: false,
                propagateKeys: [PUBLISHED_CHANNEL_LOSS_KEY],
                includeResolvedSourceId: false
            });
            allResults.push(...results);
        }

        return {
            success: true,
            executedConsequences: allResults.filter(r => r.success).length,
            executedPerAttacker: attackerComponentIds.length,
            results: allResults
        };
    }

    /**
     * Executes failure consequences for an action.
     *
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Result of failure consequence execution.
     */
    executeFailure(actionName, entityId) {
        const action = this.actionController.actionRegistry[actionName];
        if (!action || !action.failureConsequences) {
            return { success: false, error: `Action "${actionName}" has no failure consequences defined.` };
        }

        const results = [];
        for (const consequence of action.failureConsequences) {
            const resolvedParams = this._resolveParams(consequence.params, {}, {});
            // Failure log consequences in data/actions.json store message/level at the
            // top level (no params object) — merge them through so the handler logs
            // the real message instead of the empty fallback.
            const effectiveParams = consequence.type === 'log'
                ? { ...(resolvedParams || {}), ...(consequence.message ? { message: consequence.message } : {}), ...(consequence.level ? { level: consequence.level } : {}) }
                : resolvedParams;

            const targetResult = this._resolveTargetForConsequence(consequence, entityId, {}, {}, action, actionName);

            if (!targetResult.success) {
                results.push({
                    success: false,
                    error: this._resolveError({
                        code: 'CONSEQUENCE_EXECUTION_FAILED',
                        details: { type: consequence.type, error: targetResult.error }
                    }),
                    type: consequence.type
                });
                continue;
            }

            // Pass the consequence target type to the handler for interpretation
            const handlerContext = { actionName, actionParams: { consequenceTarget: consequence.target } };
            const dispatchResult = this.actionController.consequenceHandlers.dispatch(
                consequence.type,
                targetResult.targetId,
                effectiveParams,
                handlerContext
            );
            if (dispatchResult && dispatchResult.error === 'no-handler') {
                results.push({
                    success: false,
                    error: `Unknown consequence type: "${consequence.type}"`,
                    type: consequence.type
                });
                continue;
            }
            results.push({
                success: true,
                type: consequence.type,
                target: consequence.target,
                ...dispatchResult
            });
        }

        return { success: false, executedFailureConsequences: results.length, results };
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Shared per-consequence dispatch loop, extracted (Phase 4) from the ~80%
     * duplicated bodies of execute() and executeMultiAttacker().
     *
     * Behavior is option-driven so each caller preserves its exact historical
     * semantics (see the option call sites):
     * - Placeholder resolution always uses `contextParams` (the entity-aware
     *   params), while target resolution uses `targetParams`.
     * - `propagateParams` mirrors the execute() behavior of merging
     *   handler-modified actionParams back into the shared context.
     * - `includeResolvedSourceId` mirrors execute()'s equipped-item 'self'
     *   resolvedSourceId injection.
     * - `resultMeta`/`extraHandlerContext` carry the multi-attacker
     *   attackerComponentId metadata into results and the handler context.
     *
     * @param {Array} consequences - The consequence definitions to execute.
     * @param {Object} opts - Dispatch options.
     * @returns {{ results: Array }} The per-consequence result entries.
     * @private
     */
    _dispatchConsequences(consequences, {
        action,
        actionName,
        entityId,
        requirementValues,
        targetParams,
        initialContextParams,
        fulfillingComponents,
        synergyResult,
        primaryComponentId = null,
        resultMeta = null,
        extraHandlerContext = null,
        propagateParams = false,
        propagateKeys = null,
        includeResolvedSourceId = false
    }) {
        const results = [];
        // Mutable context: actionParams start from the caller-provided values and
        // may accumulate handler-modified values across consequences when
        // propagateParams is set (single-attacker execute() semantics).
        const context = {
            requirementValues,
            actionParams: { ...initialContextParams },
            fulfillingComponents,
            synergyResult
        };

        for (const consequence of consequences) {
            const meta = resultMeta ? { ...resultMeta } : {};

            // Use contextParams (which includes entityId for execute()) for
            // resolution, so placeholders like :entityId, :itemId, :itemType
            // resolve correctly.
            const resolvedParams = this._resolveParams(consequence.params, requirementValues, context.actionParams);

            try {
                let effectiveParams = this._applySynergy(resolvedParams, synergyResult);
                // Log consequences in data/actions.json store message/level at the
                // top level (no params object) — merge them through so the handler
                // logs the real message instead of the empty fallback.
                if (consequence.type === 'log') {
                    effectiveParams = {
                        ...(effectiveParams || {}),
                        ...(consequence.message ? { message: consequence.message } : {}),
                        ...(consequence.level ? { level: consequence.level } : {})
                    };
                }
                const targetResult = this._resolveTargetForConsequence(consequence, entityId, targetParams, fulfillingComponents, action, actionName, primaryComponentId);

                if (!targetResult.success) {
                    results.push({
                        success: false,
                        error: this._resolveError({
                            code: 'CONSEQUENCE_EXECUTION_FAILED',
                            details: { type: consequence.type, error: targetResult.error }
                        }),
                        type: consequence.type,
                        ...meta
                    });
                    continue;
                }

                // Pass the consequence target type to the handler for interpretation.
                // For equipped item 'self' targets (execute() path), include the
                // resolved source eqId so handlers can route stat changes to
                // EquippedItemStatsController instead of the host component.
                const isEquippedItemSelf = includeResolvedSourceId && consequence.target === 'self'
                    && context.actionParams.attackerComponentId && IdResolver.isEquippedId(context.actionParams.attackerComponentId);
                const handlerContext = {
                    ...context,
                    actionName,
                    actionParams: { ...context.actionParams, consequenceTarget: consequence.target },
                    // When the source is an equipped item and target is 'self', provide the eqId
                    // so handlers can route to EquippedItemStatsController
                    ...(isEquippedItemSelf ? { resolvedSourceId: context.actionParams.attackerComponentId } : {}),
                    ...(extraHandlerContext || {})
                };
                // Dispatch through the ConsequenceHandlers public API (BUG-122: no direct
                // access to the internal handlers map from outside the handler system).
                const dispatchResult = this.actionController.consequenceHandlers.dispatch(
                    consequence.type,
                    targetResult.targetId,
                    effectiveParams,
                    handlerContext
                );
                if (dispatchResult && dispatchResult.error === 'no-handler') {
                    results.push({ success: false, error: `Unknown consequence type: "${consequence.type}"`, type: consequence.type, ...meta });
                    continue;
                }
                const result = dispatchResult;

                // Propagate handler-modified actionParams back to context so subsequent
                // consequences in the same pipeline can see values set by earlier handlers
                // (e.g., itemVolume set by ConsumeItemHandler) — execute() semantics only.
                if (propagateParams) {
                    Object.assign(context.actionParams, handlerContext.actionParams);
                }

                // Targeted propagation (spec D11, revised): when the caller allows a
                // specific set of reserved keys, carry exactly those forward from the
                // handler context into the shared context — and nothing else. The
                // multi-attacker path uses this for the published channel loss so each
                // attacker's own drop step can consume its own damage result, while
                // every other handler-modified param keeps the path's no-propagation
                // semantics.
                if (propagateKeys) {
                    for (const key of propagateKeys) {
                        if (handlerContext.actionParams[key] !== undefined) {
                            context.actionParams[key] = handlerContext.actionParams[key];
                        }
                    }
                }

                results.push({
                    success: true,
                    type: consequence.type,
                    synergyApplied: synergyResult !== null,
                    target: consequence.target,
                    ...meta,
                    ...result
                });
            } catch (error) {
                const errorMsg = error?.message ?? String(error) ?? 'Unknown error';
                results.push({
                    success: false,
                    error: this._resolveError({
                        code: 'CONSEQUENCE_EXECUTION_FAILED',
                        details: { type: consequence.type, error: errorMsg }
                    }),
                    type: consequence.type,
                    ...meta
                });
            }
        }

        return { results };
    }

    /**
     * Resolves placeholders in consequence params.
     * Resolves :Trait.stat from requirementValues and :variable from actionParams.
     * @private
     */
    _resolveParams(params, requirementValues, actionParams) {
        // Merge requirementValues and actionParams so both :Trait.stat and :entityId
        // style placeholders can be resolved (e.g., :entityId, :itemId, :itemType).
        const resolutionContext = { ...actionParams, ...requirementValues };
        return resolvePlaceholders(params, resolutionContext);
    }

    /**
     * Applies synergy multiplier to numeric consequence properties.
     * @private
     */
    _applySynergy(params, synergyResult) {
        if (synergyResult && synergyResult.synergyMultiplier > SYNERGY_BONUS_THRESHOLD &&
            typeof params === 'object' && params !== null) {
            for (const [key, val] of Object.entries(params)) {
                if (typeof val === 'number') {
                    params[key] = this.synergyController
                        ? this.synergyController.applySynergyToResult(synergyResult, val)
                        : val;
                }
            }
        }
        return params;
    }

    /**
     * Resolves the target ID for a consequence based on its 'target' field.
     *
     * Target types:
     * - 'self':    The source component that fulfilled the action's requirements.
     * - 'target':  The explicitly targeted component/entity from action params.
     * - 'entity':  The entire entity performing the action.
     *
     * @private
     */
    _resolveTargetForConsequence(consequence, entityId, params, fulfillingComponents, action, actionName, primaryComponentId = null) {
        // MANDATORY: target field must be specified
        if (!consequence.target) {
            Logger.error(
                `[ConsequenceDispatcher] Consequence type "${consequence.type}" in action "${actionName || 'unknown'}" ` +
                `is missing required 'target' field. Expected: 'self', 'target', or 'entity'.`
            );
            return { success: false, error: 'Missing target field' };
        }

        const targetType = consequence.target;

        switch (targetType) {
            case 'self': {
                // The client explicitly specified the component to target for self-effects.
                // Prioritize attackerComponentId (multi-attacker) or targetComponentId (spatial/single).
                if (params?.attackerComponentId) {
                    return { success: true, targetId: params.attackerComponentId };
                }
                if (params?.targetComponentId) {
                    return { success: true, targetId: params.targetComponentId };
                }
                // If client sent componentIds array, use the first source component.
                if (params?.componentIds && Array.isArray(params.componentIds) && params.componentIds.length > 0) {
                    const firstSource = params.componentIds.find(c => c.role === BINDING_ROLES.SOURCE);
                    if (firstSource) {
                        return { success: true, targetId: firstSource.componentId };
                    }
                }
                // Fallback to requirement-resolved component only if client didn't specify one.
                if (primaryComponentId) {
                    return { success: true, targetId: primaryComponentId };
                }
                const selfKey = Object.keys(fulfillingComponents).find(k => fulfillingComponents[k]);
                const componentId = fulfillingComponents[selfKey] || entityId;
                return { success: true, targetId: componentId };
            }
            case 'target': {
                // Use explicitly targeted component or entity
                const targetId = params.targetComponentId || params.targetEntityId || entityId;
                return { success: true, targetId };
            }
            case 'entity':
                return { success: true, targetId: entityId };
            default:
                Logger.error(
                    `[ConsequenceDispatcher] Unknown target type "${targetType}" for consequence ` +
                    `"${consequence.type}" in action "${actionName || 'unknown'}". Expected: 'self', 'target', or 'entity'.`
                );
                return { success: false, error: `Unknown target type: ${targetType}` };
        }
    }

    /**
     * Flattens a nested trait-shaped stats object ({ Trait: { stat: value, ... } }) into
     * the flat { 'Trait.stat': value } map that PlaceholderResolver consumes as
     * requirementValues. Only finite numeric leaves are kept — non-numeric leaves are
     * irrelevant to :Trait.stat resolution and would only add noise to the context.
     *
     * @param {Object|null} stats - Nested trait-shaped stats (e.g. from getComponentStats).
     * @returns {Object<string, number>} Flat 'Trait.stat' → number map.
     * @private
     */
    _flattenStatsToTraitStatMap(stats) {
        const flat = {};
        if (!stats || typeof stats !== 'object') return flat;
        for (const [trait, group] of Object.entries(stats)) {
            if (!group || typeof group !== 'object') continue;
            for (const [stat, value] of Object.entries(group)) {
                if (typeof value === 'number' && Number.isFinite(value)) {
                    flat[`${trait}.${stat}`] = value;
                }
            }
        }
        return flat;
    }

    /**
     * Builds per-attacker consequences from the action definition for the
     * multi-attacker path.
     *
     * Two consequence models share the `damageComponent` type and are distinguished by
     * their declared params, mirroring the single-attacker execute() path:
     *
     *   - Channel model (declares `channel`): the damage axis is named by the channel
     *     string rather than a trait/stat pair, and the raw value is a POSITIVE number
     *     (the channel-loss formula clamps negative values to zero). The declared params
     *     are passed through SPREAD — so `channel` (and any other declared field) is
     *     preserved from the data, never hardcoded — and the declared `value` placeholder
     *     is resolved PER ATTACKER with the same PlaceholderResolver/requirementValues
     *     mechanism the single-attacker path uses. A stat reference (e.g. ':Physical.strength',
     *     ':Physical.sharpness') resolves to that attacker's own value, so a channel action
     *     is scaled by its declared stat, not unconditionally by strength. If the declared
     *     value does not resolve to a finite number (a :variable, an unknown stat, or a
     *     non-numeric leaf), it falls back to the attacker's resolved strength, keeping the
     *     model total.
     *
     *   - Legacy stat-delta model (no channel, declares `trait`/`stat`): unchanged — an
     *     additive NEGATIVE delta on the trait/stat pair.
     *
     * @param {Object} action - The action definition from the registry.
     * @param {Object<string, number>} requirementValues - The per-attacker flat
     *   'Trait.stat' → number stat context (see _flattenStatsToTraitStatMap); it supplies
     *   both the declared-`value` resolution and the strength fallback.
     * @returns {Array<Object>} Per-attacker consequence descriptors ready for _dispatchConsequences.
     * @private
     */
    _buildPerAttackerConsequences(action, requirementValues) {
        const attackerStrength = requirementValues?.['Physical.strength'];
        return action.consequences.map(consequence => {
            if (consequence.type === 'damageComponent') {
                if (consequence.params?.channel) {
                    // Channel model: pass the declared params through (preserving `channel`)
                    // and resolve the declared `value` placeholder per attacker. The result is
                    // a positive raw amount for the channel-loss formula (the handler clamps any
                    // negative), or the attacker's strength when it cannot be resolved to a
                    // finite number.
                    const resolvedValue = resolvePlaceholders(consequence.params.value, requirementValues);
                    const value = (typeof resolvedValue === 'number' && Number.isFinite(resolvedValue))
                        ? resolvedValue
                        : attackerStrength;
                    return {
                        type: 'damageComponent',
                        target: consequence.target,
                        params: { ...consequence.params, value }
                    };
                }
                // Legacy stat-delta model: additive negative delta on a trait/stat pair.
                return {
                    type: 'damageComponent',
                    target: consequence.target,
                    params: {
                        trait: consequence.params?.trait,
                        stat: consequence.params?.stat,
                        value: -attackerStrength
                    }
                };
            }
            if (consequence.type === 'log' && consequence?.params?.message) {
                return {
                    type: 'log',
                    target: consequence.target,
                    params: {
                        ...consequence.params,
                        message: consequence.params.message.replace(/:Physical\.strength/g, String(attackerStrength))
                    }
                };
            }
            return consequence;
        });
    }

    /**
     * Resolves a structured error to a human-readable message.
     * @private
     */
    _resolveError(error) {
        if (!error || !error.code) {
            Logger.error('An unknown error occurred.');
            return 'An unknown error occurred.';
        }

        const ERROR_REGISTRY = {
            'CONSEQUENCE_EXECUTION_FAILED': {
                message: 'Failed to execute consequence {type}: {error}',
                level: 'ERROR'
            }
        };

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
}

export default ConsequenceDispatcher;