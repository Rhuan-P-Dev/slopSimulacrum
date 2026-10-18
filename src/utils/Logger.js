/**
 * Logger provides a standardized way to log system events with different severity levels.
 * Adheres to the software engineering standards for robustness and maintainability.
 *
 * Verbosity gate — the `LOG_LEVEL` environment variable (see .env.example):
 *
 *   - Threshold, not a whitelist: a minimum severity is set; messages at or
 *     above it are emitted, milder ones suppressed. A threshold keeps ERROR and
 *     CRITICAL visible at any configuration (a gate that accidentally mutes a
 *     crash is an unbounded regression) and never breaks when the level set
 *     itself changes without re-enumerating allowed levels.
 *   - The same severity ordering as the client-side ClientLogger (error < warn
 *     < info < debug), so server and client share one vocabulary. The client
 *     gate is set in code because the browser has no .env — this knob is
 *     server-side by construction.
 *   - Read on every call, not at module load: nothing in the server chain
 *     owns env hydration (dotenv runs in the launcher, per .env.example), so
 *     a module-load read could capture an unset value even in a fully
 *     configured run; a per-call read is two string ops, lets the knob be
 *     set per process or per test, and mirrors the LLMController convention
 *     of reading process.env at request time rather than at construction.
 *   - Unset or unrecognized values fall back to DEBUG (everything emitted).
 *     The pre-gate behavior is the fallback precisely so an existing deployment
 *     never loses log visibility; a single process-lifetime diagnostic warning
 *     is emitted when an unrecognized value is first seen so a typo'd knob
 *     never degrades silently.
 */
class Logger {
    static LEVELS = {
        DEBUG: 'DEBUG',
        INFO: 'INFO',
        WARN: 'WARN',
        ERROR: 'ERROR',
        CRITICAL: 'CRITICAL'
    };

    /**
     * Ascending severity ranks — an implementation detail of the LOG_LEVEL
     * gate, kept as a second table rather than an extension of LEVELS, which
     * is the public level vocabulary.
     * @type {Record<string, number>}
     */
    static LEVEL_RANKS = {
        DEBUG: 0,
        INFO: 1,
        WARN: 2,
        ERROR: 3,
        CRITICAL: 4
    };

    /**
     * One-shot guard for the unrecognized-LOG_LEVEL diagnostic.
     * @private
     */
    static _invalidLevelWarned = false;

    /**
     * Resolves the effective minimum level from process.env.LOG_LEVEL
     * (whitespace-trimmed, case-insensitive). Unknown or missing values fall
     * back to DEBUG; the first detection of an unrecognized non-empty value
     * emits one process-lifetime diagnostic warning.
     * @returns {string} effective minimum level
     * @private
     */
    static _resolveMinimumLevel() {
        const raw = (process.env.LOG_LEVEL ?? '').trim().toUpperCase();
        const level = raw in Logger.LEVEL_RANKS ? raw : Logger.LEVELS.DEBUG;
        if (raw && level !== raw && !Logger._invalidLevelWarned) {
            Logger._invalidLevelWarned = true;
            // Raw console sink on purpose: this diagnostic fires mid-way through
            // log() (via the level resolvers), and routing it through log() would
            // be a self-recursive path guarded only by the one-shot flag above.
            console.warn(
                `Logger: unrecognized LOG_LEVEL "${raw}" — falling back to DEBUG (all levels emitted).`
            );
        }
        return level;
    }

    /**
     * Generic logging method.
     * @param {string} level - The severity level (DEBUG, INFO, WARN, ERROR, CRITICAL).
     * @param {string} message - The message to log.
     * @param {Object} [context] - Optional context data for debugging.
     */
    static log(level, message, context = null) {
        const formattedLevel = level.toUpperCase();
        const minLevel = Logger._resolveMinimumLevel();
        if (
            formattedLevel in Logger.LEVEL_RANKS &&
            Logger.LEVEL_RANKS[formattedLevel] < Logger.LEVEL_RANKS[minLevel]
        ) {
            return; // below the configured minimum level: suppressed
        }

        const timestamp = new Date().toISOString();
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
            case this.LEVELS.DEBUG:
                console.log(`🐞 DEBUG: ${logMessage}`);
                break;
            default:
                console.log(`ℹ️ INFO: ${logMessage}`);
                break;
        }
    }

    static debug(message, context) {
        this.log(this.LEVELS.DEBUG, message, context);
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
