import DataLoader from '../utils/DataLoader.js';
import ComponentStatsController from './core/componentStatsController.js';
import TraitsController from './traits/TraitsController.js';
import InternalComponentController from './core/InternalComponentController.js';
import ComponentController from './core/componentController.js';
import EntityController from './core/entityController.js';
import RoomsController from './core/RoomsController.js';
import ComponentCapabilityController from './capabilities/componentCapabilityController.js';
import ActionSelectController from './actions/actionSelectController.js';
import SynergyController from './synergy/synergyController.js';
import ActionController from './actions/actionController.js';
import ConsequenceHandlers from './consequences/consequenceHandlers.js';
import EquippedItemStatsController from './core/EquippedItemStatsController.js';
import stateEntityController from './core/stateEntityController.js';
import InventoryManager from '../utils/InventoryManager.js';
import HoldingCostController from './core/HoldingCostController.js';
import Logger from '../utils/Logger.js';
import WorldGraphBuilder from '../utils/WorldGraphBuilder.js';
import IdResolver from '../utils/IdResolver.js';

class WorldStateController {
    /**
     * @param {UniversalTickSystem} [tickSystem] - The global tick system instance.
     */
    constructor(tickSystem = null) {
        // 0. Load Configuration Data
        const actionRegistry = DataLoader.loadJsonSafe('data/actions.json');
        const componentRegistry = DataLoader.loadJsonSafe('data/components.json');
        const traitsRegistry = DataLoader.loadJsonSafe('data/traits.json');

        // Warn if action registry is empty or missing
        if (!actionRegistry || Object.keys(actionRegistry).length === 0) {
            Logger.warn('Action registry is empty or missing. Actions will not be available.');
        }

        // 1. Instantiate Data Stores (Bottom level)
        const statsController = new ComponentStatsController();
        const traitsController = new TraitsController(traitsRegistry);

        // Internal Components — State Controller (self-instantiating, no DI)
        // Pass tickSystem to enable unified tick processing
        const internalComponentController = new InternalComponentController(null, tickSystem);
        this.internalComponentController = internalComponentController;

        // 2. Instantiate Logic Controllers (Middle level - Injected with Data Stores and Registries)
        const blueprintRegistry = DataLoader.loadJsonSafe('data/blueprints.json', {});
        const componentController = new ComponentController(statsController, traitsController, componentRegistry);
        const entityController = new EntityController(componentController, blueprintRegistry);

        // 3. Instantiate Instance Managers (Top level - Injected with Logic Controllers)
        const roomsController = new RoomsController();
        this.roomsController = roomsController;
        this.componentController = componentController;

        // 4. Instantiate ComponentCapabilityController (Capability Cache Manager)
        // Manages component capability scanning, caching, scoring, and re-evaluation.
        const componentCapabilityController = new ComponentCapabilityController(this, actionRegistry);
        this.componentCapabilityController = componentCapabilityController;

        // 5. Instantiate ActionSelectController (Component selection/locking)
        // Enforces "one component, one action" rule: if a component is selected for action A,
        // it cannot be used for action B simultaneously.
        const actionSelectController = new ActionSelectController(this);
        this.actionSelectController = actionSelectController;

        // 6. Instantiate SynergyController (Synergy System — computes multi-entity/component synergy multipliers)
        // Loads synergy config from data/synergy.json (decoupled from actions.json)
        // Injected with ActionSelectController for locked-component exclusion in synergy pools.
        const synergyRegistry = DataLoader.loadJsonSafe('data/synergy.json') || {};
        const synergyController = new SynergyController(this, actionRegistry, synergyRegistry, actionSelectController);
        this.synergyController = synergyController;

        // 6.5. Instantiate EquippedItemStatsController BEFORE ActionController.
        // Manages per-instance mutable stats (sharpness, durability) for equipped items.
        // Must be available for injection into RequirementResolver so that
        // requirementValues reflect CURRENT stats, not static inventoryItems.json definitions.
        const equippedItemStats = new EquippedItemStatsController({ worldStateController: this });
        this.equippedItemStats = equippedItemStats;

        // 7. Instantiate ActionController (Top level - Injected with Dependencies)
        // NOTE: Create consequenceHandlers AFTER properties are assigned to avoid receiving partially initialized controller
        const consequenceHandlers = new ConsequenceHandlers({ worldStateController: this, equippedItemStats: equippedItemStats });
        const actionController = new ActionController(
            this,
            consequenceHandlers,
            actionRegistry,
            componentCapabilityController,
            synergyController,
            actionSelectController,
            equippedItemStats
        );
        this.actionController = actionController;

        // 8. Instantiate stateEntityController with actionController and internalComponentController
        // This follows proper DI pattern - no forward references needed
        const stateEntityControllerInstance = new stateEntityController(entityController, actionController, internalComponentController);
        this.stateEntityController = stateEntityControllerInstance;

        // Register spawn observer — adds test items + knives to every spawned entity
        stateEntityControllerInstance.registerSpawnObserver((entityId, entityData) => {
            const entity = this.stateEntityController.getEntity(entityId);
            if (!entity || !entity.components || !Array.isArray(entity.components)) return;

            // Find components for item attachment
            const centralBall = entity.components.find(c => c.type === 'centralBall');
            let handComponent = entity.components.find(c => c.type === 'droidHand');
            if (!handComponent) handComponent = entity.components.find(c => c.type === 'droidArm');

            // Add test items to centralBall (if exists)
            if (centralBall) {
                const result1 = this.inventoryManager.addItem(entity, 'testItem', centralBall.id, {
                    componentController: this.componentController
                });
                const result2 = this.inventoryManager.addItem(entity, 'testItem2', centralBall.id, {
                    componentController: this.componentController
                });

                if (result1.success) {
                    Logger.info(`[WorldStateController] Test item 1 auto-added to centralBall on spawned entity ${entityId}`);
                } else {
                    Logger.warn(`[WorldStateController] Failed to add test item 1 to spawned entity ${entityId}: ${result1.message}`);
                }
                if (result2.success) {
                    Logger.info(`[WorldStateController] Test item 2 auto-added to centralBall on spawned entity ${entityId}`);
                } else {
                    Logger.warn(`[WorldStateController] Failed to add test item 2 to spawned entity ${entityId}: ${result2.message}`);
                }
            }

            // Add knife to hand component (if exists) — every entity gets a knife
            if (handComponent) {
                const knifeResult = this.inventoryManager.addItem(entity, 'knife', handComponent.id, {
                    componentController: this.componentController
                });
                if (knifeResult.success) {
                    Logger.info(`[WorldStateController] Knife auto-added to ${handComponent.type} on spawned entity ${entityId}`);
                } else {
                    Logger.warn(`[WorldStateController] Failed to add knife to spawned entity ${entityId}: ${knifeResult.message}`);
                }
            }
        });

        // Wire up stat change notifications from ComponentController to ComponentCapabilityController
        // This enables automatic capability re-evaluation when component stats change
        this.componentController.registerStatChangeListener((componentId, traitId, statName, newValue, oldValue) => {
            this.componentCapabilityController.onStatChange(componentId, traitId, statName, newValue, oldValue);
            // Trigger broadcast if broadcastService is available
            if (this._broadcastService) {
                this._broadcastService.broadcast();
            }
        });

        // Set worldStateController reference on InternalComponentController for repair system access
        internalComponentController.setWorldStateController(this);

        // Initialize Internal Component Controller with global tick system
        internalComponentController.initialize();

        // 8. Instantiate InventoryManager (Inventory System)
        // Manages item ownership, volume constraints, and item movements for entities.
        this.inventoryManager = new InventoryManager();

        // Wire equippedItemStats stat change callback to trigger capability re-evaluation.
        // When an equipped item's stats change (e.g., sharpness drain from cut), this ensures
        // the capability cache re-scans with CURRENT stats, not stale base stats.
        // Without this wiring, the cache would show stale "canExecute" entries based on base item stats.
        equippedItemStats.setStatChangeCallback((eqId, traitId, statName, newValue, oldValue) => {
            // Find which entity this item belongs to by scanning equipped items.
            // HoldingCostController.getAllEquippedItems() returns: { [entityId]: { [eqId]: itemData } }
            const allEquipped = this.holdingCostController.getAllEquippedItems();
            for (const [entityId, items] of Object.entries(allEquipped)) {
                if (items[eqId]) {
                    // Entity found — re-evaluate its capabilities with current stats
                    const state = this.getAll();
                    this.actionController.reEvaluateEntityCapabilities(state, entityId);
                    if (this._broadcastService) {
                        this._broadcastService.broadcast();
                    }
                    Logger.info(`[WorldStateController] Capability re-evaluated for entity "${entityId}" after ${traitId}.${statName} changed: ${oldValue} → ${newValue}`);
                    return;
                }
            }
        });

        // 9. Instantiate HoldingCostController (Holding Cost System)
        // Manages holding cost requirements, debuffs, and item equip/unequip for entities.
        // Injected after actionController is available for capability re-evaluation.
        const holdingCostController = new HoldingCostController({
            worldStateController: this,
            actionController: actionController,
            equippedItemStats: equippedItemStats
        });
        this.holdingCostController = holdingCostController;

        // 10. Broadcast service (injected via setBroadcastService() from server.js)
        /** @private {WorldStateBroadcastService|null} */
        this._broadcastService = null;

        // Map of sub-controllers for easy iteration/extension
        this.subControllers = {
            rooms: this.roomsController,
            entities: this.stateEntityController,
            components: this.componentController,
            internalComponents: this.internalComponentController,
            actions: this.actionController,
            capabilities: this.componentCapabilityController,
            synergy: this.synergyController,
            selections: this.actionSelectController,
            inventory: this.inventoryManager,
            holdingCost: this.holdingCostController,
            equippedItemStats: this.equippedItemStats
        };

        // Initialize world with a sample droid as requested
        this.initializeWorld();

        // Perform initial capability scan after entities are spawned
        // Delegates to ComponentCapabilityController via ActionController wrapper
        this.actionController.scanAllCapabilities(this.getAll());
    }

    /**
     * Sets up initial world state, including default entities.
     */
    initializeWorld() {
        // Resolve the UUID for the start room to maintain spatial synchronization
        const startRoomId = this.roomsController.getUidByLogicalId('start_room');

        // Spawn the client entity (small ball droid) in the start room
        const clientEntityId = this.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

        // Add test items (volume=2, volume=4) to the client entity's centralBall component on spawn
        this._addTestItemToClientEntity(clientEntityId);

        // Add knife to the client entity's droidHand component on spawn (so it's available for equip)
        this._addKnifeToClientEntity(clientEntityId);

        // Spawn the vault guardian droid in the Deep Vault
        const vaultRoomId = this.roomsController.getUidByLogicalId('far_right_room');
        this.stateEntityController.spawnEntity('smallBallDroid', vaultRoomId);
    }

    /**
     * Adds a knife to the client entity's droidHand component on spawn.
     * The knife has holdingCost and can be equipped to enable the "cut" action.
     * @param {string} clientEntityId - The client entity ID.
     * @returns {void}
     * @private
     */
    _addKnifeToClientEntity(clientEntityId) {
        const entity = this.stateEntityController.getEntity(clientEntityId);
        if (!entity || !entity.components || !Array.isArray(entity.components)) {
            Logger.warn(`[WorldStateController] Client entity "${clientEntityId}" not found or has no components for knife.`);
            return;
        }

        // Find the first droidHand component (or droidArm as fallback)
        let handComponent = entity.components.find(c => c.type === 'droidHand');
        if (!handComponent) {
            handComponent = entity.components.find(c => c.type === 'droidArm');
        }
        if (!handComponent) {
            Logger.warn(`[WorldStateController] droidHand/droidArm component not found on entity "${clientEntityId}" for knife.`);
            return;
        }

        const result = this.addItemToEntity(clientEntityId, 'knife', handComponent.id);
        if (result.success) {
            Logger.info(`[WorldStateController] Knife added to ${handComponent.type} (component: ${handComponent.id}) on entity ${clientEntityId}`);
        } else {
            Logger.warn(`[WorldStateController] Failed to add knife to ${handComponent.type}: ${result.message}`);
        }
    }

    /**
     * Adds a test item to the client entity's centralBall component.
     * Used for inventory system verification/testing.
     * @param {string} clientEntityId - The client entity ID.
     * @returns {void}
     * @private
     */
    _addTestItemToClientEntity(clientEntityId) {
        const entity = this.stateEntityController.getEntity(clientEntityId);
        if (!entity || !entity.components || !Array.isArray(entity.components)) {
            Logger.warn(`[WorldStateController] Client entity "${clientEntityId}" not found or has no components for test item.`);
            return;
        }

        // Find the centralBall component
        const centralBall = entity.components.find(c => c.type === 'centralBall');
        if (!centralBall) {
            Logger.warn(`[WorldStateController] centralBall component not found on entity "${clientEntityId}" for test item.`);
            return;
        }

        const result = this.addItemToEntity(clientEntityId, 'testItem', centralBall.id);
        if (result.success) {
            Logger.info(`[WorldStateController] Test item added to centralBall (component: ${centralBall.id}) on entity ${clientEntityId}`);
        } else {
            Logger.warn(`[WorldStateController] Failed to add test item to centralBall: ${result.message}`);
        }
    }

    /**
     * Aggregates state data from all registered sub-controllers.
     * This method serves as a unified "getState" for the entire world.
     * @returns {Object} The combined state of the world.
     */
    getAll() {
        const globalState = {};

        // Dynamically collect data from all sub-controllers that implement getAll()
        for (const [key, controller] of Object.entries(this.subControllers)) {
            if (typeof controller.getAll === 'function') {
                globalState[key] = controller.getAll();
            }
        }

        // Include dropped items in the global state for real-time broadcast
        const droppedItems = this.getDroppedItems();
        if (droppedItems && Object.keys(droppedItems).length > 0) {
            globalState.droppedItems = droppedItems;
        }

        return globalState;
    }

    // =========================================================================
    // PUBLIC API WRAPPERS (for server.js access)
    // =========================================================================

    /**
     * Spawns an entity from a blueprint into a room.
     * @param {string} blueprintName - The blueprint to use.
     * @param {string} roomId - The room to spawn into.
     * @returns {string} The new entity ID.
     */
    spawnEntity(blueprintName, roomId) {
        return this.stateEntityController.spawnEntity(blueprintName, roomId);
    }

    /**
     * Despawns an entity and cleans up its capabilities.
     * @param {string} entityId - The entity to despawn.
     * @returns {boolean} True if successful.
     */
    despawnEntity(entityId) {
        return this.stateEntityController.despawnEntity(entityId);
    }

    /**
     * Moves an entity to a different room.
     * @param {string} entityId - The entity to move.
     * @param {string} targetRoomId - The destination room.
     * @returns {boolean} True if successful.
     */
    moveEntity(entityId, targetRoomId) {
        return this.stateEntityController.moveEntity(entityId, targetRoomId);
    }

    /**
     * Resolves a logical room name to its UUID.
     * @param {string} logicalId - The logical room name.
     * @returns {string|null} The room UUID or null.
     */
    getRoomUidByLogicalId(logicalId) {
        return this.roomsController.getUidByLogicalId(logicalId);
    }

    /**
     * Retrieves an entity by its ID.
     * Provides a public API for accessing entity state instead of direct property access.
     * @param {string} entityId - The entity ID.
     * @returns {Object|null} The entity object, or null if not found.
     */
    getEntity(entityId) {
        return this.stateEntityController.getEntity(entityId);
    }

    /**
     * Retrieves component stats by component ID.
     * @param {string} componentId - The component ID.
     * @returns {Object|null} The component stats object, or null if not found.
     */
    getComponentStats(componentId) {
        return this.componentController.getComponentStats(componentId);
    }

    // =========================================================================
    // INTERNAL COMPONENT API (for internal components system)
    // =========================================================================

    /**
     * Adds an internal component to a host component.
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @param {string} internalComponentType - The internal component type to add.
     * @returns {Object|null} The created instance, or null if failed.
     */
    addInternalComponent(entityId, hostComponentId, internalComponentType) {
        return this.internalComponentController.addInternalComponent(entityId, hostComponentId, internalComponentType);
    }

    /**
     * Gets internal components for a specific host component.
     * Returns a defensive deep copy to prevent external mutation.
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @returns {Array} Deep copy of internal component instances for the host.
     */
    getInternalComponents(entityId, hostComponentId) {
        return this.internalComponentController.getInternalComponents(entityId, hostComponentId);
    }

    /**
     * Gets all internal components for an entity.
     * Returns a defensive deep copy to prevent external mutation.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Deep copy of all internal components for the entity.
     */
    getInternalComponentsForEntity(entityId) {
        return this.internalComponentController.getInternalComponentsForEntity(entityId);
    }

    /**
     * Removes an internal component from a host component.
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @param {string} internalComponentInstanceId - The internal component instance ID to remove.
     * @returns {boolean} True if removed successfully.
     */
    removeInternalComponent(entityId, hostComponentId, internalComponentInstanceId) {
        return this.internalComponentController.removeInternalComponent(entityId, hostComponentId, internalComponentInstanceId);
    }

    /**
     * Checks if a host component has a specific type of internal component.
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @param {string} internalComponentType - The internal component type to check.
     * @returns {boolean} True if the host has the specified internal component type.
     */
    hasInternalComponent(entityId, hostComponentId, internalComponentType) {
        return this.internalComponentController.hasInternalComponent(entityId, hostComponentId, internalComponentType);
    }

    /**
     * Cleans up all internal components for a specific entity.
     * Called when an entity is despawned.
     * @param {string} entityId - The entity ID to clean up.
     * @returns {boolean} True if cleanup was performed.
     */
    cleanupInternalComponents(entityId) {
        return this.internalComponentController.cleanupEntity(entityId);
    }

    // =========================================================================
    // SYNERGY PUBLIC API (for server.js access)
    // =========================================================================

    /**
     * Computes synergy for an action without executing it.
     * @param {string} actionName - The action name
     * @param {string} entityId - The entity executing the action
     * @param {Object} [context] - Optional context (e.g., synergyGroups for multi-entity)
     * @returns {Object} SynergyResult object
     */
    computeSynergy(actionName, entityId, context) {
        return this.synergyController.computeSynergy(actionName, entityId, context);
    }

    /**
     * Gets all actions that have synergy enabled.
     * @returns {string[]} Array of action names with synergy
     */
    getActionsWithSynergy() {
        return this.synergyController.getActionsWithSynergy();
    }

    /**
     * Gets synergy configuration for an action.
     * @param {string} actionName - The action name
     * @returns {Object} Synergy config object
     */
    getSynergyConfig(actionName) {
        return this.synergyController.getSynergyConfig(actionName);
    }

    // =========================================================================
    // ACTION DATA PREVIEW (for synergy preview system)
    // =========================================================================

    /**
     * Previews action data including resolved values and synergy for a given component selection.
     * Used by the enhanced synergy preview endpoint.
     * @param {string} actionName - The action name
     * @param {string} entityId - The entity executing the action
     * @param {Object} [context] - Optional context (providedComponentIds, etc.)
     * @returns {Object} Preview data with actionData, resolvedValues, and synergyResult
     */
    previewActionData(actionName, entityId, context) {
        return this.actionController.previewActionData(actionName, entityId, context);
    }

    // =========================================================================
    // ACTION API WRAPPERS (for server.js access)
    // =========================================================================

    /**
     * Returns actions relevant to a specific entity.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Action status for the entity.
     */
    getActionsForEntity(entityId) {
        const state = this.getAll();
        return this.actionController.getActionsForEntity(state, entityId);
    }

    /**
     * Returns all action capabilities across all entities.
     * @returns {Object} Action capabilities data.
     */
    getActionCapabilities() {
        const state = this.getAll();
        return this.actionController.getActionCapabilities(state);
    }

    /**
     * Executes an action on an entity.
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity executing the action.
     * @param {Object} [params] - Optional action parameters.
     * @returns {Object} Execution result.
     */
    executeAction(actionName, entityId, params) {
        return this.actionController.executeAction(actionName, entityId, params);
    }

    // =========================================================================
    // COMPONENT CAPABILITY API WRAPPERS (for server.js access)
    // =========================================================================

    /**
     * Returns the cached action capability data for all actions.
     * @returns {Object} Cached capabilities.
     */
    getCachedCapabilities() {
        return this.componentCapabilityController.getCachedCapabilities();
    }

    /**
     * Returns the best component for a specific action across all entities.
     * @param {string} actionName - The action name.
     * @returns {Object|null} Best component entry or null.
     */
    getBestComponentForAction(actionName) {
        return this.componentCapabilityController.getBestComponentForAction(actionName);
    }

    /**
     * Returns all capability entries for a specific entity across all actions.
     * @param {string} entityId - The entity ID.
     * @returns {Array} Capability entries array.
     */
    getCapabilitiesForEntity(entityId) {
        return this.componentCapabilityController.getCapabilitiesForEntity(entityId);
    }

    /**
     * Re-evaluates all action capabilities for a specific entity.
     * @param {string} entityId - The entity ID.
     * @returns {Array} Updated capability entries.
     */
    reEvaluateEntityCapabilities(entityId) {
        const state = this.getAll();
        return this.componentCapabilityController.reEvaluateEntityCapabilities(state, entityId);
    }

    // =========================================================================
    // ROOM API WRAPPERS (for server.js access)
    // =========================================================================

    /**
     * Returns all rooms.
     * @returns {Object} All rooms data.
     */
    getRooms() {
        return this.roomsController.getAll();
    }

    /**
     * Returns the world graph with resolved room names for all connections.
     * @returns {Object} World graph structure.
     */
    getWorldGraph() {
        const rooms = this.roomsController.getAll();
        const builder = new WorldGraphBuilder(rooms);
        return builder.build();
    }

    // =========================================================================
    // ACTION SELECTION API WRAPPERS (for server.js access)
    // =========================================================================

    /**
     * Expires all stale component selections.
     * Should be called before executing any action.
     * @returns {void}
     */
    expireStaleSelections() {
        this.actionSelectController.expireStaleSelections();
    }

    /**
     * Locks multiple components to a specific action (batch selection).
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID.
     * @param {Array} components - Array of {componentId, role} objects.
     * @returns {Object} Selection result.
     */
    registerSelections(actionName, entityId, components) {
        return this.actionSelectController.registerSelections(actionName, entityId, components);
    }

    /**
     * Locks a single component to a specific action.
     * @param {string} actionName - The action name.
     * @param {string} componentId - The component ID.
     * @param {string} entityId - The entity ID.
     * @param {string} role - The component role.
     * @returns {Object} Selection result.
     */
    registerSelection(actionName, componentId, entityId, role) {
        return this.actionSelectController.registerSelection(actionName, componentId, entityId, role);
    }

    /**
     * Releases (unlocks) a component selection.
     * @param {string} componentId - The component ID to release (can be comp-* or eq-*).
     * @param {string} [entityId] - Optional entity ID for resolving equipment IDs.
     * @returns {boolean} Whether the selection was released.
     */
    releaseSelection(componentId, entityId) {
        return this.actionSelectController.releaseSelection(componentId, entityId);
    }

    /**
     * Returns all current component selections for an entity.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Locked components data.
     */
    getLockedComponents(entityId) {
        return this.actionSelectController.getLockedComponents(entityId);
    }

    // =========================================================================
    // INVENTORY PUBLIC API (for server.js access)
    // =========================================================================

    /**
     * Gets the item type definitions (registry).
     * Returns a defensive deep copy.
     * @returns {Object} Item definitions.
     */
    getItemRegistry() {
        return this.inventoryManager.getItemDefinitions();
    }

    /**
     * Gets inventory items for an entity grouped by host component.
     * Returns a defensive deep copy.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Item data grouped by component.
     */
    getEntityItems(entityId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for inventory query.`);
            return {};
        }
        return this.inventoryManager.getEntityItems(entity);
    }

    /**
     * Adds an item to an entity's inventory, attached to a specific component.
     * All items must be associated with a component — there is no general/unassigned inventory.
     * @param {string} entityId - The entity ID.
     * @param {string} itemType - The item type identifier.
     * @param {string} componentId - The component ID to attach the item to (required).
     * @returns {{ success: boolean, message?: string, item?: Object }}
     */
    addItemToEntity(entityId, itemType, componentId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for item addition.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.inventoryManager.addItem(entity, itemType, componentId, {
            componentController: this.componentController
        });

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Removes an item from an entity's inventory.
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID to remove.
     * @returns {{ success: boolean, message?: string }}
     */
    removeItemFromEntity(entityId, itemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for item removal.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.inventoryManager.removeItem(entity, itemId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Moves an item to a different component within an entity.
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID to move.
     * @param {string} targetComponentId - The target component ID.
     * @returns {{ success: boolean, message?: string }}
     */
    moveItemInEntity(entityId, itemId, targetComponentId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for item move.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.inventoryManager.moveItem(entity, itemId, targetComponentId, {
            componentController: this.componentController
        });

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    // =========================================================================
    // BROADCAST SERVICE INJECTION
    // =========================================================================

    /**
     * Injects the broadcast service for stat-change-driven broadcasts.
     * Called from server.js after WorldStateController is fully initialized.
     * @param {WorldStateBroadcastService} broadcastService - The broadcast service instance.
     */
    setBroadcastService(broadcastService) {
        this._broadcastService = broadcastService;
    }

    /**
     * Triggers an initial broadcast of world state after the broadcast service is injected.
     * Called from server.js after setBroadcastService() to sync initial state (including spawn items) to clients.
     * @returns {void}
     */
    triggerInitialBroadcast() {
        if (this._broadcastService) {
            this._broadcastService.broadcast();
            Logger.info('[WorldStateController] Initial broadcast triggered after broadcast service injection.');
        } else {
            Logger.warn('[WorldStateController] Broadcast service not available for initial broadcast.');
        }
    }

    // =========================================================================
    // HOLDING COST PUBLIC API (for server.js access)
    // =========================================================================

    /**
     * Equips an item on a component (applies holding cost debuffs, triggers capability re-evaluation).
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID being equipped.
     * @param {string} itemType - The item type (e.g., "knife").
     * @param {string} componentId - The component ID to equip on.
     * @returns {{ success: boolean, message?: string, error?: string }}
     */
    equipItem(entityId, itemId, itemType, componentId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for equip.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.holdingCostController.equipItem(entityId, itemId, itemType, componentId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Unequips an item from its component (reverses debuffs, triggers capability re-evaluation).
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID being unequipped.
     * @returns {{ success: boolean, message?: string, error?: string }}
     */
    unequipItem(entityId, itemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for unequip.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.holdingCostController.unequipItem(entityId, itemId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Transfers an equipped item from one component to another (hand swap).
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID being transferred.
     * @param {string} itemType - The item type.
     * @param {string} fromComponentId - The source component ID.
     * @param {string} toComponentId - The target component ID.
     * @returns {{ success: boolean, message?: string, error?: string }}
     */
    transferEquip(entityId, itemId, itemType, fromComponentId, toComponentId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for equip transfer.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.holdingCostController.transferEquip(entityId, itemId, itemType, fromComponentId, toComponentId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Gets all equipped items for an entity.
     * @param {string} entityId - The entity ID.
     * @returns {Array<{ itemId: string, itemType: string, componentId: string }>}
     */
    getEquippedItems(entityId) {
        return this.holdingCostController.getEquippedItems(entityId);
    }

    /**
     * Gets all equipped items across all entities.
     * Used by the capability controller to scan all equipped items for action resolution.
     * @returns {Array<{ entityId: string, itemId: string, itemType: string, componentId: string }>}
     */
    getAllEquippedItems() {
        const allEquipped = this.holdingCostController.getAllEquippedItems();
        if (!allEquipped || typeof allEquipped !== 'object') return [];
        const allItems = [];
        for (const [entityId, items] of Object.entries(allEquipped)) {
            for (const [eqId, item] of Object.entries(items)) {
                allItems.push({
                    entityId,
                    eqId,
                    itemId: item.itemId,
                    itemType: item.itemType,
                    componentId: item.componentId
                });
            }
        }
        return allItems;
    }

    // =========================================================================
    // TYPED ID MIGRATION: GET EQUIPPED ITEM PUBLIC METHODS
    // =========================================================================

    /**
     * Gets a specific equipped item by its typed equipped-item ID.
     * TYPED ID MIGRATION: Uses eq- prefixed IDs (e.g., "eq-uuid") for equipped items.
     * @param {string} entityId - The entity ID.
     * @param {string} eqId - The typed equipped-item ID (must start with "eq-").
     * @returns {Object|null} The equipped item data object, or null if not found/invalid.
     */
    getEquippedItem(entityId, eqId) {
        // TYPED ID MIGRATION: Validate that eqId has the proper "eq-" prefix
        if (!this._validateEquippedId(eqId)) {
            Logger.warn(`[WorldStateController] Invalid equipped-item ID: "${eqId}" — must start with "eq-"`);
            return null;
        }

        const allEquipped = this.holdingCostController.getAllEquippedItems();
        if (!allEquipped || typeof allEquipped !== 'object') return null;

        const entityItems = allEquipped[entityId];
        if (!entityItems || typeof entityItems !== 'object') return null;

        const item = entityItems[eqId];
        return item ? { ...item } : null;
    }

    /**
     * Gets a specific equipped item by its item ID (not typed eqId).
     * TYPED ID MIGRATION: Internal use only — prefers eqId for lookups.
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID to find.
     * @returns {Object|null} The equipped item data object, or null if not found.
     */
    getEquippedItemByItemId(entityId, itemId) {
        const allEquipped = this.holdingCostController.getAllEquippedItems();
        if (!allEquipped || typeof allEquipped !== 'object') return null;

        const entityItems = allEquipped[entityId];
        if (!entityItems || typeof entityItems !== 'object') return null;

        for (const [eqId, item] of Object.entries(entityItems)) {
            if (item.itemId === itemId) {
                return { ...item };
            }
        }

        return null;
    }

    /**
     * Gets an equipped item for a specific component.
     * TYPED ID MIGRATION: Returns equipped item data keyed by eqId for the given component.
     * @param {string} entityId - The entity ID.
     * @param {string} componentId - The component ID to check.
     * @returns {Object|null} The equipped item data, or null if no item is equipped on this component.
     */
    getEquippedItemForComponent(entityId, componentId) {
        const allEquipped = this.holdingCostController.getAllEquippedItems();
        if (!allEquipped || typeof allEquipped !== 'object') return null;

        const entityItems = allEquipped[entityId];
        if (!entityItems || typeof entityItems !== 'object') return null;

        for (const [eqId, item] of Object.entries(entityItems)) {
            if (item.componentId === componentId) {
                return { ...item };
            }
        }

        return null;
    }

    /**
     * Validates that an equipped-item ID has the proper "eq-" prefix.
     * TYPED ID MIGRATION: Internal validation helper for typed ID enforcement.
     * @param {string} eqId - The equipped-item ID to validate.
     * @returns {boolean} True if the ID has the proper "eq-" prefix.
     * @private
     */
    _validateEquippedId(eqId) {
        return IdResolver.isEquippedId(eqId);
    }

    /**
     * Gets the holding cost definitions registry.
     * @returns {Object} Holding cost definitions.
     */
    getHoldingCostRegistry() {
        return this.holdingCostController.getHoldingCostRegistry();
    }

    // =========================================================================
    // DROPPED ITEMS PUBLIC API
    // =========================================================================

    /**
     * Gets all dropped items in the world.
     * Returns a defensive deep copy to prevent external mutation.
     * @returns {Object<string, {id: string, itemType: string, itemId: string, x: number, y: number, ownerId: string}>} Dropped items map.
     */
    getDroppedItems() {
        // Initialize if not yet created
        if (!this._droppedItems) {
            this._droppedItems = {};
        }
        return structuredClone(this._droppedItems);
    }

    /**
     * Gets dropped items filtered by room ID.
     * Returns a defensive deep copy to prevent external mutation.
     * @param {string} roomId - The room ID to filter by.
     * @returns {Object<string, Object>} Dropped items map filtered by room.
     */
    getDroppedItemsByRoom(roomId) {
        if (!this._droppedItems) {
            return {};
        }
        const filtered = {};
        for (const [id, item] of Object.entries(this._droppedItems)) {
            if (item.roomId === roomId) {
                filtered[id] = item;
            }
        }
        return structuredClone(filtered);
    }

    /**
     * Sets all dropped items in the world.
     * @param {Object} droppedItems - The dropped items map.
     * @returns {void}
     */
    setDroppedItems(droppedItems) {
        this._droppedItems = droppedItems;

        if (this._broadcastService) {
            this._broadcastService.broadcast();
        }
    }

    /**
     * Removes a dropped item from the world.
     * @param {string} droppedItemId - The dropped item ID.
     * @returns {{ success: boolean, message?: string }}
     */
    removeDroppedItem(droppedItemId) {
        const droppedItems = this.getDroppedItems();
        if (!droppedItems[droppedItemId]) {
            Logger.warn(`[WorldStateController] Dropped item "${droppedItemId}" not found.`);
            return { success: false, message: `Dropped item "${droppedItemId}" not found.` };
        }

        delete droppedItems[droppedItemId];
        this.setDroppedItems(droppedItems);

        Logger.info(`[WorldStateController] Removed dropped item "${droppedItemId}".`);
        return { success: true };
    }

    /**
     * Picks up a dropped item from the map and adds it to an entity's inventory component.
     * This is the public API for the pick-up-item operation, delegating to the consequence handler system.
     *
     * @param {string} entityId - The entity picking up the item.
     * @param {string} droppedItemId - The ID of the dropped item on the map.
     * @param {string} componentId - The component ID to attach the item to.
     * @returns {{ success: boolean, message?: string, pickedUpItem?: object }}
     */
    executePickUpItem(entityId, droppedItemId, componentId) {
        // Access the consequence dispatcher's pickUpItem handler via the public consequenceHandlers property
        const pickUpHandler = this.actionController?.consequenceHandlers?.handlers?.pickUpItem;

        if (typeof pickUpHandler !== 'function') {
            Logger.error('[WorldStateController] PickUpItem handler not available.');
            return { success: false, message: 'PickUpItem handler not available.' };
        }

        return pickUpHandler(null, { entityId, droppedItemId, componentId }, { entityId });
    }

    /**
     * Retrieves a component by its instance ID, searching across all active entities.
     * Returns a defensive copy to prevent external mutation of internal state.
     *
     * @param {string} componentId - The component instance ID.
     * @returns {Object|null} The component object with `id`, `type`, and `entityId` fields, or null if not found.
     */
    getComponent(componentId) {
        const allEntities = this.stateEntityController.getAll();
        for (const [, entity] of Object.entries(allEntities)) {
            if (Array.isArray(entity.components)) {
                const component = entity.components.find(c => c.id === componentId);
                if (component) {
                    return { ...component, entityId: entity.id };
                }
            }
        }
        return null;
    }

    /**
     * Gets a specific item instance by ID from an entity's inventory.
     * Returns a defensive deep copy.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID to find.
     * @returns {Object|null} Deep clone of the item, or null if not found.
     */
    getItem(entityId, itemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) return null;
        return this.inventoryManager.getItem(entity, itemId);
    }

    /**
     * Computes the full stats for a single item instance, combining:
     * - Base traits from inventoryItems.json (always shown)
     * - Dynamic equipped item stats (sharpness, durability current — shown when equipped)
     * - Holding cost requirements (shown when equipped, informational only)
     *
     * Note: Holding cost debuffs are applied to the COMPONENT's stats, not the item's.
     * They are shown as informational metadata, not subtracted from item stats.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID.
     * @returns {Object|null} The combined stats object, or null if item not found.
     */
    getItemStats(entityId, itemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) return null;

        const item = this.inventoryManager.getItem(entity, itemId);
        if (!item) return null;

        // 1. Build base stats from item traits (always present)
        const baseStats = {};
        const traitCategories = {}; // Track which trait categories have stats
        if (item.traits && typeof item.traits === 'object') {
            for (const [traitCategory, traitData] of Object.entries(item.traits)) {
                if (typeof traitData === 'object' && traitData !== null && !Array.isArray(traitData)) {
                    traitCategories[traitCategory] = true;
                    for (const [statName, statValue] of Object.entries(traitData)) {
                        if (typeof statValue === 'number') {
                            baseStats[statName] = statValue;
                        }
                    }
                }
            }
        }

        // 2. Check if equipped and get dynamic stats
        const isEquipped = this.holdingCostController.isItemEquipped(entityId, itemId);
        const dynamicStats = {};
        const dynamicStatCategories = {};

        if (isEquipped && this.equippedItemStats) {
            // FIX: Get eqId from itemId to properly look up equipped item stats
            const equippedItem = this.getEquippedItemByItemId(entityId, itemId);
            if (equippedItem && equippedItem.eqId) {
                const eqStats = this.equippedItemStats.getStats(equippedItem.eqId);
                if (eqStats) {
                    for (const [traitCategory, traitData] of Object.entries(eqStats)) {
                        if (typeof traitData === 'object' && traitData !== null && !Array.isArray(traitData)) {
                            dynamicStatCategories[traitCategory] = true;
                            for (const [statName, statValue] of Object.entries(traitData)) {
                                dynamicStats[statName] = statValue;
                            }
                        }
                    }
                }
            }
        }

        // 3. Get holding cost requirements if equipped (informational, NOT applied to item stats)
        const holdingCostRequirements = [];
        if (isEquipped) {
            const holdingCostDef = this.holdingCostController.getHoldingCostDefinition(item.type);
            if (holdingCostDef && holdingCostDef.holdingCost) {
                for (const costEntry of holdingCostDef.holdingCost) {
                    holdingCostRequirements.push({
                        trait: costEntry.trait,
                        stat: costEntry.stat,
                        value: costEntry.value
                    });
                }
            }
        }

        // 4. Build final result with metadata and separated sections
        const result = {
            _itemId: item.id,
            _type: item.type,
            _name: item.name || item.type,
            _isEquipped: isEquipped,
            _volume: item.volume,
            _baseStats: baseStats,
            _traitCategories: traitCategories
        };

        // Add dynamic stats when equipped
        if (isEquipped && Object.keys(dynamicStats).length > 0) {
            result._dynamicStats = dynamicStats;
            result._dynamicStatCategories = dynamicStatCategories;
        }

        // Add holding cost requirements when equipped
        if (isEquipped && holdingCostRequirements.length > 0) {
            result._holdingCostRequirements = holdingCostRequirements;
        }

        // Also flatten for easy display: base + dynamic merged
        const displayStats = { ...baseStats };
        for (const [statName, statValue] of Object.entries(dynamicStats)) {
            displayStats[statName] = statValue;
        }
        Object.assign(result, displayStats);

        return result;
    }

    /**
     * Finds all dropped items near a spatial coordinate.
     * @param {number} x - The X coordinate.
     * @param {number} y - The Y coordinate.
     * @param {number} radius - Search radius.
     * @returns {Array<{id: string, itemType: string, itemId: string, x: number, y: number, ownerId: string, distance: number}>}
     */
    findDroppedItemsNear(x, y, radius = 5) {
        const droppedItems = this.getDroppedItems();
        const nearby = [];

        for (const [id, item] of Object.entries(droppedItems)) {
            const dx = item.x - x;
            const dy = item.y - y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance <= radius) {
                nearby.push({ ...item, distance: Math.round(distance * 100) / 100 });
            }
        }

        return nearby;
    }
}

export default WorldStateController;