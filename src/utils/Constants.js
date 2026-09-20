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

/**
 * Fallback pick-up range (world units) for the pickUpItem action.
 * Range is data-driven from actions.json pickUpItem (50); fallback mirrors
 * that value for missing-data safety.
 * @type {number}
 */
export const PICK_UP_RANGE_FALLBACK = 50;

// =========================================================================
// DYNAMIC ITEM TYPE CONSTANTS (feature 2 — material chunk drop on punch)
// =========================================================================

/**
 * Prefix for dynamically-generated chunk item types (feature 2). When a
 * component is punched it sheds a "chunk" per dropped material; a chunk's only
 * identity is its material, so the type embeds it:
 * `${CHUNK_ITEM_TYPE_PREFIX}${material}` (e.g. `chunk_iron`). The type is
 * self-describing — any consumer can recover the material from the type alone —
 * which is what lets chunks exist with NO inventoryItems.json entry (spec D8).
 * Kept server-side: the client never classifies a type, it only renders the
 * self-describing ground record.
 * @type {string}
 */
export const CHUNK_ITEM_TYPE_PREFIX = 'chunk_';

/**
 * Whether an item type string is a dynamically-generated chunk type.
 * @param {string|undefined|null} itemType - An item type string.
 * @returns {boolean} true only when the type starts with the chunk prefix and
 *   has a non-empty material name after it.
 */
export function isChunkItemType(itemType) {
    return typeof itemType === 'string'
        && itemType.startsWith(CHUNK_ITEM_TYPE_PREFIX)
        && itemType.length > CHUNK_ITEM_TYPE_PREFIX.length;
}

/**
 * Recovers the material name embedded in a chunk item type string.
 * @param {string|undefined|null} itemType - A chunk item type string (e.g. `chunk_iron`).
 * @returns {string|null} The material name (`iron`), or null when the type is not a chunk type.
 */
export function recoverChunkMaterial(itemType) {
    if (!isChunkItemType(itemType)) return null;
    return itemType.slice(CHUNK_ITEM_TYPE_PREFIX.length);
}

// =========================================================================
// CONSEQUENCE-PIPELINE PUBLISHED-LOSS CONTRACT (server-internal, spec D5)
// =========================================================================
/**
 * The reserved action-params key under which the channel-damage step publishes
 * the applied (clamped) loss and the chunk-drop step reads it back. Server-internal
 * only — never part of a client payload. Kept here (not in shared/) because it is
 * a dispatcher contract, not a wire contract.
 * @type {string}
 */
export const PUBLISHED_CHANNEL_LOSS_KEY = 'lastChannelLoss';

/**
 * Shape of the entry written under {@link PUBLISHED_CHANNEL_LOSS_KEY} (spec D5).
 * @typedef {Object} ChannelLossPublication
 * @property {string} targetId - The damaged target's component (or equipped-item) ID.
 * @property {number} appliedLoss - Applied, clamped existence loss (0..1) that actually left the target.
 */

// =========================================================================
// TURN SYSTEM CONSTANTS (Feature A + two-phase barrier turns, spec v2)
//
// Rounds are EVENT-DRIVEN rendezvous (wiki/subMDs/controllers/npc_ai_controller.md v2), not
// tick spans: round 0 starts lazily on the first tick, planning closes only
// when every roster planner has signaled plan-complete (no deadline), and the
// next round starts on the tick after resolution. The turn system therefore
// owns no tick geometry — there are no round-cadence, planning-window, or
// agent-tick constants. The only remaining turn constant is the per-entity
// queue cap, which is orthogonal to timing.
// =========================================================================

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

/**
 * Default number of recent events returned by getRecent() consumers
 * (world-event log, LLM context, world-state aggregation). Smaller than
 * WORLD_EVENTS_MAX_LIMIT: most consumers only need a short recent tail,
 * while the full 50-entry ring stays the storage/endpoint cap.
 * @type {number}
 */
export const WORLD_EVENTS_RECENT_LIMIT = 20;

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

// =========================================================================
// ENVIRONMENT FLAG CONSTANTS
// =========================================================================

/**
 * The string value a boolean environment flag must equal (after trim and
 * case-folding, where the reading site uses the relaxed comparison) to be
 * considered ON.
 * @type {string}
 */
export const ENV_FLAG_ON_VALUE = 'true';

/**
 * Interprets a raw environment variable value as a boolean flag using the
 * RELAXED comparison used by spawn-time gates: trim, casefold, exact match.
 *
 * Intentionally distinct from authMiddleware's strict `=== 'true'` request-
 * time check (src/utils/authMiddleware.js) — that strictness is a deliberate
 * production-auth semantic and must NOT be "unified" with this helper.
 * @param {*} value - The raw process.env value (any type).
 * @returns {boolean} true only for string values equal to "true" after trim and case-folding.
 */
export function isEnvFlagOn(value) {
    return typeof value === 'string' && value.trim().toLowerCase() === ENV_FLAG_ON_VALUE;
}
// CHAT CONSTANTS
// =========================================================================

/**
 * Maximum length (characters) of a single room-chat message. Messages
 * longer than this are rejected, and the LLM context layer truncates
 * chat excerpts to this width so one message cannot blow the budget.
 * @type {number}
 */
export const CHAT_MESSAGE_MAX_LENGTH = 200;

/**
 * Per-room chat history ring-buffer capacity (RoomChatController).
 * @type {number}
 */
export const ROOM_CHAT_HISTORY_LIMIT = 50;

// =========================================================================
// LLM CONSTANTS
// =========================================================================

/**
 * Default OpenAI-compatible chat-completions endpoint used when
 * LLM_ENDPOINT is not set via environment (local dev proxy).
 * @type {string}
 */
export const LLM_DEFAULT_ENDPOINT = 'http://127.0.0.1:20003/v1/chat/completions';

/**
 * Default model name requested from the LLM endpoint.
 * @type {string}
 */
export const LLM_DEFAULT_MODEL = 'gpt-3.5-turbo';

/**
 * Default sampling temperature for general LLM calls (agent-loop uses its
 * own lower temperature — see LLMAgentController).
 * @type {number}
 */
export const LLM_DEFAULT_TEMPERATURE = 0.7;

/**
 * Default maximum completion tokens per LLM call.
 * @type {number}
 */
export const LLM_DEFAULT_MAX_TOKENS = 2048;

/**
 * Default request timeout (ms) for LLM HTTP calls.
 * @type {number}
 */
export const LLM_DEFAULT_TIMEOUT_MS = 30000;

/**
 * Length (characters) after which LLM request/response payloads are
 * truncated in log output — keeps logs readable without losing the start
 * of long payloads.
 * @type {number}
 */
export const LLM_LOG_TRUNCATION_CHARS = 500;

// =========================================================================
// LLM CONTEXT CONSTANTS (LlmContextController token budget)
// =========================================================================

/**
 * Total character budget for the composed LLM context narrative.
 * @type {number}
 */
export const LLM_CONTEXT_MAX_CHARS = 5000;

/**
 * Max entities from OTHER rooms included in the LLM context.
 * @type {number}
 */
export const LLM_CONTEXT_OTHER_ROOM_ENTITIES = 2;

/**
 * Max recent world events included in the LLM context.
 * @type {number}
 */
export const LLM_CONTEXT_MAX_EVENTS = 20;

/**
 * Max chat messages scanned from room history when composing the LLM
 * context (the excerpted portion is further capped by
 * LLM_CONTEXT_MAX_CHAT_IN_CONTEXT).
 * @type {number}
 */
export const LLM_CONTEXT_MAX_CHAT = 10;

/**
 * Max instinct entries included in the LLM context.
 * @type {number}
 */
export const LLM_CONTEXT_MAX_INSTINCTS = 5;

/**
 * Max candidate actions listed in the LLM context.
 * @type {number}
 */
export const LLM_CONTEXT_MAX_ACTIONS = 2;

/**
 * Max per-entity stats shown per nearby entity in the LLM context.
 * @type {number}
 */
export const LLM_CONTEXT_MAX_NEARBY_STATS = 2;

/**
 * Max hint entries included in the LLM context.
 * @type {number}
 */
export const LLM_CONTEXT_MAX_HINTS = 3;

/**
 * Max chat messages actually excerpted into the composed LLM context
 * (the narrative portion of the chat section).
 * @type {number}
 */
export const LLM_CONTEXT_MAX_CHAT_IN_CONTEXT = 5;

/**
 * Max instinct entries actually rendered into the composed LLM context
 * (the narrative portion of the instinct section).
 * @type {number}
 */
export const LLM_CONTEXT_MAX_INSTINCTS_IN_CONTEXT = 3;

/**
 * Max agent feedback entries rendered into the composed LLM context.
 * @type {number}
 */
export const LLM_CONTEXT_MAX_FEEDBACK = 5;

// =========================================================================
// AGENT CONSTANTS
// =========================================================================

/**
 * Per-agent action-outcome feedback ring-buffer capacity
 * (LlmAgentFeedbackController). Bounds the agent's short-term memory of
 * "what did I do" entries.
 * @type {number}
 */
export const AGENT_FEEDBACK_CAPACITY = 5;

// =========================================================================
// NPC CONSTANTS
// =========================================================================

/**
 * Default attack range (world units) for NPC combat behaviors.
 * Currently the ONLY value: data/npcs.json has no attackRange field;
 * data-driven per-NPC ranges are deferred (see wiki npc_ai_controller).
 * @type {number}
 */
export const NPC_DEFAULT_ATTACK_RANGE = 100;

/**
 * Behavior key registered by NpcAIController for the chase-then-attack
 * combat strategy (matches data/npcs.json behavior names).
 * @type {string}
 */
export const NPC_BEHAVIOR_CHASE_ATTACK = 'chase_attack';

// =========================================================================
// INTERNAL COMPONENT CONSTANTS
// =========================================================================

/**
 * Base tick interval (in ticks) at which internal components advance.
 * @type {number}
 */
export const IC_BASE_TICK_INTERVAL = 5;

/**
 * Fallback host volume used when an internal component's host component
 * has no resolvable volume stat.
 * @type {number}
 */
export const DEFAULT_HOST_VOLUME_FALLBACK = 10;

// =========================================================================
// SERVER CONSTANTS
// =========================================================================

/**
 * Timeout (ms) after which a graceful shutdown is forced (server.js
 * shutdown handler). Bounds the shutdown path so a stuck controller
 * cannot hold the process open.
 * @type {number}
 */
export const FORCED_SHUTDOWN_TIMEOUT_MS = 10000;
