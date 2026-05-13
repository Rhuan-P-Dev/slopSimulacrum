import RoomsController from './core/RoomsController.js';
import stateEntityController from './core/stateEntityController.js';
import ComponentController from './core/componentController.js';
import EntityController from './core/entityController.js';
import ComponentStatsController from './core/componentStatsController.js';
import TraitsController from './traits/TraitsController.js';
import ActionController from './actions/actionController.js';
import ComponentCapabilityController from './capabilities/componentCapabilityController.js';
import SynergyController from './synergy/synergyController.js';
import ActionSelectController from './actions/actionSelectController.js';
import ConsequenceHandlers from './consequences/consequenceHandlers.js';
import DataLoader from '../utils/DataLoader.js';
import Logger from '../utils/Logger.js';
import WorldGraphBuilder from '../utils/WorldGraphBuilder.js';

/**
 * WorldStateController acts as a high-level coordinator for the server's global state.
 * It manages various sub-controllers and provides a unified interface to access
 * the current state of the simulated world.
 *
 * This class acts as the Root Injector, ensuring all controllers share the same
 * state instances to prevent desynchronization.
 */
class WorldStateController {
    constructor() {
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

        // 7. Instantiate ActionController (Top level - Injected with Dependencies)
        // NOTE: Create consequenceHandlers AFTER properties are assigned to avoid receiving partially initialized controller
        const consequenceHandlers = new ConsequenceHandlers({ worldStateController: this });
        const actionController = new ActionController(
            this,
            consequenceHandlers,
            actionRegistry,
            componentCapabilityController,
            synergyController,
            actionSelectController
        );
        this.actionController = actionController;

        // 8. Instantiate stateEntityController with actionController (after ActionController is created)
        // This follows proper DI pattern - no forward references needed
        const stateEntityControllerInstance = new stateEntityController(entityController, actionController, null);
        this.stateEntityController = stateEntityControllerInstance;

        // 7. Wire up stat change notifications from ComponentController to ComponentCapabilityController
        // This enables automatic capability re-evaluation when component stats change
        this.componentController.registerStatChangeListener((componentId, traitId, statName, newValue, oldValue) => {
            this.componentCapabilityController.onStatChange(componentId, traitId, statName, newValue, oldValue);
            // Trigger broadcast if broadcastService is available
            if (this._broadcastService) {
                this._broadcastService.broadcast();
            }
        });

        // 8. Broadcast service (injected via setBroadcastService() from server.js)
        /** @private {WorldStateBroadcastService|null} */
        this._broadcastService = null;

        // Map of sub-controllers for easy iteration/extension
        this.subControllers = {
            rooms: this.roomsController,
            entities: this.stateEntityController,
            components: this.componentController,
            actions: this.actionController,
            capabilities: this.componentCapabilityController,
            synergy: this.synergyController,
            selections: this.actionSelectController
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

        // Spawn the small ball droid in the resolved start room UUID
        this.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

        // Spawn the vault guardian droid in the Deep Vault
        const vaultRoomId = this.roomsController.getUidByLogicalId('far_right_room');
        this.stateEntityController.spawnEntity('smallBallDroid', vaultRoomId);
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
     * Retrieves an entity's component by its component ID.
     * @param {string} componentId - The component ID.
     * @returns {Object|null} The component object, or null if not found.
     */
    getComponent(componentId) {
        return this.componentController.getComponent(componentId);
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
     * @param {string} componentId - The component ID to release.
     * @returns {boolean} Whether the selection was released.
     */
    releaseSelection(componentId) {
        return this.actionSelectController.releaseSelection(componentId);
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
}

export default WorldStateController;
