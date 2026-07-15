/**
 * RoomConnectionRenderer
 * Handles SVG rendering of connections between rooms.
 * Provides edge-to-edge line drawing with arrow markers and midpoint labels.
 * Connections are clickable and trigger the onConnectionClick callback with the target room ID.
 *
 * @module RoomConnectionRenderer
 */
import { AppConfig } from './Config.js';

export class RoomConnectionRenderer {
    /**
     * Renders connection lines from the current room to all connected target rooms.
     *
     * @param {Object} room - The current room object (has id, x, y, width, height, connections)
     * @param {Object} rooms - Map of all rooms keyed by room id
     * @param {SVGElement} roomLayer - The SVG group element for the room layer
     * @param {Function} [onConnectionClick] - Optional callback when a connection is clicked.
     *   Receives (entityId, targetRoomId, doorName).
     * @param {string} [entityId] - The entity ID to pass to the click callback
     * @param {Function} [onDoorHover] - Optional callback when hovering a connection line.
     *   Receives (doorName, doorPosition) where doorPosition is {x, y} in room-center-relative coords.
     * @param {Function} [onDoorLeave] - Optional callback when leaving a connection line hover.
     */
    static renderRoomConnections(room, rooms, roomLayer, onConnectionClick = null, entityId = null, onDoorHover = null, onDoorLeave = null) {
        const connections = room.connections || {};

        if (Object.keys(connections).length === 0) {
            return;
        }

        const offsetX = AppConfig.VIEW.CENTER_X - room.width / 2;
        const offsetY = AppConfig.VIEW.CENTER_Y - room.height / 2;

        // Build bidirectional connection pair map for curve rendering
        const connectionPairs = this._buildConnectionPairs(rooms);

        for (const [door, connData] of Object.entries(connections)) {
            const targetId = typeof connData === 'object' ? connData.target : connData;
            const targetRoom = rooms[targetId];
            if (!targetRoom) continue;

            this._drawConnection(
                room, targetRoom, door, offsetX, offsetY, roomLayer, onConnectionClick, entityId,
                connectionPairs, onDoorHover, onDoorLeave
            );
        }
    }

    /**
     * Draws a single connection between two rooms.
     * Routes to curved or straight drawing based on bidirectional pair detection.
     * @private
     * @param {Object} room - The source room.
     * @param {Object} targetRoom - The target room.
     * @param {string} door - The door name.
     * @param {number} offsetX - SVG X offset for the source room.
     * @param {number} offsetY - SVG Y offset for the source room.
     * @param {SVGElement} layer - The SVG group to append elements to.
     * @param {Function} [onConnectionClick] - Click callback (entityId, targetRoomId, doorName).
     * @param {string} [entityId] - The entity ID for click callbacks.
     * @param {Function} [onDoorHover] - Hover callback (doorName, doorPosition).
     *   doorPosition is in room-center-relative coordinates.
     * @param {Function} [onDoorLeave] - Leave callback.
     */
    static _drawConnection(room, targetRoom, door, offsetX, offsetY, layer, onConnectionClick = null, entityId = null,
        connectionPairs = new Map(), onDoorHover = null, onDoorLeave = null) {
        // Build canonical key for this connection pair
        const pairKey = this._getConnectionKey(room.id, targetRoom.id);
        const pairData = connectionPairs.get(pairKey);
        const isBidirectional = pairData && pairData.isBidirectional;

        // Determine if this is the forward or backward connection
        const isForward = room.id < targetRoom.id;

        if (isBidirectional) {
            this._drawCurvedConnection(room, targetRoom, door, offsetX, offsetY, layer,
                onConnectionClick, entityId, isForward, onDoorHover, onDoorLeave);
        } else {
            this._drawStraightConnection(room, targetRoom, door, offsetX, offsetY, layer,
                onConnectionClick, entityId, onDoorHover, onDoorLeave);
        }
    }

    /**
     * Draws a curved (Bézier) connection for bidirectional room pairs.
     * Forward connections curve one direction, backward connections curve the opposite.
     * @private
     */
    static _drawCurvedConnection(room, targetRoom, door, offsetX, offsetY, layer,
        onConnectionClick = null, entityId = null, isForward = true,
        onDoorHover = null, onDoorLeave = null) {
        // Room centers relative to SVG viewBox (matching _renderRoom() centering)
        // _renderRoom() places the current room at (CENTER_X - room.width/2, CENTER_Y - room.height/2)
        // Target rooms are positioned relative to the current room using data coordinate deltas
        const roomCX = offsetX + room.width / 2;
        const roomCY = offsetY + room.height / 2;
        const targetCX = offsetX + (targetRoom.x - room.x) + targetRoom.width / 2;
        const targetCY = offsetY + (targetRoom.y - room.y) + targetRoom.height / 2;

        // Target room's SVG position (for clamping the end point)
        const targetOffsetX = offsetX + (targetRoom.x - room.x);
        const targetOffsetY = offsetY + (targetRoom.y - room.y);

        // Calculate edge points
        const [startX, startY] = this._getEdgePoint(room, targetRoom, roomCX, roomCY, offsetX, offsetY);
        const [endX, endY] = this._getEdgePoint(targetRoom, room, targetCX, targetCY, targetOffsetX, targetOffsetY);

        // Calculate curve parameters
        const dx = endX - startX;
        const dy = endY - startY;
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length === 0) return;

        // Perpendicular offset direction.
        // NOTE: Do NOT multiply by an offset sign here. When direction reverses (B→A vs A→B),
        // the perpendicular vector naturally flips (perp' = -perp), which places the control
        // point on the opposite side of the midpoint — exactly what we need for non-overlapping curves.
        // Adding an offsetSign would cancel this natural flip, causing perfect overlap.
        const perpX = -dy / length;
        const perpY = dx / length;
       
        // Increased from 25 to 50 to reduce arrow overlap on bidirectional connections.
        // Wider spacing gives bidirectional arrows more visual separation.
        const CURVE_OFFSET = 50;
       
        // Control point: midpoint + perpendicular offset (no sign flip)
        const midX = (startX + endX) / 2;
        const midY = (startY + endY) / 2;
        const cpX = midX + CURVE_OFFSET * perpX;
        const cpY = midY + CURVE_OFFSET * perpY;

        // Build quadratic Bézier path
        const pathData = `M ${startX} ${startY} Q ${cpX} ${cpY} ${endX} ${endY}`;

        // Invisible wide hit-area path for reliable click detection
        const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hitPath.setAttribute('d', pathData);
        hitPath.setAttribute('stroke', 'transparent');
        hitPath.setAttribute('stroke-width', '15');
        hitPath.setAttribute('fill', 'none');
        hitPath.setAttribute('data-target-room', targetRoom.id);
        hitPath.setAttribute('data-entity-id', entityId || '');
        hitPath.setAttribute('data-door', door);
        hitPath.style.pointerEvents = 'stroke';
        hitPath.style.cursor = 'pointer';
        layer.appendChild(hitPath);

        // Visible connection path
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', pathData);
        path.setAttribute('class', 'room-connection-line');
        path.setAttribute('stroke', 'var(--neon-green)');
        path.setAttribute('stroke-width', '2');
        path.setAttribute('stroke-dasharray', '6,4');
        path.setAttribute('opacity', '0.6');
        path.setAttribute('data-target-room', targetRoom.id);
        path.setAttribute('data-entity-id', entityId || '');
        path.setAttribute('data-door', door);
        path.style.pointerEvents = 'stroke';
        path.style.cursor = 'pointer';
        layer.appendChild(path);

        // Draw arrowhead at curve endpoint with proper tangent alignment
        this._drawArrowheadAtCurve(startX, startY, cpX, cpY, endX, endY, layer);

        // Label positioned at midpoint with perpendicular offset (opposite side of curve)
        // Since the curve is offset by +CURVE_OFFSET * perp, the label goes on the opposite side
        // to avoid visual overlap between the curve line and the text.
        // Increased from 8 to 16 to reduce text label overlap with curves and other labels.
        const LABEL_OFFSET = 16;
        const labelOffsetX = -LABEL_OFFSET * perpX;
        const labelOffsetY = -LABEL_OFFSET * perpY;
        const labelX = midX + labelOffsetX;
        const labelY = midY + labelOffsetY;

        // Format room name for display
        const roomName = targetRoom.name || 'Unknown';
        const labelText = isForward ? `→ ${roomName}` : `← ${roomName}`;

        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', labelX);
        text.setAttribute('y', labelY - 6);
        text.setAttribute('class', 'room-connection-label');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', 'var(--neon-green)');
        text.setAttribute('font-size', '11');
        text.setAttribute('font-weight', 'bold');
        text.setAttribute('style', 'pointer-events: none;');
        text.textContent = labelText;
        layer.appendChild(text);

        // Subtle background rect for text readability
        const textWidth = labelText.length * 6.5;
        const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bgRect.setAttribute('x', labelX - textWidth / 2 - 4);
        bgRect.setAttribute('y', labelY - 20);
        bgRect.setAttribute('width', textWidth + 8);
        bgRect.setAttribute('height', 16);
        bgRect.setAttribute('class', 'room-connection-label-bg');
        bgRect.setAttribute('fill', 'var(--bg-black)');
        bgRect.setAttribute('opacity', '0.75');
        bgRect.setAttribute('rx', '3');
        layer.insertBefore(bgRect, text);

        // Invisible wide hit-area rect for label click detection
        const labelHitRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        labelHitRect.setAttribute('x', labelX - textWidth / 2 - 8);
        labelHitRect.setAttribute('y', labelY - 24);
        labelHitRect.setAttribute('width', textWidth + 16);
        labelHitRect.setAttribute('height', 24);
        labelHitRect.setAttribute('fill', 'transparent');
        labelHitRect.setAttribute('style', 'pointer-events: fill; cursor: pointer;');
        labelHitRect.setAttribute('data-target-room', targetRoom.id);
        labelHitRect.setAttribute('data-entity-id', entityId || '');
        labelHitRect.setAttribute('data-door', door);
        layer.insertBefore(labelHitRect, text);

        // Click handlers
        path.addEventListener('click', (e) => {
            e.stopPropagation();
            if (onConnectionClick) {
                onConnectionClick(entityId, targetRoom.id, door);
            }
        });

        hitPath.addEventListener('click', (e) => {
            e.stopPropagation();
            if (onConnectionClick) {
                onConnectionClick(entityId, targetRoom.id, door);
            }
        });

        labelHitRect.addEventListener('click', (e) => {
            e.stopPropagation();
            if (onConnectionClick) {
                onConnectionClick(entityId, targetRoom.id, door);
            }
        });

        // Compute the door position in room-center-relative coordinates for hover callbacks.
        // The start point is on the current room's edge, expressed in SVG coords.
        // Convert to room-center-relative by subtracting CENTER_X/CENTER_Y.
        const doorX = startX - AppConfig.VIEW.CENTER_X;
        const doorY = startY - AppConfig.VIEW.CENTER_Y;

        // Hover effects on visible path
        path.addEventListener('mouseenter', () => {
            path.setAttribute('opacity', '1');
            path.setAttribute('stroke-width', '3');
            if (onDoorHover) {
                onDoorHover(door, { x: doorX, y: doorY });
            }
        });
        path.addEventListener('mouseleave', () => {
            path.setAttribute('opacity', '0.6');
            path.setAttribute('stroke-width', '2');
            if (onDoorLeave) {
                onDoorLeave();
            }
        });

        // Hover effects on hit-area path (same callbacks)
        hitPath.addEventListener('mouseenter', () => {
            path.setAttribute('opacity', '1');
            path.setAttribute('stroke-width', '3');
            if (onDoorHover) {
                onDoorHover(door, { x: doorX, y: doorY });
            }
        });
        hitPath.addEventListener('mouseleave', () => {
            path.setAttribute('opacity', '0.6');
            path.setAttribute('stroke-width', '2');
            if (onDoorLeave) {
                onDoorLeave();
            }
        });
    }

    /**
     * Draws a straight connection (for unidirectional pairs).
     * Preserves original straight line behavior.
     * @private
     */
    static _drawStraightConnection(room, targetRoom, door, offsetX, offsetY, layer,
        onConnectionClick = null, entityId = null, onDoorHover = null, onDoorLeave = null) {
        // Room centers relative to SVG viewBox
        const roomCX = offsetX + room.width / 2;
        const roomCY = offsetY + room.height / 2;
        const targetCX = offsetX + (targetRoom.x - room.x) + targetRoom.width / 2;
        const targetCY = offsetY + (targetRoom.y - room.y) + targetRoom.height / 2;

        // Target room's SVG position (for clamping the end point)
        const targetOffsetX = offsetX + (targetRoom.x - room.x);
        const targetOffsetY = offsetY + (targetRoom.y - room.y);

        // Calculate edge points
        const [startX, startY] = this._getEdgePoint(room, targetRoom, roomCX, roomCY, offsetX, offsetY);
        const [endX, endY] = this._getEdgePoint(targetRoom, room, targetCX, targetCY, targetOffsetX, targetOffsetY);

        // Compute the door position in room-center-relative coordinates for hover callbacks.
        // The start point is on the current room's edge, expressed in SVG coords.
        // Convert to room-center-relative by subtracting CENTER_X/CENTER_Y.
        const doorX = startX - AppConfig.VIEW.CENTER_X;
        const doorY = startY - AppConfig.VIEW.CENTER_Y;

        // Invisible wide hit-area line for reliable click detection (15px stroke)
        const hitLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        hitLine.setAttribute('x1', startX);
        hitLine.setAttribute('y1', startY);
        hitLine.setAttribute('x2', endX);
        hitLine.setAttribute('y2', endY);
        hitLine.setAttribute('stroke', 'transparent');
        hitLine.setAttribute('stroke-width', '15');
        hitLine.setAttribute('data-target-room', targetRoom.id);
        hitLine.setAttribute('data-entity-id', entityId || '');
        hitLine.setAttribute('data-door', door);
        hitLine.style.pointerEvents = 'stroke';
        hitLine.style.cursor = 'pointer';
        layer.appendChild(hitLine);

        // Visible connection line
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', startX);
        line.setAttribute('y1', startY);
        line.setAttribute('x2', endX);
        line.setAttribute('y2', endY);
        line.setAttribute('class', 'room-connection-line');
        line.setAttribute('stroke', 'var(--neon-green)');
        line.setAttribute('stroke-width', '2');
        line.setAttribute('stroke-dasharray', '6,4');
        line.setAttribute('opacity', '0.6');
        line.setAttribute('data-target-room', targetRoom.id);
        line.setAttribute('data-entity-id', entityId || '');
        line.setAttribute('data-door', door);
        line.style.pointerEvents = 'stroke';
        line.style.cursor = 'pointer';
        layer.appendChild(line);

        // Draw arrowhead
        this._drawArrowhead(startX, startY, endX, endY, layer);

        // Draw label at midpoint
        const midX = (startX + endX) / 2;
        const midY = (startY + endY) / 2;

        // Format room name for display
        const roomName = targetRoom.name || 'Unknown';
        const labelText = `→ ${roomName}`;

        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', midX);
        text.setAttribute('y', midY - 8);
        text.setAttribute('class', 'room-connection-label');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', 'var(--neon-green)');
        text.setAttribute('font-size', '11');
        text.setAttribute('font-weight', 'bold');
        text.setAttribute('style', 'pointer-events: none;');
        text.textContent = labelText;
        layer.appendChild(text);

        // Subtle background rect for text readability
        const textWidth = labelText.length * 6.5;
        const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bgRect.setAttribute('x', midX - textWidth / 2 - 4);
        bgRect.setAttribute('y', midY - 22);
        bgRect.setAttribute('width', textWidth + 8);
        bgRect.setAttribute('height', 16);
        bgRect.setAttribute('class', 'room-connection-label-bg');
        bgRect.setAttribute('fill', 'var(--bg-black)');
        bgRect.setAttribute('opacity', '0.75');
        bgRect.setAttribute('rx', '3');
        layer.insertBefore(bgRect, text);

        // Invisible wide hit-area rect for label click detection
        const labelHitRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        labelHitRect.setAttribute('x', midX - textWidth / 2 - 8);
        labelHitRect.setAttribute('y', midY - 26);
        labelHitRect.setAttribute('width', textWidth + 16);
        labelHitRect.setAttribute('height', 24);
        labelHitRect.setAttribute('fill', 'transparent');
        labelHitRect.setAttribute('style', 'pointer-events: fill; cursor: pointer;');
        labelHitRect.setAttribute('data-target-room', targetRoom.id);
        labelHitRect.setAttribute('data-entity-id', entityId || '');
        labelHitRect.setAttribute('data-door', door);
        layer.insertBefore(labelHitRect, text);

        // Click handlers
        line.addEventListener('click', (e) => {
            e.stopPropagation();
            if (onConnectionClick) {
                onConnectionClick(entityId, targetRoom.id, door);
            }
        });

        hitLine.addEventListener('click', (e) => {
            e.stopPropagation();
            if (onConnectionClick) {
                onConnectionClick(entityId, targetRoom.id, door);
            }
        });

        labelHitRect.addEventListener('click', (e) => {
            e.stopPropagation();
            if (onConnectionClick) {
                onConnectionClick(entityId, targetRoom.id, door);
            }
        });

        // Hover effects
        line.addEventListener('mouseenter', () => {
            line.setAttribute('opacity', '1');
            line.setAttribute('stroke-width', '3');
            if (onDoorHover) {
                onDoorHover(door, { x: doorX, y: doorY });
            }
        });
        line.addEventListener('mouseleave', () => {
            line.setAttribute('opacity', '0.6');
            line.setAttribute('stroke-width', '2');
            if (onDoorLeave) {
                onDoorLeave();
            }
        });

        // Hover effects on hit-area line (same callbacks)
        hitLine.addEventListener('mouseenter', () => {
            line.setAttribute('opacity', '1');
            line.setAttribute('stroke-width', '3');
            if (onDoorHover) {
                onDoorHover(door, { x: doorX, y: doorY });
            }
        });
        hitLine.addEventListener('mouseleave', () => {
            line.setAttribute('opacity', '0.6');
            line.setAttribute('stroke-width', '2');
            if (onDoorLeave) {
                onDoorLeave();
            }
        });
    }

    /**
     * Draws an arrowhead at the end of a Bézier curve, aligned with the curve tangent.
     * For a quadratic Bézier Q(P0, P1, P2), the tangent at t=1 is: 2*(P2-P1).
     * @private
     */
    static _drawArrowheadAtCurve(startX, startY, cpX, cpY, endX, endY, layer) {
        const arrowSize = 8;

        // Tangent at the end of the curve (t=1): direction from control point to endpoint
        const tangentX = 2 * (endX - cpX);
        const tangentY = 2 * (endY - cpY);

        // Normalize and calculate arrowhead points
        const angle = Math.atan2(tangentY, tangentX);

        const x1 = endX - arrowSize * Math.cos(angle - Math.PI / 6);
        const y1 = endY - arrowSize * Math.sin(angle - Math.PI / 6);
        const x2 = endX - arrowSize * Math.cos(angle + Math.PI / 6);
        const y2 = endY - arrowSize * Math.sin(angle + Math.PI / 6);

        const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        polyline.setAttribute('points', `${endX},${endY} ${x1},${y1} ${x2},${y2}`);
        polyline.setAttribute('class', 'room-connection-arrow');
        polyline.setAttribute('fill', 'var(--neon-green)');
        polyline.setAttribute('opacity', '0.8');
        polyline.style.pointerEvents = 'fill';
        polyline.style.cursor = 'pointer';

        // Hover effects
        polyline.addEventListener('mouseenter', () => {
            polyline.setAttribute('opacity', '1');
        });
        polyline.addEventListener('mouseleave', () => {
            polyline.setAttribute('opacity', '0.8');
        });

        layer.appendChild(polyline);
    }

    /**
     * Draws an arrowhead at the end of a straight connection line.
     * @private
     */
    static _drawArrowhead(startX, startY, endX, endY, layer) {
        const arrowSize = 8;
        const angle = Math.atan2(endY - startY, endX - startX);

        const x1 = endX - arrowSize * Math.cos(angle - Math.PI / 6);
        const y1 = endY - arrowSize * Math.sin(angle - Math.PI / 6);
        const x2 = endX - arrowSize * Math.cos(angle + Math.PI / 6);
        const y2 = endY - arrowSize * Math.sin(angle + Math.PI / 6);

        const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        polyline.setAttribute('points', `${endX},${endY} ${x1},${y1} ${x2},${y2}`);
        polyline.setAttribute('class', 'room-connection-arrow');
        polyline.setAttribute('fill', 'var(--neon-green)');
        polyline.setAttribute('opacity', '0.8');
        polyline.style.pointerEvents = 'fill';
        polyline.style.cursor = 'pointer';

        // Hover effects
        polyline.addEventListener('mouseenter', () => {
            polyline.setAttribute('opacity', '1');
        });
        polyline.addEventListener('mouseleave', () => {
            polyline.setAttribute('opacity', '0.8');
        });

        layer.appendChild(polyline);
    }

    /**
     * Calculates the edge point on a room's boundary toward another room.
     * @private
     */
    static _getEdgePoint(room, otherRoom, roomCX, roomCY, offsetX = 0, offsetY = 0) {
        // Use the same offset as _drawConnection for consistent coordinate system
        // otherRoom coordinates are relative to room (offset by room.x/room.y)
        const otherCX = offsetX + (otherRoom.x - room.x) + otherRoom.width / 2;
        const otherCY = offsetY + (otherRoom.y - room.y) + otherRoom.height / 2;

        // Direction from room center to other room center
        const dx = otherCX - roomCX;
        const dy = otherCY - roomCY;

        // Room boundaries relative to center
        const halfW = room.width / 2;
        const halfH = room.height / 2;

        // Determine which edge to use
        // Use >= to handle the tie case: when direction is more horizontal, hit left/right edge
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        let edgeX, edgeY;

        if (absDx * halfH >= absDy * halfW) {
            // Left or right edge
            const sign = dx > 0 ? 1 : -1;
            edgeX = roomCX + sign * halfW;
            edgeY = roomCY + (dy / absDx) * halfW;
        } else {
            // Top or bottom edge
            const sign = dy > 0 ? 1 : -1;
            edgeY = roomCY + sign * halfH;
            edgeX = roomCX + (dx / absDy) * halfH;
        }

        // Clamp to room boundaries (in SVG coordinate space)
        // The room's SVG bounds are offsetX to offsetX+width, offsetY to offsetY+height
        edgeX = Math.max(offsetX, Math.min(offsetX + room.width, edgeX));
        edgeY = Math.max(offsetY, Math.min(offsetY + room.height, edgeY));

        return [edgeX, edgeY];
    }

    /**
     * Builds a canonical key for a connection pair between two rooms.
     * Keys are sorted by room ID so that A→B and B→A produce the same key.
     * @param {string} idA - First room ID
     * @param {string} idB - Second room ID
     * @returns {string} Canonical connection key
     * @private
     */
    static _getConnectionKey(idA, idB) {
        return idA < idB ? `${idA}||${idB}` : `${idB}||${idA}`;
    }

    /**
     * Builds a map of connection pairs for all rooms.
     * Detects bidirectional connections (A→B and B→A) for curve rendering.
     * @param {Object} rooms - Map of all rooms keyed by room id
     * @returns {Map<string, {forward: boolean[], backward: boolean[], isBidirectional: boolean}>} Connection pair map
     * @private
     */
    static _buildConnectionPairs(rooms) {
        const pairMap = new Map();

        for (const room of Object.values(rooms)) {
            const connections = room.connections || {};
            for (const conn of Object.values(connections)) {
                const targetId = typeof conn === 'object' ? conn.target : conn;
                const pairKey = this._getConnectionKey(room.id, targetId);
                if (!pairMap.has(pairKey)) {
                    pairMap.set(pairKey, { forward: [], backward: [], isBidirectional: false });
                }
                const pair = pairMap.get(pairKey);
                if (room.id < targetId) {
                    pair.forward.push({ fromId: room.id, toId: targetId });
                } else {
                    pair.backward.push({ fromId: targetId, toId: room.id });
                }
            }
        }

        // Mark pairs as bidirectional if they have both forward and backward connections
        for (const pair of pairMap.values()) {
            pair.isBidirectional = pair.forward.length > 0 && pair.backward.length > 0;
        }

        return pairMap;
    }
}
