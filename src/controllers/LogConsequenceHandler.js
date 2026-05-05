/**
 * LogConsequenceHandler — Handles logging of action events.
 * Single Responsibility: Write structured log messages at specified severity levels.
 *
 * Extracted from ConsequenceHandlers to adhere to the Single Responsibility Principle.
 *
 * @module LogConsequenceHandler
 */

import Logger from '../utils/Logger.js';

class LogConsequenceHandler {
    /**
     * Handles a log consequence, writing a message to the server log.
     *
     * @param {string} targetId - The entity/component ID associated with the log entry.
     * @param {Object} params - Parameters containing message and log level.
     * @param {Object} context - Context containing action parameters (unused, kept for signature normalization).
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleLog(targetId, params, context) {
        if (!params) return { success: true, message: 'Logged empty action', data: { level: 'info' } };
        const { message = 'No message provided', level = 'info' } = params;

        const logMethod = Logger[level.toLowerCase()] || Logger.info;
        logMethod(`[Action:${targetId}] ${message}`);

        return { success: true, message: `Logged: ${message}`, data: { level, targetId } };
    }
}

export default LogConsequenceHandler;