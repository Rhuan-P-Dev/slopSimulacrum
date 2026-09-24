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
import DataLoader from '../../utils/DataLoader.js';

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
        // Lazy cache for recipe files (data/components/components.json,
        // data/components/inventoryItems.json) used to name components/weapons in
        // log messages (BUG-140 follow-up).
        this._recipeCache = null;
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
            let resolvedAttackerId;
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
                includeResolvedSourceId: false,
                // The message's :stat / :damageValue placeholders resolve against this
                // attacker's FULL stat context (sharpness, fine_controls, …) so a
                // two-handed shot logs real damage; param resolution above stays
                // strength-only (BUG-134). Without this, non-strength actions logged 0.
                messageStatContext: perAttackerStatContext
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
            // Failure log consequences in data/systems/actions.json store message/level
            // at the top level (no params object). Resolve the template (carrying
            // :entityId) so the logged line names the acting entity instead of leaking
            // raw placeholder tokens.
            const resolvedFailureMessage = this._resolveLogMessage(
                consequence.message,
                {},
                {},
                entityId,
                actionName,
                this._getEntityName(entityId),
                action
            );
            const effectiveParams = consequence.type === 'log'
                ? { ...(resolvedParams || {}), ...(resolvedFailureMessage ? { message: resolvedFailureMessage } : {}), ...(consequence.level ? { level: consequence.level } : {}) }
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
        includeResolvedSourceId = false,
        messageStatContext = undefined
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
                // Log consequences in data/systems/actions.json store message/level at
                // the top level (no params object). The message is a data-driven
                // template — resolve it (like the damage value it mirrors) so the
                // concrete actor and damage number appear in the log and LLM event
                // context instead of raw ":placeholder" tokens leaking through
                // (e.g. "Item ':itemType' dropped at (:targetX, :targetY)"). The level is
                // resolved against the SAME context so a templated level can never leak
                // raw tokens either.
                if (consequence.type === 'log') {
                    // BUG-140 follow-up: the component doing the hitting (so the line
                    // can read "…'s <component>"). Prefers the per-attacker param
                    // (multi-attacker / shoot / cut), then the single-attacker source
                    // component, then the first fulfilling component.
                    const attackerComponentId = context.actionParams.attackerComponentId
                        || primaryComponentId
                        || (fulfillingComponents ? Object.values(fulfillingComponents)[0] : null)
                        || null;
                    const logCtx = this._logResolutionContext(
                        requirementValues,
                        context.actionParams,
                        entityId,
                        actionName,
                        this._getEntityName(entityId),
                        action,
                        // The template resolves its :stat / :damageValue placeholders against
                        // the FULL stat context (messageStatContext) — on the multi-attacker
                        // path that is the per-attacker stat map — while the param resolution
                        // above keeps the strength-only requirementValues (BUG-134 ammo
                        // semantics). Defaults to requirementValues on the single-attacker
                        // path, whose requirementValues already carry the stats.
                        messageStatContext ?? requirementValues,
                        attackerComponentId
                    );
                    const resolvedMessage = (consequence.message != null && consequence.message !== '')
                        ? resolvePlaceholders(String(consequence.message), logCtx)
                        : undefined;
                    const resolvedLevel = consequence.level
                        ? resolvePlaceholders(String(consequence.level), logCtx)
                        : undefined;
                    effectiveParams = {
                        ...(effectiveParams || {}),
                        ...(resolvedMessage ? { message: resolvedMessage } : {}),
                        ...(resolvedLevel ? { level: resolvedLevel } : {})
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
                const errorMsg = error?.message ?? String(error);
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
     * Builds the resolution context shared by a log consequence's top-level
     * template fields (`message` and `level`). Data-driven log consequences
     * store message/level on the consequence itself (not inside a `params`
     * object), so neither is touched by _resolveParams (which only resolves
     * `params`).
     *
     * WHY the same template can name a stat for the damage ("dealing
     * :Physical.strength impact damage") as for prose ("dealing
     * :Physical.sharpness cut damage"), and both must display the concrete number
     * to the player and in the LLM event context. Routing the template through
     * the same PlaceholderResolver, with a context that carries the acting
     * entity (:entityId), the action params (:itemType, :targetX, ...) and the
     * resolved trait stats, keeps the human-readable "who / what / how much" in
     * sync with the damage actually dealt. Without this step the raw
     * ":placeholder" tokens leak verbatim into the server log and the LLM event
     * context — the original symptom being a log line that names neither the
     * entity ID nor the damage.
     *
     * Unknown placeholders are left untouched (the resolver's embedded path
     * returns the original token when the value is absent), so this degrades to
     * the pre-fix behavior for templates that reference values not present in
     * scope.
     *
     * @param {Object|null} requirementValues - Flat "Trait.stat" -> number stats.
     * @param {Object|null} actionParams - Action execution params.
     * @param {string} entityId - The acting entity ID.
     * @param {string|null|undefined} actionName - Action name for :actionName (registry name).
     * @param {string|null|undefined} entityName - Acting entity display name for :entityName.
     * @param {Object|null} action - Action definition (source of the damage context).
     * @param {Object<string, number>|null|undefined} statContext - Stat base for :stat / :damageValue resolution; defaults to requirementValues when undefined/null. The multi-attacker path passes the full per-attacker stat map so non-strength stats resolve; single-attacker and failure paths omit it.
     * @param {string|null} [attackerComponentId] - The component doing the hitting (BUG-140).
     * @returns {Object} The placeholder resolution context.
     * @private
     */
    _logResolutionContext(requirementValues, actionParams, entityId, actionName, entityName, action, statContext, attackerComponentId = null) {
        // statContext supplies the base for :stat / :damageValue resolution. It defaults
        // to requirementValues (single-attacker); the multi-attacker path passes its full
        // per-attacker stat map so non-strength stats resolve in the message even though
        // param resolution stays strength-only (BUG-134).
        const statBase = statContext !== undefined && statContext !== null
            ? statContext
            : (requirementValues || {});

        // BUG-140 follow-up: name WHAT was hit and WITH WHAT. The damage consequences
        // target the victim (target: 'target') while the log sits on the attacker
        // (target: 'self'), so the victim must be resolved from the action params. The
        // attacker's attacking component (a hand / the knife / the T1) is supplied by
        // the caller. Each side renders as a possessive phrase ('s <Name>) that degrades
        // to '' when the component cannot be resolved, keeping the sentence grammatical.
        const targetEntityId = (actionParams && actionParams.targetEntityId) || entityId;
        const targetComponentId = (actionParams && actionParams.targetComponentId) || null;
        const targetName = this._getEntityName(targetEntityId);
        const targetCompName = this._getComponentDisplayName(targetComponentId, targetEntityId);
        const attackerCompName = this._getComponentDisplayName(attackerComponentId, entityId);

        const resolutionContext = {
            ...statBase,
            ...(actionParams || {}),
            // Generic "who / what / how much" placeholders so ANY log template reads
            // the same: the acting entity, the action name, and (for damage actions)
            // the damage amount + channel. Templates that use a placeholder get a
            // concrete value; templates without one are untouched (the resolver leaves
            // unknown placeholders as-is). This is what makes the message format
            // generic — punch, cut, shoot and shotgun all share one template.
            ...(actionName && typeof actionName === 'string' ? { actionName } : {}),
            ...(entityName && typeof entityName === 'string' ? { entityName } : {}),
            ...this._damageContext(action, statBase, actionParams),
            // BUG-140 follow-up placeholders: the victim (always set — it defaults to the
            // acting entity — so the sentence never leaks a raw token) and the possessive
            // component phrases (the attacker's weapon/limb and the victim's hit component).
            targetName,
            targetId: targetEntityId,
            attackerCompPhrase: attackerCompName ? `'s ${attackerCompName}` : '',
            targetCompPhrase: targetCompName ? `'s ${targetCompName}` : '',
            // entity goes last: it is the authoritative actor for every log line and
            // must not be shadowed by any coincidentally-named action param.
            entityId
        };
        return resolutionContext;
    }

    /**
     * Resolves the free-text message declared on a log consequence's top-level
     * `message` field using _logResolutionContext (see its docs for the context
     * semantics).
     *
     * @param {string|null|undefined} message - The template string (may contain no placeholders).
     * @param {Object|null} requirementValues - Flat "Trait.stat" -> number stats.
     * @param {Object|null} actionParams - Action execution params.
     * @param {string} entityId - The acting entity ID.
     * @param {string|null|undefined} actionName - Action name for :actionName (registry name).
     * @param {string|null|undefined} entityName - Acting entity display name for :entityName.
     * @param {Object|null} action - Action definition (source of the damage context).
     * @param {Object<string, number>|null|undefined} statContext - Stat base for :stat / :damageValue resolution; see _logResolutionContext.
     * @param {string|null} [attackerComponentId] - The component doing the hitting (BUG-140).
     * @returns {string|undefined} The resolved message, or undefined when none declared.
     * @private
     */
    _resolveLogMessage(message, requirementValues, actionParams, entityId, actionName, entityName, action, statContext, attackerComponentId = null) {
        if (message === undefined || message === null || message === '') return undefined;
        const resolutionContext = this._logResolutionContext(
            requirementValues,
            actionParams,
            entityId,
            actionName,
            entityName,
            action,
            statContext,
            attackerComponentId
        );
        return resolvePlaceholders(String(message), resolutionContext);
    }

    /**
     * Returns the acting entity's display name, for the `:entityName` placeholder.
     * Uses the same convention as the LLM context (LlmContextController: entity.name ||
     * 'Droid'): a named entity (NPC) returns its trimmed name; a bare droid, a missing
     * entity, or an unavailable world (test seams / pre-injection) returns "Droid".
     * Never throws — log rendering must be fault-tolerant.
     * @private
     */
    _getEntityName(entityId) {
        if (!this.worldStateController || typeof this.worldStateController.getEntity !== 'function') return 'Droid';
        const entity = this.worldStateController.getEntity(entityId);
        // Same display convention as the LLM context (LlmContextController: entity.name ||
        // 'Droid'): a named entity (NPC) renders with its name; a bare droid renders as
        // "Droid" — the label the player already sees elsewhere.
        if (entity && typeof entity.name === 'string' && entity.name.trim() !== '') {
            return entity.name.trim();
        }
        return 'Droid';
    }

    /**
     * Returns a display name for a component (or equipped weapon) ID, for the
     * `:attackerCompPhrase` / `:targetCompPhrase` log placeholders.
     *
     * Two kinds of IDs arrive here:
     *   - a body-part component (comp-...): resolved through the owning entity's
     *     component list to its `type`, then named from data/components/components.json
     *     (e.g. droidHand -> "Droid Hand").
     *   - an equipped weapon (eq-...): resolved through the holder's equipped
     *     inventory to its `itemType`, then named from data/components/inventoryItems.json
     *     (e.g. t1 -> "T1", knife -> "Knife").
     *
     * Falls back to a prettified recipe/type key, and to null when nothing can be
     * resolved (unavailable world / unknown id) — in which case the possessive
     * phrase is simply omitted, so the log line stays grammatical. Never throws:
     * log rendering must be fault-tolerant.
     * @param {string} componentId - The component or equipped-item ID to name.
     * @param {string} [entityId] - The owning entity (needed to resolve eq- IDs).
     * @returns {string|null}
     * @private
     */
    _getComponentDisplayName(componentId, entityId) {
        if (!componentId || typeof componentId !== 'string') return null;
        const ws = this.worldStateController;
        if (!ws) return null;

        // Body part: resolve the owning component to its type, then to a recipe name.
        if (typeof ws.getComponent === 'function') {
            try {
                const comp = ws.getComponent(componentId);
                if (comp && comp.type) {
                    return this._recipeName('components', comp.type) || this._prettifyType(comp.type);
                }
            } catch (_) { /* fall through to the equipped-item path */ }
        }

        // Equipped weapon: resolve the holder's equipped entry to its itemType, then name.
        if (typeof ws.getEquippedItem === 'function' && entityId) {
            try {
                const item = ws.getEquippedItem(entityId, componentId);
                if (item && item.itemType) {
                    return this._recipeName('inventoryItems', item.itemType) || this._prettifyType(item.itemType);
                }
            } catch (_) { /* fall through */ }
        }

        return null;
    }

    /**
     * Lazily loads and caches a recipe file, returning the human-readable `name`
     * for a recipe key (component or item type). Used by _getComponentDisplayName().
     * @param {'components'|'inventoryItems'} file - data/components/<file>.json to read.
     * @param {string} type - The recipe key (component / item type).
     * @returns {string|null}
     * @private
     */
    _recipeName(file, type) {
        if (!type || typeof type !== 'string') return null;
        let recipes = this._recipeCache && this._recipeCache[file];
        if (!recipes) {
            recipes = DataLoader.loadJsonSafe(`data/components/${file}.json`, {});
            // Only cache a successful (non-empty) load so a transient read failure
            // (loadJsonSafe returning the {} default) can be retried on the next call
            // instead of being cached for the dispatcher's lifetime.
            if (recipes && Object.keys(recipes).length > 0) {
                this._recipeCache = { ...(this._recipeCache || {}), [file]: recipes };
            }
        }
        const def = recipes && recipes[type];
        return (def && typeof def.name === 'string' && def.name !== '') ? def.name : null;
    }

    /**
     * Prettifies a camelCase recipe/type key into a readable name (droidHand ->
     * "Droid Hand"). Used only when a recipe file has no explicit `name`.
     * @param {string} type
     * @returns {string|null}
     * @private
     */
    _prettifyType(type) {
        if (!type || typeof type !== 'string') return null;
        return type.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
    }

    /**
     * Computes the `:damageValue` / `:damageChannel` placeholders for an action's
     * log message, so the generic template
     * ":entityName (:entityId) performed :actionName dealing :damageValue :damageChannel damage"
     * shows a concrete number + channel for ANY damage action — no per-action wording.
     * First channel-damage consequence wins:
     *   - damageComponent:      declared value (a stat placeholder, resolved against
     *     the stat context) — punch → :Physical.strength, cut → :Physical.sharpness.
     *   - consumeItemAndDamage: the consumed item's volume, published as
     *     actionParams.itemVolume by ConsumeItemHandler (declared `value` is 0; the
     *     real damage comes from `damageSource`).
     *   - damageRandomComponents: PER-PELLET value × count (hand shotgun) — the total
     *     damage the spread deals across its random components.
     * `damageValue` is always a finite number (0 fallback) so a template naming
     * `:damageValue` never leaks a raw placeholder token. Returns {} when the action
     * has no channel damage (non-damage actions), so their templates simply never
     * reference the damage placeholders.
      *
      * NOTE (synergy): this returns the PRE-SYNERGY damage. Synergy multipliers are
      * applied separately by the damage handler (_applySynergy) at execution time and
      * intentionally NOT reflected here, so under an active synergy bonus the logged
      * :damageValue may be lower than the damage actually applied. The log intentionally
      * reports the base (pre-synergy) figure from the action definition; the post-synergy
      * amount is applied by the damage handler.
     * @private
     */
    _damageContext(action, requirementValues, actionParams) {
        if (!action || !Array.isArray(action.consequences)) return {};
        const damageTypes = ['damageComponent', 'consumeItemAndDamage', 'damageRandomComponents'];
        const damage = action.consequences.find(
            c => c && c.params && damageTypes.includes(c.type) && typeof c.params.channel === 'string'
        );
        if (!damage) return {};

        const { channel, value, count } = damage.params;
        const base = { ...(requirementValues || {}), ...(actionParams || {}) };

        let perHit;
        if (damage.type === 'consumeItemAndDamage') {
            // ShootT1-style: declared value is 0; the real damage is the consumed
            // item's volume (actionParams.itemVolume), set by ConsumeItemHandler.
            perHit = (typeof base.itemVolume === 'number' && Number.isFinite(base.itemVolume))
                ? base.itemVolume
                : (typeof value === 'number' && Number.isFinite(value) ? value : 0);
        } else {
            // Only attempt stat/param placeholder resolution when a context is actually
            // present. On the failure path the context is empty ({}), so a stat like
            // :Physical.strength cannot resolve and resolvePlaceholders would emit a
            // spurious "placeholder not found" WARN — there is no damage on a failed
            // action, so fall straight through to the declared-value fallback instead.
            const hasContext = base && typeof base === 'object' && Object.keys(base).length > 0;
            const resolved = hasContext ? resolvePlaceholders(value, base) : undefined;
            perHit = (typeof resolved === 'number' && Number.isFinite(resolved) && resolved >= 0)
                ? resolved
                : (typeof value === 'number' && Number.isFinite(value) ? value : 0);
        }

        const rawCount = (count !== undefined && count !== null && Number.isFinite(Number(count)))
            ? Number(count)
            : 1;
        const pelletCount = (rawCount > 1) ? rawCount : 1;

        return {
            damageChannel: channel,
            damageValue: perHit * pelletCount
        };
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
            if (consequence.type === 'damageRandomComponents') {
                // Channel-model analog to damageComponent: preserve the declared params
                // (channel, count) and resolve the declared `value` placeholder PER ATTACKER
                // against this attacker's full stat context, so a multi-attacker (two-handed)
                // shot fires for each hand using its own Manipulation.fine_controls. The
                // `count` stays per-attacker, matching how multi-attacker doubles the damage
                // of a single-attacker component action. Falls back to the attacker's
                // strength so the model stays total (mirrors the damageComponent channel
                // model).
                const resolvedValue = resolvePlaceholders(consequence.params?.value, requirementValues);
                const value = (typeof resolvedValue === 'number' && Number.isFinite(resolvedValue))
                    ? resolvedValue
                    : attackerStrength;
                return {
                    type: 'damageRandomComponents',
                    target: consequence.target,
                    params: { ...consequence.params, value }
                };
            }
            // Log consequences carry their message at the TOP level (no params object);
            // they pass through here unchanged and are resolved per-attacker later by
            // _resolveLogMessage (which receives the full per-attacker stat context).
            // The old params.message string-replace branch is gone with that data shape.
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