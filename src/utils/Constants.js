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

// =========================================================================
// ITEM DROP / PICK-UP CONSTANTS
// =========================================================================

/**
 * Base range for dropping items (minimum distance).
 * Total drop range = DROP_BASE_RANGE + (Physical.strength × DROP_RANGE_MULTIPLIER).
 * @type {number}
 */
export const DROP_BASE_RANGE = 3;

/**
 * Multiplier applied to Physical.strength for calculating drop range.
 * Total drop range = DROP_BASE_RANGE + (Physical.strength × DROP_RANGE_MULTIPLIER).
 * @type {number}
 */
export const DROP_RANGE_MULTIPLIER = 2;

// =========================================================================
// TURN SYSTEM CONSTANTS (Feature A — spec §5.1)
//
// The world runs on a deterministic round cadence: a PLANNING window during
// which any entity may enqueue actions, a single NPC-AGENT tick where the
// (future) LLM layer fires, and a SETTLE/resolution window where the queued
// actions replay through the real ActionController.executeAction pipeline in
// initiative order. These constants define the round geometry. They are tick-
// based (not millisecond-based) so the loop is deterministic regardless of
// the tick rate.
// =========================================================================

/**
 * Number of ticks in one full round (6 s at 60 ticks/s).
 * @type {number}
 */
export const TURN_ROUND_TICKS = 360;

/**
 * Ticks in the planning window (local ticks [0, TURN_PLANNING_TICKS)).
 * Queue submissions are accepted during this window.
 * @type {number}
 */
export const TURN_PLANNING_TICKS = 300;

/**
 * Local tick at which NPC agent calls are fired each round.
 * @type {number}
 */
export const TURN_NPC_AGENT_TICK = 20;

/**
 * Maximum number of queued actions per entity per round.
 * @type {number}
 */
export const TURN_MAX_QUEUED_PER_ROUND = 3;

// =========================================================================
// TICK SYSTEM CONSTANTS
// =========================================================================

/**
 * Maximum number of simulation ticks per second.
 * Controls the speed of the universal tick loop.
 * @type {number}
 */
export const MAX_TICKS_PER_SECOND = 30;

// =========================================================================
// WORLD EVENT LOG CONSTANTS
// =========================================================================

/**
 * Maximum number of recent events returned by the /world-events endpoint
 * and the default capacity for the WorldEventLogController ring buffer.
 * The client constant Config.EVENTS.HISTORY_LIMIT must stay in sync with this value.
 * @type {number}
 */
export const WORLD_EVENTS_MAX_LIMIT = 50;

// =========================================================================
// SPATIAL CONTEXT CAPS (spec "better text & vision")
//
// Single source of truth for how much spatial detail the LLM text layer
// (LlmContextController.BUDGET) and the frontend event panel
// (worldEventRoutes.CONTEXT_CAPS) surface per room: nearby entities,
// dropped items, and exits. Both layers derive their caps from these
// constants so the two views of the same room always agree.
// =========================================================================

/**
 * Maximum number of same-room entities listed in the enriched spatial
 * context (LLM "NEARBY ENTITIES" section and event-panel context).
 * @type {number}
 */
export const CONTEXT_MAX_ENTITIES = 8;

/**
 * Maximum number of current-room dropped items listed in the enriched
 * spatial context (LLM "Dropped items:" line and event-panel context).
 * @type {number}
 */
export const CONTEXT_MAX_DROPPED_ITEMS = 6;

/**
 * Maximum number of current-room exits listed in the enriched spatial
 * context (LLM "Exits:" line and event-panel context). Rooms rarely have
 * more than 2–3 doors; this is a safety cap.
 * @type {number}
 */
export const CONTEXT_MAX_EXITS = 6;