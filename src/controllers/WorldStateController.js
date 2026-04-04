const RoomsController = require('./RoomsController');

/**
 * WorldStateController acts as a high-level coordinator for the server's global state.
 * It manages various sub-controllers and provides a unified interface to access
 * the current state of the simulated world.
 */
class WorldStateController {
    constructor() {
        // Initialize sub-controllers
        this.roomsController = new RoomsController();
        
        // Map of sub-controllers for easy iteration/extension
        this.subControllers = {
            rooms: this.roomsController
        };
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
