/**
 * Constants for the game application.
 * All constants use UPPER_SNAKE_CASE naming convention.
 */

/**
 * Minimum movement distance required to trigger movement calculation.
 * When distance is 0 or less, no movement is needed.
 * @type {number}
 */
export const MIN_MOVEMENT_DISTANCE = 0;

/**
 * Minimum strength delta required to trigger a stat update.
 * When delta is 0, no update is needed (strength is already correct).
 * @type {number}
 */
export const MIN_STRENGTH_DELTA = 0;

/**
 * Default volume consumed by an item when not explicitly specified.
 * Used for backpack capacity calculations.
 * @type {number}
 */
export const DEFAULT_ITEM_VOLUME = 1;

/**
 * Default speed for entity movement when not specified.
 * @type {number}
 */
export const DEFAULT_SPEED = 0;

/**
 * Default value for numeric stat initialization.
 * @type {number}
 */
export const DEFAULT_STAT_VALUE = 0;

/**
 * Default spatial coordinate value when not specified.
 * @type {number}
 */
export const DEFAULT_COORDINATE = 0;

/**
 * Spatial offset for respawning items when released.
 * Items spawn 5 units away from the releasing entity.
 * @type {number}
 */
export const ITEM_SPAWN_OFFSET = 5;

/**
 * Default base multiplier for synergy calculations when not specified.
 * Represents 100% base value (1.0x multiplier).
 * @type {number}
 */
export const DEFAULT_SYNERGY_BASE_MULTIPLIER = 1.0;

/**
 * Default placeholder multiplier when no multiplier is specified in placeholder strings.
 * Represents 1x multiplier (use the value as-is).
 * @type {number}
 */
export const DEFAULT_PLACEHOLDER_MULTIPLIER = 1;

/**
 * Base-10 radix used for parsing integer values in placeholder strings.
 * @type {number}
 */
export const PARSING_RADIX = 10;

/**
 * Synergy multiplier threshold below which no synergy bonus is applied.
 * Values greater than 1.0 indicate a bonus; 1.0 is the baseline (no bonus).
 * @type {number}
 */
export const SYNERGY_BONUS_THRESHOLD = 1.0;

/**
 * Score for the "release" action capability entry (lowest priority).
 * @type {number}
 */
export const RELEASE_ACTION_SCORE = 10;

/**
 * Invalid score threshold: scores at or below this value are considered invalid.
 * @type {number}
 */
export const INVALID_SCORE_THRESHOLD = 0;

/**
 * Maximum allowed parameters for a function before refactoring is recommended.
 * @type {number}
 */
export const MAX_FUNCTION_PARAMETERS = 4;

/**
 * Maximum recommended lines for a single function before extraction is recommended.
 * @type {number}
 */
export const MAX_FUNCTION_LINES = 50;

/**
 * Maximum recommended lines for a single file before extraction is recommended.
 * @type {number}
 */
export const MAX_FILE_LINES = 200;

/**
 * Minimum indentation level before code should be refactored for readability.
 * @type {number}
 */
export const MAX_INDENTATION_LEVEL = 4;

/**
 * Minimum number of local variables in a function before refactoring is recommended.
 * @type {number}
 */
export const MAX_LOCAL_VARIABLES = 10;

/**
 * TTL for synergy computation cache in milliseconds (5 seconds).
 * Used by SynergyController to expire stale synergy results.
 * @type {number}
 */
export const SYNERGY_CACHE_TTL_MS = 5000;

/**
 * Maximum number of entries in the synergy cache.
 * Prevents unbounded memory growth.
 * @type {number}
 */
export const SYNERGY_CACHE_MAX_SIZE = 100;
