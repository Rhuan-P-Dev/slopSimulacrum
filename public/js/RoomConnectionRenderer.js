/**
 * RoomConnectionRenderer
 * Handles SVG rendering of connections between rooms.
 * Provides edge-to-edge line drawing with arrow markers and midpoint labels.
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
     */
    static renderRoomConnections(room, rooms, roomLayer) {
        const connections = room.connections || {};

        if (Object.keys(connections).length === 0) {
            return;
        }

        const centerOffsetX = AppConfig.VIEW.CENTER_X;
        const centerOffsetY = AppConfig.VIEW.CENTER_Y;

        for (const [door, targetId] of Object.entries(connections)) {
            const targetRoom = rooms[targetId];
            if (!targetRoom) continue;

            this._drawConnection(
                room, targetRoom, door, centerOffsetX, centerOffsetY, roomLayer
            );
        }
    }

    /**
     * Draws a single connection between two rooms.
     * @private
     */
    static _drawConnection(room, targetRoom, door, offsetX, offsetY, layer) {
        // Room centers relative to SVG viewBox
        const roomCX = offsetX + room.x;
        const roomCY = offsetY + room.y;
        const targetCX = offsetX + targetRoom.x;
        const targetCY = offsetY + targetRoom.y;

        // Calculate edge points
        const [startX, startY] = this._getEdgePoint(room, targetRoom, roomCX, roomCY);
        const [endX, endY] = this._getEdgePoint(targetRoom, room, targetCX, targetCY);

        // Draw connection line
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', startX);
        line.setAttribute('y1', startY);
        line.setAttribute('x2', endX);
        line.setAttribute('y2', endY);
        line.setAttribute('class', 'room-connection-line');
        line.setAttribute('stroke', 'var(--neon-green)');
        line.setAttribute('stroke-width', '1.5');
        line.setAttribute('stroke-dasharray', '6,4');
        line.setAttribute('opacity', '0.6');
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
        layer.appendChild(polyline);
    }

    /**
     * Calculates the edge point on a room's boundary toward another room.
     * @private
     */
    static _getEdgePoint(room, otherRoom, roomCX, roomCY) {
        const otherCX = AppConfig.VIEW.CENTER_X + otherRoom.x;
        const otherCY = AppConfig.VIEW.CENTER_Y + otherRoom.y;

        // Direction from room center to other room center
        const dx = otherCX - roomCX;
        const dy = otherCY - roomCY;

        // Room boundaries relative to center
        const halfW = room.width / 2;
        const halfH = room.height / 2;

        // Determine which edge to use
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        let edgeX, edgeY;

        if (absDx * halfH > absDy * halfW) {
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

        // Clamp to room boundaries
        edgeX = Math.max(room.x, Math.min(room.x + room.width, edgeX));
        edgeY = Math.max(room.y, Math.min(room.y + room.height, edgeY));

        return [edgeX, edgeY];
    }
}