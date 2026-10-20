/**
 * AppBoot — the ClientApp constructor's guarded panel-init sequence,
 * extracted (T10, plans/FIX-PLAN-2026-09.md).
 *
 * House shape (the app instance as first argument — the convention ruling
 * in plans/FIX-PLAN-2026-09.md T9, applied to the client): these three
 * panel inits run at the end of the ClientApp constructor (steps 13b-13d,
 * immediately after every collaborator is assigned), so the function only
 * reads those stored references.
 *
 * The order and the try/catch guards are part of the contract: turns ->
 * room chat, each wrapped so a missing slot / DOM issue can never break
 * app startup (a failure here would take down the whole client, not just
 * one optional panel). The blocks are moved verbatim.
 */

import ClientLogger from '../utils/ClientLogger.js';

/**
 * Initializes the optional boot-time panels (turn HUD, room chat, events),
 * each guarded so a missing slot / DOM issue can never break app startup.
 * @param {import('./App.js').ClientApp} app - the app instance (constructor, after all collaborators)
 */
export function initGuardedPanels(app) {
    // 13b. Feature A: initialize the turn HUD in the config-bar slot.
    // Wrapped so a missing slot / DOM issue can never break app startup.
    try {
        app.turns.init();
    } catch (err) {
        ClientLogger.error('App', 'Turn HUD init failed (UI unaffected):', err);
    }

    // 13c. Feature D: initialize the room chat panel. Same guard — a
    // missing panel must never break startup.
    try {
        app.roomChat.init();
    } catch (err) {
        ClientLogger.error('App', 'Room chat init failed (UI unaffected):', err);
    }
}
