/**
 * BrokenComponentRemovalHandler — built-in handler, registered first.
 *
 * Thin delegate to the facade's orchestrator `removeBrokenComponent(payload)`.
 * The full cascade (a)→(a½)→(b)→(c) lives in the facade's orchestrator
 * (this handler only invokes the method and lets the facade do all
 * the heavy lifting.
 *
 * Why thin delegate: SRP (mirroring the consequence handlers).
 * Phase (a½) dependency lives in the facade because only it holds the
 * reverse index, re-entrancy counter, and all sub-controllers.
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
     * Handler for `component:broke` event.
     * Delegates to facade removeBrokenComponent(payload).
     * @param {Object} payload - Event payload.
     */
    handle(payload) {
        try {
            this._wsc.removeBrokenComponent(payload);
        } catch (error) {
            Logger.error(`[BrokenComponentRemovalHandler] Error in removeBrokenComponent: ${error.message}`, { payload });
            // Does not re-throw: isolation per handler
        }
    }
}

export default BrokenComponentRemovalHandler;
