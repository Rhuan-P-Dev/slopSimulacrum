/**
 * Logger provides a standardized way to log system events with different severity levels.
 * Adheres to the software engineering standards for robustness and maintainability.
 */
class Logger {
    static LEVELS = {
        INFO: 'INFO',
        WARN: 'WARN',
        ERROR: 'ERROR',
        CRITICAL: 'CRITICAL'
    };

    /**
     * Generic logging method.
     * @param {string} level - The severity level (INFO, WARN, ERROR, CRITICAL).
     * @param {string} message - The message to log.
     * @param {Object} [context] - Optional context data for debugging.
     */
    static log(level, message, context = null) {
        const timestamp = new Date().toISOString();
        const formattedLevel = level.toUpperCase();
        const ctxString = context ? ` | Context: ${JSON.stringify(context)}` : '';
        
        const logMessage = `[${timestamp}] [${formattedLevel}] ${message}${ctxString}`;

        switch (formattedLevel) {
            case this.LEVELS.CRITICAL:
                console.error(`🚨 CRITICAL: ${logMessage}`);
                break;
            case this.LEVELS.ERROR:
                console.error(`❌ ERROR: ${logMessage}`);
                break;
            case this.LEVELS.WARN:
                console.warn(`⚠️ WARN: ${logMessage}`);
                break;
            default:
                console.log(`ℹ️ INFO: ${logMessage}`);
                break;
        }
    }

    static info(message, context) {
        this.log(this.LEVELS.INFO, message, context);
    }

    static warn(message, context) {
        this.log(this.LEVELS.WARN, message, context);
    }

    static error(message, context) {
        this.log(this.LEVELS.ERROR, message, context);
    }

    static critical(message, context) {
        this.log(this.LEVELS.CRITICAL, message, context);
    }
}

export default Logger;
