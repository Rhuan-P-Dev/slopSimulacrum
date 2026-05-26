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
        DROP_ITEM: 'dropItem',
        PICK_UP_ITEM: 'pickUpItem',
    },
    COLORS: {
        ENTITY_ACTIVE: "#fff",
        ENTITY_DEFAULT: "#00ff00",
        COMPONENT_DEFAULT: "#66ff66",
        NEON_GREEN: "var(--neon-green)",
        INTERNAL_COMPONENT: {
            DURABILITY_REPAIR_SPHERE_FILL: '#00ccff',
            DURABILITY_REPAIR_SPHERE_STROKE: '#0099cc',
        },
    },
    MARKER_SIZES: {
        ENTITY_RADIUS: 12,
        COMPONENT_RADIUS: 5,
        INTERNAL_COMPONENT_RADIUS: 3,
    },
    TARGETING: {
        PUNCH_TOLERANCE: 20,
    },
    MULTIPLIERS: {
        DASH_RANGE: 2,
        DROP_RANGE: 2,
    },
    DROP: {
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
    },
    DEFAULTS: {
        DROID_BLUEPRINT: 'smallBallDroid',
    }
};