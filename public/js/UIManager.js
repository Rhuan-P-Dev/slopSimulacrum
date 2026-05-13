import { AppConfig } from './Config.js';
import { RoomConnectionRenderer } from './RoomConnectionRenderer.js';

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
            // Action list element (moved to NavActionsPanel, no longer used)
            actionList: document.getElementById('action-list'),
            // Detail overlay
            detailOverlay: document.getElementById('detail-overlay'),
            detailContent: document.getElementById('detail-content'),
            closeDetailsBtn: document.getElementById('close-details-btn'),
            // Config bar
            configBar: document.getElementById('config-bar'),
            // Stat bars
            statBarsSection: document.getElementById('stat-bars-section'),
            statBarsContainer: document.getElementById('stat-bars-container'),
            // Overlays
            componentViewerOverlay: document.getElementById('component-viewer-overlay'),
            componentViewerContent: document.getElementById('component-viewer-content'),
            navActionsOverlay: document.getElementById('nav-actions-overlay'),
            navActionsContent: document.getElementById('nav-actions-content'),
            // Add stat dialog
            addStatDialog: document.getElementById('add-stat-dialog'),
            addStatDialogOverlay: document.getElementById('add-stat-dialog-overlay'),
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
     * @param {Function} onEntityClick
     * @param {Function} onComponentClick
     */
    updateEntityAndComponentViews(room, entities, droid, state, onEntityClick, onComponentClick) {
        this._renderEntities(room, entities, onEntityClick, droid?.id);
        this._renderDroidComponents(droid, state, onComponentClick);
    }

    /**
     * Main update loop for the UI.
     * @param {Object} state The current world state.
     * @param {Object} droid The active droid entity.
     * @param {Function} onMoveCallback Callback for navigation buttons.
     */
    updateWorldView(state, droid, onMoveCallback) {
        if (!droid) {
            this._renderEmptyState();
            return;
        }

        if (!state || !state.rooms || !state.rooms[droid.location]) {
            console.warn(`[UI] updateWorldView skipped: Room ${droid?.location} not found in state`);
            return;
        }

        const room = state.rooms[droid.location];

        // Update Text Info
        this.elements.roomName.textContent = room.name;
        this.elements.roomDesc.textContent = room.description;
        this.elements.roomCoords.textContent = `Room Size: ${room.width}x${room.height}`;

        // Render map layers
        this._renderRoom(room);
        this.renderRoomConnections(room, state.rooms);
        this._renderEntities(room, state.entities, null, droid.id);
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

    _renderNavButtons(room, entityId, onMoveCallback) {
        const navEl = this.elements.navButtons;
        navEl.innerHTML = '';
        const connections = room.connections || {};

        if (Object.keys(connections).length === 0) {
            navEl.innerHTML = '<em class="text-muted">No exits available.</em>';
        } else {
            for (const [door, targetId] of Object.entries(connections)) {
                const btn = document.createElement('button');
                btn.className = 'nav-btn';
                btn.textContent = `Go ${door.replace('_', ' ')}`;
                btn.onclick = () => onMoveCallback(entityId, targetId);
                navEl.appendChild(btn);
            }
        }
    }

    renderRangeIndicator(droid, range, color = 'red') {
        const entitiesLayer = this.elements.entitiesLayer;

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
        circle.setAttribute("stroke", color);
        circle.setAttribute("stroke-width", "2");
        circle.setAttribute("stroke-dasharray", "5,5");
        circle.setAttribute("class", "range-indicator");
        circle.setAttribute("style", "pointer-events: none; opacity: 0.6;");

        entitiesLayer.appendChild(circle);
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
     * Renders connection lines/arrows between the current room and adjacent rooms.
     * @param {Object} room - The current room object.
     * @param {Object} rooms - Map of all rooms.
     */
    renderRoomConnections(room, rooms) {
        if (!this._currentRoomLayer) return;
        RoomConnectionRenderer.renderRoomConnections(room, rooms, this._currentRoomLayer);
    }

    _renderEntities(room, entities, onEntityClick, activeDroidId) {
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

            if (onEntityClick) {
                marker.onclick = () => onEntityClick(entity);
            }

            entitiesLayer.appendChild(marker);
        });
    }

    _renderDroidComponents(droid, state, onComponentClick) {
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

            if (onComponentClick) {
                marker.onclick = () => onComponentClick(comp, stats);
            }

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


    /**
     * Checks if a component is a grabbed item (not a standard droid component).
     * Grabbed items like 'knife' are added as components to the entity but are not part of
     * the base blueprint structure.
     * @param {string} compType - The component type to check.
     * @returns {boolean} True if the component is a grabbed item.
     */
    _isGrabbedItemComponent(compType) {
        const standardComponents = [
            'centralBall', 'droidHead', 'droidArm', 'droidHand',
            'humanoidDroidFinger', 'droidRollingBall'
        ];
        return !standardComponents.includes(compType);
    }

    showEntityDetails(entity, state) {
        let componentsHtml = '';
        if (entity.components && state.components && state.components.instances) {
            componentsHtml = '<div class="component-section"><h3 class="text-neon">🛠️ Installed Components</h3></div>';
            entity.components.forEach(comp => {
                const stats = state.components.instances[comp.id];
                let statsHtml = '';
                if (stats) {
                    for (const [traitId, properties] of Object.entries(stats)) {
                        let propsHtml = '';
                        for (const [propKey, propVal] of Object.entries(properties)) {
                            propsHtml += `<span class="trait-stat">${propKey}: ${propVal}</span> `;
                        }
                        statsHtml += `<div class="trait-row"><span class="trait-name">${traitId}</span>: ${propsHtml}</div>`;
                    }
                }

                // Check if this is a grabbed item (e.g., knife) that can be released
                const isGrabbedItem = this._isGrabbedItemComponent(comp.type);
                const releaseButton = isGrabbedItem
                    ? `<button class="release-btn" data-comp-id="${comp.id}" data-comp-type="${comp.type}">🗑️ Release ${comp.type}</button>`
                    : '';

                componentsHtml += `
                    <div class="component-item">
                        <div class="component-title">
                            <span>${comp.type}</span>
                            <span class="id-text">ID: ${comp.identifier}</span>
                        </div>
                        ${statsHtml || '<div class="trait-row">No technical data available.</div>'}
                        ${releaseButton}
                    </div>`;
            });
            componentsHtml += '</div>';
        }

        this.elements.detailContent.innerHTML = `
            <div class="detail-header">
                <h2 class="detail-header-main">Entity Analysis</h2>
                <p class="detail-subheader">Unit: ${entity.id}</p>
            </div>
            <div class="entity-stat">
                <span class="stat-label">Unit ID:</span>
                <span class="stat-value">${entity.id}</span>
            </div>
            <div class="entity-stat">
                <span class="stat-label">Blueprint:</span>
                <span class="stat-value">${entity.blueprint}</span>
            </div>
            <div class="entity-stat">
                <span class="stat-label">Current Zone:</span>
                <span class="stat-value">${state.rooms[entity.location]?.name || 'Unknown'}</span>
            </div>
            ${componentsHtml}
        `;
        this.elements.detailOverlay.style.display = 'flex';

        // Attach click events to release buttons
        this.elements.detailContent.querySelectorAll('.release-btn').forEach(btn => {
            btn.onclick = () => {
                const componentId = btn.dataset.compId;
                const compType = btn.dataset.compType;
                console.log(`[UIManager] Release button clicked for ${compType} (component: ${componentId})`);
                // Dispatch event for App.js to handle
                this.elements.detailOverlay.dispatchEvent(new CustomEvent('release-component', {
                    detail: { componentId, componentType: compType },
                    bubbles: true
                }));
            };
        });
    }

    showComponentDetails(component, stats) {
        let statsHtml = '';
        if (stats) {
            for (const [traitId, properties] of Object.entries(stats)) {
                let propsHtml = '';
                for (const [propKey, propVal] of Object.entries(properties)) {
                    propsHtml += `<span class="trait-stat">${propKey}: ${propVal}</span> `;
                }
                statsHtml += `<div class="trait-row"><span class="trait-name">${traitId}</span>: ${propsHtml}</div>`;
            }
        }

        this.elements.detailContent.innerHTML = `
            <div class="detail-header">
                <h2 class="detail-header-main">Component Analysis</h2>
                <p class="detail-subheader">Type: ${component.type}</p>
            </div>
            <div class="entity-stat">
                <span class="stat-label">Component ID:</span>
                <span class="stat-value">${component.id}</span>
            </div>
            <div class="entity-stat">
                <span class="stat-label">Identifier:</span>
                <span class="stat-value">${component.identifier}</span>
            </div>
            <div class="component-section">
                ${statsHtml || '<div class="trait-row">No technical data available.</div>'}
            </div>
        `;
        this.elements.detailOverlay.style.display = 'flex';
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
}