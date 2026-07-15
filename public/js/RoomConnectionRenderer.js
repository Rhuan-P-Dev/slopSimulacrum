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
     * @param {Function} [onConnectionClick] - Optional callback when a connection is clicked (entityId, targetRoomId)
     * @param {string} [entityId] - The entity ID to pass to the click callback
     */
    static renderRoomConnections(room, rooms, roomLayer, onConnectionClick = null, entityId = null) {
        const connections = room.connections || {};

        if (Object.keys(connections).length === 0) {
            return;
        }

        const offsetX = AppConfig.VIEW.CENTER_X - room.width / 2;
        const offsetY = AppConfig.VIEW.CENTER_Y - room.height / 2;

        for (const [door, targetId] of Object.entries(connections)) {
            const targetRoom = rooms[targetId];
            if (!targetRoom) continue;

            this._drawConnection(
                room, targetRoom, door, offsetX, offsetY, roomLayer, onConnectionClick, entityId
            );
        }
    }

    /**
     * Draws a single connection between two rooms.
     * @private
     */
    static _drawConnection(room, targetRoom, door, offsetX, offsetY, layer, onConnectionClick = null, entityId = null) {
        // Room centers relative to SVG viewBox (matching _renderRoom() centering)
        // _renderRoom() places the current room at (CENTER_X - room.width/2, CENTER_Y - room.height/2)
        // Target rooms are positioned relative to the current room using data coordinate deltas
        const roomCX = offsetX + room.width / 2;
        const roomCY = offsetY + room.height / 2;
        // Use relative data coordinates: target position = offsetX + (target.x - room.x) + target.width/2
        const targetCX = offsetX + (targetRoom.x - room.x) + targetRoom.width / 2;
        const targetCY = offsetY + (targetRoom.y - room.y) + targetRoom.height / 2;

        // Target room's SVG position (for clamping the end point)
        const targetOffsetX = offsetX + (targetRoom.x - room.x);
        const targetOffsetY = offsetY + (targetRoom.y - room.y);

        // Calculate edge points (pass correct offsets for each room's clamping)
        const [startX, startY] = this._getEdgePoint(room, targetRoom, roomCX, roomCY, offsetX, offsetY);
        const [endX, endY] = this._getEdgePoint(targetRoom, room, targetCX, targetCY, targetOffsetX, targetOffsetY);

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
        line.style.pointerEvents = 'stroke';
        line.style.cursor = 'pointer';
        layer.appendChild(line);

        // Draw arrowhead
        this._drawArrowhead(startX, startY, endX, endY, layer);

        // Draw label at midpoint
        const midX = (startX + endX) / 2;
        const midY = (startY + endY) / 2;

        // Format door name for display
        const doorLabel = door.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
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

        // Add a subtle background rect for text readability
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
        layer.insertBefore(labelHitRect, text);

        // Click handler on the visible line (hit-area is behind it)
        line.addEventListener('click', (e) => {
            e.stopPropagation();
            if (onConnectionClick) {
                onConnectionClick(entityId, targetRoom.id, door);
            }
        });

        // Also attach click to hit-area line
        hitLine.addEventListener('click', (e) => {
            e.stopPropagation();
            if (onConnectionClick) {
                onConnectionClick(entityId, targetRoom.id, door);
            }
        });

        // Attach click to label hit-area rect
        labelHitRect.addEventListener('click', (e) => {
            e.stopPropagation();
            if (onConnectionClick) {
                onConnectionClick(entityId, targetRoom.id, door);
            }
        });

        // Hover effects on visible line
        line.addEventListener('mouseenter', () => {
            line.setAttribute('opacity', '1');
            line.setAttribute('stroke-width', '3');
        });
        line.addEventListener('mouseleave', () => {
            line.setAttribute('opacity', '0.6');
            line.setAttribute('stroke-width', '2');
        });
    }

    /**
     * Draws an arrowhead at the end of the connection line.
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
}