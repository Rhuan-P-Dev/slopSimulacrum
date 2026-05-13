/**
 * WorldMapView
 * Manages a full-screen overlay with an SVG world map showing ALL rooms as nodes,
 * connections as directed arrows with door names, and the current room highlighted.
 *
 * Features:
 * - Fetches data from GET /world-map endpoint
 * - Renders rooms as labeled rectangles on an SVG canvas
 * - Draws directed connection arrows with door name labels
 * - Highlights the current room with a distinct border color
 * - Supports pan (drag) and zoom (mouse wheel) for large maps
 * - Toggle via 🌐 button in the config bar
 *
 * Expected /world-map response format:
 * {
 *   "rooms": [
 *     { "id": "room_id_1", "name": "Living Room", "x": 100, "y": 100, "width": 120, "height": 80,
 *       "connections": [{ "door": "kitchen_door", "targetId": "room_id_2", "targetName": "Kitchen" }] }
 *   ]
 * }
 *
 * @module WorldMapView
 */
import { AppConfig } from './Config.js';

export class WorldMapView {
    /**
     * Creates a new WorldMapView.
     * @param {Object} deps - Dependencies
     * @param {Function} deps.onRoomClick - Callback when a room is clicked (roomId)
     */
    constructor(deps = {}) {
        this._onRoomClick = deps.onRoomClick || null;
        this._overlay = null;
        this._svg = null;
        this._mapGroup = null;
        this._worldData = null;
        this._currentRoomId = null;

        // Pan/zoom state
        this._panX = 0;
        this._panY = 0;
        this._scale = 1;
        this._isPanning = false;
        this._lastMouseX = 0;
        this._lastMouseY = 0;
    }

    /**
     * Initializes the overlay DOM element.
     */
    init() {
        this._overlay = document.getElementById('world-map-overlay');
    }

    /**
     * Fetches world map data and renders it.
     * @returns {Promise<boolean>} True if successful.
     */
    async fetchAndRender() {
        try {
            const response = await fetch('/world-map');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            this._worldData = await response.json();
            return true;
        } catch (error) {
            console.error('[WorldMapView] Failed to fetch world map:', error);
            return false;
        }
    }

    /**
     * Sets the current room ID for highlighting.
     * @param {string} roomId - The current room ID.
     */
    setCurrentRoomId(roomId) {
        this._currentRoomId = roomId;
    }

    /**
     * Shows the world map overlay.
     * Fetches data and renders the map.
     */
    async show() {
        if (!this._overlay) this.init();
        if (!this._overlay) return;

        // Fetch fresh data
        const success = await this.fetchAndRender();
        if (!success || !this._worldData) {
            console.warn('[WorldMapView] Could not fetch world map data.');
            return;
        }

        this._overlay.style.display = 'flex';

        // Render the SVG map
        this._renderMap();
    }

    /**
     * Hides the world map overlay.
     */
    hide() {
        if (!this._overlay) return;
        this._overlay.style.display = 'none';
    }

    /**
     * Toggles the world map overlay.
     */
    toggle() {
        if (this._overlay && this._overlay.style.display === 'flex') {
            this.hide();
        } else {
            this.show();
        }
    }

    /**
     * Renders the SVG world map.
     * @private
     */
    _renderMap() {
        if (!this._overlay || !this._worldData) return;

        // Clear existing SVG content
        const content = document.getElementById('world-map-content');
        content.innerHTML = '';

        const rooms = this._worldData.rooms || [];
        if (rooms.length === 0) {
            content.innerHTML = '<p style="color: var(--text-dim); text-align: center; margin-top: 50px;">No rooms available.</p>';
            return;
        }

        // Calculate bounds for auto-scaling
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const room of rooms) {
            minX = Math.min(minX, room.x);
            minY = Math.min(minY, room.y);
            maxX = Math.max(maxX, room.x + room.width);
            maxY = Math.max(maxY, room.y + room.height);
        }

        const mapWidth = maxX - minX + 200;
        const mapHeight = maxY - minY + 200;
        const offsetX = -minX + 100;
        const offsetY = -minY + 100;

        // Create SVG
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('viewBox', `0 0 ${mapWidth} ${mapHeight}`);
        svg.style.cursor = 'grab';
        svg.id = 'world-map-svg';

        // Defs for arrow marker
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
        marker.setAttribute('id', 'world-map-arrow');
        marker.setAttribute('viewBox', '0 0 10 10');
        marker.setAttribute('refX', '9');
        marker.setAttribute('refY', '5');
        marker.setAttribute('markerWidth', '6');
        marker.setAttribute('markerHeight', '6');
        marker.setAttribute('orient', 'auto');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 Z');
        path.setAttribute('fill', 'var(--neon-green)');
        marker.appendChild(path);
        defs.appendChild(marker);
        svg.appendChild(defs);

        // Main group with pan/zoom transform
        const mapGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        mapGroup.setAttribute('transform', `translate(${offsetX}, ${offsetY})`);
        mapGroup.id = 'world-map-group';

        // Draw connections first (behind rooms)
        for (const room of rooms) {
            for (const conn of (room.connections || [])) {
                this._drawConnection(mapGroup, room, conn, rooms);
            }
        }

        // Draw room nodes
        for (const room of rooms) {
            this._drawRoomNode(mapGroup, room);
        }

        svg.appendChild(mapGroup);
        content.appendChild(svg);

        // Setup pan/zoom interactions
        this._setupPanZoom(svg, mapGroup);
    }

    /**
     * Draws a connection between rooms on the SVG.
     * @private
     */
    _drawConnection(group, room, conn, allRooms) {
        const targetRoom = allRooms.find(r => r.id === conn.targetId);
        if (!targetRoom) return;

        const roomCX = room.x + room.width / 2;
        const roomCY = room.y + room.height / 2;
        const targetCX = targetRoom.x + targetRoom.width / 2;
        const targetCY = targetRoom.y + targetRoom.height / 2;

        // Get edge points
        const [startX, startY] = this._getEdgePoint(room, targetRoom, roomCX, roomCY);
        const [endX, endY] = this._getEdgePoint(targetRoom, room, targetCX, targetCY);

        // Draw line
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', startX);
        line.setAttribute('y1', startY);
        line.setAttribute('x2', endX);
        line.setAttribute('y2', endY);
        line.setAttribute('stroke', 'var(--neon-green)');
        line.setAttribute('stroke-width', '2');
        line.setAttribute('stroke-dasharray', '8,4');
        line.setAttribute('opacity', '0.5');
        line.setAttribute('marker-end', 'url(#world-map-arrow)');
        group.appendChild(line);

        // Draw label
        const midX = (startX + endX) / 2;
        const midY = (startY + endY) / 2;

        const labelText = `${conn.door.replace(/_/g, ' ')}`;
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', midX);
        text.setAttribute('y', midY - 8);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', 'var(--text-dim)');
        text.setAttribute('font-size', '10');
        text.textContent = labelText;
        group.appendChild(text);
    }

    /**
     * Draws a room node on the SVG.
     * @private
     */
    _drawRoomNode(group, room) {
        const isCurrentRoom = room.id === this._currentRoomId;

        // Room rectangle
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', room.x);
        rect.setAttribute('y', room.y);
        rect.setAttribute('width', room.width);
        rect.setAttribute('height', room.height);
        rect.setAttribute('rx', '6');
        rect.setAttribute('class', 'world-map-room-node');
        rect.setAttribute('fill', isCurrentRoom ? 'rgba(0, 255, 0, 0.15)' : 'rgba(0, 0, 0, 0.5)');
        rect.setAttribute('stroke', isCurrentRoom ? 'var(--neon-green)' : 'var(--text-dim)');
        rect.setAttribute('stroke-width', isCurrentRoom ? '3' : '1.5');
        rect.style.cursor = 'pointer';

        if (isCurrentRoom) {
            rect.setAttribute('filter', 'url(#glow)');
        }

        // Click handler for room
        rect.addEventListener('click', () => {
            if (this._onRoomClick) {
                this._onRoomClick(room.id);
            }
        });

        group.appendChild(rect);

        // Room name label
        const nameText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        nameText.setAttribute('x', room.x + room.width / 2);
        nameText.setAttribute('y', room.y + room.height / 2);
        nameText.setAttribute('text-anchor', 'middle');
        nameText.setAttribute('dominant-baseline', 'middle');
        nameText.setAttribute('fill', isCurrentRoom ? 'var(--neon-green)' : 'var(--text-main)');
        nameText.setAttribute('font-size', '12');
        nameText.setAttribute('font-weight', isCurrentRoom ? 'bold' : 'normal');
        nameText.style.pointerEvents = 'none';
        nameText.textContent = room.name;
        group.appendChild(nameText);
    }

    /**
     * Calculates the edge point on a room's boundary toward another room.
     * @private
     */
    _getEdgePoint(room, otherRoom, roomCX, roomCY) {
        const otherCX = otherRoom.x + otherRoom.width / 2;
        const otherCY = otherRoom.y + otherRoom.height / 2;

        const dx = otherCX - roomCX;
        const dy = otherCY - roomCY;

        const halfW = room.width / 2;
        const halfH = room.height / 2;

        let edgeX, edgeY;

        if (Math.abs(dx) * halfH > Math.abs(dy) * halfW) {
            const sign = dx > 0 ? 1 : -1;
            edgeX = roomCX + sign * halfW;
            edgeY = roomCY + (dy / Math.abs(dx)) * halfW;
        } else {
            const sign = dy > 0 ? 1 : -1;
            edgeY = roomCY + sign * halfH;
            edgeX = roomCX + (dx / Math.abs(dy)) * halfH;
        }

        edgeX = Math.max(room.x, Math.min(room.x + room.width, edgeX));
        edgeY = Math.max(room.y, Math.min(room.y + room.height, edgeY));

        return [edgeX, edgeY];
    }

    /**
     * Sets up pan (drag) and zoom (mouse wheel) interactions.
     * @private
     */
    _setupPanZoom(svg, group) {
        svg.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            this._isPanning = true;
            this._lastMouseX = e.clientX;
            this._lastMouseY = e.clientY;
            svg.style.cursor = 'grabbing';
        });

        window.addEventListener('mousemove', (e) => {
            if (!this._isPanning) return;
            const dx = e.clientX - this._lastMouseX;
            const dy = e.clientY - this._lastMouseY;
            this._lastMouseX = e.clientX;
            this._lastMouseY = e.clientY;

            const transform = group.getAttribute('transform');
            const match = transform.match(/translate\(([-\d.]+),\s*([-\d.]+)\)/);
            if (match) {
                const newX = parseFloat(match[1]) + dx;
                const newY = parseFloat(match[2]) + dy;
                group.setAttribute('transform', `translate(${newX}, ${newY})`);
            }
        });

        window.addEventListener('mouseup', () => {
            this._isPanning = false;
            if (svg) svg.style.cursor = 'grab';
        });

        svg.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            // Simple zoom by adjusting viewBox
            const currentVB = svg.getAttribute('viewBox').split(' ').map(Number);
            const newWidth = currentVB[2] / delta;
            const newHeight = currentVB[3] / delta;
            svg.setAttribute('viewBox', `${currentVB[0]} ${currentVB[1]} ${newWidth} ${newHeight}`);
        });
    }
}