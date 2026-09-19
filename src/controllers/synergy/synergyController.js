/**
 * SynergyController — Orchestrates synergy computation for actions.
 * Single Responsibility: Delegate to SynergyConfigManager, SynergyComponentGatherer,
 * SynergyCalculator, and SynergyCacheManager modules.
 *
 * Extracted from original monolithic SynergyController (1064 lines → ~200 lines).
 * Config management extracted to SynergyConfigManager.js.
 * Component gathering extracted to SynergyComponentGatherer.js.
 * Multiplier calculation extracted to SynergyCalculator.js.
 * Cache management extracted to SynergyCacheManager.js.
 *
 * @module SynergyController
 */

import Logger from '../../utils/Logger.js';
import IdResolver from '../../utils/IdResolver.js';
import SynergyConfigManager from './SynergyConfigManager.js';
import SynergyComponentGatherer from './SynergyComponentGatherer.js';
import SynergyCalculator from './SynergyCalculator.js';
import SynergyCacheManager from './SynergyCacheManager.js';
import { DEFAULT_SYNERGY_BASE_MULTIPLIER } from '../../utils/Constants.js';
import { BINDING_ROLES } from '../../../shared/ActionVocabulary.js';
import { TRAIT_GROUPS } from '../../../shared/StatVocabulary.js';

class SynergyController {
    /**
     * Creates a new SynergyController.
     *
     * FASE 5: the facade is no longer passed at construction. It is injected via
     * setWorldStateController() after the facade is fully built (this controller —
     * and its nested SynergyComponentGatherer — depend on the facade).
     *
     * @param {Object} actionRegistry - The full action registry from data/actions.json.
     * @param {Object} [synergyRegistry] - The synergy registry from data/synergy.json (optional).
     * @param {ActionSelectController} [actionSelectController] - Component selection controller.
     */
    constructor(actionRegistry, synergyRegistry, actionSelectController) {
        /** @type {WorldStateController|null} Injected post-construction. */
        this.worldStateController = null;
        this.actionRegistry = actionRegistry || {};
        this.actionSelectController = actionSelectController || null;

        // Inject extracted modules (the gatherer receives the facade later via the setter)
        this.configManager = new SynergyConfigManager();
        this.componentGatherer = new SynergyComponentGatherer(actionSelectController);
        this.calculator = new SynergyCalculator();
        this.cacheManager = new SynergyCacheManager();

        // Load synergy config
        if (synergyRegistry && Object.keys(synergyRegistry).length > 0) {
            this.configManager.synergyRegistry = synergyRegistry;
        } else {
            this.configManager.load();
        }

        Logger.info('[SynergyController] Initialized', {
            actionsWithSynergy: this.configManager.countActionsWithSynergy()
        });
    }

    /**
     * Injects the world state facade (WorldStateController) after it is fully built,
     * and propagates it to the nested SynergyComponentGatherer. FASE 5: replaces the
     * constructor-time facade dependency (BUG-100 root cause).
     * @param {WorldStateController} worldStateController - The fully-built facade.
     */
    setWorldStateController(worldStateController) {
        this.worldStateController = worldStateController;
        if (this.componentGatherer) {
            this.componentGatherer.setWorldStateController(worldStateController);
        }
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    /**
     * Computes synergy for an action execution.
     * @param {string} actionName - Name of the action being executed.
     * @param {string} entityId - ID of the primary entity.
     * @param {Object} [context] - Execution context.
     * @returns {Object} Computed synergy result.
     */
    computeSynergy(actionName, entityId, context = {}) {
        const config = this.configManager.getConfig(actionName);

        if (!config.enabled) {
            return this.calculator.createResult(actionName, DEFAULT_SYNERGY_BASE_MULTIPLIER, false, null, []);
        }

        const contributingComponents = [];
        let totalMultiplier = DEFAULT_SYNERGY_BASE_MULTIPLIER;

        const sourceComponentId = context?.sourceComponentId;
        const providedComponentIds = context.providedComponentIds;

        // Build allowedComponentIds set from client-selected components.
        // This ensures synergy only counts components the client actually selected,
        // not all same-type siblings on the entity.
        let allowedComponentIds = null;
        if (providedComponentIds && providedComponentIds.length > 0) {
            allowedComponentIds = new Set(providedComponentIds.map(c => c.componentId));
        } else if (sourceComponentId) {
            // When no providedComponentIds but sourceComponentId is set (e.g., spatial actions
            // where the client sends targetComponentId but not componentIds), only count the
            // source component itself — never auto-include same-type siblings.
            allowedComponentIds = new Set([sourceComponentId]);
        }

        if (providedComponentIds && providedComponentIds.length > 0) {
            totalMultiplier *= this._evaluateProvidedComponents(
                actionName, entityId, providedComponentIds, config, contributingComponents
            );
        } else {
            totalMultiplier *= this._evaluateComponentGroups(
                actionName, entityId, config.componentGroups, contributingComponents, sourceComponentId, allowedComponentIds
            );
        }

        const { finalValue: multiplier, capped, capKey } = this._applyCaps(actionName, totalMultiplier, config);

        const summary = this._buildSummary(actionName, multiplier, contributingComponents);
        const result = this.calculator.createResult(actionName, multiplier, capped, capKey, contributingComponents, summary);

        this.cacheManager.set(actionName, result);

        Logger.info('[SynergyController] Synergy computed', {
            actionName, multiplier, capped, capKey, componentCount: contributingComponents.length
        });

        return result;
    }

    /**
     * Retrieves a cached synergy result if it exists and has not expired.
     * @param {string} actionName - The action name to look up.
     * @returns {Object|null} Cached result or null.
     */
    getCachedSynergy(actionName) {
        return this.cacheManager.get(actionName);
    }

    /**
     * Applies a synergy multiplier to a base value.
     * @param {Object} synergyResult - The synergy result.
     * @param {number} baseValue - The base consequence value.
     * @returns {number} Capped final value.
     */
    applySynergyToResult(synergyResult, baseValue) {
        return this.calculator.applyToValue(synergyResult.synergyMultiplier, baseValue);
    }

    /**
     * Gets the synergy summary string for a result.
     * @param {Object} synergyResult - The synergy result.
     * @returns {string} Human-readable summary.
     */
    getSynergySummary(synergyResult) {
        return synergyResult.summary || this._buildSummary(
            synergyResult.actionName, synergyResult.synergyMultiplier, synergyResult.contributingComponents
        );
    }

    /**
     * Gets the synergy configuration for an action.
     * @param {string} actionName - Name of the action.
     * @returns {Object} The synergy config (or default).
     */
    getSynergyConfig(actionName) {
        return this.configManager.getConfig(actionName);
    }

    /**
     * Clears the synergy computation cache.
     */
    clearCache() {
        this.cacheManager.clear();
    }

    /**
     * Gets all actions that have synergy enabled.
     * @returns {string[]} Array of action names.
     */
    getActionsWithSynergy() {
        return this.configManager.getActionsWithSynergy();
    }

    // =========================================================================
    // PRIVATE: EVALUATION
    // =========================================================================

    _evaluateProvidedComponents(actionName, entityId, providedComponentIds, config, contributingComponents) {
        let totalMultiplier = DEFAULT_SYNERGY_BASE_MULTIPLIER;
        for (const groupDef of config.componentGroups) {
            const members = this._filterProvidedForGroup(actionName, entityId, providedComponentIds, groupDef);
            if (members.length < groupDef.minCount) continue;
            const multiplier = this.calculator.computeMultiplier(
                members.length,
                groupDef.scaling || 'linear',
                groupDef.baseMultiplier ?? DEFAULT_SYNERGY_BASE_MULTIPLIER,
                groupDef.perUnitBonus ?? 0
            );
            totalMultiplier *= multiplier;
            // Add members to contributing components
            for (const member of members) {
                contributingComponents.push({
                    componentId: member.componentId,
                    entityId: member.entityId,
                    componentType: member.componentType,
                    contribution: multiplier / members.length
                });
            }
        }
        // Deduplicate
        const unique = this.calculator.deduplicate(contributingComponents);
        contributingComponents.length = 0;
        contributingComponents.push(...unique);
        return totalMultiplier;
    }

    _filterProvidedForGroup(actionName, entityId, providedComponentIds, groupDef) {
        const lockedComponentIds = this.componentGatherer.getLockedComponentIds(actionName);
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) return [];

        // First pass: find the component type from the first valid component in providedComponentIds
        // (regardless of roleFilter) - this makes type detection deterministic and independent
        // of array order / component stats.
        // Resolves equipment IDs (eq-*) to host component IDs (comp-*) for lookup.
        let detectedType = null;
        for (const { componentId } of providedComponentIds) {
            if (lockedComponentIds.has(componentId)) continue;

            // Resolve equipment IDs to component IDs for lookup
            let resolvedId = componentId;
            if (IdResolver.isEquippedId(componentId)) {
                const equipped = this.worldStateController.getEquippedItem(entityId, componentId);
                if (equipped && equipped.componentId) {
                    resolvedId = equipped.componentId;
                } else {
                    continue; // Equipment not found, skip
                }
            }

            const component = entity.components.find(c => c.id === resolvedId);
            if (component) {
                detectedType = component.type;
                break;
            }
        }

        // Second pass: filter by roleFilter and same type
        const validComponents = providedComponentIds
            .filter(({ componentId }) => {
                if (lockedComponentIds.has(componentId)) return false;

                // Resolve equipment IDs to component IDs for lookup
                let resolvedId = componentId;
                if (IdResolver.isEquippedId(componentId)) {
                    const equipped = this.worldStateController.getEquippedItem(entityId, componentId);
                    if (equipped && equipped.componentId) {
                        resolvedId = equipped.componentId;
                    } else {
                        return false; // Equipment not found, exclude
                    }
                }

                const component = entity.components.find(c => c.id === resolvedId);
                if (!component) return false;
                const stats = this.worldStateController.componentController.getComponentStats(resolvedId);
                if (!stats) return false;

                // Check roleFilter
                if (groupDef.roleFilter) {
                    if (!this._matchesRoleFilter(stats, groupDef.roleFilter)) return false;
                }

                // Only include same-type components
                if (detectedType && component.type !== detectedType) return false;

                return true;
            })
            .map(({ componentId, role }) => ({
                componentId, entityId, componentType: entity.components.find(c => c.id === componentId)?.type || null,
                role
            }));

        return validComponents;
    }

    _matchesRoleFilter(stats, roleFilter) {
        switch (roleFilter) {
            case BINDING_ROLES.SOURCE: case BINDING_ROLES.SPATIAL:
                return (stats[TRAIT_GROUPS.MOVEMENT] && Object.keys(stats[TRAIT_GROUPS.MOVEMENT]).length > 0) ||
                       (stats[TRAIT_GROUPS.PHYSICAL] && Object.keys(stats[TRAIT_GROUPS.PHYSICAL]).length > 0);
            case BINDING_ROLES.SELF_TARGET:
                return stats[TRAIT_GROUPS.PHYSICAL] && Object.keys(stats[TRAIT_GROUPS.PHYSICAL]).length > 0;
            default: return true;
        }
    }

    _evaluateComponentGroups(actionName, entityId, groups, contributingComponents, sourceComponentId, allowedComponentIds) {
        let totalMultiplier = DEFAULT_SYNERGY_BASE_MULTIPLIER;
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) return DEFAULT_SYNERGY_BASE_MULTIPLIER;

        for (const groupDef of groups) {
            const members = this._gatherGroupMembers(actionName, entityId, groupDef, sourceComponentId, allowedComponentIds);
            if (members.length < groupDef.minCount) continue;

            const multiplier = this.calculator.computeMultiplier(
                members.length, groupDef.scaling || 'linear',
                groupDef.baseMultiplier ?? DEFAULT_SYNERGY_BASE_MULTIPLIER, groupDef.perUnitBonus ?? 0
            );
            totalMultiplier *= multiplier;

            for (const member of members) {
                contributingComponents.push({
                    componentId: member.componentId, entityId: member.entityId,
                    componentType: member.componentType, contribution: multiplier / members.length
                });
            }
        }

        const unique = this.calculator.deduplicate(contributingComponents);
        contributingComponents.length = 0;
        contributingComponents.push(...unique);
        return totalMultiplier;
    }

    _gatherGroupMembers(actionName, entityId, groupDef, sourceComponentId, allowedComponentIds) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) return [];

        const roleFilter = groupDef.roleFilter;
        const lockedComponentIds = this.componentGatherer.getLockedComponentIds(actionName);

        // Default to sameComponentType for all groupTypes (auto-detects component type from source).
        // Pass allowedComponentIds to ensure only client-selected components count toward synergy.
        // Future groupTypes can be added here when needed.
        return this.componentGatherer.gatherSameComponentType(entity, groupDef, roleFilter, lockedComponentIds, sourceComponentId, allowedComponentIds);
    }


    // PRIVATE: CAPS & SUMMARY
    // =========================================================================

    _applyCaps(actionName, multiplier, config) {
        const caps = Object.entries(config.caps || {}).filter(([, d]) => typeof d.max === 'number');
        if (caps.length === 0) return { finalValue: multiplier, capped: false, capKey: null };

        const lowestCap = Math.min(...caps.map(([, d]) => d.max));
        if (multiplier <= lowestCap) return { finalValue: multiplier, capped: false, capKey: null };

        return { finalValue: lowestCap, capped: true, capKey: caps[0][0] };
    }

    _buildSummary(actionName, multiplier, contributingComponents) {
        const componentCount = contributingComponents.length;
        let parts = [`Synergy: ${multiplier.toFixed(2)}x`];
        parts.push(`${componentCount} component${componentCount !== 1 ? 's' : ''}`);
        return parts.join(', ');
    }
}

export default SynergyController;