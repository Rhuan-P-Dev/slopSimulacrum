/**
 * EventConsequenceHandler — Handles event triggering for logging/notification.
 * Single Responsibility: Log event triggers for downstream processing.
 *
 * Extracted from ConsequenceHandlers to adhere to the Single Responsibility Principle.
 *
 * Target Resolution:
 * - 'self'    → Event with source component context.
 * - 'target'  → Event with explicitly targeted component/entity context.
 * - 'entity'  → Event with entity context.
 *
 * @module EventConsequenceHandler
 */

import Logger from '../../utils/Logger.js';

class EventConsequenceHandler {
    /**
     * Handles event triggering for logging/notification purposes.
     *
     * @param {string} targetId - The resolved target ID (component or entity ID based on target type).
     * @param {Object} eventParams - Object containing eventType and optional data.
     * @param {Object} context - Context containing action parameters.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleTriggerEvent(targetId, eventParams, context) {
        const { eventType, data } = eventParams;
        Logger.info(`Event triggered: ${eventType} for target ${targetId}`, data || {});
        return { success: true, message: `Event "${eventType}" triggered`, data: { eventType, targetId } };
    }
}

export default EventConsequenceHandler;