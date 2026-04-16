const RoomsController = require('./RoomsController');
const stateEntityController = require('./stateEntityController');
const ComponentController = require('./componentController');
const EntityController = require('./entityController');
const ComponentStatsController = require('./componentStatsController');
const TraitsController = require('./traitsController');
const ActionController = require('./actionController');
const ConsequenceHandlers = require('./consequenceHandlers');
const DataLoader = require('../utils/DataLoader');

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
        
        // 4. Instantiate ActionController (Top level - Injected with Dependencies)
        // NOTE: Create consequenceHandlers AFTER properties are assigned to avoid receiving partially initialized controller
        const consequenceHandlers = new ConsequenceHandlers({ worldStateController: this });
        const actionController = new ActionController(this, consequenceHandlers, actionRegistry);
        this.actionController = actionController;
        
        // Map of sub-controllers for easy iteration/extension
        this.subControllers = {
            rooms: this.roomsController,
            entities: this.stateEntityController,
            components: this.componentController,
            actions: this.actionController
        };

        // Initialize world with a sample droid as requested
        this.initializeWorld();
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
}

module.exports = WorldStateController;
