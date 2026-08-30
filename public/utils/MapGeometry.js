/**
 * MapGeometry
 * Shared map-visualization geometry constants for the client.
 *
 * Centralizes the rendering geometry of room connections that was previously
 * defined twice — once in RoomConnectionRenderer (in-room connection lines
 * in the main room SVG) and once in WorldMapView (the zoomed-out full-map
 * overlay). Both draw the same artifact family — Bézier connection curves,
 * midpoint door-name labels, and arrowheads — so one module now owns the
 * shared numbers, and both import from here.
 *
 * The two dash arrays below are INTENTIONALLY different: the world map is a
 * zoomed-out context layer (thinner visual weight, opacity 0.5), while
 * in-room connection lines are the primary navigation surface (opacity 0.6).
 * The naming is standardized; the values are preserved as-is.
 *
 * @module MapGeometry
 */

/**
 * Bézier control-point offset (px) for room-connection curves.
 * Increased from 30 (WorldMapView) to 50 to align with
 * RoomConnectionRenderer and reduce arrow overlap on bidirectional pairs;
 * RoomConnectionRenderer independently raised its own 25 to the same 50.
 * The value was migrated here from the two local definitions in
 * WorldMapView and RoomConnectionRenderer.
 * @type {number}
 */
export const CURVE_OFFSET = 50;

/**
 * Perpendicular offset (px) from a connection midpoint to its door-name
 * label. Increased from 8 to 16 to reduce text label overlap with curves
 * and with other labels (identical rationale in both former sites).
 * @type {number}
 */
export const LABEL_OFFSET = 16;

/**
 * Arrowhead size (px) at the end of a room-connection line or curve.
 * @type {number}
 */
export const ARROW_SIZE = 8;

/**
 * SVG dash array for world-map edges (opacity 0.5, the zoomed-out context
 * layer). Intentionally different from ROOM_CONNECTION_DASH_ARRAY — see the
 * module header.
 * @type {string}
 */
export const WORLD_MAP_DASH_ARRAY = '8,4';

/**
 * SVG dash array for in-room connection lines (opacity 0.6, the primary
 * navigation surface). Intentionally different from WORLD_MAP_DASH_ARRAY —
 * see the module header.
 * @type {string}
 */
export const ROOM_CONNECTION_DASH_ARRAY = '6,4';

/**
 * Average character width, in em, used to estimate SVG text width for
 * door-name labels without a DOM measurement at render time.
 *
 * The historical 6 (WorldMapView) vs 6.5 (RoomConnectionRenderer) drift was
 * an artifact of the two label font sizes: 6/10 = 0.60 and 6.5/11 ≈ 0.59.
 * This factor reproduces 6.0 at a 10px font exactly and yields 6.6 at an
 * 11px font — a 0.1px per-character sub-pixel delta, invisible in practice.
 * @type {number}
 */
export const CHAR_WIDTH_PER_EM = 0.6;

/**
 * Estimates the pixel width of an SVG text label rendered at `fontSize`,
 * using CHAR_WIDTH_PER_EM.
 *
 * @param {string} text - The label text.
 * @param {number} fontSize - The font size (px) the label is drawn with.
 * @returns {number} The estimated width in px (rounded).
 */
export function estimateTextWidth(text, fontSize) {
    return Math.round(text.length * fontSize * CHAR_WIDTH_PER_EM);
}
