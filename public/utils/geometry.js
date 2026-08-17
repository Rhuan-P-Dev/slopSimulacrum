/**
 * geometry
 * Shared 2D geometry helpers for the client.
 *
 * Centralizes the "edge point of a room boundary toward another room" math
 * that was previously duplicated between RoomConnectionRenderer._getEdgePoint
 * (SVG viewBox coordinate space, with center offsets) and WorldMapView's
 * private _getEdgePoint (raw room-data coordinate space, no offsets).
 *
 * Both callers pass room centers and clamping bounds in their own coordinate
 * space; the core computation is identical apart from the offset shift, which
 * is normalized here by accepting explicit offsets (default 0).
 *
 * @module geometry
 */

/**
 * Calculates the point on `room`'s boundary that lies on the line from the
 * room center toward `otherRoom`'s center.
 *
 * Tie-break rule: when both edges are equidistant (absDx * halfH >= absDy *
 * halfW), the left/right edge is chosen. This matches the long-standing
 * RoomConnectionRenderer behavior; WorldMapView previously used a strict `>`
 * and is aligned to this rule by this consolidation (documented adaptation).
 *
 * @param {Object} room - The source room ({ x, y, width, height }).
 * @param {Object} otherRoom - The target room ({ x, y, width, height }).
 *   Coordinates are in the same data space as `room` (relative deltas applied
 *   by the caller when needed).
 * @param {number} roomCX - X center of `room` in the output coordinate space.
 * @param {number} roomCY - Y center of `room` in the output coordinate space.
 * @param {number} [offsetX=0] - Origin X of the output coordinate space
 *   (used for clamping and shifting `otherRoom`'s center).
 * @param {number} [offsetY=0] - Origin Y of the output coordinate space.
 * @returns {[number, number]} The edge point [x, y] in the output space,
 *   clamped to the room's bounds [offsetX, offsetX+width] x [offsetY, offsetY+height].
 */
export function getRoomEdgePoint(room, otherRoom, roomCX, roomCY, offsetX = 0, offsetY = 0) {
    // otherRoom coordinates are relative to room (offset by room.x/room.y)
    const otherCX = offsetX + (otherRoom.x - room.x) + otherRoom.width / 2;
    const otherCY = offsetY + (otherRoom.y - room.y) + otherRoom.height / 2;

    // Direction from room center to other room center
    const dx = otherCX - roomCX;
    const dy = otherCY - roomCY;

    // Room boundaries relative to center
    const halfW = room.width / 2;
    const halfH = room.height / 2;

    // Determine which edge to use.
    // Use >= to handle the tie case: when direction is more horizontal,
    // hit the left/right edge.
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    let edgeX;
    let edgeY;

    if (absDx * halfH >= absDy * halfW) {
        // Left or right edge (guards against division by zero when dx === 0,
        // which can only happen when dy is also 0 — overlapping centers).
        const sign = dx > 0 ? 1 : -1;
        edgeX = roomCX + sign * halfW;
        edgeY = absDx > 0 ? roomCY + (dy / absDx) * halfW : roomCY;
    } else {
        // Top or bottom edge
        const sign = dy > 0 ? 1 : -1;
        edgeY = roomCY + sign * halfH;
        edgeX = absDy > 0 ? roomCX + (dx / absDy) * halfH : roomCX;
    }

    // Clamp to room boundaries in the output coordinate space
    edgeX = Math.max(offsetX, Math.min(offsetX + room.width, edgeX));
    edgeY = Math.max(offsetY, Math.min(offsetY + room.height, edgeY));

    return [edgeX, edgeY];
}
