/**
 * InventoryManager handles inventory operations for entities.
 * Manages item ownership, volume constraints, and item movements.
 *
 * @module InventoryManager
 */
import DataLoader from './DataLoader.js';
import Logger from './Logger.js';
import { generateItemId } from './idGenerator.js';
import { ID_PREFIXES, isPrefixed } from '../../shared/IdPrefixes.js';

/**
 * Reads a definition's physical volume. In the recipe→derivation model the
 * volume lives under `form.volume` (items and components alike); the legacy
 * top-level `volume` / `traits.Physical.volume` locations are kept as a
 * fallback for definitions that have not been migrated. Returns 0 when no
 * volume is declared (an unbounded / non-volume-bearing definition).
 * @param {Object|undefined|null} def - The item or component definition.
 * @returns {number} The declared volume (0 when absent).
 * @private
 */
function _defVolume(def) {
    if (!def) return 0;
    if (typeof def.form?.volume === 'number') return def.form.volume;
    if (typeof def.volume === 'number') return def.volume;
    if (typeof def.traits?.Physical?.volume === 'number') return def.traits.Physical.volume;
    return 0;
}

class InventoryManager {
    constructor(options = {}) {
        /**
         * Optional MaterialController for deriving trait stats from material compositions.
         * When null, items are created with raw blueprint traits (backward-compatible).
         * @type {import('../controllers/materials/MaterialController.js')|null}
         */
        this._materialController = options.materialController ?? null;

        /**
         * Item type definitions loaded from data/inventoryItems.json
         * Format: { [itemType]: { name, description, volume, traits } }
         * @type {Object}
         */
        this._itemDefinitions = DataLoader.loadJsonSafe('data/inventoryItems.json', {});

        /**
         * Component definitions loaded from data/components.json
         * Format: { [componentType]: { name, traits } }
         * @type {Object}
         */
        this._componentDefinitions = DataLoader.loadJsonSafe('data/components.json', {});

        Logger.info(`InventoryManager initialized with ${Object.keys(this._itemDefinitions).length} item types`);


        /**
         * Inventory state: { [entityId]: { [itemId]: itemInstance } }
         * Each itemInstance: { id, type, name, volume, traits, hostComponentId }
         * @type {Object}
         */
        this._inventory = {};
    }

    /**
     * Merges material-derived stats under blueprint trait overrides.
     * Material layer sits below blueprint overrides — blueprint wins on conflict.
     * Global defaults are NOT injected (items never carried them; doing so would
     * flood the panel with irrelevant stats like temperature/strength).
     * @param {Object} itemDef - The item definition from inventoryItems.json.
     * @returns {Object} Merged traits object.
     * @private
     */
    _mergeItemTraits(itemDef) {
        const traits = itemDef.traits ? structuredClone(itemDef.traits) : {};

        if (!this._materialController || !Array.isArray(itemDef.materials) || itemDef.materials.length === 0) {
            return traits; // backward-compatible passthrough
        }

        try {
            const derived = this._materialController.derive(itemDef);
            for (const [traitId, stats] of Object.entries(derived)) {
                traits[traitId] = { ...stats, ...(traits[traitId] || {}) }; // blueprint wins
            }
        } catch (error) {
            Logger.warn(`[InventoryManager] Failed to derive material traits for "${itemDef.name}" (${itemDef.type}): ${error.message}. Using raw blueprint traits.`);
        }

        return traits;
    }

    /**
     * Re-derives material traits for item instances after a snapshot restore.
     * Fill-only (wiki/subMDs/data/materials.md, resyncItemTraits section): keys already present in the
     * persisted item.traits are PRESERVED; only missing keys are filled from blueprint ⊕ material-derived.
     * Non-destructive by contract — data re-tuning does not retroactively change already-persisted items;
     * new items pick up new values on first spawn. This stays safe even if a future feature mutates
     * item traits at runtime (an implicit, undocumented invariant we now enforce explicitly).
     * @returns {void}
     */
    resyncItemTraits() {
        if (!this._materialController) return;
        for (const entityId of Object.keys(this._inventory)) {
            const entityInv = this._inventory[entityId];
            if (!entityInv) continue;
            for (const [itemId, item] of Object.entries(entityInv)) {
                if (!item.type) continue;
                const itemDef = this._itemDefinitions[item.type];
                if (!itemDef || !Array.isArray(itemDef.materials) || itemDef.materials.length === 0) continue;
                const derivedTraits = this._mergeItemTraits(itemDef);
                if (!derivedTraits) continue;
                if (!item.traits) item.traits = {};
                for (const [group, stats] of Object.entries(derivedTraits)) {
                    if (!item.traits[group] || typeof item.traits[group] !== 'object') item.traits[group] = {};
                    for (const [key, value] of Object.entries(stats)) {
                        if (item.traits[group][key] === undefined) item.traits[group][key] = value;
                    }
                }
            }
        }
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

        const componentDef = this._componentDefinitions[componentType];

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
        // Explicit definition override (feature 2, D8 site 2): a dynamically-generated
        // chunk type has no registry entry, so callers pass the synthesized definition
        // (self-describing name/volume + a 100% single-material composition). When absent,
        // this resolves to the normal registry lookup (behavior unchanged).
        const itemDef = options.itemDef || this._itemDefinitions[itemType];

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

        // Determine the host volume: prefer the external footprint (recipe→derivation stores it
        // under form.externalVolume; the legacy top-level externalVolume is a fallback), else the
        // full volume. This lets items like T1 occupy a small external footprint while keeping a
        // large internal capacity.
        const externalVolume = (typeof itemDef.form?.externalVolume === 'number')
            ? itemDef.form.externalVolume
            : (typeof itemDef.externalVolume === 'number' ? itemDef.externalVolume : undefined);
        const hostVolume = (typeof externalVolume === 'number') ? externalVolume : _defVolume(itemDef);

        const maxVolume = this._getComponentMaxVolume(componentType);
        if (maxVolume > 0) {
            const usedVolume = this._calculateComponentUsedVolume(entity, hostComponentId);
            if (usedVolume + hostVolume > maxVolume) {
                return {
                    success: false,
                    message: `Component ${hostComponentId} does not have enough volume. Available: ${maxVolume - usedVolume}, Item needs: ${hostVolume}`
                };
            }
        }

        const newItem = {
            id: generateItemId(),
            type: itemType,
            name: itemDef.name,
            // Store the instance's volume/footprint from the definition's recipe→derivation
            // location (form.volume / form.externalVolume). This is informational (used by the
            // craft pre-check and volume readouts); it does NOT enforce capacity here.
            volume: _defVolume(itemDef),
            hostVolume: hostVolume,
            externalVolume: itemDef.externalVolume ?? null,
            traits: this._mergeItemTraits(itemDef),
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

        const targetItem = this._findItem(entity, itemId);
        if (!targetItem) {
            Logger.warn(`[InventoryManager] Item "${itemId}" not found in entity ${entityId}.`);
            return { success: false, message: `Item not found: ${itemId}` };
        }

        // Remove item and all descendants (cascade)
        this._removeItemAndDescendants(entity, itemId);

        Logger.info(`[InventoryManager] Removed item ${itemId} and its descendants from entity ${entityId}`);
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
            const itemHostVolume = item.hostVolume ?? item.volume ?? 0;
            if (usedVolume + itemHostVolume > maxVolume) {
                return {
                    success: false,
                    message: `Target component ${targetComponentId} does not have enough volume. Available: ${maxVolume - usedVolume}, Item needs: ${itemHostVolume}`
                };
            }
        }

        item.hostComponentId = targetComponentId;
        Logger.info(`[InventoryManager] Moved item ${itemId} to component ${targetComponentId} on entity ${entity.id}`);
        return { success: true };
    }

    /**
     * Gets a specific item instance by ID from an entity's inventory.
     * Returns a defensive deep copy.
     * @param {Object} entity - The entity object.
     * @param {string} itemId - The item ID to find.
     * @returns {Object|null} Deep clone of the item, or null if not found.
     */
    getItem(entity, itemId) {
        if (!entity.items || !Array.isArray(entity.items)) {
            return null;
        }
        const item = entity.items.find(i => i.id === itemId);
        if (!item) return null;
        return structuredClone(item);
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
            .reduce((sum, item) => sum + (item.hostVolume ?? item.volume ?? 0), 0);

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
            .reduce((sum, item) => sum + (item.hostVolume ?? item.volume ?? 0), 0);
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

        // Check component definitions for volume. This is a READ (used by the volume
        // readouts getAvailableVolume/getComponentVolume); it is independent of the
        // additive capacity enforcement in addItem, which remains non-enforcing.
        const componentDef = this._componentDefinitions[compType];
        return _defVolume(componentDef);
    }

    /**
     * Gets the available (free) volume for a component on an entity.
     * Public API replacement for the former direct calls to the private
     * _getComponentMaxVolumeFromEntity() / _calculateComponentUsedVolume() pair.
     * @param {Object} entity - The entity object.
     * @param {string} componentId - The component ID.
     * @returns {number} Available volume (max - used; 0 for unknown components).
     */
    getAvailableVolume(entity, componentId) {
        const maxVolume = this._getComponentMaxVolumeFromEntity(entity, componentId);
        const usedVolume = this._calculateComponentUsedVolume(entity, componentId);
        return maxVolume - usedVolume;
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

    // =========================================================================
    // NESTED INVENTORY — GENERIC VOLUME VALIDATION
    // =========================================================================

    /**
     * Get all direct children of a host (component or container item).
     * Works for both component items and container children.
     * @param {Object} entity - The entity object
     * @param {string} parentId - Component ID or container item ID
     * @returns {Array} Array of child item instances
     * @private
     */
    _getChildren(entity, parentId) {
        const items = entity.items || [];
        return items.filter(item => item.hostComponentId === parentId);
    }

    /**
     * Calculate total volume of all direct children of a host.
     * Works for both component items and container children.
     * @param {Object} entity - The entity object
     * @param {string} parentId - Component ID or container item ID
     * @returns {number} Total volume
     * @private
     */
    _getHostUsedVolume(entity, parentId) {
        return this._getChildren(entity, parentId)
            .reduce((sum, item) => sum + (item.volume || 0), 0);
    }

    /**
     * Check if a child item fits in a host (component or container).
     * @param {Object} entity - The entity object
     * @param {string} parentId - Component ID or container item ID
     * @param {number} childVolume - The volume of the item to add
     * @returns {boolean}
     * @private
     */
    _canChildFit(entity, parentId, childVolume) {
        const host = this._getHostDefinition(entity, parentId);
        if (!host || host.maxVolume <= 0) return false;
        const used = this._getHostUsedVolume(entity, parentId);
        return (used + childVolume) <= host.maxVolume;
    }

    /**
     * Get the max volume for a host (component or container item).
     * @param {Object} entity - The entity object
     * @param {string} parentId - Component ID or container item ID
     * @returns {{ maxVolume: number, isComponent: boolean, host: Object|null }}
     * @private
     */
    _getHostDefinition(entity, parentId) {
        // Check if parentId is a component ID
        if (isPrefixed(parentId, ID_PREFIXES.COMPONENT)) {
            const maxVolume = this._getComponentMaxVolumeFromEntity(entity, parentId);
            return { maxVolume, isComponent: true, host: null };
        }

        // Check if parentId is an item ID (container)
        const parentItem = entity.items?.find(i => i.id === parentId);
        if (parentItem) {
            return { maxVolume: parentItem.volume, isComponent: false, host: parentItem };
        }

        return { maxVolume: 0, isComponent: false, host: null };
    }

    /**
     * Find an item by ID in the entity's flat items array.
     * @param {Object} entity - The entity object
     * @param {string} itemId - The item ID to find
     * @returns {Object|null} The item instance, or null
     * @private
     */
    _findItem(entity, itemId) {
        return (entity.items || []).find(item => item.id === itemId) || null;
    }

    /**
     * Check if itemId is a direct or indirect child of parentId.
     * @param {Object} entity - The entity object
     * @param {string} itemId - The item ID to check
     * @param {string} parentId - The ancestor item/component ID
     * @returns {boolean}
     * @private
     */
    _isDescendantOf(entity, itemId, parentId) {
        const visited = new Set();
        let current = this._findItem(entity, itemId);
        while (current && current.hostComponentId) {
            if (visited.has(current.hostComponentId)) {
                return false; // Circular reference detected, treat as not descendant
            }
            visited.add(current.hostComponentId);
            if (current.hostComponentId === parentId) return true;
            current = this._findItem(entity, current.hostComponentId);
        }
        return false;
    }

    /**
     * Collects all direct and indirect nested items (descendants) of a container item.
     * Does NOT modify the inventory — returns a defensive deep copy.
     * @param {Object} entity - The entity object
     * @param {string} parentId - The container item ID
     * @returns {Array} Array of all nested item instances (deep copy)
     * @private
     */
    _collectNestedItems(entity, parentId) {
        const result = [];
        const visited = new Set();

        const gather = (hostId) => {
            const children = this._getChildren(entity, hostId);
            for (const child of children) {
                if (visited.has(child.id)) continue; // Prevent circular references
                visited.add(child.id);
                result.push(structuredClone(child));
                // Recursively gather children of child (in case it's also a container)
                if (child.hostComponentId === hostId) {
                    gather(child.id);
                }
            }
        };

        gather(parentId);
        return result;
    }

    /**
     * Public wrapper for _collectNestedItems (§3.5.1).
     * @param {Object} entity - The entity object.
     * @param {string} parentId - The parent item ID to collect from.
     * @returns {Array} Deep copy of nested items.
     */
    collectNestedItems(entity, parentId) {
        return this._collectNestedItems(entity, parentId);
    }

    /**
     * Removes an item and all its descendants from entity.items.
     * @param {Object} entity - The entity object
     * @param {string} itemId - The item ID to remove (and all descendants)
     * @private
     */
    _removeItemAndDescendants(entity, itemId) {
        const entityId = entity.id;
        const children = this._getChildren(entity, itemId);

        // Recursively remove descendants first
        for (const child of children) {
            this._removeItemAndDescendants(entity, child.id);
        }

        // Remove self
        const index = entity.items.findIndex(item => item.id === itemId);
        if (index !== -1) {
            entity.items.splice(index, 1);
        }
        if (this._inventory[entityId] && this._inventory[entityId][itemId]) {
            delete this._inventory[entityId][itemId];
        }
    }

    // =========================================================================
    // NESTED INVENTORY — CONTAINER OPERATIONS
    // =========================================================================

    /**
     * Adds a new item to a container item within an entity's inventory.
     * @param {Object} entity - The entity object.
     * @param {string} containerItemId - The container item ID.
     * @param {string} itemType - The item type to add.
     * @returns {{ success: boolean, message?: string, item?: Object }}
     */
    addItemToContainer(entity, containerItemId, itemType) {
        const entityId = entity.id;
        this._ensureEntityInventory(entityId);

        // Find the container item in entity.items
        const containerItem = this._findItem(entity, containerItemId);
        if (!containerItem) {
            return { success: false, message: `Container item "${containerItemId}" not found.` };
        }

        const itemDef = this._itemDefinitions[itemType];
        if (!itemDef) {
            return { success: false, message: `Unknown item type: ${itemType}` };
        }

        // GENERIC VALIDATION: Use same logic as component volume check. The child's
        // footprint comes from the recipe→derivation location (form.volume / form.externalVolume).
        const childVolume = _defVolume(itemDef);
        if (!this._canChildFit(entity, containerItemId, childVolume)) {
            const used = this._getHostUsedVolume(entity, containerItemId);
            return {
                success: false,
                message: `Container capacity exceeded. Used: ${used}/${containerItem.volume}, Item needs: ${childVolume}`
            };
        }

        const newItem = {
            id: generateItemId(),
            type: itemType,
            name: itemDef.name,
            volume: _defVolume(itemDef),
            traits: this._mergeItemTraits(itemDef),
            hostComponentId: containerItemId
        };

        entity.items.push(newItem);
        this._inventory[entityId][newItem.id] = newItem;

        return { success: true, item: structuredClone(newItem) };
    }

    /**
     * Removes an item from a container item within an entity's inventory.
     * Also removes all descendants (cascade).
     * @param {Object} entity - The entity object.
     * @param {string} containerItemId - The container item ID.
     * @param {string} itemId - The item ID to remove.
     * @returns {{ success: boolean, message?: string }}
     */
    removeItemFromContainer(entity, containerItemId, itemId) {
        const entityId = entity.id;

        const containerItem = this._findItem(entity, containerItemId);
        if (!containerItem) {
            return { success: false, message: `Container item "${containerItemId}" not found.` };
        }

        const targetItem = this._findItem(entity, itemId);
        if (!targetItem) {
            return { success: false, message: `Item "${itemId}" not found.` };
        }

        // Validate: item must be a direct or indirect child of the container
        if (!this._isDescendantOf(entity, itemId, containerItemId)) {
            return { success: false, message: `Item "${itemId}" is not a child of container "${containerItemId}".` };
        }

        // Remove item and all descendants
        this._removeItemAndDescendants(entity, itemId);

        return { success: true };
    }

    /**
     * Moves an existing item from the component level (or another container) into a container.
     * @param {Object} entity - The entity object.
     * @param {string} containerItemId - The container item ID.
     * @param {string} itemId - The item ID to move into container.
     * @returns {{ success: boolean, message?: string }}
     */
    moveItemIntoContainer(entity, containerItemId, itemId) {
        const entityId = entity.id;

        const containerItem = this._findItem(entity, containerItemId);
        if (!containerItem) {
            return { success: false, message: `Container item "${containerItemId}" not found.` };
        }

        const sourceItem = this._findItem(entity, itemId);
        if (!sourceItem) {
            return { success: false, message: `Item "${itemId}" not found.` };
        }

        // Prevent moving a container into itself or its own descendants
        if (this._isDescendantOf(entity, containerItemId, itemId)) {
            return { success: false, message: "Cannot move a container into its own descendants." };
        }

        // GENERIC VALIDATION: Use same logic as component volume check
        if (!this._canChildFit(entity, containerItemId, sourceItem.volume)) {
            const used = this._getHostUsedVolume(entity, containerItemId);
            return {
                success: false,
                message: `Container capacity exceeded. Used: ${used}/${containerItem.volume}, Item needs: ${sourceItem.volume}`
            };
        }

        // Move: just change the host reference
        sourceItem.hostComponentId = containerItemId;

        return { success: true };
    }

    /**
     * Moves an item out of a container back to the component level.
     * @param {Object} entity - The entity object.
     * @param {string} containerItemId - The container item ID.
     * @param {string} itemId - The item ID to move out of container.
     * @param {string} targetComponentId - The component to attach the item to.
     * @returns {{ success: boolean, message?: string }}
     */
    moveItemOutOfContainer(entity, containerItemId, itemId, targetComponentId) {
        const entityId = entity.id;

        const containerItem = this._findItem(entity, containerItemId);
        if (!containerItem) {
            return { success: false, message: `Container item "${containerItemId}" not found.` };
        }

        const targetItem = this._findItem(entity, itemId);
        if (!targetItem) {
            return { success: false, message: `Item "${itemId}" not found.` };
        }

        // Validate: item must be a direct child of the container
        if (targetItem.hostComponentId !== containerItemId) {
            return { success: false, message: `Item "${itemId}" is not a direct child of container "${containerItemId}".` };
        }

        targetItem.hostComponentId = targetComponentId;

        return { success: true };
    }

    /**
     * Gets direct children of a container (or component).
     * @param {Object} entity - The entity object.
     * @param {string} containerItemId - The container item ID.
     * @returns {Array} Array of direct child item instances.
     */
    getContainerItems(entity, containerItemId) {
        return structuredClone(this._getChildren(entity, containerItemId));
    }
}

export default InventoryManager;