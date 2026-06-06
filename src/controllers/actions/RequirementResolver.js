/**
 * RequirementResolver — Resolves action requirements to component stats.
 * Single Responsibility: Check if entity/component meets action requirements and resolve values.
 *
 * Extracted from ActionController to adhere to the Single Responsibility Principle.
 *
 * Supports typed IDs: comp-... for components, eq-... for equipped items.
 *
 * @module RequirementResolver
 */

import Logger from '../../utils/Logger.js';
import { checkRequirements, checkRequirementsForComponent } from '../../utils/RequirementChecker.js';
import IdResolver from '../../utils/IdResolver.js';

class RequirementResolver {
    /**
     * @param {WorldStateController} worldStateController - The root state controller.
     * @param {EquippedItemStatsController} [equippedItemStats] - The equipped item stats manager (for mutable stats).
     */
    constructor(worldStateController, equippedItemStats) {
        this.worldStateController = worldStateController;
        this.equippedItemStats = equippedItemStats || null;
    }

    /**
     * Checks entity-level requirements for an action.
     * Requirements can be satisfied by multiple components.
     *
     * @param {Array<Object>} requirements - Array of requirement objects.
     * @param {string} entityId - The entity ID to check (typed ent-... or legacy UUID).
     * @returns {{ passed: boolean, requirementValues?: Object, fulfillingComponents?: Object, componentId?: string, error?: {code: string, details: Object} }}
     */
    checkEntityRequirements(requirements, entityId) {
        const entity = this.worldStateController.getEntity(entityId);
        if (!entity) {
            return {
                passed: false,
                error: { code: 'ENTITY_NOT_FOUND', details: { entityId } }
            };
        }

        return checkRequirements(requirements, entity, (compId) =>
            this.worldStateController.getComponentStats(compId)
        );
    }

    /**
     * Checks if a specific component meets ALL of the action's requirements.
     *
     * Supports typed IDs: eq-... (equipped items) and comp-... (components).
     * For equipped items, resolves traits from EquippedItemStatsController's mutable stats.
     *
     * @param {Array<Object>} requirements - Array of requirement objects.
     * @param {string} entityId - The entity ID (used for error logging).
     * @param {string} componentId - The typed component or equipped item ID.
     * @returns {{ passed: boolean, requirementValues?: Object, fulfillingComponents?: Object, error?: {code: string, details: Object} }}
     */
    checkComponentRequirements(requirements, entityId, componentId) {
        let componentStats;
        let resolvingTargetId = componentId;

        // If this is an equipped item (typed eq-...), resolve traits directly from the item's mutable stats
        if (IdResolver.isEquippedId(componentId)) {
            const equippedData = this._findEquippedItemByEqId(componentId, entityId);
            if (!equippedData) {
                return { passed: false, error: { code: 'EQUIPPED_ITEM_NOT_FOUND', details: { componentId } } };
            }
            const eqId = componentId;
            if (this.equippedItemStats?.hasStats(eqId)) {
                const currentStats = this.equippedItemStats.getStats(eqId);
                if (currentStats) {
                    componentStats = currentStats;
                } else {
                    componentStats = equippedData.traits;
                }
            } else {
                componentStats = equippedData.traits;
            }
            resolvingTargetId = eqId;
        } else if (IdResolver.isCompId(componentId)) {
            // Check if this host component has an equipped item
            const equipped = this._resolveEquippedItemForHostComponent(componentId, entityId);
            if (equipped) {
                const eqId = equipped.eqId;
                // MERGE equipped item traits with host component stats instead of replacing
                // This ensures host stats like Physical.strength are preserved alongside item traits
                const hostStats = this.worldStateController.getComponentStats(componentId);
                const baseTraits = this.equippedItemStats?.hasStats(eqId)
                    ? this.equippedItemStats.getStats(eqId)
                    : equipped.traits;
                const baseTraitsToUse = baseTraits || equipped.traits;

                // Start with host stats (e.g., droidHand has Physical.strength: 25)
                const mergedStats = {};
                if (hostStats) {
                    for (const [trait, data] of Object.entries(hostStats)) {
                        mergedStats[trait] = { ...data };
                    }
                }
                // Overlay equipped item traits (knife has Physical.sharpness: 50)
                for (const [trait, data] of Object.entries(baseTraitsToUse)) {
                    if (!mergedStats[trait]) {
                        mergedStats[trait] = { ...data };
                    } else {
                        for (const [stat, value] of Object.entries(data)) {
                            if (mergedStats[trait][stat] === undefined) {
                                mergedStats[trait][stat] = value;
                            }
                        }
                    }
                }
                componentStats = mergedStats;
                resolvingTargetId = eqId;
            } else {
                componentStats = this.worldStateController.getComponentStats(componentId);
                if (!componentStats) {
                    return { passed: false, error: { code: 'COMPONENT_NOT_FOUND', details: { componentId } } };
                }
            }
        } else {
            // Legacy raw UUID — look up component stats directly
            componentStats = this.worldStateController.getComponentStats(componentId);
            if (!componentStats) {
                return { passed: false, error: { code: 'COMPONENT_NOT_FOUND', details: { componentId } } };
            }
        }

        const result = checkRequirementsForComponent(requirements, componentStats);
        // Store the resolved target ID in fulfillingComponents for each requirement
        if (result.passed) {
            for (const key of Object.keys(result.fulfillingComponents)) {
                result.fulfillingComponents[key] = resolvingTargetId;
            }
        }
        return result;
    }

    /**
     * Resolves requirement values from a component's stats.
     * Builds a map of "trait.stat" → numeric value.
     *
     * Supports typed IDs: eq-... (equipped items), comp-... (components).
     *
     * @param {string} componentId - The typed component or equipped item ID.
     * @returns {Object|null} Map of requirement values, or null if component not found.
     */
    resolveRequirementValues(componentId) {
        let stats;

        if (IdResolver.isEquippedId(componentId)) {
            const equippedData = this._findEquippedItemByEqId(componentId, null);
            if (!equippedData) return null;
            if (this.equippedItemStats?.hasStats(componentId)) {
                const currentStats = this.equippedItemStats.getStats(componentId);
                if (currentStats) {
                    stats = currentStats;
                } else {
                    stats = equippedData.traits;
                }
            } else {
                stats = equippedData.traits;
            }
        } else if (IdResolver.isCompId(componentId)) {
            const equipped = this._resolveEquippedItemForHostComponent(componentId, null);
            if (equipped) {
                // MERGE equipped item traits with host component stats instead of replacing
                const hostStats = this.worldStateController.getComponentStats(componentId);
                const baseTraits = this.equippedItemStats?.hasStats(equipped.eqId)
                    ? this.equippedItemStats.getStats(equipped.eqId)
                    : equipped.traits;
                const baseTraitsToUse = baseTraits || equipped.traits;

                const mergedStats = {};
                if (hostStats) {
                    for (const [trait, data] of Object.entries(hostStats)) {
                        mergedStats[trait] = { ...data };
                    }
                }
                for (const [trait, data] of Object.entries(baseTraitsToUse)) {
                    if (!mergedStats[trait]) {
                        mergedStats[trait] = { ...data };
                    } else {
                        for (const [stat, value] of Object.entries(data)) {
                            if (mergedStats[trait][stat] === undefined) {
                                mergedStats[trait][stat] = value;
                            }
                        }
                    }
                }
                stats = mergedStats;
            } else {
                stats = this.worldStateController.getComponentStats(componentId);
                if (!stats) return null;
            }
        } else {
            stats = this.worldStateController.getComponentStats(componentId);
            if (!stats) return null;
        }

        const values = {};
        for (const [traitId, traitData] of Object.entries(stats)) {
            for (const [statName, statValue] of Object.entries(traitData)) {
                if (typeof statValue === 'number') {
                    values[`${traitId}.${statName}`] = statValue;
                }
            }
        }
        return values;
    }

    /**
     * Checks if a host component (typed comp-... ID) has an equipped item and returns
     * both the item's traits AND its eqId.
     *
     * @param {string} componentId - The typed component ID (e.g., "comp-abc123...").
     * @param {string|null} entityId - Entity ID for error context logging.
     * @returns {{ traits: Object, eqId: string }|null} Equipped item traits and eqId, or null if no item equipped.
     * @private
     */
    _resolveEquippedItemForHostComponent(componentId, entityId) {
        const allEquipped = this.worldStateController.getAllEquippedItems() || [];

        // Find equipped item hosted on this component by matching eq.componentId === componentId
        const equipped = allEquipped.find(eq => eq.componentId === componentId);
        if (!equipped) return null;

        // Look up item definition from registry
        const itemRegistry = this.worldStateController.getItemRegistry() || {};
        const itemDef = itemRegistry[equipped.itemType];
        if (!itemDef?.traits) {
            if (entityId) {
                Logger.warn(`[RequirementResolver] Item type "${equipped.itemType}" has no traits defined.`);
            }
            return null;
        }

        // Build traits as a stats-like object (shallow copy per trait)
        const traits = {};
        for (const [traitId, traitData] of Object.entries(itemDef.traits)) {
            traits[traitId] = { ...traitData };
        }

        return { traits, eqId: equipped.eqId };
    }

    /**
     * Finds an equipped item by its typed eqId and returns both its traits and eqId.
     *
     * @param {string} eqId - The typed equipped item ID (eq-${uuid}).
     * @param {string|null} entityId - Entity ID for error context logging.
     * @returns {{ traits: Object, eqId: string }|null} Item traits and eqId, or null if not found.
     * @private
     */
    _findEquippedItemByEqId(eqId, entityId) {
        const allEquipped = this.worldStateController.getAllEquippedItems() || [];

        const equippedItem = allEquipped.find(eq => eq.eqId === eqId);

        if (!equippedItem) {
            if (entityId) {
                Logger.warn(`[RequirementResolver] Equipped item "${eqId}" not found for entity "${entityId}".`);
            }
            return null;
        }

        const itemRegistry = this.worldStateController.getItemRegistry() || {};
        const itemDef = itemRegistry[equippedItem.itemType];
        if (!itemDef?.traits) {
            if (entityId) {
                Logger.warn(`[RequirementResolver] Item type "${equippedItem.itemType}" has no traits defined.`);
            }
            return null;
        }

        const traits = {};
        for (const [traitId, traitData] of Object.entries(itemDef.traits)) {
            traits[traitId] = { ...traitData };
        }

        return { traits, eqId: equippedItem.eqId };
    }
}

export default RequirementResolver;