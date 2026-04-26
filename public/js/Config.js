/**
 * Application Configuration
 * Centralized constants to avoid magic numbers and ensure consistency across the client.
 */
export const AppConfig = {
    VIEW: {
        WIDTH: 800,
        HEIGHT: 500,
        CENTER_X: 800 / 2,
        CENTER_Y: 500 / 2,
    },
    ACTIONS: {
        MOVE: 'move',
        DASH: 'dash',
    },
    COLORS: {
        ENTITY_ACTIVE: "#fff",
        ENTITY_DEFAULT: "#00ff00",
        COMPONENT_DEFAULT: "#66ff66",
        NEON_GREEN: "var(--neon-green)",
    },
    MARKER_SIZES: {
        ENTITY_RADIUS: 12,
        COMPONENT_RADIUS: 5,
    },
    TARGETING: {
        PUNCH_TOLERANCE: 20,
    },
    MULTIPLIERS: {
        DASH_RANGE: 2,
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
    },
    DEFAULTS: {
        DROID_BLUEPRINT: 'smallBallDroid',
    }
};
