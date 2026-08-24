/**
 * BrokenComponentRemovalHandler — built-in handler, registered first (§3.5, §3.5.2).
 *
 * Thin delegate to the facade's orchestrator `removeBrokenComponent(payload)`.
 * The full cascade (a)→(a½)→(b)→(c) lives in the facade's orchestrator
 * (§3.6.4); this handler only invokes the method and lets the facade do all
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
     * §3.5: delegates to facade removeBrokenComponent(payload).
     * @param {Object} payload - Event payload (§3.3).
     */
    handle(payload) {
        try {
            this._wsc.removeBrokenComponent(payload);
        } catch (error) {
            Logger.error(`[BrokenComponentRemovalHandler] Error in removeBrokenComponent: ${error.message}`, { payload });
            // Does not re-throw: isolation per handler (§3.2)
        }
    }
}

export default BrokenComponentRemovalHandler;
