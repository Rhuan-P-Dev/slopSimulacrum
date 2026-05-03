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
