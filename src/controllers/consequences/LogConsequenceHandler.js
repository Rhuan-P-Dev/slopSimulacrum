/**
 * LogConsequenceHandler — Handles logging of action events.
 * Single Responsibility: Write structured log messages at specified severity levels.
 *
 * Extracted from ConsequenceHandlers to adhere to the Single Responsibility Principle.
 *
 * Target Resolution:
 * - 'self'    → Logs with the source component ID as context.
 * - 'target'  → Logs with the explicitly targeted component/entity ID as context.
 * - 'entity'  → Logs with the entity ID as context.
 *
 * Feature B: optionally forwards the resolved message to an event sink
 * (the world event ring buffer), so the action pipeline's "something
 * happened" sentences are retained in memory — not only in the server log.
 *
 * @module LogConsequenceHandler
 */

import Logger from '../../utils/Logger.js';

class LogConsequenceHandler {
    /**
     * @param {Function|null} [eventSink=null] - Optional sink receiving
     *   { action, targetId, message, level } for every logged consequence.
     *   The caller (ConsequenceHandlers) stamps the world tick.
     */
    constructor(eventSink = null) {
        this._eventSink = typeof eventSink === 'function' ? eventSink : null;
    }

    /**
     * Handles a log consequence, writing a message to the server log.
     *
     * @param {string} targetId - The resolved target ID (component or entity ID based on target type).
     * @param {Object} params - Parameters containing message and log level.
     * @param {Object} context - Context containing action parameters.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleLog(targetId, params, context) {
        if (!params) return { success: true, message: 'Logged empty action', data: { level: 'info' } };
        const { message = 'No message provided', level = 'info' } = params;

        const logLevel = (typeof level === 'string' && level.toLowerCase()) || 'info';
        // Logger methods are static and rely on `this` — call them bound to Logger.
        (Logger[logLevel] || Logger.info).call(Logger, `[Action:${targetId}] ${message}`);

        if (this._eventSink) {
            this._eventSink({
                action: context?.actionName ?? 'action',
                targetId,
                message,
                level
                // tick is stamped by the sink wrapper
            });
        }

        return { success: true, message: `Logged: ${message}`, data: { level, targetId } };
    }
}

export default LogConsequenceHandler;
