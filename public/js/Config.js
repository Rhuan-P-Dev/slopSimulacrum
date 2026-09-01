/**
 * Application Configuration
 * Centralized constants to avoid magic numbers and ensure consistency across the client.
 */
import { ACTION_NAMES } from '../../shared/ActionVocabulary.js';
import { DEFAULT_PLAYER_BLUEPRINT } from '../../shared/Defaults.js';

export const AppConfig = {
    VIEW: {
        WIDTH: 800,
        HEIGHT: 500,
        CENTER_X: 800 / 2,
        CENTER_Y: 500 / 2,
    },
    // Action names derived from the shared vocabulary (data/actions.json keys);
    // values are byte-identical to the former literals.
    ACTIONS: {
        MOVE: ACTION_NAMES.MOVE,
        DASH: ACTION_NAMES.DASH,
        DROP_ITEM: ACTION_NAMES.DROP_ITEM,
        PICK_UP_ITEM: ACTION_NAMES.PICK_UP_ITEM,
    },
    COLORS: {
        ENTITY_ACTIVE: "#fff",
        ENTITY_DEFAULT: "#00ff00",
        COMPONENT_DEFAULT: "#66ff66",
        NEON_GREEN: "var(--neon-green)",
        RANGE: {
            IN_RANGE: '#44ff44',
            OUT_OF_RANGE: '#ff4444',
        },
        INTERNAL_COMPONENT: {
            REPAIR_SPHERE_FILL: '#00ccff',
            REPAIR_SPHERE_STROKE: '#0099cc',
        },
    },
    MARKER_SIZES: {
        ENTITY_RADIUS: 12,
        COMPONENT_RADIUS: 5,
        INTERNAL_COMPONENT_RADIUS: 3,
    },
    TARGETING: {
        // Phase 4: renamed from PUNCH_TOLERANCE — the constant is the generic
        // target-acquisition click tolerance used by ActionExecutor for any
        // component targeting action (not punch-specific).
        TARGETING_TOLERANCE: 20,
    },
    ANIMATION: {
        DOOR_FLASH_DURATION: 400,
    },
    MULTIPLIERS: {
        DASH_RANGE: 2,
        // NOTE: DROP_RANGE is a legacy fallback value. The actual drop range is now
        // resolved from data/actions.json range expression (e.g., ":Physical.strength*2+3").
        // This value is only used if no range expression is found in the action data.
        DROP_RANGE: 2,
    },
    DROP: {
        // NOTE: BASE_RANGE is a legacy fallback value. The actual drop range is now
        // resolved from data/actions.json range expression (e.g., ":Physical.strength*2+3").
        // This value is only used if no range expression is found in the action data.
        BASE_RANGE: 3,
    },
    ENDPOINTS: {
        WORLD_STATE: '/world-state',
        ACTIONS: '/actions',
        EXECUTE_ACTION: '/execute-action',
        MOVE_ENTITY: '/move-entity',
        SELECT_COMPONENTS: '/select-components',
        SELECT_COMPONENT: '/select-component',
        RELEASE_SELECTION: '/release-selection',
        SYNERGY_PREVIEW: '/synergy/preview',
        SYNERGY_PREVIEW_DATA: '/synergy/preview-data',
        DROPPED_ITEMS: '/dropped-items',
        // Feature A (turn system, spec §5.4). TURNS_QUEUE is a prefix — append
        // "/:entityId" or "/:entityId/:queueId" to list or cancel entries.
        TURNS_STATE: '/turns/state',
        TURNS_QUEUE: '/turns/queue',
        // Two-phase barrier (turns spec §2.4): PREFIX — append "/:entityId"
        // to signal plan-complete for one entity (POST /turns/ready/:entityId).
        TURNS_READY: '/turns/ready',
        // Feature D (spec §7.3/§7.4): per-room chat. Both are PREFIXES —
        // append "/:roomId" (send) or "/:roomId?limit=N" (history).
        ROOM_CHAT_SEND: '/rooms',
        ROOM_CHAT_HISTORY: '/rooms',
        // Hint system (deterministic reachability hints).
        HINTS: '/hints',
        // World event log (spec: Events tab).
        WORLD_EVENTS: '/world-events',
        // Knowledge codex (read-only reference; static at runtime — the
        // KnowledgePanel fetches it once per session).
        KNOWLEDGE: '/knowledge',
    },
    // Feature D (spec §7.4): room chat. PLAYER_NAME is the fixed speaker
    // name for player messages (sent explicitly per the spec); CHAT_MAX_LENGTH
    // mirrors the server constant CHAT_MESSAGE_MAX_LENGTH
    // (src/utils/Constants.js) for pre-validation.
    PLAYER_NAME: 'Player',
    CHAT_MAX_LENGTH: 200,
    ROOM_CHAT: {
        // History depth for GET /rooms/:id/chat; mirrors the server constant
        // ROOM_CHAT_HISTORY_LIMIT (src/utils/Constants.js).
        HISTORY_LIMIT: 50,
    },
    EVENTS: {
        // History depth for GET /world-events (must stay in sync with WORLD_EVENTS_MAX_LIMIT on the server).
        HISTORY_LIMIT: 50,
        // Max number of same-room "others" entities the event-panel context
        // sub-line renders before collapsing the remainder into "… +N".
        // Must stay in sync with CONTEXT_MAX_ENTITIES in src/utils/Constants.js
        // (the server caps context.entities at this value in worldEventRoutes).
        CONTEXT_MAX_ENTITIES: 8,
    },
    DEFAULTS: {
        // Derived from the shared default (identical value); the server is the
        // single source of truth for the spawn blueprint.
        DROID_BLUEPRINT: DEFAULT_PLAYER_BLUEPRINT,
    },
    // Mirrors the server constants TURN_ROUND_TICKS / TURN_PLANNING_TICKS
    // (src/utils/Constants.js). The single source of truth is the server; the
    // client only mirrors these values for HUD math (round progress bar).
    TURN: {
        ROUND_TICKS: 360,
        PLANNING_TICKS: 300,
    },
    // Mirrors the server constant DEFAULT_SYNERGY_BASE_MULTIPLIER
    // (src/utils/Constants.js): the no-synergy baseline multiplier.
    SYNERGY: {
        BASE_MULTIPLIER: 1.0,
    },
    // UI layering and timing.
    UI: {
        // Base z-index for overlay panels (OverlayManager._baseZIndex).
        Z_INDEX_BASE: 100,
        // Stacking step: layers that must sit one step above the manager's
        // active panel (dragging panels, the drop/pick-up selectors) add this.
        Z_INDEX_STEP: 10,
        // Default popup lifetime in ms (UIManager error/hint popups, hint markers).
        POPUP_DURATION_MS: 5000,
        // Short-lived error popups (e.g. action-restore failures in App.js).
        POPUP_DURATION_SHORT_MS: 3000,
    },
    // Inventory (client-side volume/capacity display rules).
    INVENTORY: {
        // An item with internal capacity at or above this is treated as a
        // container in the inventory overlay.
        CONTAINER_MIN_CAPACITY: 5,
        // Volume-bar color thresholds (percent of capacity used).
        VOLUME_BAR_THRESHOLDS: {
            FULL: 100,
            HIGH: 75,
            MEDIUM: 40,
        },
    }
};