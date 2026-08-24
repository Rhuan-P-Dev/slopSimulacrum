/**
 * LlmAgentFeedbackController — Per-agent action-outcome feedback ring buffer.
 *
 * Purpose: a per-entity ring of recent action outcomes — the LLM agent's own
 * "what did I do and what happened" short-term memory. It is a state owner
 * (per the controller-pattern rule that state lives in a sub-controller) but
 * deliberately **not** broadcast (no `getAll()`), exactly like
 * `WorldEventLogController` and `RoomChatController`.
 *
 * Outcome entry shape:
 *   { round, actionName, componentId, targetEntityId, queued, success, detail, instinct?, atTick }
 *   `instinct` is an optional sanitized string field (present when the action came from an instinct expansion).
 *
 * @module LlmAgentFeedbackController
 */

import Logger from '../../utils/Logger.js';

class LlmAgentFeedbackController {
    /**
     * @param {number} [capacityPerAgent = 5] - Maximum number of retained outcomes PER entity.
     */
    constructor(capacityPerAgent = 5) {
        if (!Number.isInteger(capacityPerAgent) || capacityPerAgent <= 0) {
            throw new TypeError(
                `LlmAgentFeedbackController: capacityPerAgent must be a positive integer, got ${capacityPerAgent}`
            );
        }
        /** @private {number} */
        this._capacityPerAgent = capacityPerAgent;
        /** @private {Map<string, Array>} entityId → ring of outcome entries (oldest→newest). */
        this._stores = new Map();
    }

    /**
     * Records an action outcome for an entity. Evicts oldest beyond capacity.
     * @param {string} entityId
     * @param {Object} outcome - Outcome entry (stamped with `atTick` if not already present).
     * @returns {void}
     */
    record(entityId, outcome) {
        if (typeof entityId !== 'string' || entityId.length === 0) {
            throw new TypeError('LlmAgentFeedbackController.record: entityId must be a non-empty string');
        }
        if (!outcome || typeof outcome !== 'object') {
            throw new TypeError('LlmAgentFeedbackController.record: outcome must be an object');
        }
        if (!this._stores.has(entityId)) {
            this._stores.set(entityId, []);
        }
        const ring = this._stores.get(entityId);
        // Sanitize the optional instinct field: must be a non-empty string, else null.
        const rawInstinct = outcome.instinct;
        const instinct = (typeof rawInstinct === 'string' && rawInstinct.length > 0) ? rawInstinct : null;
        const entry = {
            round: typeof outcome.round === 'number' ? outcome.round : 0,
            actionName: typeof outcome.actionName === 'string' ? outcome.actionName : 'unknown',
            componentId: outcome.componentId ?? null,
            targetEntityId: outcome.targetEntityId ?? null,
            queued: Boolean(outcome.queued),
            success: Boolean(outcome.success),
            detail: typeof outcome.detail === 'string' ? outcome.detail : 'unknown outcome',
            instinct,
            atTick: typeof outcome.atTick === 'number' ? outcome.atTick : 0
        };
        ring.push(entry);
        if (ring.length > this._capacityPerAgent) {
            ring.shift();
        }
    }

    /**
     * Returns this entity's recent outcomes (oldest → newest), as defensive copies.
     * @param {string} entityId
     * @param {number} [limit = 5] - Maximum number of entries.
     * @returns {Array}
     */
    getRecent(entityId, limit = 5) {
        if (typeof entityId !== 'string' || entityId.length === 0) {
            throw new TypeError('LlmAgentFeedbackController.getRecent: entityId must be a non-empty string');
        }
        if (!Number.isInteger(limit) || limit < 0) {
            throw new TypeError('LlmAgentFeedbackController.getRecent: limit must be a non-negative integer');
        }
        const ring = this._stores.get(entityId);
        if (!ring || ring.length === 0) {
            return [];
        }
        const start = Math.max(0, ring.length - limit);
        return ring.slice(start).map(entry => structuredClone(entry));
    }

    /**
     * Clears the ring for a specific entity.
     * @param {string} entityId
     * @returns {void}
     */
    clear(entityId) {
        this._stores.delete(entityId);
    }

    /**
     * Returns all data for persistence (deep-copied).
     * @returns {Object} - { [entityId]: Array<outcome> }
     */
    serialize() {
        const result = {};
        for (const [entityId, ring] of this._stores.entries()) {
            result[entityId] = ring.map(entry => structuredClone(entry));
        }
        return result;
    }

    /**
     * Restores data from a serialized object.
     * @param {Object} store - { [entityId]: Array<outcome> }
     * @returns {void}
     */
    restore(store) {
        if (!store || typeof store !== 'object' || Array.isArray(store)) {
            Logger.warn('[LlmAgentFeedbackController] restore() called with a malformed store — ignoring.');
            return;
        }
        for (const [entityId, ring] of Object.entries(store)) {
            if (!Array.isArray(ring)) continue;
            this._stores.set(entityId, ring
                .slice(-this._capacityPerAgent)
                .map(entry => (entry && typeof entry === 'object') ? structuredClone(entry) : entry)
            );
        }
    }
}

export default LlmAgentFeedbackController;
