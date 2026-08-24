/**
 * BrokenComponentRemovalHandler — handler built-in, registrado 1º (§3.5, §3.5.2).
 * 
 * Delegador fino ao orquestrador da façade `removeBrokenComponent(payload)`.
 * A cascata completa (a)→(a½)→(b)→(c) vive no orquestrador da façade
 * (§3.6.4); este handler apenas invoca o método e deixa a façade fazer todo
 * o trabalho pesado.
 * 
 * Por que delegador fino: SRP (espelhando os consequence handlers).
 * A fase (a½) de dependência vive na façade porque só ela detém o
 * índice reverso, o contador de reentrância e todos os sub-controllers.
 * 
 * @module BrokenComponentRemovalHandler
 */

import Logger from '../../utils/Logger.js';

class BrokenComponentRemovalHandler {
    /**
     * @param {Object} deps
     * @param {import('../WorldStateController.js').default} deps.worldStateController
     */
    constructor(deps) {
        this._wsc = deps.worldStateController;
    }

    /**
     * Handler para evento `component:broke`.
     * §3.5: delega à façade removeBrokenComponent(payload).
     * @param {Object} payload - Payload do evento (§3.3).
     */
    handle(payload) {
        try {
            this._wsc.removeBrokenComponent(payload);
        } catch (error) {
            Logger.error(`[BrokenComponentRemovalHandler] Error in removeBrokenComponent: ${error.message}`, { payload });
            // Não re-lança: isolamento por handler (§3.2)
        }
    }
}

export default BrokenComponentRemovalHandler;
