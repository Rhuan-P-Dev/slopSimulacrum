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
 *
 * @module ConsequenceHandlers
 */

import SpatialConsequenceHandler from './SpatialConsequenceHandler.js';
import StatConsequenceHandler from './StatConsequenceHandler.js';
import DamageConsequenceHandler from './DamageConsequenceHandler.js';
import LogConsequenceHandler from './LogConsequenceHandler.js';
import EventConsequenceHandler from './EventConsequenceHandler.js';
import { handleDropItem } from './DropItemHandler.js';
import { handlePickUpItem } from './PickUpItemHandler.js';
import { handleConsumeItemAndDamage } from './ConsumeItemHandler.js';

class ConsequenceHandlers {
    /**
     * @param {Object} controllers - The set of available controllers (WorldStateController, etc.)
     * @param {WorldStateController} controllers.worldStateController - The root state controller.
     */
    constructor(controllers) {
        this.worldStateController = controllers.worldStateController;
        this.equippedItemStats = controllers.equippedItemStats || null;

        // Initialize focused handlers
        this.spatialHandler = new SpatialConsequenceHandler(controllers);
        this.statHandler = new StatConsequenceHandler(controllers);
        // Pass equippedItemStats so DamageConsequenceHandler can route equipped item damage correctly
        const damageControllers = { ...controllers, equippedItemStats: this.equippedItemStats };
        this.damageHandler = new DamageConsequenceHandler(damageControllers);
        this.logHandler = new LogConsequenceHandler();
        this.eventHandler = new EventConsequenceHandler();
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
            dropItem: (targetId, params, context) => this._handleDropItem(params, context),
            pickUpItem: (targetId, params, context) => this._handlePickUpItem(params, context),
            consumeItemAndDamage: (targetId, params, context) => this._handleConsumeItemAndDamage(targetId, params, context),
        };
    }

    // =========================================================================
    // ITEM HANDLER WRAPPERS
    // =========================================================================

    /**
     * Handles the dropItem consequence by delegating to DropItemHandler.
     * @private
     */
    _handleDropItem(params, context) {
        return handleDropItem(
            { worldStateController: this.worldStateController },
            params,
            context
        );
    }

    /**
     * Handles the pickUpItem consequence by delegating to PickUpItemHandler.
     * @private
     */
    _handlePickUpItem(params, context) {
        return handlePickUpItem(
            {
                worldStateController: this.worldStateController,
                holdingCostController: this.worldStateController.holdingCostController
            },
            params,
            context
        );
    }

    /**
     * Handles the consumeItemAndDamage consequence by delegating to ConsumeItemHandler.
     * @private
     */
    _handleConsumeItemAndDamage(targetId, params, context) {
        return handleConsumeItemAndDamage(
            {
                worldStateController: this.worldStateController,
                damageHandler: this.damageHandler
            },
            targetId,
            params,
            context
        );
    }
}

export default ConsequenceHandlers;