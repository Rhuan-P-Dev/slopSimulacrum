import RoomsController from './RoomsController.js';
import stateEntityController from './stateEntityController.js';
import ComponentController from './componentController.js';
import EntityController from './entityController.js';
import ComponentStatsController from './componentStatsController.js';
import TraitsController from './traitsController.js';
import ActionController from './actionController.js';
import ComponentCapabilityController from './componentCapabilityController.js';
import SynergyController from './synergyController.js';
import ActionSelectController from './actionSelectController.js';
import ConsequenceHandlers from './consequenceHandlers.js';
import DataLoader from '../utils/DataLoader.js';

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
            console.warn('[WorldStateController] Action registry is empty or missing. Actions will not be available.');
        }

        // 1. Instantiate Data Stores (Bottom level)
        const statsController = new ComponentStatsController();
        const traitsController = new TraitsController(traitsRegistry);

        // 2. Instantiate Logic Controllers (Middle level - Injected with Data Stores and Registries)
        const componentController = new ComponentController(statsController, traitsController, componentRegistry);
        const entityController = new EntityController(componentController);

        // 3. Instantiate Instance Managers (Top level - Injected with Logic Controllers)
        const stateEntityControllerInstance = new stateEntityController(entityController);
        const roomsController = new RoomsController();

        // Assign to the WorldStateController for coordination and the getAll() method
        this.roomsController = roomsController;
        this.stateEntityController = stateEntityControllerInstance;
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

        // Wire the actionController reference into stateEntityController for spawn/despawn hooks
        // Must be done AFTER actionController is instantiated (forward reference)
        this.stateEntityController.actionController = actionController;

        // 7. Wire up stat change notifications from ComponentController to ComponentCapabilityController
        // This enables automatic capability re-evaluation when component stats change
        this.componentController.registerStatChangeListener((componentId, traitId, statName, newValue, oldValue) => {
            this.componentCapabilityController.onStatChange(componentId, traitId, statName, newValue, oldValue);
        });

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
}

export default WorldStateController;