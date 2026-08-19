/**
 * HintManager — Client module for fetching and displaying deterministic hints.
 *
 * Fires-and-forgets on out-of-range errors: fetches a hint from the server,
 * shows a cyan popup with the message, and renders a transient marker at the
 * suggested (x, y) on the spatial map. Never throws; never blocks UI.
 *
 * @module HintManager
 */

import { AppConfig } from './Config.js';
import ClientLogger from '/utils/ClientLogger.js';

export class HintManager {
    /**
     * @param {Object} deps
     * @param {import('./UIManager.js').UIManager} deps.uiManager
     */
    constructor({ uiManager }) {
        this._ui = uiManager;
    }

    /**
     * Fetch hints from the server.
     * @param {string} entityId - The entity ID (ent-…).
     * @param {string} targetId - Optional specific target to hint about.
     * @returns {Promise<Array>} Hints array; empty on failure.
     */
    async fetchHints(entityId, targetId) {
        try {
            const params = new URLSearchParams({ entityId });
            if (targetId) params.set('targetId', targetId);
            const url = `${AppConfig.ENDPOINTS.HINTS}?${params.toString()}`;
            const res = await fetch(url, { method: 'GET' });
            if (!res.ok) {
                ClientLogger.warn('HintManager', `fetchHints: HTTP ${res.status} for ${url}`);
                return [];
            }
            const body = await res.json();
            return body && Array.isArray(body.hints) ? body.hints : [];
        } catch (err) {
            ClientLogger.warn('HintManager', `fetchHints failed: ${err?.message || err}`);
            return [];
        }
    }

    /**
     * Fire-and-forget: on an out-of-range click, fetch hints and display the first.
     * @param {string} entityId - The entity ID (ent-…).
     * @param {string} targetId - The dropped item id that was out of range.
     */
    async onOutOfRangeClick(entityId, targetId) {
        try {
            const hints = await this.fetchHints(entityId, targetId);
            if (!hints || hints.length === 0) return;

            const hint = hints[0];
            this._ui.showHintPopup(hint.message);
            this._ui.renderHintMarker(hint.suggestedPosition.x, hint.suggestedPosition.y);
        } catch (err) {
            ClientLogger.warn('HintManager', `onOutOfRangeClick failed: ${err?.message || err}`);
        }
    }
}
