/**
 * TriggerController — núcleo do sistema de eventos de engine (§3.2).
 *
 * Consumidor das notificações de stat já existentes (ComponentController +
 * EquippedItemStatsController, delegadas pela façade WorldStateController).
 * Detecta crossing `old > 0 → new <= 0` em Physical.durability (threshold 0,
 * spec §3.1) e emite `component:broke` com payload do §3.3.
 *
 * Padrão DI: on/off para registro de handlers, emit para execução com
 * isolamento por handler (try/catch). Construído na composition root, com
 * façade e broadcaster injetados pós-construção.
 *
 * @module TriggerController
 */

import Logger from '../../utils/Logger.js';

/**
 * Limiar de quebra — spec §3.1: crossing é oldValue > 0 && newValue <= 0.
 * Threshold = 0 garante que FRACTIONAL values (e.g. 0.5) NÃO disparam break;
 * apenas o cruzamento estrito de positivo → zero ou negativo dispara.
 * @constant
 */
const BROKEN_DURABILITY_THRESHOLD = 0;

/**
 * Nome do stat que dispara o evento.
 * @constant
 */
const STAT_TRAIT = 'Physical';
const STAT_NAME = 'durability';

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
     * Injeta a façade WorldStateController (chamado pela composition root).
     * @param {import('../WorldStateController.js').default} wsc
     */
    setWorldStateController(wsc) {
        this._worldStateController = wsc;
    }

    /**
     * Injeta o serviço de broadcast (chamado pela composition root).
     * @param {Function} broadcaster
     */
    setBroadcaster(broadcaster) {
        this._broadcaster = broadcaster;
    }

    /**
     * Registra um handler para um evento.
     * @param {string} event - Nome do evento.
     * @param {Function} handler - Função callback(payload).
     */
    on(event, handler) {
        if (!this._handlers.has(event)) {
            this._handlers.set(event, []);
        }
        this._handlers.get(event).push(handler);
    }

    /**
     * Remove um handler registrado.
     * @param {string} event - Nome do evento.
     * @param {Function} handler - Handler a remover.
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
     * Executa todos os handlers registrados para o evento, com isolamento por handler.
     * @param {string} event - Nome do evento.
     * @param {Object} payload - Payload do evento.
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
     * Verifica crossing de durability e emite `component:broke` se aplicável.
     * §3.1: old > 0 → new <= 0 apenas dispara.
     * 
     * @param {string} componentId - ID da instância de componente.
     * @param {string} entityId - Entidade dona do componente.
     * @param {number} oldValue - Valor antigo da durabilidade.
     * @param {number} newValue - Novo valor da durabilidade.
     * @param {Object} extra - Dados adicionais (roomId, position, tick).
     */
    onComponentBrokeCheck(componentId, entityId, oldValue, newValue, extra = {}) {
        // Spec §3.1: crossing = strictly-positive-old → zero-or-below-new (purely stat-based)
        if (oldValue > BROKEN_DURABILITY_THRESHOLD && newValue <= BROKEN_DURABILITY_THRESHOLD) {
            const payload = this._buildPayload(componentId, entityId, oldValue, newValue, extra);
            
            // Registra no event log (§3.2)
            if (this._worldStateController && this._worldStateController.worldEventLogController) {
                this._worldStateController.worldEventLogController.record({
                    action: 'component:broke',
                    level: 'warn',
                    tick: extra.tick ?? 0,
                    targetId: componentId,
                    message: `Component ${componentId} broke (durability ${oldValue} → ${newValue})`
                });
            }

            this.emit('component:broke', payload);
        }
    }

    /**
     * Monta o payload do evento `component:broke` (§3.3).
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
            event: 'component:broke',
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
     * Versão para item equipado (§3.3 kind = 'equipped-item').
     * @param {string} eqId - ID do item equipado.
     * @param {string} entityId - Entidade dona.
     * @param {string} hostComponentId - Componente host.
     * @param {number} oldValue - Valor antigo.
     * @param {number} newValue - Novo valor.
     * @param {Object} extra - Dados adicionais.
     */
    onEquippedItemBrokeCheck(eqId, entityId, hostComponentId, oldValue, newValue, extra = {}) {
        // Spec §3.1: crossing = strictly-positive-old → zero-or-below-new (purely stat-based)
        if (oldValue > BROKEN_DURABILITY_THRESHOLD && newValue <= BROKEN_DURABILITY_THRESHOLD) {
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
                event: 'component:broke',
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

            // Registra no event log
            if (this._worldStateController && this._worldStateController.worldEventLogController) {
                this._worldStateController.worldEventLogController.record({
                    action: 'component:broke',
                    level: 'warn',
                    tick: extra.tick ?? 0,
                    targetId: eqId,
                    message: `Equipped item ${eqId} broke (durability ${oldValue} → ${newValue})`
                });
            }

            this.emit('component:broke', payload);
        }
    }
}

export default TriggerController;
