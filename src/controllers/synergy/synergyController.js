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
import SynergyConfigManager from './SynergyConfigManager.js';
import SynergyComponentGatherer from './SynergyComponentGatherer.js';
import SynergyCalculator from './SynergyCalculator.js';
import SynergyCacheManager from './SynergyCacheManager.js';

class SynergyController {
    /**
     * Creates a new SynergyController.
     *
     * @param {WorldStateController} worldStateController - The root state controller (injected).
     * @param {Object} actionRegistry - The full action registry from data/actions.json.
     * @param {Object} [synergyRegistry] - The synergy registry from data/synergy.json (optional).
     * @param {ActionSelectController} [actionSelectController] - Component selection controller.
     */
    constructor(worldStateController, actionRegistry, synergyRegistry, actionSelectController) {
        this.worldStateController = worldStateController;
        this.actionRegistry = actionRegistry || {};
        this.actionSelectController = actionSelectController || null;

        // Inject extracted modules
        this.configManager = new SynergyConfigManager();
        this.componentGatherer = new SynergyComponentGatherer(worldStateController, actionSelectController);
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
            return this.calculator.createResult(actionName, 1.0, false, null, []);
        }

        const contributingComponents = [];
        let totalMultiplier = 1.0;

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
        let totalMultiplier = 1.0;
        for (const groupDef of config.componentGroups) {
            const members = this._filterProvidedForGroup(actionName, entityId, providedComponentIds, groupDef);
            if (members.length < groupDef.minCount) continue;
            const multiplier = this.calculator.computeMultiplier(
                members.length,
                groupDef.scaling || 'linear',
                groupDef.baseMultiplier ?? 1.0,
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
        let detectedType = null;
        for (const { componentId } of providedComponentIds) {
            if (lockedComponentIds.has(componentId)) continue;
            const component = entity.components.find(c => c.id === componentId);
            if (component) {
                detectedType = component.type;
                break;
            }
        }

        // Second pass: filter by roleFilter and same type
        const validComponents = providedComponentIds
            .filter(({ componentId, role }) => {
                if (lockedComponentIds.has(componentId)) return false;
                const component = entity.components.find(c => c.id === componentId);
                if (!component) return false;
                const stats = this.worldStateController.componentController.getComponentStats(componentId);
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
                componentId, entityId, componentType: entity.components.find(c => c.id === componentId)?.type,
                role
            }));

        return validComponents;
    }

    _matchesRoleFilter(stats, roleFilter) {
        switch (roleFilter) {
            case 'source': case 'spatial':
                return (stats.Movement && Object.keys(stats.Movement).length > 0) ||
                       (stats.Physical && Object.keys(stats.Physical).length > 0);
            case 'self_target':
                return stats.Physical && Object.keys(stats.Physical).length > 0;
            default: return true;
        }
    }

    _evaluateComponentGroups(actionName, entityId, groups, contributingComponents, sourceComponentId, allowedComponentIds) {
        let totalMultiplier = 1.0;
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) return 1.0;

        for (const groupDef of groups) {
            const members = this._gatherGroupMembers(actionName, entityId, groupDef, sourceComponentId, allowedComponentIds);
            if (members.length < groupDef.minCount) continue;

            const multiplier = this.calculator.computeMultiplier(
                members.length, groupDef.scaling || 'linear',
                groupDef.baseMultiplier ?? 1.0, groupDef.perUnitBonus ?? 0
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