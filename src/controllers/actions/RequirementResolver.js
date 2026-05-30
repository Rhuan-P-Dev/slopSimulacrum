/**
 * RequirementResolver — Resolves action requirements to component stats.
 * Single Responsibility: Check if entity/component meets action requirements and resolve values.
 *
 * Extracted from ActionController to adhere to the Single Responsibility Principle.
 *
 * @module RequirementResolver
 */

import Logger from '../../utils/Logger.js';
import { checkRequirements, checkRequirementsForComponent } from '../../utils/RequirementChecker.js';

class RequirementResolver {
    /**
     * @param {WorldStateController} worldStateController - The root state controller.
     */
    constructor(worldStateController) {
        this.worldStateController = worldStateController;
    }

    /**
     * Checks entity-level requirements for an action.
     * Requirements can be satisfied by multiple components.
     *
     * @param {Array<Object>} requirements - Array of requirement objects.
     * @param {string} entityId - The entity ID to check.
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
     * If the componentId starts with "equipped-", resolves traits directly
     * from the equipped item's definition in inventoryItems.json instead of
     * from component stats. This ensures equipped items' traits (e.g., knife's
     * Physical.sharpness) are used for requirement validation.
     *
     * When an equipped item's traits are used for a host component, the
     * fulfillingComponents map stores the equipped item's itemId (not the host
     * componentId) so that consequence handlers can correctly route stat
     * modifications (e.g., sharpness drain) to the equipped item.
     *
     * @param {Array<Object>} requirements - Array of requirement objects.
     * @param {string} entityId - The entity ID (used for error logging).
     * @param {string} componentId - The specific component to evaluate.
     * @returns {{ passed: boolean, requirementValues?: Object, fulfillingComponents?: Object, error?: {code: string, details: Object} }}
     */
    checkComponentRequirements(requirements, entityId, componentId) {
        let componentStats;
        let resolvingTargetId = componentId;

        // If this is an equipped item (prefixed "equipped-"), resolve traits directly from the item definition
        if (componentId.startsWith('equipped-')) {
            const equippedData = this._findEquippedItemData(componentId, entityId);
            if (!equippedData) {
                return { passed: false, error: { code: 'EQUIPPED_ITEM_NOT_FOUND', details: { componentId } } };
            }
            componentStats = equippedData.traits;
            // FIX (Round 3): Use the equipped item's itemId as resolvingTargetId so consequences
            // (e.g., sharpness drain) route to the item's per-instance stats store, not the prefixed ID.
            resolvingTargetId = equippedData.itemId;
        } else {
            // Check if this host component has an equipped item — if so, use the item's stats
            const equipped = this._resolveEquippedItemForHostComponent(componentId, entityId);
            if (equipped) {
                componentStats = equipped.traits;
                // Use the equipped item's itemId as the resolving target so consequences
                // (e.g., sharpness drain) apply to the item, not the host component
                resolvingTargetId = equipped.itemId;
            } else {
                componentStats = this.worldStateController.getComponentStats(componentId);
                if (!componentStats) {
                    return { passed: false, error: { code: 'COMPONENT_NOT_FOUND', details: { componentId } } };
                }
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
     * If the componentId starts with "equipped-", resolves traits directly
     * from the equipped item's definition in inventoryItems.json.
     *
     * @param {string} componentId - The component ID.
     * @returns {Object|null} Map of requirement values, or null if component not found.
     */
    resolveRequirementValues(componentId) {
        let stats;

        // If this is an equipped item (prefixed "equipped-"), resolve traits directly from the item definition
        if (componentId.startsWith('equipped-')) {
            const equippedData = this._findEquippedItemData(componentId, null);
            if (!equippedData) return null;
            stats = equippedData.traits;
        } else {
            // Check if this host component has an equipped item — if so, use the item's stats directly
            const equippedTraits = this._resolveEquippedTraitsForHostComponent(componentId, null);
            if (equippedTraits) {
                stats = equippedTraits;
            } else {
                stats = this.worldStateController.getComponentStats(componentId);
                if (!stats) return null;
            }
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
     * Checks if a host component (non-prefixed ID) has an equipped item and returns
     * both the item's traits AND its itemId.
     *
     * This method solves the core issue where the frontend sends the host component ID
     * (e.g., "droidHand-xyz") for an equipped item action, instead of an "equipped-" prefixed ID.
     * The capability controller stores entries with `componentId: equipped.componentId` (the host),
     * so the frontend's `attackerComponentId` resolves to the host component, not the item itself.
     *
     * @param {string} componentId - The host component ID (e.g., "droidHand-xyz").
     * @param {string|null} entityId - Entity ID for error context logging.
     * @returns {{ traits: Object, itemId: string }|null} Equipped item traits and itemId, or null if no item equipped.
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

        // Build traits as a stats-like object (shallow copy per trait to prevent reference sharing)
        const traits = {};
        for (const [traitId, traitData] of Object.entries(itemDef.traits)) {
            traits[traitId] = { ...traitData };
        }

        // Return both traits and the actual itemId used by EquippedItemStatsController
        return { traits, itemId: equipped.itemId };
    }

    /**
     * Legacy alias for backwards compatibility.
     * @deprecated Use _resolveEquippedItemForHostComponent() instead — it returns both traits and itemId.
     * @private
     */
    _resolveEquippedTraitsForHostComponent(componentId, entityId) {
        const result = this._resolveEquippedItemForHostComponent(componentId, entityId);
        if (!result) return null;
        return result.traits;
    }

    /**
     * Finds an equipped item by its componentId and returns both its traits AND itemId.
     * Looks up the equipped item by componentId, then reads traits from inventoryItems.json.
     *
     * This method handles "equipped-" prefixed IDs (e.g., "equipped-abc-knife").
     * It returns both traits and itemId so that consequence handlers can correctly
     * route stat modifications (e.g., sharpness drain) to the equipped item's per-instance stats.
     *
     * @param {string} componentId - The equipped component ID (e.g., "equipped-abc123-knife").
     * @param {string|null} entityId - Entity ID for error context logging.
     * @returns {{ traits: Object, itemId: string }|null} Item traits and itemId, or null if not found.
     * @private
     */
    _findEquippedItemData(componentId, entityId) {
        const allEquipped = this.worldStateController.getAllEquippedItems() || [];

        // Find matching equipped item by componentId
        let equippedItem = allEquipped.find(eq => eq.componentId === componentId);

        if (!equippedItem) {
            // Fallback: parse itemId and itemType from "equipped-<itemId>-<itemType>" pattern
            const parts = componentId.split('-');
            if (parts.length >= 3) {
                const itemType = parts[parts.length - 1];
                const itemId = parts.slice(1, -1).join('-');
                equippedItem = allEquipped.find(eq => eq.itemId === itemId && eq.itemType === itemType);
            }
        }

        if (!equippedItem) {
            if (entityId) {
                Logger.warn(`[RequirementResolver] Equipped item "${componentId}" not found for entity "${entityId}".`);
            }
            return null;
        }

        // Look up item definition from registry
        const itemRegistry = this.worldStateController.getItemRegistry() || {};
        const itemDef = itemRegistry[equippedItem.itemType];
        if (!itemDef?.traits) {
            if (entityId) {
                Logger.warn(`[RequirementResolver] Item type "${equippedItem.itemType}" has no traits defined.`);
            }
            return null;
        }

        // Build traits as a stats-like object (shallow copy per trait to prevent reference sharing)
        const traits = {};
        for (const [traitId, traitData] of Object.entries(itemDef.traits)) {
            traits[traitId] = { ...traitData };
        }

        // Return both traits and the actual itemId used by EquippedItemStatsController
        return { traits, itemId: equippedItem.itemId };
    }

    /**
     * Resolves traits from an equipped item's definition (legacy alias).
     * Delegates to _findEquippedItemData for backwards compatibility.
     *
     * @deprecated Use _findEquippedItemData() instead — it returns both traits and itemId.
     * @private
     */
    _resolveEquippedItemTraits(componentId, entityId) {
        const result = this._findEquippedItemData(componentId, entityId);
        if (!result) return null;
        return result.traits;
    }
}

export default RequirementResolver;