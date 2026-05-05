/**
 * EventConsequenceHandler — Handles event triggering for logging/notification.
 * Single Responsibility: Log event triggers for downstream processing.
 *
 * Extracted from ConsequenceHandlers to adhere to the Single Responsibility Principle.
 *
 * @module EventConsequenceHandler
 */

import Logger from '../utils/Logger.js';

class EventConsequenceHandler {
    /**
     * Handles event triggering for logging/notification purposes.
     *
     * @param {string} entityId - The entity ID associated with the event.
     * @param {Object} eventParams - Object containing eventType and optional data.
     * @param {Object} context - Context containing action parameters (unused, kept for signature normalization).
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleTriggerEvent(entityId, eventParams, context) {
        const { eventType, data } = eventParams;
        Logger.info(`Event triggered: ${eventType} for entity ${entityId}`, data || {});
        return { success: true, message: `Event "${eventType}" triggered`, data: { eventType, entityId } };
    }
}

export default EventConsequenceHandler;