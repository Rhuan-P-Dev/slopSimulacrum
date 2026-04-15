/**
 * ClientErrorController
 * Handles error resolution and formatting on the client side.
 * Decouples error detection from visual representation.
 */
export class ClientErrorController {
    /**
     * @param {UIManager} uiManager - The UI manager used to display the formatted errors.
     */
    constructor(uiManager) {
        this.uiManager = uiManager;

        /**
         * Error templates registry.
         * Keys are error codes, values are template strings with {placeholder} for details.
         */
        this.templates = {
            'TARGET_OUT_OF_RANGE': 'Target out of range ({distance}px > {range}px)',
            'NO_TARGET_FOUND': 'No target entity found at this location',
            'ACTION_FAILED': 'Action failed: {message}',
            'MOVEMENT_FAILED': 'Movement failed: {message}',
            'PUNCH_FAILED': 'Punch failed: {message}',
            'CONNECTION_ERROR': 'Connection Error: {message}',
            'INITIALIZATION_ERROR': 'Initialization Error: {message}',
            'SOCKET_ERROR': 'System Error: {message}',
            'GENERIC_ERROR': 'Error: {message}'
        };
    }

    /**
     * Processes a structured error object and triggers the UI pop-up.
     * @param {Object} error - The structured error object.
     * @param {string} error.code - The error code matching a template.
     * @param {Object} [error.details] - Contextual data for the template.
     * @param {string} [error.level] - The severity level (INFO, WARN, ERROR, CRITICAL).
     * @param {string} [error.message] - A fallback or direct message.
     */
    handleError(error) {
        const { code, details = {}, message } = error;
        let finalMessage = '';

        if (this.templates[code]) {
            finalMessage = this._resolveTemplate(this.templates[code], details, message);
        } else {
            finalMessage = message || 'An unknown system error occurred.';
        }

        console.error(`[ClientErrorController] [${code || 'UNKNOWN'}] ${finalMessage}`);
        this.uiManager.showErrorPopup(finalMessage);
    }

    /**
     * Internal helper to replace placeholders in a template with actual values.
     * @param {string} template The template string.
     * @param {Object} details The data to inject.
     * @param {string} fallbackMessage Fallback message if details are missing.
     * @returns {string} The formatted message.
     */
    _resolveTemplate(template, details, fallbackMessage) {
        const resolved = template.replace(/\{(\w+)\}/g, (match, key) => {
            if (key === 'message') return fallbackMessage || match;
            return details[key] !== undefined ? details[key] : match;
        });

        return resolved !== template ? resolved : (fallbackMessage || resolved);
    }
}
