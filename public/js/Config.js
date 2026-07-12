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
        RANGE: {
            IN_RANGE: '#44ff44',
            OUT_OF_RANGE: '#ff4444',
        },
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
    },
    DEFAULTS: {
        DROID_BLUEPRINT: 'smallBallDroid',
    }
};