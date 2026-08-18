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

import Logger from '../../utils/Logger.js';
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
     * @param {Object} [deps] - Named dependencies.
     * @param {EquippedItemStatsController} [deps.equippedItemStats] - Mutable equipped-item stats.
     * @param {WorldEventLogController|null} [deps.worldEventLog] - World event ring buffer
     *   (Feature B): the log handler forwards every resolved log message to it.
     *
     * FASE 5: the facade (WorldStateController) is no longer passed at construction.
     * It is injected via setWorldStateController() after the facade is fully built,
     * and propagated to the focused handlers (which keep reading
     * `this.worldStateController` exactly as before — their class bodies are untouched).
     */
    constructor({ equippedItemStats, worldEventLog = null } = {}) {
        /** @type {WorldStateController|null} Injected post-construction. */
        this.worldStateController = null;
        this.equippedItemStats = equippedItemStats || null;

        // Initialize focused handlers. The `controllers` bag carries the facade
        // reference each handler stores; setWorldStateController() keeps it in sync.
        const controllers = { worldStateController: this.worldStateController, equippedItemStats: this.equippedItemStats };
        this.spatialHandler = new SpatialConsequenceHandler(controllers);
        this.statHandler = new StatConsequenceHandler(controllers);
        // Pass equippedItemStats so DamageConsequenceHandler can route equipped item damage correctly
        const damageControllers = { ...controllers, equippedItemStats: this.equippedItemStats };
        this.damageHandler = new DamageConsequenceHandler(damageControllers);
        // Feature B: single choke point where "something happened in the world"
        // already produces a human sentence — forward it into the event buffer.
        // The closure reads this.worldStateController lazily (the facade is
        // injected post-construction, exactly like the existing handlers).
        const eventSink = worldEventLog
            ? (event) => worldEventLog.record({
                  ...event,
                  tick: this.worldStateController?.tickSystem?.currentTick ?? null
              })
            : null;
        this.logHandler = new LogConsequenceHandler(eventSink);
        this.eventHandler = new EventConsequenceHandler();

        // Cache the handler map once (it used to be rebuilt on every `handlers` access).
        // All handlers follow the normalized signature: (targetId, params, context)
        this._handlers = this._buildHandlerMap();
    }

    /**
     * Injects the world state facade (WorldStateController) after it is fully built,
     * and propagates it to the focused handlers. FASE 5: replaces the constructor-time
     * facade dependency (BUG-100 root cause).
     * @param {WorldStateController} worldStateController - The fully-built facade.
     */
    setWorldStateController(worldStateController) {
        this.worldStateController = worldStateController;
        this.spatialHandler.worldStateController = worldStateController;
        this.statHandler.worldStateController = worldStateController;
        this.damageHandler.worldStateController = worldStateController;
    }

    /**
     * Map of handler functions (cached, built once in the constructor).
     * All handlers follow a normalized signature: (targetId, params, context)
     * @returns {Object} Map of handler functions.
     */
    get handlers() {
        return this._handlers;
    }

    /**
     * Builds the handler map once. Kept private so the map stays an implementation
     * detail — external callers should use dispatch().
     * @returns {Object} Map of consequence type → handler function.
     * @private
     */
    _buildHandlerMap() {
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

    /**
     * Dispatches a consequence to its registered handler. Public entry point for
     * everything outside the dispatcher — callers no longer need to reach into
     * the `handlers` map (BUG-122).
     *
     * @param {string} type - The consequence type (e.g., 'pickUpItem').
     * @param {string|null} targetId - The resolved target component/entity ID.
     * @param {Object} params - Consequence parameters.
     * @param {Object} context - Action execution context.
     * @returns {{ success: boolean, error?: string }} Handler result, or
     *   { success: false, error: 'no-handler' } when no handler is registered.
     */
    dispatch(type, targetId, params, context) {
        const handler = this.handlers[type];

        if (typeof handler !== 'function') {
            Logger.error(`[ConsequenceHandlers] No handler registered for consequence type "${type}".`);
            return { success: false, error: 'no-handler' };
        }

        return handler(targetId, params, context);
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