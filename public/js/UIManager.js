import { AppConfig } from './Config.js';
import { RoomConnectionRenderer } from './RoomConnectionRenderer.js';
import ClientLogger from '/utils/ClientLogger.js';

/**
 * UIManager
 * Handles all DOM and SVG rendering logic for the client.
 * Decouples the visual representation from the application logic.
 */
export class UIManager {
    constructor() {
        // Cache frequently used DOM elements
        this.elements = {
            // Status
            status: document.getElementById('status'),
            // Room info
            roomName: document.getElementById('current-room-name'),
            roomDesc: document.getElementById('current-room-desc'),
            roomCoords: document.getElementById('current-room-coords'),
            // SVG layers
            roomLayer: document.getElementById('room-layer'),
            entitiesLayer: document.getElementById('entities-layer'),
            componentsLayer: document.getElementById('components-layer'),
            // Detail overlay
            detailOverlay: document.getElementById('detail-overlay'),
            detailContent: document.getElementById('detail-content'),
            closeDetailsBtn: document.getElementById('close-details-btn'),
        };

        this._setupEventListeners();
    }

    _setupEventListeners() {
        this.elements.closeDetailsBtn.onclick = () => this.closeDetails();
    }

    /**
     * Updates the entity and component layers.
     * @param {Object} room
     * @param {Object} entities
     * @param {Object} droid
     * @param {Object} state
     */
    updateEntityAndComponentViews(room, entities, droid, state) {
        this._renderEntities(room, entities, droid?.id);
        this._renderDroidComponents(droid, state);
    }

    /**
     * Main update loop for the UI.
     * @param {Object} state The current world state.
     * @param {Object} droid The active droid entity.
     * @param {Function} onMoveCallback Callback when a connection is clicked.
     *   Receives (entityId, targetRoomId, doorName, range) where range is null if not set.
     * @param {Function} [onDoorHover] - Hover callback for door connections (doorName, doorPosition, range).
     * @param {Function} [onDoorLeave] - Leave callback for door connections.
     */
    updateWorldView(state, droid, onMoveCallback, onDoorHover = null, onDoorLeave = null) {
        if (!droid) {
            this._renderEmptyState();
            return;
        }

        if (!state || !state.rooms || !state.rooms[droid.location]) {
            ClientLogger.warn('UIManager', ` updateWorldView skipped: Room ${droid?.location} not found in state`);
            return;
        }

        const room = state.rooms[droid.location];

        // Update Text Info
        this.elements.roomName.textContent = room.name;
        this.elements.roomDesc.textContent = room.description;
        this.elements.roomCoords.textContent = `Room Size: ${room.width}x${room.height}`;

        // Render map layers
        this._renderRoom(room);
        this.renderRoomConnections(room, state.rooms, onMoveCallback, droid.id, onDoorHover, onDoorLeave);
        this._renderEntities(room, state.entities, droid.id);
        this._renderDroidComponents(droid, state);
    }

    _renderEmptyState() {
        this.elements.roomName.textContent = "No Droid Found";
        this.elements.roomDesc.textContent = "The simulation is empty.";
        this.elements.roomCoords.textContent = "";
        this.elements.roomLayer.innerHTML = '';
        this.elements.entitiesLayer.innerHTML = '';
        this.elements.componentsLayer.innerHTML = '';
    }

    /**
     * Renders a range indicator circle on the entities layer.
     * Supports different colors and types for different action modes.
     *
     * @param {Object} droid - The droid entity object with spatial coordinates.
     * @param {number} range - The radius of the range indicator.
     * @param {string} color - The stroke color ('red' for drop, 'white' for movement, etc.).
     * @param {string} [indicatorType='default'] - The type of indicator ('drop', 'pickup', 'default').
     */
    renderRangeIndicator(droid, range, color = 'red', indicatorType = 'default') {
        const entitiesLayer = this.elements.entitiesLayer;

        // Guard: prevent NaN/Infinity range values from breaking SVG
        if (typeof range !== 'number' || isNaN(range) || !isFinite(range)) {
            return;
        }

        // Remove existing range indicators if any
        const existing = entitiesLayer.querySelector('.range-indicator');
        if (existing) existing.remove();

        const entityX = AppConfig.VIEW.CENTER_X + (droid.spatial?.x || 0);
        const entityY = AppConfig.VIEW.CENTER_Y + (droid.spatial?.y || 0);

        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", entityX);
        circle.setAttribute("cy", entityY);
        circle.setAttribute("r", range);
        circle.setAttribute("fill", "none");

        // Style based on indicator type to visually distinguish different modes
        // 'drop' = full drop range circle, 'pickup' = confirmed pickup range,
        // 'hover-pickup' = lightweight hover preview (thinner, more dashed)
        let strokeColor, opacity, dasharray, strokeWidth;

        if (indicatorType === 'hover-pickup') {
            strokeColor = color;
            opacity = 0.4;
            dasharray = '3,6';
            strokeWidth = 2;
        } else if (indicatorType === 'drop') {
            strokeColor = '#ff4444';
            opacity = 0.8;
            dasharray = '8,4';
            strokeWidth = 3;
        } else {
            strokeColor = color;
            opacity = 0.6;
            dasharray = '5,5';
            strokeWidth = 3;
        }

        circle.setAttribute("stroke", strokeColor);
        circle.setAttribute("stroke-width", strokeWidth);
        circle.setAttribute("stroke-dasharray", dasharray);
        circle.setAttribute("class", `range-indicator range-${indicatorType}`);
        circle.setAttribute("style", `pointer-events: none; opacity: ${opacity};`);

        entitiesLayer.appendChild(circle);
    }

    /**
     * Clears any existing range indicator from the map.
     */
    clearRangeIndicator() {
        const existing = this.elements.entitiesLayer.querySelector('.range-indicator');
        if (existing) existing.remove();
    }

    /**
     * Renders dropped items as small item icons on the map.
     * Each dropped item is displayed as a small circle with an item indicator.
     *
     * @param {Object} droppedItems - Map of dropped items { [droppedItemId]: {id, itemType, x, y, ownerId} }.
     * @param {Function} [onDroppedItemClick] - Callback when a dropped item is clicked.
     */
    renderDroppedItems(droppedItems, onDroppedItemClick) {
        const entitiesLayer = this.elements.entitiesLayer;

        // Remove existing dropped item indicators
        const existing = entitiesLayer.querySelectorAll('.dropped-item-indicator');
        existing.forEach(el => el.remove());

        if (!droppedItems || typeof droppedItems !== 'object') return;

        for (const [id, item] of Object.entries(droppedItems)) {
            const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            const x = AppConfig.VIEW.CENTER_X + (item.x || 0);
            const y = AppConfig.VIEW.CENTER_Y + (item.y || 0);

            circle.setAttribute("cx", x);
            circle.setAttribute("cy", y);
            circle.setAttribute("r", 8);
            circle.setAttribute("fill", "#ffaa00");
            circle.setAttribute("stroke", "#ff8800");
            circle.setAttribute("stroke-width", "2");
            circle.setAttribute("class", "dropped-item-indicator");
            circle.setAttribute("data-dropped-id", id);
            circle.setAttribute("style", "pointer-events: all; cursor: pointer; opacity: 0.9;");

            // Click handler for dropped items
            if (onDroppedItemClick) {
                circle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    onDroppedItemClick(id, item);
                });
            }

            // Tooltip text
            const tooltip = document.createElementNS("http://www.w3.org/2000/svg", "title");
            tooltip.textContent = `${item.itemType} (dropped item)`;
            circle.appendChild(tooltip);

            entitiesLayer.appendChild(circle);
        }
    }

    /**
     * Renders dropped items on the spatial map (#world-map SVG).
     * Called from App.js after world state refresh to display dropped items.
     * Renders as blue squares to distinguish from entity markers.
     *
     * Hover callbacks receive (id, item) and return a color string for the marker stroke.
     * The hover callback returns the range-status color (green/red), and the leave callback
     * returns null to reset to the default stroke. UIManager applies the stroke directly,
     * keeping DOM manipulation decoupled from App's range calculation logic.
     *
     * @param {Object} droppedItems - Map of dropped items { [droppedItemId]: {id, itemType, x, y, name, ...} }.
     * @param {Function} [onDroppedItemClick] - Callback when a dropped item is clicked (id, item).
     * @param {Function} [onDroppedItemHover] - Callback when hovering over a dropped item. Receives (id, item), returns stroke color string.
     * @param {Function} [onDroppedItemLeave] - Callback when leaving a dropped item. Receives (id, item), returns null to reset stroke.
     */
    renderDroppedItemsOnSpatialMap(droppedItems, onDroppedItemClick, onDroppedItemHover, onDroppedItemLeave) {
        const entitiesLayer = this.elements.entitiesLayer;

        // Remove existing dropped item indicators
        const existing = entitiesLayer.querySelectorAll('.dropped-item-indicator');
        existing.forEach(el => el.remove());

        if (!droppedItems || typeof droppedItems !== 'object') return;

        const SIZE = 16;
        const HALF = SIZE / 2;
        const DEFAULT_STROKE = '#88bbff';
        const DEFAULT_STROKE_WIDTH = '2';

        for (const [id, item] of Object.entries(droppedItems)) {
            const x = AppConfig.VIEW.CENTER_X + (item.x || 0);
            const y = AppConfig.VIEW.CENTER_Y + (item.y || 0);

            const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            rect.setAttribute("x", x - HALF);
            rect.setAttribute("y", y - HALF);
            rect.setAttribute("width", SIZE);
            rect.setAttribute("height", SIZE);
            rect.setAttribute("rx", "2");
            rect.setAttribute("fill", "#4488ff");
            rect.setAttribute("stroke", DEFAULT_STROKE);
            rect.setAttribute("stroke-width", DEFAULT_STROKE_WIDTH);
            rect.setAttribute("class", "dropped-item-indicator");
            rect.setAttribute("data-dropped-id", id);
            rect.setAttribute("style", "pointer-events: all; cursor: pointer; opacity: 0.9;");

            if (onDroppedItemClick) {
                rect.addEventListener('click', (e) => {
                    e.stopPropagation();
                    onDroppedItemClick(id, item);
                });
            }

            // Hover: App calculates range and returns color; UIManager applies stroke to marker
            if (onDroppedItemHover) {
                rect.addEventListener('mouseenter', () => {
                    const color = onDroppedItemHover(id, item);
                    if (color) {
                        rect.setAttribute("stroke", color);
                        rect.setAttribute("stroke-width", "3");
                    }
                });
            }
            if (onDroppedItemLeave) {
                rect.addEventListener('mouseleave', () => {
                    onDroppedItemLeave(id, item);
                    rect.setAttribute("stroke", DEFAULT_STROKE);
                    rect.setAttribute("stroke-width", DEFAULT_STROKE_WIDTH);
                });
            }

            // Name label below the square
            const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
            label.setAttribute("x", x);
            label.setAttribute("y", y + HALF + 12);
            label.setAttribute("text-anchor", "middle");
            label.setAttribute("fill", "#88bbff");
            label.setAttribute("font-size", "9");
            label.style.pointerEvents = 'none';
            label.textContent = item.name || item.itemType;

            entitiesLayer.appendChild(rect);
            entitiesLayer.appendChild(label);
        }
    }

    _renderRoom(room) {
        const roomLayer = this.elements.roomLayer;
        roomLayer.innerHTML = '';

        const roomX = AppConfig.VIEW.CENTER_X - room.width / 2;
        const roomY = AppConfig.VIEW.CENTER_Y - room.height / 2;

        const group = document.createElementNS("http://www.w3.org/2000/svg", "g");

        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", roomX);
        rect.setAttribute("y", roomY);
        rect.setAttribute("width", room.width);
        rect.setAttribute("height", room.height);
        rect.setAttribute("class", `room-boundary active`);

        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", AppConfig.VIEW.CENTER_X);
        label.setAttribute("y", roomY - 15);
        label.setAttribute("class", "room-label");
        label.textContent = room.name;

        const coords = document.createElementNS("http://www.w3.org/2000/svg", "text");
        coords.setAttribute("x", AppConfig.VIEW.CENTER_X);
        coords.setAttribute("y", roomY - 35);
        coords.setAttribute("class", "room-coords");
        coords.textContent = `Room Coords: (${room.x}, ${room.y})`;

        group.appendChild(rect);
        group.appendChild(label);
        group.appendChild(coords);
        roomLayer.appendChild(group);

        // Store reference to roomLayer for connection rendering
        this._currentRoomLayer = roomLayer;
    }

    /**
     * Renders connection lines from the current room to all connected target rooms.
     * @param {Object} room - The current room object.
     * @param {Object} rooms - Map of all rooms keyed by room id.
     * @param {Function} [onConnectionClick] - Click callback.
     *   Receives (entityId, targetRoomId, doorName, range) where range is null if not set.
     * @param {string} [entityId] - The entity ID for click callbacks.
     * @param {Function} [onDoorHover] - Hover callback (doorName, doorPosition, range).
     * @param {Function} [onDoorLeave] - Leave callback.
     */
    renderRoomConnections(room, rooms, onConnectionClick = null, entityId = null, onDoorHover = null, onDoorLeave = null) {
        if (!this._currentRoomLayer) return;
        RoomConnectionRenderer.renderRoomConnections(room, rooms, this._currentRoomLayer,
            onConnectionClick, entityId, onDoorHover, onDoorLeave);
    }

    _renderEntities(room, entities, activeDroidId) {
        const entitiesLayer = this.elements.entitiesLayer;
        entitiesLayer.innerHTML = '';

        const roomEntities = Object.values(entities || {}).filter(e => e.location === room.id);

        roomEntities.forEach(entity => {
            const entityX = AppConfig.VIEW.CENTER_X + (entity.spatial?.x || 0);
            const entityY = AppConfig.VIEW.CENTER_Y + (entity.spatial?.y || 0);

            const marker = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            marker.setAttribute("cx", entityX);
            marker.setAttribute("cy", entityY);
            marker.setAttribute("r", AppConfig.MARKER_SIZES.ENTITY_RADIUS);
            marker.setAttribute("fill", entity.id === activeDroidId ? AppConfig.COLORS.ENTITY_ACTIVE : AppConfig.COLORS.ENTITY_DEFAULT);
            marker.setAttribute("class", `entity-marker`);
            marker.setAttribute("filter", "url(#glow)");

            entitiesLayer.appendChild(marker);

            // Entity name label (spec §7.4): named entities (NPCs — "Bolt the
            // Merchant") are readable on the map; nameless player droids fall
            // back to 'Droid'.
            const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
            label.setAttribute("x", entityX);
            label.setAttribute("y", entityY - AppConfig.MARKER_SIZES.ENTITY_RADIUS - 4);
            label.setAttribute("text-anchor", "middle");
            label.setAttribute("fill", entity.isNPC ? "#ffaa00" : "#88bbff");
            label.setAttribute("font-size", "9");
            label.style.pointerEvents = 'none';
            label.textContent = entity.name || 'Droid';

            entitiesLayer.appendChild(label);
        });
    }

    _renderDroidComponents(droid, state) {
        const componentsLayer = this.elements.componentsLayer;
        componentsLayer.innerHTML = '';

        if (!droid || !droid.components || !state.components || !state.components.instances) return;

        const entityX = AppConfig.VIEW.CENTER_X + (droid.spatial?.x || 0);
        const entityY = AppConfig.VIEW.CENTER_Y + (droid.spatial?.y || 0);

        droid.components.forEach(comp => {
            const stats = state.components.instances[comp.id];
            if (!stats || !stats.Spatial) return;

            const compX = entityX + stats.Spatial.x;
            const compY = entityY + stats.Spatial.y;

            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", entityX);
            line.setAttribute("y1", entityY);
            line.setAttribute("x2", compX);
            line.setAttribute("y2", compY);
            line.setAttribute("class", "component-connection");
            componentsLayer.appendChild(line);

            const marker = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            marker.setAttribute("cx", compX);
            marker.setAttribute("cy", compY);
            marker.setAttribute("r", AppConfig.MARKER_SIZES.COMPONENT_RADIUS);
            marker.setAttribute("fill", AppConfig.COLORS.COMPONENT_DEFAULT);
            marker.setAttribute("class", "component-marker");
            marker.setAttribute("title", `${comp.type}: ${comp.identifier}`);

            componentsLayer.appendChild(marker);
        });
    }

    /**
     * Displays live synergy preview in the UI.
     * Two modes:
     * - SINGLE COMPONENT: Shows action data (range, consequences, requirements)
     * - MULTI COMPONENT: Shows synergy with modified values (before → after + bonus%)
     *
     * @param {Object} preview - Preview data from server.
     * @param {Object} preview.actionData - Action definition (targetingType, range, consequences, requirements).
     * @param {Object} preview.resolvedValues - Consequence values with placeholders resolved.
     * @param {Object} preview.synergyResult - Synergy computation result (multiplier, contributingComponents).
     */
    renderSynergyPreview(preview) {
        // Remove existing
        const existing = document.querySelector('.synergy-preview-display');
        if (existing) existing.remove();

        if (!preview) return;

        const { actionData, resolvedValues, synergyResult } = preview;
        const componentCount = synergyResult?.contributingComponents?.length ?? 0;

        const display = document.createElement('div');
        display.className = 'synergy-preview-display';

        if (componentCount <= 1) {
            // Single component mode: show action data
            display.innerHTML = this._buildActionDataHtml(actionData, resolvedValues);
        } else {
            // Multi-component mode: show synergy with modified values
            display.innerHTML = this._buildSynergyPreviewHtml(actionData, resolvedValues, synergyResult);
        }

        const actionSection = document.querySelector('.action-section') || document.body;
        actionSection.appendChild(display);
    }

    /**
     * Builds HTML for single-component action data preview.
     * Shows: range, consequences (resolved values), requirements.
     *
     * @private
     * @param {Object} actionData - Action definition.
     * @param {Object} resolvedValues - Resolved consequence values.
     * @returns {string} HTML string.
     */
    _buildActionDataHtml(actionData, resolvedValues) {
        if (!actionData) return '';

        let html = '<div class="action-data-preview">';

        // Action name header
        html += `<div class="synergy-header"><span class="synergy-multiplier">📋 Action: ${actionData._name || 'Unknown'}</span></div>`;

        // Range (if defined)
        if (actionData.range !== undefined) {
            html += `<div class="action-data-row"><span class="action-data-label">Range:</span> <span class="action-data-value">${actionData.range}</span></div>`;
        }

        // Consequences with resolved values
        if (actionData.consequences && actionData.consequences.length > 0) {
            html += '<div class="action-data-section">';
            html += '<div class="action-data-section-title">Consequences:</div>';

            for (const consequence of actionData.consequences) {
                const resolved = resolvedValues[consequence.type];
                if (resolved) {
                    // deltaSpatial uses 'speed' property instead of 'value'
                    let valueStr = '';
                    if (consequence.type === 'deltaSpatial') {
                        valueStr = resolved.speed !== undefined ? ` → ${resolved.speed}` : '';
                    } else {
                        valueStr = resolved.value !== undefined ? ` → ${resolved.value}` : '';
                    }
                    const displayValue = consequence.type === 'deltaSpatial' ? resolved.speed : resolved.value;
                    const sign = displayValue < 0 ? '🔴' : '🟢';
                    html += `<div class="action-data-row consequence-row">
                        <span class="action-data-label">${sign} ${consequence.type}:</span>
                        <span class="action-data-value">${valueStr}</span>
                    </div>`;
                }
            }
            html += '</div>';
        }

        // Requirements
        if (actionData.requirements && actionData.requirements.length > 0) {
            html += '<div class="action-data-section">';
            html += '<div class="action-data-section-title">Requirements:</div>';
            for (const req of actionData.requirements) {
                html += `<div class="action-data-row req-row">
                    <span class="action-data-label">⚙ ${req.trait}.${req.stat}:</span>
                    <span class="action-data-value">≥ ${req.minValue}</span>
                </div>`;
            }
            html += '</div>';
        }

        html += '</div>';
        return html;
    }

    /**
     * Builds HTML for multi-component synergy preview.
     * Shows: synergy multiplier, modified values (before → after + bonus%), contributing components.
     *
     * @private
     * @param {Object} actionData - Action definition.
     * @param {Object} resolvedValues - Resolved consequence values (without synergy).
     * @param {Object} synergyResult - Synergy computation result.
     * @returns {string} HTML string.
     */
    _buildSynergyPreviewHtml(actionData, resolvedValues, synergyResult) {
        if (!actionData || !synergyResult) return '';

        const { synergyMultiplier, contributingComponents, capped, capKey, summary } = synergyResult;
        const multiplier = parseFloat(synergyMultiplier);

        let html = '<div class="synergy-preview-display-inner">';

        // Synergy multiplier header
        const bonusPercent = Math.round((multiplier - 1) * 100);
        html += `<div class="synergy-header">
            <span class="synergy-multiplier">⚡ Synergy: ${multiplier.toFixed(3)}x (+${bonusPercent}%)</span>
        </div>`;

        // Modified values: show each consequence with synergy-applied value
        if (actionData.consequences && actionData.consequences.length > 0) {
            html += '<div class="synergy-values-section">';
            html += '<div class="synergy-values-title">Modified Values:</div>';

            for (const consequence of actionData.consequences) {
                const baseResolved = resolvedValues[consequence.type];

                // deltaSpatial uses 'speed' property instead of 'value'
                let baseValue;
                if (consequence.type === 'deltaSpatial') {
                    if (!baseResolved || typeof baseResolved.speed !== 'number') continue;
                    baseValue = baseResolved.speed;
                } else {
                    if (!baseResolved || typeof baseResolved.value !== 'number') continue;
                    baseValue = baseResolved.value;
                }

                const finalValue = this._applySynergyToValue(baseValue, multiplier);
                const diff = finalValue - baseValue;
                const absDiff = Math.abs(diff);
                const sign = diff >= 0 ? '+' : '';

                // Determine visual indicator
                const isDamage = consequence.type === 'damageComponent';
                const isHeal = consequence.type === 'updateComponentStatDelta';
                const isMove = consequence.type === 'deltaSpatial';

                let indicator = '→';
                if (isDamage) indicator = diff >= 0 ? '💥' : '🔻';
                else if (isHeal) indicator = diff >= 0 ? '💚' : '🔻';
                else if (isMove) indicator = diff >= 0 ? '🏃' : '🐌';

                const labelProperty = consequence.type === 'deltaSpatial' ? 'speed' : 'value';
                html += `<div class="synergy-value-row">
                    <span class="synergy-value-label">${indicator} ${consequence.type} (${labelProperty}):</span>
                    <span class="synergy-value-changed">
                        <span class="synergy-value-base">${Math.abs(baseValue)}</span>
                        <span class="synergy-value-arrow">→</span>
                        <span class="synergy-value-final">${Math.abs(finalValue).toFixed(1)}</span>
                        <span class="synergy-value-bonus ${diff >= 0 ? 'bonus-positive' : 'bonus-negative'}">(${sign}${bonusPercent}%)</span>
                    </span>
                </div>`;
            }
            html += '</div>';
        }

        // Contributing components
        if (contributingComponents && contributingComponents.length > 0) {
            html += '<div class="synergy-components-section">';
            html += '<div class="synergy-components-title">Contributing Components:</div>';
            for (const comp of contributingComponents) {
                const idShort = comp.componentId ? comp.componentId.substring(0, 8) + '...' : 'unknown';
                html += `<span class="synergy-component">• ${comp.componentType} (${idShort})</span>`;
            }
            html += '</div>';
        }

        // Cap warning
        if (capped && capKey) {
            html += `<div class="synergy-cap-warning">⚠ Capped at ${capKey}</div>`;
        }

        // Summary
        if (summary) {
            html += `<div class="synergy-summary">${summary}</div>`;
        }

        html += '</div>';
        return html;
    }

    /**
     * Applies synergy multiplier to a numeric value.
     * For negative values (damage, durability loss), synergy increases magnitude.
     * For positive values (healing, movement), synergy increases magnitude.
     *
     * @private
     * @param {number} baseValue - The original value.
     * @param {number} multiplier - The synergy multiplier.
     * @returns {number} The synergy-applied value.
     */
    _applySynergyToValue(baseValue, multiplier) {
        // Synergy always increases magnitude: negative values become more negative, positive become more positive
        return baseValue * multiplier;
    }

    /**
     * Clears the synergy preview display.
     */
    clearSynergyPreview() {
        const existing = document.querySelector('.synergy-preview-display');
        if (existing) existing.remove();
    }


    showComponentSelection(entity, state, onComponentSelect) {
        let componentsHtml = '';
        if (entity.components && state.components && state.components.instances) {
            componentsHtml = `
                <div class="component-section">
                    <h3 class="targeting-protocol-header">
                        📡 Targeting Protocol Active
                    </h3>
                    <div class="component-selection-list">`;

            entity.components.forEach(comp => {
                const stats = state.components.instances[comp.id];
                const durability = stats?.Physical?.durability ?? 0;
                const durPercent = Math.min(Math.max((durability / 100) * 100, 0), 100);

                componentsHtml += `
                    <div class="component-select-item clickable" data-comp-id="${comp.id}">
                        <div class="comp-info">
                            <span class="comp-type">${comp.type}</span>
                            <span class="comp-id">ID: ${comp.identifier}</span>
                        </div>
                        <div class="comp-stats-container">
                            <div class="durability-bar-bg">
                                <div class="durability-bar-fill" style="width: ${durPercent}%"></div>
                            </div>
                            <span class="comp-dur-text">${durability} HP</span>
                        </div>
                    </div>`;
            });

            componentsHtml += `</div></div>`;
        }

        this.elements.detailContent.innerHTML = `
            <div class="detail-header">
                <h2 class="system-header">SYSTEM: TARGET_ACQUISITION</h2>
                <p class="detail-subheader" style="font-size: 0.8em;">
                    SCANNING ENTITY: ${entity.id} | STATUS: <span class="text-neon">LOCKED</span>
                </p>
            </div>
            ${componentsHtml || '<div class="trait-row text-center">NO TARGETABLE COMPONENTS DETECTED</div>'}
        `;

        this.elements.detailOverlay.style.display = 'flex';

        // Attach click events to components
        this.elements.detailContent.querySelectorAll('.component-select-item').forEach(el => {
            el.onclick = () => onComponentSelect(el.dataset.compId);
        });
    }

    closeDetails() {
        this.elements.detailOverlay.style.display = 'none';
    }

    setStatus(message, isError = false) {
        this.elements.status.textContent = message;
        this.elements.status.style.display = 'block';
        this.elements.status.style.color = isError ? 'red' : 'inherit';
    }

    hideStatus() {
        this.elements.status.style.display = 'none';
    }

    /**
     * Displays a red error pop-up in the bottom-right corner.
     * @param {string} message The error message to display.
     * @param {number} duration Duration in ms before the popup is removed from DOM.
     */
    showErrorPopup(message, duration = 5000) {
        const popup = document.createElement('div');
        popup.className = 'error-popup';
        popup.textContent = message;
        document.body.appendChild(popup);

        // Remove the element after the animation duration to keep DOM clean
        setTimeout(() => {
            popup.remove();
        }, duration);
    }

    /**
     * Displays a cyan hint pop-up in the bottom-right corner (above the error popup).
     * @param {string} message The hint message to display.
     * @param {number} [duration=5000] Duration in ms before the popup is removed from DOM.
     */
    showHintPopup(message, duration = 5000) {
        // Remove existing hint popup before showing new one (single visible hint semantics)
        const existing = document.querySelector('.hint-popup');
        if (existing) existing.remove();

        const popup = document.createElement('div');
        popup.className = 'hint-popup';
        popup.textContent = message;
        document.body.appendChild(popup);

        setTimeout(() => {
            popup.remove();
        }, duration);
    }

    /**
     * Renders a transient pulsing hint marker on the spatial map SVG layer.
     * Replaces any existing hint marker. Auto-removed after `duration`.
     * @param {number} x - World-space X (room-relative).
     * @param {number} y - World-space Y (room-relative).
     * @param {number} [duration=5000] Display duration in ms.
     */
    renderHintMarker(x, y, duration = 5000) {
        // Clear previous marker timer to prevent race condition
        if (this._hintMarkerTimer) {
            clearTimeout(this._hintMarkerTimer);
            this._hintMarkerTimer = null;
        }
        this.clearHintMarker();
        const entitiesLayer = this.elements.entitiesLayer;

        // Convert world-space (room-relative) to screen-space.
        const svgX = AppConfig.VIEW.CENTER_X + x;
        const svgY = AppConfig.VIEW.CENTER_Y + y;

        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", svgX);
        circle.setAttribute("cy", svgY);
        circle.setAttribute("r", "14");
        circle.setAttribute("class", "hint-marker");
        circle.setAttribute("fill", "none");
        circle.setAttribute("stroke", "#00c8d7");
        circle.setAttribute("stroke-width", "2");

        entitiesLayer.appendChild(circle);

        this._hintMarkerTimer = setTimeout(() => {
            this.clearHintMarker();
            this._hintMarkerTimer = null;
        }, duration);
    }

    /**
     * Immediately removes the current hint marker from the spatial map.
     */
    clearHintMarker() {
        const existing = this.elements.entitiesLayer.querySelector('.hint-marker');
        if (existing) existing.remove();
    }
}