/**
 * SynergyController — Computes combined effect multipliers when multiple
 * components or entities collaborate on a single action.
 *
 * Architecture:
 * - Follows Dependency Injection pattern (controller_patterns.md §2, §3)
 * - Injected by WorldStateController as Root Injector
 * - Integrated into ActionController execution pipeline
 * - Delegates stat reads to ComponentController / StateEntityController
 *
 * Per wiki/code_quality_and_best_practices.md:
 * - SRP: Only computes synergy multipliers, never executes consequences
 * - Loose coupling: reads via public APIs, never touches internal state
 * - No magic numbers: all thresholds in SynergyScaling.js
 *
 * @module SynergyController
 */

import Logger from '../utils/Logger.js';
import DataLoader from '../utils/DataLoader.js';
import { DEFAULT_SYNERGY_BASE_MULTIPLIER } from '../utils/Constants.js';
import {
    calculateSynergyMultiplier,
    SCALING_CURVES
} from '../utils/SynergyScaling.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Default synergy configuration applied when an action has no explicit synergy definition.
 * @type {Object}
 */
const DEFAULT_SYNERGY_CONFIG = {
    enabled: false,
    multiEntity: false,
    scaling: 'linear',
    caps: {},
    componentGroups: []
};

/**
 * Marker object returned when a synergy group entry is removed.
 * @typedef {Object} SynergyRemovalMarker
 * @property {string} _type - Always 'REMOVAL'
 * @property {string} componentId - ID of the removed component
 * @property {string} entityId - ID of the entity owning the component
 * @property {string} actionName - Action that the component no longer contributes to
 */

/**
 * Result of a synergy computation.
 * @typedef {Object} SynergyResult
 * @property {string} actionName - The action this synergy applies to
 * @property {number} baseValue - Original consequence value before synergy
 * @property {number} synergyMultiplier - Computed multiplier (> 1.0 = bonus, = 1.0 = no synergy)
 * @property {number} finalValue - baseValue * synergyMultiplier (after caps)
 * @property {boolean} capped - Whether the final value was capped
 * @property {string|null} capKey - Which cap was applied (e.g., 'damage')
 * @property {Array} contributingComponents - List of { componentId, entityId, componentType, contribution }
 * @property {string} summary - Human-readable summary string
 */

/**
 * Synergy configuration defined per-action in the action registry.
 * @typedef {Object} SynergyConfig
 * @property {boolean} enabled - Whether synergy is active for this action
 * @property {boolean} multiEntity - Whether multiple entities can collaborate
 * @property {string} scaling - Scaling curve name ('linear', 'diminishingReturns', 'increasingReturns')
 * @property {Object} caps - Cap definitions keyed by effect type
 * @property {Array} componentGroups - Groups of components that can synergize
 */

/**
 * Definition of a component group for synergy evaluation.
 * @typedef {Object} ComponentGroupDef
 * @property {string} groupType - How to identify group members ('sameComponentType', 'movementComponents', 'anyPhysical', 'anyComponent')
 * @property {number} minCount - Minimum members required for synergy to activate
 * @property {string} scaling - Scaling curve override (defaults to action-level)
 * @property {number} baseMultiplier - Starting multiplier for this group
 * @property {number} perUnitBonus - Bonus per additional member
 * @property {string} [synergyStat] - Specific stat to aggregate (e.g., 'Physical.strength')
 */

/**
 * Cap definition for a synergy effect.
 * @typedef {Object} CapDef
 * @property {number|null} max - Maximum allowed value (null = no cap, 'infinite' = unlimited)
 * @property {string} [req] - Required trait.stat to unlock the cap (e.g., 'stability')
 * @property {string} [statPath] - Full trait.stat path for the requirement
 */

// ─── SynergyController ───────────────────────────────────────────────────────

/**
 * Computes synergy multipliers for actions based on component compositions
 * and multi-entity collaborations.
 *
 * Synergy configuration is loaded from data/synergy.json (separate from actions.json)
 * to decouple synergy definitions from action definitions.
 *
 * @class
 */
class SynergyController {
    /**
     * Creates a new SynergyController.
     *
     * @param {Object} worldStateController - The root state controller (injected)
     * @param {Object} actionRegistry - The full action registry from data/actions.json
     * @param {Object} [synergyRegistry] - The synergy registry from data/synergy.json (optional, loaded internally if not provided)
     */
    constructor(worldStateController, actionRegistry, synergyRegistry, actionSelectController) {
        this.worldStateController = worldStateController;
        this.actionRegistry = actionRegistry || {};
        this.actionSelectController = actionSelectController || null;

        // Use provided synergyRegistry or load from synergy.json
        if (synergyRegistry && Object.keys(synergyRegistry).length > 0) {
            this.synergyRegistry = synergyRegistry;
        } else {
            this.synergyRegistry = DataLoader.loadJsonSafe('data/synergy.json') || {};
        }

        this._synergyCache = new Map(); // actionName → SynergyResult (short-lived)
        this._cacheTtlMs = 5000; // 5-second cache for preview queries

        Logger.info('[SynergyController] Initialized', {
            actionsWithSynergy: this._countActionsWithSynergy()
        });
    }

    // ─── Public API ────────────────────────────────────────────────────────

    /**
     * Computes synergy for an action execution. This is the main entry point
     * called from ActionController before consequences are applied.
     *
     * Evaluates both single-entity component groups and multi-entity
     * collaboration groups, then merges their multipliers multiplicatively.
     * 
     * Component Binding Integration:
     * When gathering synergy members, respects the `roleFilter` from synergy
     * component group definitions. Only components matching the bound role
     * contribute to synergy (enforcing "one body part, one action").
     *
     * Multi-Component Support:
     * If `context.providedComponentIds` is provided (from client selection),
     * those exact components are used for synergy computation instead of
     * auto-gathering from the entity.
     *
     * @param {string} actionName - Name of the action being executed
     * @param {string} entityId - ID of the primary entity
     * @param {Object} [context] - Execution context
     * @param {Array<{componentId: string, role: string}>} [context.providedComponentIds] - Client-provided component list
     * @param {Object} [context.synergyGroups] - Optional multi-entity synergy groups from client
     * @param {Object} [context.synergyResult] - Existing synergy result to extend
     * @param {Object} [context.sourceComponentId] - The source component ID from binding resolution
     * @returns {SynergyResult} Computed synergy result
     */
    computeSynergy(actionName, entityId, context = {}) {
        const config = this._getSynergyConfig(actionName);

        if (!config.enabled) {
            return this._createResult(actionName, 1.0, false, null, []);
        }

        const contributingComponents = [];
        let totalMultiplier = 1.0;

        // Get the source component ID from binding context (for role filtering)
        const sourceComponentId = context?.sourceComponentId;

        // If client provided explicit component IDs, use them directly
        if (context.providedComponentIds && context.providedComponentIds.length > 0) {
            const singleResult = this._evaluateProvidedComponents(
                actionName, entityId, context.providedComponentIds, config
            );
            totalMultiplier *= singleResult.multiplier;
            contributingComponents.push(...singleResult.components);
        } else {
            // 1. Evaluate single-entity component groups (auto-gather mode)
            const singleResult = this._evaluateComponentGroups(
                actionName, entityId, config.componentGroups, contributingComponents, sourceComponentId
            );
            totalMultiplier *= singleResult.multiplier;
        }

        // 2. Evaluate multi-entity groups if enabled
        if (config.multiEntity && context.synergyGroups) {
            for (const groupDef of context.synergyGroups) {
                const multiResult = this._evaluateMultiEntityGroup(
                    actionName, groupDef, config, contributingComponents
                );
                totalMultiplier *= multiResult.multiplier;
            }
        }

        // 3. Apply caps
        const { finalValue, capped, capKey } = this._applyCaps(
            actionName, totalMultiplier, config
        );

        // 4. Build summary
        const summary = this._buildSummary(actionName, totalMultiplier, contributingComponents);

        const result = this._createResult(
            actionName,
            totalMultiplier,
            capped,
            capKey,
            contributingComponents,
            summary
        );

        // Cache for preview queries
        this._synergyCache.set(actionName, {
            result,
            timestamp: Date.now()
        });

        Logger.info('[SynergyController] Synergy computed', {
            actionName,
            multiplier: totalMultiplier,
            capped,
            capKey,
            componentCount: contributingComponents.length,
            mode: context.providedComponentIds ? 'provided' : 'auto-gather'
        });

        return result;
    }

    /**
     * Computes synergy for a multi-entity collaboration group.
     * Used internally by computeSynergy and also available as a standalone
     * method for preview queries.
     *
     * @param {string} actionName - Name of the action
     * @param {Object} groupDef - Group definition from client with primaryEntityId, supportingEntityIds
     * @param {SynergyConfig} config - Action-level synergy config
     * @returns {{ multiplier: number, components: Array }} Result
     */
    computeMultiEntitySynergy(actionName, groupDef, config) {
        return this._evaluateMultiEntityGroup(actionName, groupDef, config, []);
    }

    /**
     * Applies a synergy multiplier to a base value, respecting caps.
     *
     * @param {SynergyResult} synergyResult - The synergy result to apply
     * @param {number} baseValue - The base consequence value
     * @returns {number} Capped final value
     */
    applySynergyToResult(synergyResult, baseValue) {
        const uncapped = baseValue * synergyResult.synergyMultiplier;

        if (synergyResult.capped && synergyResult.capKey !== null) {
            const config = this._getSynergyConfig(synergyResult.actionName);
            const capDef = config.caps[synergyResult.capKey];

            if (capDef && capDef.max !== null && capDef.max !== 'infinite') {
                return Math.min(uncapped, capDef.max);
            }
        }

        return uncapped;
    }

    /**
     * Gets the synergy summary string for a result.
     *
     * @param {SynergyResult} synergyResult - The synergy result
     * @returns {string} Human-readable summary
     */
    getSynergySummary(synergyResult) {
        return synergyResult.summary || this._buildSummary(
            synergyResult.actionName,
            synergyResult.synergyMultiplier,
            synergyResult.contributingComponents
        );
    }

    /**
     * Gets the synergy configuration for an action.
     *
     * @param {string} actionName - Name of the action
     * @returns {SynergyConfig} The synergy config (or default)
     */
    getSynergyConfig(actionName) {
        return this._getSynergyConfig(actionName);
    }

    /**
     * Clears the synergy computation cache.
     */
    clearCache() {
        this._synergyCache.clear();
        Logger.info('[SynergyController] Cache cleared');
    }

    /**
     * Gets all actions that have synergy enabled.
     *
     * @returns {string[]} Array of action names with synergy enabled
     */
    getActionsWithSynergy() {
        return Object.keys(this.synergyRegistry).filter(
            (name) => this.synergyRegistry[name]?.enabled
        );
    }

    // ─── Private: Config ───────────────────────────────────────────────────

    /**
     * Retrieves the synergy configuration for an action.
     * Synergy configs are loaded from the standalone synergy.json registry.
     *
     * @private
     * @param {string} actionName - Name of the action
     * @returns {SynergyConfig}
     */
    _getSynergyConfig(actionName) {
        const synergyDef = this.synergyRegistry[actionName];
        if (!synergyDef) {
            Logger.info(`[SynergyController] No synergy config for action "${actionName}" — using defaults`);
            return DEFAULT_SYNERGY_CONFIG;
        }

        return {
            enabled: synergyDef.enabled ?? false,
            multiEntity: synergyDef.multiEntity ?? false,
            scaling: synergyDef.scaling || 'linear',
            caps: synergyDef.caps || {},
            componentGroups: synergyDef.componentGroups || []
        };
    }

    /**
     * Counts how many actions have synergy enabled.
     *
     * @private
     * @returns {number}
     */
    _countActionsWithSynergy() {
        return Object.keys(this.synergyRegistry).filter(
            (name) => this.synergyRegistry[name]?.enabled
        ).length;
    }

    // ─── Private: Client-Provided Component Evaluation ──────────────────────

    /**
     * Evaluates synergy using client-provided component IDs directly.
     * Filters components through each group definition's criteria.
     *
     * @private
     * @param {string} actionName - Name of the action
     * @param {string} entityId - ID of the entity
     * @param {Array<{componentId: string, role: string}>} providedComponentIds - Client-provided component list
     * @param {SynergyConfig} config - Action-level synergy config
     * @returns {{ multiplier: number, components: Array }}
     */
    _evaluateProvidedComponents(actionName, entityId, providedComponentIds, config) {
        const contributingComponents = [];
        let totalMultiplier = 1.0;

        for (const groupDef of config.componentGroups) {
            // Filter provided components to members matching this group
            const members = this._filterProvidedComponentsForGroup(
                actionName, entityId, providedComponentIds, groupDef
            );

            if (members.length < groupDef.minCount) {
                Logger.info(`[SynergyController] Group "${groupDef.groupType}" for ${actionName} has ${members.length}/${groupDef.minCount} provided members — skipped`, {
                    actionName,
                    groupType: groupDef.groupType,
                    actualCount: members.length,
                    requiredCount: groupDef.minCount,
                    providedCount: providedComponentIds.length
                });
                continue;
            }

            const groupScaling = groupDef.scaling || groupDef._parentScaling || 'linear';
            const multiplier = calculateSynergyMultiplier(
                members.length,
                groupScaling,
                groupDef.baseMultiplier ?? DEFAULT_SYNERGY_BASE_MULTIPLIER,
                groupDef.perUnitBonus ?? 0
            );

            totalMultiplier *= multiplier;

            for (const member of members) {
                contributingComponents.push({
                    componentId: member.componentId,
                    entityId: member.entityId,
                    componentType: member.componentType,
                    contribution: multiplier / members.length,
                    role: member.role
                });
            }

            Logger.info(`[SynergyController] Provided group "${groupDef.groupType}" contributed ${multiplier.toFixed(3)}x`, {
                actionName,
                count: members.length,
                scaling: groupScaling,
                componentIds: members.map((m) => m.componentId)
            });
        }

        // Deduplicate: each component should appear at most once
        const seen = new Set();
        const unique = [];
        for (const c of contributingComponents) {
            if (!seen.has(c.componentId)) {
                seen.add(c.componentId);
                unique.push(c);
            }
        }
        return { multiplier: totalMultiplier, components: unique };
    }

    /**
     * Filters client-provided components for a specific group definition.
     * Checks role filter, component type, and trait requirements.
     *
     * @private
     * @param {string} actionName - Name of the action
     * @param {string} entityId - ID of the entity
     * @param {Array<{componentId: string, role: string}>} providedComponentIds - Client-provided component list
     * @param {ComponentGroupDef} groupDef - Group definition to filter against
     * @returns {Array<{ componentId, entityId, componentType, stats, role }>}
     */
    _filterProvidedComponentsForGroup(actionName, entityId, providedComponentIds, groupDef) {
        const members = [];

        // Get locked component IDs to exclude those locked to other actions
        const lockedComponentIds = this._getLockedComponentIds(actionName);

        for (const { componentId, role } of providedComponentIds) {
            // Exclude components locked to other actions
            if (lockedComponentIds.has(componentId)) continue;

            // Find the component on the entity
            const entity = this.worldStateController.stateEntityController.getEntity(entityId);
            if (!entity) continue;

            const component = entity.components.find((c) => c.id === componentId);
            if (!component) continue;

            const stats = this.worldStateController.componentController.getComponentStats(componentId);
            if (!stats) continue;

            // Apply role filter from group definition
            if (groupDef.roleFilter) {
                if (!this._matchesRoleFilter(stats, groupDef.roleFilter, component)) {
                    continue;
                }
            }

            // Apply component type filter if specified
            if (groupDef.componentType && component.type !== groupDef.componentType) {
                continue;
            }

            // Apply group-type-specific filters
            let passesFilter = true;
            switch (groupDef.groupType) {
                case 'movementComponents':
                    passesFilter = stats.Movement && Object.keys(stats.Movement).length > 0;
                    break;
                case 'anyPhysical':
                    passesFilter = stats.Physical && Object.keys(stats.Physical).length > 0;
                    break;
                case 'sameComponentType':
                    // Already filtered by componentType above
                    passesFilter = true;
                    break;
                case 'anyComponent':
                default:
                    passesFilter = true;
                    break;
            }

            if (!passesFilter) continue;

            members.push({
                componentId,
                entityId,
                componentType: component.type,
                stats,
                role
            });
        }

        return members;
    }

    /**
     * Checks if a component's stats match a role filter.
     *
     * @private
     * @param {Object} stats - Component stats object
     * @param {string} roleFilter - Role filter ('source', 'target', 'spatial', 'self_target')
     * @param {Object} [component] - Optional component object for additional checks
     * @returns {boolean}
     */
    _matchesRoleFilter(stats, roleFilter, component) {
        switch (roleFilter) {
            case 'source':
            case 'spatial':
                // Source/spatial: must have Movement traits OR Physical traits (for attack actions)
                // Movement = movement-based actions (move, dash)
                // Physical = attack-based actions (punch) where strength provides power
                return (stats.Movement && Object.keys(stats.Movement).length > 0) ||
                       (stats.Physical && Object.keys(stats.Physical).length > 0);
            case 'self_target':
                // Self-target: must have Physical traits
                return stats.Physical && Object.keys(stats.Physical).length > 0;
            case 'target':
                // Target: any component can be a target
                return true;
            default:
                return true;
        }
    }

    // ─── Private: Single-Entity Evaluation ─────────────────────────────────

    /**
     * Evaluates all component groups for a single entity (auto-gather mode).
     * Respects roleFilter from synergy component group definitions.
     *
     * @private
     * @param {string} actionName - Name of the action
     * @param {string} entityId - ID of the entity
     * @param {Array<ComponentGroupDef>} groups - Component group definitions
     * @param {Array} contributingComponents - Accumulator array (mutated in place)
     * @param {string} [sourceComponentId] - Optional source component from binding resolution
     * @returns {{ multiplier: number, components: Array }}
     */
    _evaluateComponentGroups(actionName, entityId, groups, contributingComponents, sourceComponentId) {
        let totalMultiplier = 1.0;

        for (const groupDef of groups) {
            const members = this._gatherGroupMembers(actionName, entityId, groupDef, sourceComponentId);

            if (members.length < groupDef.minCount) {
                Logger.info(`[SynergyController] Group "${groupDef.groupType}" for ${actionName} has ${members.length}/${groupDef.minCount} members — skipped`, {
                    actionName,
                    groupType: groupDef.groupType,
                    actualCount: members.length,
                    requiredCount: groupDef.minCount
                });
                continue;
            }

            const groupScaling = groupDef.scaling || groupDef._parentScaling || 'linear';
            const multiplier = calculateSynergyMultiplier(
                members.length,
                groupScaling,
                groupDef.baseMultiplier ?? DEFAULT_SYNERGY_BASE_MULTIPLIER,
                groupDef.perUnitBonus ?? 0
            );

            totalMultiplier *= multiplier;

            for (const member of members) {
                contributingComponents.push({
                    componentId: member.componentId,
                    entityId: member.entityId,
                    componentType: member.componentType,
                    contribution: multiplier / members.length
                });
            }

            Logger.info(`[SynergyController] Group "${groupDef.groupType}" contributed ${multiplier.toFixed(3)}x`, {
                count: members.length,
                scaling: groupScaling
            });
        }

        // Deduplicate: each component should appear at most once
        const seen = new Set();
        const unique = [];
        for (const c of contributingComponents) {
            if (!seen.has(c.componentId)) {
                seen.add(c.componentId);
                unique.push(c);
            }
        }
        return { multiplier: totalMultiplier, components: unique };
    }

    /**
     * Gathers group members based on the group type definition.
     * Respects roleFilter: only components matching the bound role contribute.
     *
     * @private
     * @param {string} actionName - Name of the action
     * @param {string} entityId - ID of the entity
     * @param {ComponentGroupDef} groupDef - Group definition
     * @param {string} [sourceComponentId] - Optional source component from binding resolution
     * @returns {Array<{ componentId, entityId, componentType, stats }>}
     */
    _gatherGroupMembers(actionName, entityId, groupDef, sourceComponentId) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[SynergyController] Entity "${entityId}" not found for synergy evaluation`);
            return [];
        }

        // If a roleFilter is defined, only include components matching that role
        const roleFilter = groupDef.roleFilter;

        // Get locked component IDs (exclude those locked to the current action)
        const lockedComponentIds = this._getLockedComponentIds(actionName);

        switch (groupDef.groupType) {
            case 'sameComponentType':
                return this._gatherSameComponentType(entity, groupDef, roleFilter, lockedComponentIds);

            case 'movementComponents':
                return this._gatherMovementComponents(entity, groupDef, roleFilter, lockedComponentIds);

            case 'anyPhysical':
                return this._gatherAnyPhysicalComponent(entity, groupDef, roleFilter, lockedComponentIds);

            case 'anyComponent':
            default:
                return this._gatherAllComponents(entity, groupDef, roleFilter, lockedComponentIds);
        }
    }

    /**
     * Gathers all components of the same type on an entity.
     * Respects roleFilter: only components matching the bound role contribute.
     *
     * @private
     * @param {Object} entity - The entity object
     * @param {ComponentGroupDef} groupDef - Group definition
     * @param {string} [roleFilter] - Optional role filter from synergy config
     * @returns {Array}
     */
    _gatherSameComponentType(entity, groupDef, roleFilter, lockedComponentIds) {
        // If groupDef specifies a particular component type, filter to that
        const typeFilter = groupDef.componentType;
        const members = entity.components
            .filter((c) => {
                // Exclude components locked to other actions
                if (lockedComponentIds.has(c.id)) return false;

                // Filter by component type if specified
                if (typeFilter && c.type !== typeFilter) return false;
                
                // Filter by role if specified
                if (roleFilter) {
                    const stats = this.worldStateController.componentController.getComponentStats(c.id);
                    if (!stats) return false;

                    // Check if component matches the role filter
                    if (roleFilter === 'source' || roleFilter === 'spatial') {
                        // Source/spatial: must have Movement traits (movement actions) OR Physical traits (attack actions like punch)
                        return (stats.Movement && Object.keys(stats.Movement).length > 0) ||
                               (stats.Physical && Object.keys(stats.Physical).length > 0);
                    }
                    if (roleFilter === 'self_target') {
                        // Self-target: must have Physical traits
                        return stats.Physical && Object.keys(stats.Physical).length > 0;
                    }
                    if (roleFilter === 'target') {
                        // Target: any component can be a target
                        return true;
                    }
                }
                return true;
            })
            .map((c) => ({
                componentId: c.id,
                entityId: entity.id,
                componentType: c.type,
                stats: this.worldStateController.componentController.getComponentStats(c.id)
            }));
        return members;
    }

    /**
     * Gathers all components with Movement traits.
     * Respects roleFilter: only components matching the bound role contribute.
     *
     * @private
     * @param {Object} entity - The entity object
     * @param {ComponentGroupDef} groupDef - Group definition
     * @param {string} [roleFilter] - Optional role filter from synergy config
     * @returns {Array}
     */
    _gatherMovementComponents(entity, groupDef, roleFilter, lockedComponentIds) {
        return entity.components
            .filter((c) => {
                // Exclude components locked to other actions
                if (lockedComponentIds.has(c.id)) return false;

                const stats = this.worldStateController.componentController.getComponentStats(c.id);
                // Must have Movement traits
                if (!stats || !stats.Movement || Object.keys(stats.Movement).length === 0) return false;
                
                // If roleFilter is specified, enforce it
                if (roleFilter && roleFilter !== 'source' && roleFilter !== 'spatial') {
                    return false;
                }
                return true;
            })
            .map((c) => ({
                componentId: c.id,
                entityId: entity.id,
                componentType: c.type,
                stats: this.worldStateController.componentController.getComponentStats(c.id)
            }));
    }

    /**
     * Gathers all components with Physical traits.
     * Respects roleFilter: only components matching the bound role contribute.
     *
     * @private
     * @param {Object} entity - The entity object
     * @param {ComponentGroupDef} groupDef - Group definition
     * @param {string} [roleFilter] - Optional role filter from synergy config
     * @returns {Array}
     */
    _gatherAnyPhysicalComponent(entity, groupDef, roleFilter, lockedComponentIds) {
        return entity.components
            .filter((c) => {
                // Exclude components locked to other actions
                if (lockedComponentIds.has(c.id)) return false;

                const stats = this.worldStateController.componentController.getComponentStats(c.id);
                // Must have Physical traits
                if (!stats || !stats.Physical || Object.keys(stats.Physical).length === 0) return false;
                
                // If roleFilter is specified, enforce it
                if (roleFilter && roleFilter !== 'self_target' && roleFilter !== 'source') {
                    return false;
                }
                return true;
            })
            .map((c) => ({
                componentId: c.id,
                entityId: entity.id,
                componentType: c.type,
                stats: this.worldStateController.componentController.getComponentStats(c.id)
            }));
    }

    /**
     * Gathers all components on an entity.
     * Respects roleFilter: only components matching the bound role contribute.
     *
     * @private
     * @param {Object} entity - The entity object
     * @param {ComponentGroupDef} groupDef - Group definition
     * @param {string} [roleFilter] - Optional role filter from synergy config
     * @returns {Array}
     */
    _gatherAllComponents(entity, groupDef, roleFilter, lockedComponentIds) {
        if (!roleFilter) {
            // No role filter: return all components (excluding locked)
            return entity.components
                .filter((c) => !lockedComponentIds.has(c.id))
                .map((c) => ({
                componentId: c.id,
                entityId: entity.id,
                componentType: c.type,
                stats: this.worldStateController.componentController.getComponentStats(c.id)
            }));
        }

        // Filter by role (and exclude locked components)
        return entity.components
            .filter((c) => {
                // Exclude components locked to other actions
                if (lockedComponentIds.has(c.id)) return false;

                const stats = this.worldStateController.componentController.getComponentStats(c.id);
                if (!stats) return false;

                if (roleFilter === 'source' || roleFilter === 'spatial') {
                    return stats.Movement && Object.keys(stats.Movement).length > 0;
                }
                if (roleFilter === 'self_target') {
                    return stats.Physical && Object.keys(stats.Physical).length > 0;
                }
                if (roleFilter === 'target') {
                    return true;
                }
                return true;
            })
            .map((c) => ({
                componentId: c.id,
                entityId: entity.id,
                componentType: c.type,
                stats: this.worldStateController.componentController.getComponentStats(c.id)
            }));
    }

    // ─── Private: Multi-Entity Evaluation ──────────────────────────────────

    /**
     * Evaluates a multi-entity collaboration group.
     *
     * @private
     * @param {string} actionName - Name of the action
     * @param {Object} groupDef - Group definition from client
     * @param {SynergyConfig} config - Action-level synergy config
     * @param {Array} contributingComponents - Accumulator array
     * @returns {{ multiplier: number, components: Array }}
     */
    _evaluateMultiEntityGroup(actionName, groupDef, config, contributingComponents) {
        const primaryEntityId = groupDef.primaryEntityId || groupDef.entityId;
        const supportingEntityIds = groupDef.supportingEntityIds || groupDef.supportingEntities || [];
        const primaryComponentId = groupDef.primaryComponentId;
        const supportingComponentIds = groupDef.supportingComponentIds || [];

        // Gather all entities (primary + supporting)
        const allEntities = [primaryEntityId, ...supportingEntityIds].filter(Boolean);
        if (allEntities.length < 2) {
                Logger.info(`[SynergyController] Multi-entity group for "${actionName}" has fewer than 2 entities — skipped`);
            return { multiplier: 1.0, components: contributingComponents };
        }

        // Gather all relevant components across entities
        const allMembers = [];

        // Primary entity component
        const primaryEntity = this.worldStateController.stateEntityController.getEntity(primaryEntityId);
        if (primaryEntity) {
            const primaryComp = primaryEntity.components.find((c) => c.id === primaryComponentId) ||
                                primaryEntity.components[0];
            if (primaryComp) {
                allMembers.push({
                    componentId: primaryComp.id,
                    entityId: primaryEntity.id,
                    componentType: primaryComp.type,
                    stats: this.worldStateController.componentController.getComponentStats(primaryComp.id),
                    isPrimary: true
                });
            }
        }

        // Supporting entities
        for (const supId of supportingEntityIds) {
            const supEntity = this.worldStateController.stateEntityController.getEntity(supId);
            if (!supEntity) {
                Logger.warn(`[SynergyController] Supporting entity "${supId}" not found for synergy`);
                continue;
            }

            // Find specific supporting component if specified
            const supCompId = supportingComponentIds.find((id) => id === supId) ||
                              supEntity.components[0]?.id;
            const supComp = supEntity.components.find((c) => c.id === supCompId) ||
                            supEntity.components[0];

            if (supComp) {
                allMembers.push({
                    componentId: supComp.id,
                    entityId: supEntity.id,
                    componentType: supComp.type,
                    stats: this.worldStateController.componentController.getComponentStats(supComp.id),
                    isPrimary: false
                });
            }
        }

        if (allMembers.length < 2) {
            Logger.info(`[SynergyController] Multi-entity group for "${actionName}" has fewer than 2 valid components — skipped`);
            return { multiplier: 1.0, components: contributingComponents };
        }

        // Calculate synergy multiplier
        const scaling = config.scaling || 'linear';
        const baseMultiplier = 1.0;
        const perUnitBonus = groupDef.perUnitBonus || config.perUnitBonus || 0.1;

        const multiplier = calculateSynergyMultiplier(
            allMembers.length,
            scaling,
            baseMultiplier,
            perUnitBonus
        );

        for (const member of allMembers) {
            contributingComponents.push({
                componentId: member.componentId,
                entityId: member.entityId,
                componentType: member.componentType,
                contribution: multiplier / allMembers.length,
                isPrimary: member.isPrimary
            });
        }

        Logger.info('[SynergyController] Multi-entity synergy computed', {
            actionName,
            entityCount: allMembers.length,
            multiplier
        });

        return { multiplier, components: contributingComponents };
    }

    // ─── Private: Caps ─────────────────────────────────────────────────────

    /**
     * Applies caps to the synergy multiplier for an action.
     *
     * @private
     * @param {string} actionName - Name of the action
     * @param {number} multiplier - Computed multiplier
     * @param {SynergyConfig} config - Synergy configuration
     * @returns {{ finalValue: number, capped: boolean, capKey: string|null }}
     */
    _applyCaps(actionName, multiplier, config) {
        let capped = false;
        let capKey = null;

        // Check each cap definition
        for (const [capKeyCandidate, capDef] of Object.entries(config.caps || {})) {
            if (capDef.max === null || capDef.max === 'infinite') {
                continue; // No cap or infinite — skip
            }

            if (typeof capDef.max === 'number' && multiplier > capDef.max) {
                capped = true;
                capKey = capKeyCandidate;
                Logger.info(`[SynergyController] Cap applied: ${capKeyCandidate} = ${capDef.max}`, {
                    actionName,
                    originalMultiplier: multiplier,
                    cappedValue: capDef.max
                });
            }
        }

        // If any cap was applied, clamp to the lowest cap value
        if (capped) {
            const lowestCap = Math.min(
                ...Object.entries(config.caps || {})
                    .filter(([, capDef]) => typeof capDef.max === 'number')
                    .map(([, capDef]) => capDef.max)
            );
            return { finalValue: lowestCap, capped: true, capKey };
        }

        return { finalValue: multiplier, capped: false, capKey: null };
    }

    // ─── Private: Result Builders ──────────────────────────────────────────

    /**
     * Creates a SynergyResult object.
     *
     * @private
     * @param {string} actionName - Action name
     * @param {number} synergyMultiplier - Computed multiplier
     * @param {boolean} capped - Whether capped
     * @param {string|null} capKey - Cap that was applied
     * @param {Array} contributingComponents - List of contributing components
     * @param {string} [summary] - Optional summary string
     * @returns {SynergyResult}
     */
    _createResult(actionName, synergyMultiplier, capped, capKey, contributingComponents, summary) {
        return {
            actionName,
            baseValue: 1.0,
            synergyMultiplier: Math.round(synergyMultiplier * 1000) / 1000, // Round to 3 decimals
            finalValue: Math.round(synergyMultiplier * 1000) / 1000,
            capped,
            capKey,
            contributingComponents,
            summary: summary || this._buildSummary(actionName, synergyMultiplier, contributingComponents)
        };
    }

    /**
     * Builds a human-readable summary string.
     *
     * @private
     * @param {string} actionName - Action name
     * @param {number} multiplier - Synergy multiplier
     * @param {Array} contributingComponents - Contributing components
     * @returns {string}
     */
    _buildSummary(actionName, multiplier, contributingComponents) {
        const entityIds = [...new Set(contributingComponents.map((c) => c.entityId))];
        const entityCount = entityIds.length;
        const componentCount = contributingComponents.length;

        let parts = [`Synergy: ${multiplier.toFixed(2)}x`];

        if (entityCount > 1) {
            parts.push(`${entityCount} entities`);
        }

        parts.push(`${componentCount} component${componentCount !== 1 ? 's' : ''}`);

        if (contributingComponents.some((c) => c.isPrimary)) {
            parts.push('(primary collaboration)');
        }

        return parts.join(', ');
    }

    /**
     * Gets locked component IDs, excluding those locked to the current action.
     * @private
     * @param {string} actionName - The current action name.
     * @returns {Set<string>} Set of locked component IDs to exclude.
     */
    _getLockedComponentIds(actionName) {
        if (this.actionSelectController) {
            return this.actionSelectController.getLockedComponentIds(actionName);
        }
        return new Set();
    }
}

export default SynergyController;
