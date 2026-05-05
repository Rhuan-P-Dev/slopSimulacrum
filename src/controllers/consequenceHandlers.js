/**
 * ConsequenceHandlers — Lightweight dispatcher that delegates to focused handler modules.
 * Single Responsibility: Route consequence types to their dedicated handlers.
 *
 * All handler logic has been extracted to single-focused modules:
 * - SpatialConsequenceHandler: Spatial coordinate updates and delta movements
 * - StatConsequenceHandler: Stat value updates on components and entities
 * - DamageConsequenceHandler: Damage application to components
 * - LogConsequenceHandler: Logging of action events
 * - EventConsequenceHandler: Event triggering for logging/notification
 * - EquipmentConsequenceHandler: Equipment grab, release, and drop operations
 *
 * @module ConsequenceHandlers
 */

import SpatialConsequenceHandler from './SpatialConsequenceHandler.js';
import StatConsequenceHandler from './StatConsequenceHandler.js';
import DamageConsequenceHandler from './DamageConsequenceHandler.js';
import LogConsequenceHandler from './LogConsequenceHandler.js';
import EventConsequenceHandler from './EventConsequenceHandler.js';
import EquipmentConsequenceHandler from './EquipmentConsequenceHandler.js';

class ConsequenceHandlers {
    /**
     * @param {Object} controllers - The set of available controllers (WorldStateController, etc.)
     * @param {WorldStateController} controllers.worldStateController - The root state controller.
     */
    constructor(controllers) {
        this.worldStateController = controllers.worldStateController;

        // Initialize focused handlers
        this.spatialHandler = new SpatialConsequenceHandler(controllers);
        this.statHandler = new StatConsequenceHandler(controllers);
        this.damageHandler = new DamageConsequenceHandler(controllers);
        this.logHandler = new LogConsequenceHandler();
        this.eventHandler = new EventConsequenceHandler();
        this.equipmentHandler = new EquipmentConsequenceHandler(controllers);
    }

    /**
     * Map of handler functions.
     * All handlers now follow a normalized signature: (targetId, params, context)
     * @returns {Object} Map of handler functions.
     */
    get handlers() {
        return {
            updateSpatial: (targetId, params, context) => this.spatialHandler._handleUpdateSpatial(targetId, params, context),
            deltaSpatial: (targetId, params, context) => this.spatialHandler._handleDeltaSpatial(targetId, params, context),
            log: (targetId, params, context) => this.logHandler._handleLog(targetId, params, context),
            updateStat: (targetId, params, context) => this.statHandler._handleUpdateStat(targetId, params, context),
            updateComponentStatDelta: (targetId, params, context) => this.statHandler._handleUpdateComponentStatDelta(targetId, params, context),
            triggerEvent: (targetId, params, context) => this.eventHandler._handleTriggerEvent(targetId, params, context),
            damageComponent: (targetId, params, context) => this.damageHandler._handleDamageComponent(targetId, params, context),
            grabItem: (targetId, params, context) => this.equipmentHandler._handleGrabItem(targetId, params, context),
            releaseItem: (targetId, params, context) => this.equipmentHandler._handleReleaseItem(targetId, params, context),
            grabToBackpack: (targetId, params, context) => this.equipmentHandler._handleGrabToBackpack(targetId, params, context),
            dropAll: (targetId, params, context) => this.equipmentHandler._handleDropAll(targetId, params, context),
        };
    }
}

export default ConsequenceHandlers;