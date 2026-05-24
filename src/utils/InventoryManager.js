/**
 * InventoryManager handles inventory operations for entities.
 * Manages item ownership, volume constraints, and item movements.
 *
 * @module InventoryManager
 */
import DataLoader from './DataLoader.js';
import Logger from './Logger.js';

class InventoryManager {
    constructor() {
        /**
         * Item type definitions loaded from data/inventoryItems.json
         * Format: { [itemType]: { name, description, volume, traits } }
         * @type {Object}
         */
        this._itemDefinitions = DataLoader.loadJsonSafe('data/inventoryItems.json', {});

        Logger.info(`InventoryManager initialized with ${Object.keys(this._itemDefinitions).length} item types`);

        /** @private */
        this._nextId = 1;

        /**
         * Inventory state: { [entityId]: { [itemId]: itemInstance } }
         * Each itemInstance: { id, type, name, volume, traits, hostComponentId }
         * @type {Object}
         */
        this._inventory = {};
    }

    /**
     * Gets the item type definitions.
     * Returns a defensive deep copy.
     * @returns {Object} Item definitions.
     */
    getItemDefinitions() {
        return structuredClone(this._itemDefinitions);
    }

    /**
     * Ensures the entity has an inventory entry.
     * @param {string} entityId - The entity ID.
     * @returns {void}
     * @private
     */
    _ensureEntityInventory(entityId) {
        if (!this._inventory[entityId]) {
            this._inventory[entityId] = {};
        }
    }

    /**
     * Gets the component's max volume from the component type definition.
     * Looks up the volume from data/components.json by component type.
     * @param {string} componentType - The component type name (e.g., 'centralBall').
     * @returns {number} The max volume, or 0 if not found.
     * @private
     */
    _getComponentMaxVolume(componentType) {
        if (!componentType) return 0;

        const componentDefs = DataLoader.loadJsonSafe('data/components.json', {});
        const componentDef = componentDefs[componentType];

        if (componentDef && componentDef.traits &&
            componentDef.traits.Physical &&
            componentDef.traits.Physical.volume !== undefined) {
            return componentDef.traits.Physical.volume;
        }

        return 0;
    }

    /**
     * Adds an item to an entity's inventory, attached to a specific component.
     * All items must be associated with a component — there is no general/unassigned inventory.
     * Validates volume, adds item to entity.items.
     * @param {Object} entity - The entity object (mutable).
     * @param {string} itemType - The item type identifier.
     * @param {string} hostComponentId - The component ID to attach the item to (required).
     * @param {Object} [options] - Optional parameters.
     * @param {Object} [options.componentController] - ComponentController for volume validation.
     * @returns {{ success: boolean, message?: string, item?: Object }}
     */
    addItem(entity, itemType, hostComponentId, options = {}) {
        const { componentController } = options;
        const itemDef = this._itemDefinitions[itemType];

        if (!itemDef) {
            Logger.warn(`[InventoryManager] Item type "${itemType}" not found in registry.`);
            return { success: false, message: `Unknown item type: ${itemType}` };
        }

        if (!hostComponentId) {
            Logger.warn(`[InventoryManager] hostComponentId is required for item addition.`);
            return { success: false, message: `hostComponentId is required: all items must be attached to a component.` };
        }

        const entityId = entity.id;
        this._ensureEntityInventory(entityId);

        // Initialize entity.items if not present
        if (!entity.items) {
            entity.items = [];
        }

        // Validate volume against the component
        // Find the component's type from the entity's component list
        let componentType = null;
        if (entity.components && Array.isArray(entity.components)) {
            const compRef = entity.components.find(c => c.id === hostComponentId);
            if (compRef) {
                componentType = compRef.type || compRef.entityComponentType || null;
            }
        }

        const maxVolume = this._getComponentMaxVolume(componentType);
        if (maxVolume > 0) {
            const usedVolume = this._calculateComponentUsedVolume(entity, hostComponentId);
            if (usedVolume + itemDef.volume > maxVolume) {
                return {
                    success: false,
                    message: `Component ${hostComponentId} does not have enough volume. Available: ${maxVolume - usedVolume}, Item needs: ${itemDef.volume}`
                };
            }
        }

        const newItem = {
            id: `item-${this._nextId++}`,
            type: itemType,
            name: itemDef.name,
            volume: itemDef.volume,
            traits: itemDef.traits ? structuredClone(itemDef.traits) : {},
            hostComponentId: hostComponentId
        };

        entity.items.push(newItem);
        this._inventory[entityId][newItem.id] = newItem;

        Logger.info(`[InventoryManager] Added ${itemType} to entity ${entityId}${hostComponentId ? ` (component: ${hostComponentId})` : ''}`);
        return { success: true, item: structuredClone(newItem) };
    }

    /**
     * Removes an item from an entity's inventory.
     * @param {Object} entity - The entity object (mutable).
     * @param {string} itemId - The item ID to remove.
     * @returns {{ success: boolean, message?: string }}
     */
    removeItem(entity, itemId) {
        const entityId = entity.id;

        if (!entity.items || !Array.isArray(entity.items)) {
            return { success: false, message: 'Entity has no items.' };
        }

        const index = entity.items.findIndex(item => item.id === itemId);
        if (index === -1) {
            Logger.warn(`[InventoryManager] Item "${itemId}" not found in entity ${entityId}.`);
            return { success: false, message: `Item not found: ${itemId}` };
        }

        const removed = entity.items.splice(index, 1)[0];
        if (this._inventory[entityId] && this._inventory[entityId][itemId]) {
            delete this._inventory[entityId][itemId];
        }

        Logger.info(`[InventoryManager] Removed item ${itemId} from entity ${entityId}`);
        return { success: true };
    }

    /**
     * Moves an item to a different component (within the same entity).
     * Validates target component volume.
     * @param {Object} entity - The entity object (mutable).
     * @param {string} itemId - The item ID to move.
     * @param {string} targetComponentId - The target component ID.
     * @param {Object} [options] - Optional parameters.
     * @returns {{ success: boolean, message?: string }}
     */
    moveItem(entity, itemId, targetComponentId, options = {}) {
        if (!entity.items || !Array.isArray(entity.items)) {
            return { success: false, message: 'Entity has no items.' };
        }

        const item = entity.items.find(i => i.id === itemId);
        if (!item) {
            Logger.warn(`[InventoryManager] Item "${itemId}" not found.`);
            return { success: false, message: `Item not found: ${itemId}` };
        }

        // Validate target component volume
        // Find the target component's type from the entity's component list
        let targetComponentType = null;
        if (entity.components && Array.isArray(entity.components)) {
            const compRef = entity.components.find(c => c.id === targetComponentId);
            if (compRef) {
                targetComponentType = compRef.type || compRef.entityComponentType || null;
            }
        }

        const maxVolume = this._getComponentMaxVolume(targetComponentType);
        if (maxVolume > 0) {
            const usedVolume = this._calculateComponentUsedVolume(entity, targetComponentId);
            if (usedVolume + item.volume > maxVolume) {
                return {
                    success: false,
                    message: `Target component ${targetComponentId} does not have enough volume. Available: ${maxVolume - usedVolume}, Item needs: ${item.volume}`
                };
            }
        }

        item.hostComponentId = targetComponentId;
        Logger.info(`[InventoryManager] Moved item ${itemId} to component ${targetComponentId} on entity ${entity.id}`);
        return { success: true };
    }

    /**
     * Gets items for an entity grouped by host component.
     * Returns a defensive deep copy.
     * @param {Object} entity - The entity object.
     * @returns {Array} Array of { componentId, componentName, componentMaxVolume, items[] } objects.
     */
    getEntityItems(entity) {
        const entityId = entity.id;
        const items = entity.items || [];

        // Group by component
        const grouped = {};
        for (const item of items) {
            const key = item.hostComponentId || '__unassigned__';
            if (!grouped[key]) {
                grouped[key] = [];
            }
            grouped[key].push(structuredClone(item));
        }

        return structuredClone(grouped);
    }

    /**
     * Gets the volume used and max for a component on an entity.
     * @param {Object} entity - The entity object.
     * @param {string} componentId - The component ID.
     * @returns {{ used: number, max: number, percentage: number }}
     */
    getComponentVolume(entity, componentId) {
        const items = entity.items || [];
        const used = items
            .filter(item => item.hostComponentId === componentId)
            .reduce((sum, item) => sum + (item.volume || 0), 0);

        // Get max volume from component
        const max = this._getComponentMaxVolumeFromEntity(entity, componentId);

        const percentage = max > 0 ? (used / max) * 100 : 0;

        return {
            used: Math.round(used * 100) / 100,
            max: Math.round(max * 100) / 100,
            percentage: Math.round(percentage * 100) / 100
        };
    }

    /**
     * Checks if an item can fit in a component on an entity.
     * @param {Object} entity - The entity object.
     * @param {string} componentId - The component ID.
     * @param {number} itemVolume - The item volume.
     * @returns {boolean}
     */
    canFitItem(entity, componentId, itemVolume) {
        const volume = this.getComponentVolume(entity, componentId);
        return (volume.used + itemVolume) <= volume.max;
    }

    /**
     * Calculates the total volume used by items on a specific component.
     * @param {Object} entity - The entity object.
     * @param {string} componentId - The component ID.
     * @returns {number}
     * @private
     */
    _calculateComponentUsedVolume(entity, componentId) {
        const items = entity.items || [];
        return items
            .filter(item => item.hostComponentId === componentId)
            .reduce((sum, item) => sum + (item.volume || 0), 0);
    }

    /**
     * Gets the max volume for a component from the entity's component data.
     * @param {Object} entity - The entity object.
     * @param {string} componentId - The component ID.
     * @returns {number}
     * @private
     */
    _getComponentMaxVolumeFromEntity(entity, componentId) {
        if (!entity.components || !Array.isArray(entity.components)) return 0;

        const component = entity.components.find(c => c.id === componentId);
        if (!component) return 0;

        const compType = component.type;

        // Check component definitions for volume
        const defs = this._itemDefinitions;
        const componentDefs = DataLoader.loadJsonSafe('data/components.json', {});

        if (componentDefs[compType] && componentDefs[compType].traits &&
            componentDefs[compType].traits.Physical &&
            componentDefs[compType].traits.Physical.volume !== undefined) {
            return componentDefs[compType].traits.Physical.volume;
        }

        return 0;
    }

    /**
     * Adds a set of pre-defined items to an entity (bulk add).
     * @param {Object} entity - The entity object.
     * @param {Array} itemsToAdd - Array of { type, componentId? } objects.
     * @param {Object} [options] - Optional parameters.
     * @param {Object} [options.componentController] - ComponentController for volume validation.
     * @returns {{ success: boolean, added: number, failed: Array }}
     */
    bulkAddItems(entity, itemsToAdd, options = {}) {
        let added = 0;
        const failed = [];

        for (const itemSpec of itemsToAdd) {
            const result = this.addItem(entity, itemSpec.type, itemSpec.componentId, options);
            if (result.success) {
                added++;
            } else {
                failed.push({ type: itemSpec.type, reason: result.message });
            }
        }

        return { success: failed.length === 0, added, failed };
    }
}

export default InventoryManager;