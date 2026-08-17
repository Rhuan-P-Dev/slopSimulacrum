/**
 * ClientLogger
 * Browser-side logging wrapper with severity levels and per-module prefixes.
 *
 * Replaces raw `console.log/warn/error` calls across the client (BUG-123).
 * Usage: ClientLogger.debug('SelectionController', 'toggleComponent', { ... });
 *
 * Level semantics (ascending verbosity): error < warn < info < debug
 * A global level flag gates output: messages below the current level are
 * suppressed. Default level is 'info' so verbose debug traces (e.g., the
 * former "[SelectionController DEBUG]" logs) are silent unless explicitly
 * enabled via ClientLogger.setLevel('debug').
 *
 * The prefix is normalized to "[Module]" for messages that do not already
 * start with one, so console output stays consistent with the previous
 * "[Module] message" convention.
 *
 * @module ClientLogger
 */

const LEVELS = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};

let currentLevel = LEVELS.info;

class ClientLogger {
    /**
     * Sets the global minimum level. Anything below is suppressed.
     * @param {string} level - One of 'error', 'warn', 'info', 'debug'.
     */
    static setLevel(level) {
        if (level in LEVELS) {
            currentLevel = LEVELS[level];
        }
    }

    /**
     * Returns the current minimum level name.
     * @returns {string}
     */
    static getLevel() {
        for (const [name, value] of Object.entries(LEVELS)) {
            if (value === currentLevel) return name;
        }
        return 'info';
    }

    /**
     * Normalizes the message with the module prefix.
     * @param {string} module - The module name (e.g., 'ActionManager').
     * @param {...*} args - The message and any context payloads.
     * @returns {Array} Normalized console arguments.
     * @private
     */
    static _format(module, args) {
        const [first, ...rest] = args;
        if (typeof first === 'string') {
            const message = first.startsWith('[')
                ? first
                : `[${module}] ${first}`;
            return [message, ...rest];
        }
        return [`[${module}]`, first, ...rest];
    }

    /**
     * Logs a debug-level message (suppressed unless setLevel('debug')).
     * @param {string} module - The module name.
     * @param {...*} args - The message and optional context.
     */
    static debug(module, ...args) {
        if (currentLevel >= LEVELS.debug) {
            console.debug(...ClientLogger._format(module, args));
        }
    }

    /**
     * Logs an info-level message (suppressed unless level is 'info' or 'debug').
     * @param {string} module - The module name.
     * @param {...*} args - The message and optional context.
     */
    static info(module, ...args) {
        if (currentLevel >= LEVELS.info) {
            console.log(...ClientLogger._format(module, args));
        }
    }

    /**
     * Logs a warning-level message.
     * @param {string} module - The module name.
     * @param {...*} args - The message and optional context.
     */
    static warn(module, ...args) {
        if (currentLevel >= LEVELS.warn) {
            console.warn(...ClientLogger._format(module, args));
        }
    }

    /**
     * Logs an error-level message.
     * @param {string} module - The module name.
     * @param {...*} args - The message and optional context.
     */
    static error(module, ...args) {
        if (currentLevel >= LEVELS.error) {
            console.error(...ClientLogger._format(module, args));
        }
    }
}

export default ClientLogger;
