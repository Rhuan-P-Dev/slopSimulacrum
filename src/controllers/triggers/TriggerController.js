/**
 * TriggerController — core of the engine's event system (§3.2).
 *
 * Consumer of existing stat notifications (ComponentController +
 * EquippedItemStatsController, delegated via the WorldStateController facade).
 * Detects crossing `old > 0 → new <= 0` in Physical.existence (threshold 0,
 * spec §3.1) and emits `component:broke` with payload from §3.3.
 *
 * DI pattern: on/off for handler registration, emit for execution with
 * isolation per handler (try/catch). Built at the composition root, with
 * facade and broadcaster injected post-construction.
 *
 * @module TriggerController
 */

import Logger from '../../utils/Logger.js';
import { EXISTENCE_GONE_AT } from '../../../shared/StatVocabulary.js';
import { SOCKET_EVENTS } from '../../../shared/SocketProtocol.js';

class TriggerController {
    constructor() {
        /** @private {Map<string, Array<Function>>} */
        this._handlers = new Map();
        /** @private {import('../WorldStateController.js').default|null} */
        this._worldStateController = null;
        /** @private {Function|null} */
        this._broadcaster = null;
    }

    /**
     * Injects the WorldStateController facade (called by the composition root).
     * @param {import('../WorldStateController.js').default} wsc
     */
    setWorldStateController(wsc) {
        this._worldStateController = wsc;
    }

    /**
     * Injects the broadcast service (called by the composition root).
     * @param {Function} broadcaster
     */
    setBroadcaster(broadcaster) {
        this._broadcaster = broadcaster;
    }

    /**
     * Registers a handler for an event.
     * @param {string} event - Event name.
     * @param {Function} handler - Callback function(payload).
     */
    on(event, handler) {
        if (!this._handlers.has(event)) {
            this._handlers.set(event, []);
        }
        this._handlers.get(event).push(handler);
    }

    /**
     * Removes a registered handler.
     * @param {string} event - Event name.
     * @param {Function} handler - Handler to remove.
     */
    off(event, handler) {
        const handlers = this._handlers.get(event);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index !== -1) {
                handlers.splice(index, 1);
            }
        }
    }

    /**
     * Executes all registered handlers for the event, with isolation per handler.
     * @param {string} event - Event name.
     * @param {Object} payload - Event payload.
     */
    emit(event, payload) {
        const handlers = this._handlers.get(event);
        if (!handlers || handlers.length === 0) {
            // §4.5 fallback defensivo: sem handlers → invocar _broadcaster (se injetado)
            if (this._broadcaster && typeof this._broadcaster === 'function') {
                try {
                    this._broadcaster();
                } catch (error) {
                    Logger.error(`[TriggerController] Broadcaster fallback error for event "${event}": ${error.message}`);
                }
            }
            return;
        }

        for (const handler of handlers) {
            try {
                handler(payload);
            } catch (error) {
                Logger.error(`[TriggerController] Handler error for event "${event}": ${error.message}`, { event, payload: { ...payload, /* omit large refs */ } });
            }
        }
    }

    /**
     * Checks for existence crossing and emits `component:broke` if applicable.
     * §3.1: old > 0 → new <= 0 only triggers.
     *
     * @param {string} componentId - ID of the component instance.
     * @param {string} entityId - Entity owning the component.
     * @param {number} oldValue - Old existence value.
     * @param {number} newValue - New existence value.
     * @param {Object} extra - Additional data (roomId, position, tick).
     */
    onComponentBrokeCheck(componentId, entityId, oldValue, newValue, extra = {}) {
        // Spec §3.1: crossing = strictly-positive-old → zero-or-below-new (purely stat-based)
        if (oldValue > EXISTENCE_GONE_AT && newValue <= EXISTENCE_GONE_AT) {
            const payload = this._buildPayload(componentId, entityId, oldValue, newValue, extra);
            
            // Registra no event log (§3.2)
            if (this._worldStateController && this._worldStateController.worldEventLogController) {
                this._worldStateController.worldEventLogController.record({
                    action: 'component:broke',
                    level: 'warn',
                    tick: extra.tick ?? 0,
                    targetId: componentId,
                    message: `Component ${componentId} broke (existence ${oldValue} → ${newValue})`
                });
            }

            this.emit(SOCKET_EVENTS.COMPONENT_BROKE, payload);
        }
    }

    /**
     * Constructs the `component:broke` event payload (§3.3).
     * @private
     */
    _buildPayload(componentId, entityId, oldValue, newValue, extra) {
        // Use nullish coalescing (??) so defined falsy values (e.g. roomId: '') survive.
        // When a value is truly undefined, fall back to default AND warn via Logger.
        const roomId = extra.roomId ?? (() => {
            Logger.warn(`[TriggerController] Missing roomId anchor for trigger "${componentId}" on entity "${entityId}"`, { componentId, entityId, oldValue, newValue });
            return null;
        })();
        const position = extra.position ?? (() => {
            Logger.warn(`[TriggerController] Missing position anchor for trigger "${componentId}" on entity "${entityId}"`, { componentId, entityId, oldValue, newValue });
            return { x: 0, y: 0 };
        })();

        return {
            event: SOCKET_EVENTS.COMPONENT_BROKE,
            entityId,
            roomId,
            position,
            componentId,
            componentType: extra.componentType || null,
            componentIdentifier: extra.componentIdentifier || null,
            kind: 'component',
            prevValue: oldValue,
            value: newValue,
            tick: extra.tick ?? 0
        };
    }

    /**
     * Version for equipped item (§3.3 kind = 'equipped-item').
     * @param {string} eqId - ID of the equipped item.
     * @param {string} entityId - Owning entity.
     * @param {string} hostComponentId - Host component.
     * @param {number} oldValue - Old value.
     * @param {number} newValue - New value.
     * @param {Object} extra - Additional data.
     */
    onEquippedItemBrokeCheck(eqId, entityId, hostComponentId, oldValue, newValue, extra = {}) {
        // Spec §3.1: crossing = strictly-positive-old → zero-or-below-new (purely stat-based)
        if (oldValue > EXISTENCE_GONE_AT && newValue <= EXISTENCE_GONE_AT) {
            // Use nullish coalescing (??) so defined falsy values (e.g. roomId: '') survive.
            const roomId = extra.roomId ?? (() => {
                Logger.warn(`[TriggerController] Missing roomId anchor for equipped-item "${eqId}" on entity "${entityId}"`, { eqId, entityId, oldValue, newValue });
                return null;
            })();
            const position = extra.position ?? (() => {
                Logger.warn(`[TriggerController] Missing position anchor for equipped-item "${eqId}" on entity "${entityId}"`, { eqId, entityId, oldValue, newValue });
                return { x: 0, y: 0 };
            })();

            const payload = {
                event: SOCKET_EVENTS.COMPONENT_BROKE,
                entityId,
                roomId,
                position,
                componentId: hostComponentId,
                componentType: null,
                componentIdentifier: null,
                kind: 'equipped-item',
                eqId,
                itemType: extra.itemType || null,
                itemId: extra.itemId || eqId,
                prevValue: oldValue,
                value: newValue,
                tick: extra.tick ?? 0
            };

            // Records in the event log
            if (this._worldStateController && this._worldStateController.worldEventLogController) {
                this._worldStateController.worldEventLogController.record({
                    action: 'component:broke',
                    level: 'warn',
                    tick: extra.tick ?? 0,
                    targetId: eqId,
                    message: `Equipped item ${eqId} broke (existence ${oldValue} → ${newValue})`
                });
            }

            this.emit(SOCKET_EVENTS.COMPONENT_BROKE, payload);
        }
    }
}

export default TriggerController;
