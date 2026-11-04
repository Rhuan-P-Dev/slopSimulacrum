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
 * - SensitivePartConsequenceHandler: the touch action — raises the touched
 *   droid's Pleasure.pleasure by the sensitivity of the touched body part
 * - DoorTraversalHandler: the crossDoor action — walks the entity through a
 *   door of its current room into the room beyond
 *
 * @module ConsequenceHandlers
 */

import Logger from '../../utils/Logger.js';
import SpatialConsequenceHandler from './SpatialConsequenceHandler.js';
import StatConsequenceHandler from './StatConsequenceHandler.js';
import DamageConsequenceHandler from './DamageConsequenceHandler.js';
import MaterialChunkDropHandler from './MaterialChunkDropHandler.js';
import LogConsequenceHandler from './LogConsequenceHandler.js';
import EventConsequenceHandler from './EventConsequenceHandler.js';
import SensitivePartConsequenceHandler from './SensitivePartConsequenceHandler.js';
import { handleDropItem } from './DropItemHandler.js';
import { handlePickUpItem } from './PickUpItemHandler.js';
import { handleConsumeItemAndDamage } from './ConsumeItemHandler.js';
import { handlePlaceMachine } from '../core/PlaceMachineHandler.js';
import { handleRetrieveMachine } from '../core/RetrieveMachineHandler.js';
import { handleDoorTraversal } from './DoorTraversalHandler.js';

class ConsequenceHandlers {
    /**
     * @param {Object} [deps] - Named dependencies.
     * @param {EquippedItemStatsController} [deps.equippedItemStats] - Mutable equipped-item stats.
     * @param {MaterialController|null} [deps.materialController] - Feature 1: owns the
     *   per-material damage-type split (data/mods/core-material-damage-types/materialDamageTypes.json); forwarded to the
     *   damage handler. Null-tolerant (the feature degrades to the declared channel).
     * @param {WorldEventLogController|null} [deps.worldEventLog] - World event ring buffer
     *   (Feature B): the log handler forwards every resolved log message to it.
     *
     * FASE 5: the facade (WorldStateController) is no longer passed at construction.
     * It is injected via setWorldStateController() after the facade is fully built,
     * and propagated to the focused handlers (which keep reading
     * `this.worldStateController` exactly as before — their class bodies are untouched).
     */
    constructor({ equippedItemStats, worldEventLog = null, materialController = null, worldRulesController = null, machineRegistry = null } = {}) {
        /** @type {WorldStateController|null} Injected post-construction. */
        this.worldStateController = null;
        this.equippedItemStats = equippedItemStats || null;
        // Machine registry (data/mods/core-machines/machines.json): forwarded to the
        // place/retrieve machine handlers (data-driven item <-> machine bindings).
        // Null-tolerant (tests can omit it). Stored, not in setWorldStateController,
        // because it is static config data, not the mutable facade.
        this.machineRegistry = machineRegistry || null;
        // Feature 1: MaterialController owns the per-material damage-type split
        // (data/mods/core-material-damage-types/materialDamageTypes.json); forwarded to the damage handler below.
        this.materialController = materialController || null;
        // World-rules layer (WR-6): forwarded to the chunk-drop handler so the
        // torn-material step can read the active percentage. Null-tolerant.
        this.worldRulesController = worldRulesController || null;

        // Initialize focused handlers. The `controllers` bag carries the facade
        // reference each handler stores; setWorldStateController() keeps it in sync.
        const controllers = { worldStateController: this.worldStateController, equippedItemStats: this.equippedItemStats };
        this.spatialHandler = new SpatialConsequenceHandler(controllers);
        this.statHandler = new StatConsequenceHandler(controllers);
        // Pass equippedItemStats so DamageConsequenceHandler can route equipped item
        // damage correctly, and materialController for the per-material damage-type
        // split (feature 1).
        const damageControllers = { ...controllers, equippedItemStats: this.equippedItemStats, materialController: this.materialController };
        this.damageHandler = new DamageConsequenceHandler(damageControllers);
        // Feature 2: chunk drop on punch. Named deps only (the facade arrives via
        // setWorldStateController below); materialController is forwarded so the handler
        // can read the drop-rates registry (data/mods/core-material-drop-rates/materialDropRates.json).
        // World-rules layer (WR-6): worldRulesController is forwarded so the handler
        // can read the active torn-material percentage.
        const chunkControllers = { worldStateController: this.worldStateController, materialController: this.materialController, worldRulesController: this.worldRulesController };
        this.materialChunkDropHandler = new MaterialChunkDropHandler(chunkControllers);
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
        // The touch action (stimulateSensitivePart): the facade arrives via
        // setWorldStateController below; the sensitivity file loads in the
        // constructor (static world data).
        this.sensitivePartHandler = new SensitivePartConsequenceHandler(controllers);

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
        this.materialChunkDropHandler.worldStateController = worldStateController;
        this.sensitivePartHandler.worldStateController = worldStateController;
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
            // Random-spread channel damage (hand shotgun): N pellets, each hit
            // landing on a random living component of the target entity.
            damageRandomComponents: (targetId, params, context) => this.damageHandler._handleRandomComponentDamage(targetId, params, context),
            dropMaterialChunk: (targetId, params, context) => this.materialChunkDropHandler._handleDropMaterialChunk(targetId, params, context),
            dropItem: (targetId, params, context) => this._handleDropItem(params, context),
            pickUpItem: (targetId, params, context) => this._handlePickUpItem(params, context),
            consumeItemAndDamage: (targetId, params, context) => this._handleConsumeItemAndDamage(targetId, params, context),
            // Walk through a named door of the actor's current room into the room beyond.
            traverseDoor: (targetId, params, context) => this._handleTraverseDoor(params, context),
            // Place a carried machine into the world (becomes isStatic, self-running).
            placeMachine: (targetId, params, context) => this._handlePlaceMachine(params, context),
            // Retrieve a previously-placed machine back into inventory (spills stored contents).
            retrieveMachine: (targetId, params, context) => this._handleRetrieveMachine(params, context),
            // The touch action: raise the touched droid's Pleasure.pleasure by the
            // sensitivity of the touched body-part component (validated sensitive flag).
            stimulateSensitivePart: (targetId, params, context) => this.sensitivePartHandler._handleStimulateSensitivePart(targetId, params, context),
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

    /**
     * Handles the traverseDoor consequence by delegating to DoorTraversalHandler
     * (the `crossDoor` action: a door of the actor's current room, the room beyond).
     * @private
     */
    _handleTraverseDoor(params, context) {
        return handleDoorTraversal(
            { worldStateController: this.worldStateController },
            params,
            context
        );
    }

    /**
     * Handles the placeMachine consequence by delegating to PlaceMachineHandler.
     * The machine registry (item <-> machine bindings) and the world facade are
     * passed in the deps object. @private
     */
    _handlePlaceMachine(params, context) {
        return handlePlaceMachine(
            { worldStateController: this.worldStateController, machineRegistry: this.machineRegistry },
            params,
            context
        );
    }

    /**
     * Handles the retrieveMachine consequence by delegating to RetrieveMachineHandler.
     * @private
     */
    _handleRetrieveMachine(params, context) {
        return handleRetrieveMachine(
            { worldStateController: this.worldStateController, machineRegistry: this.machineRegistry },
            params,
            context
        );
    }
}

export default ConsequenceHandlers;