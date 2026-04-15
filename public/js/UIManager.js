import { AppConfig } from './Config.js';

/**
 * UIManager
 * Handles all DOM and SVG rendering logic for the client.
 * Decouples the visual representation from the application logic.
 */
export class UIManager {
    constructor() {
        // Cache frequently used DOM elements
        this.elements = {
            status: document.getElementById('status'),
            roomName: document.getElementById('current-room-name'),
            roomDesc: document.getElementById('current-room-desc'),
            roomCoords: document.getElementById('current-room-coords'),
            navButtons: document.getElementById('nav-buttons'),
            activeDroidId: document.getElementById('active-droid-id'),
            roomLayer: document.getElementById('room-layer'),
            entitiesLayer: document.getElementById('entities-layer'),
            componentsLayer: document.getElementById('components-layer'),
            actionList: document.getElementById('action-list'),
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
        this.elements.activeDroidId.textContent = droid.id;
        this.elements.roomName.textContent = room.name;
        this.elements.roomDesc.textContent = room.description;
        this.elements.roomCoords.textContent = `Room Size: ${room.width}x${room.height}`;

        this._renderNavButtons(room, droid.id, onMoveCallback);
        this._renderRoom(room);
        this._renderEntities(room, state.entities);
        this._renderDroidComponents(droid, state);
    }

    _renderEmptyState() {
        this.elements.roomName.textContent = "No Droid Found";
        this.elements.roomDesc.textContent = "The simulation is empty.";
        this.elements.navButtons.innerHTML = "";
        this.elements.activeDroidId.textContent = "None";
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
            navEl.innerHTML = '<em style="color: #666">No exits available.</em>';
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
    }

    _renderEntities(room, entities, onEntityClick) {
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
            marker.setAttribute("fill", entity.id === this.elements.activeDroidId.textContent ? AppConfig.COLORS.ENTITY_ACTIVE : AppConfig.COLORS.ENTITY_DEFAULT);
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
     * Renders the action list in the control panel.
     * @param {Object} actions The list of available actions.
     * @param {Object|null} pendingAction The currently selected movement action.
     * @param {Function} onActionClick Callback for action selection.
     */
    renderActionList(actions, pendingAction, onActionClick) {
        const actionListEl = this.elements.actionList;
        if (!actions || Object.keys(actions).length === 0) {
            actionListEl.innerHTML = '<em style="color: #666;">No actions available.</em>';
            return;
        }

        let html = '';
        for (const [actionName, actionData] of Object.entries(actions)) {
            const capableHtml = (actionData.canExecute || []).map(entity => {
                const isSelected = pendingAction && 
                                   pendingAction.actionName === actionName && 
                                   pendingAction.entityId === entity.entityId;

                const reqStatusText = entity.requirementsStatus
                    .map(rs => `${rs.trait}.${rs.stat}: ${rs.current}/${rs.required}`)
                    .join('<br>');

                return `
                    <div class="action-capable clickable ${isSelected ? 'action-selected' : ''}" 
                         data-action="${actionName}" 
                         data-entity="${entity.entityId}" 
                         data-comp-name="${entity.componentName}" 
                         data-comp-id="${entity.componentIdentifier}">
                        <span class="component-name">${entity.componentName} (${entity.componentIdentifier})</span>
                        <span class="${entity.requirementsStatus.every(rs => rs.current >= rs.required) ? 'status-ok' : 'status-fail'}">${reqStatusText}</span>
                    </div>`;
            }).join('');

            const incapableHtml = (actionData.cannotExecute || []).map(entity => {
                let statusText = `${entity.componentName} (${entity.componentIdentifier}) cannot execute`;
                if (entity.stats) {
                    const statStrings = (actionData.requirements || []).filter(req => 
                        entity.stats[req.trait] && entity.stats[req.trait][req.stat] !== undefined
                    ).map(req => `${req.trait}.${req.stat}=${entity.stats[req.trait][req.stat]}`);

                    if (statStrings.length > 0) {
                        statusText = `${entity.componentName} (${entity.componentIdentifier}): ${statStrings.join(', ')} cannot execute`;
                    }
                }
                return `<div class="action-req status-fail">${statusText}</div>`;
            }).join('');

            html += `
                <div class="action-item">
                    <div class="action-name">${actionName}</div>
                    <div class="action-capabilities">
                        ${capableHtml || '<em style="color: #888;">No capable components found</em>'}
                    </div>
                    ${incapableHtml}
                </div>`;
        }
        actionListEl.innerHTML = html;

        // Attach events to new elements
        actionListEl.querySelectorAll('.clickable').forEach(el => {
            el.onclick = () => onActionClick(
                el.dataset.action, 
                el.dataset.entity, 
                el.dataset.compName, 
                el.dataset.compId
            );
        });
    }

    showEntityDetails(entity, state) {
        let componentsHtml = '';
        if (entity.components && state.components && state.components.instances) {
            componentsHtml = '<div class="component-section"><h3 style="color: var(--neon-green)">🛠️ Installed Components</h3></div>';
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
                componentsHtml += `
                    <div class="component-item">
                        <div class="component-title">
                            <span>${comp.type}</span>
                            <span style="font-size: 0.7em; color: #666;">ID: ${comp.identifier}</span>
                        </div>
                        ${statsHtml || '<div class="trait-row">No technical data available.</div>'}
                    </div>`;
            });
            componentsHtml += '</div>';
        }

        this.elements.detailContent.innerHTML = `
            <div class="detail-header">
                <h2 style="margin:0; color: var(--neon-green);">Entity Analysis</h2>
                <p style="color: var(--text-dim); margin: 5px 0 0 0;">Unit: ${entity.id}</p>
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
                <h2 style="margin:0; color: var(--neon-green);">Component Analysis</h2>
                <p style="color: var(--text-dim); margin: 5px 0 0 0;">Type: ${component.type}</p>
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
                    <h3 style="color: var(--neon-green); text-align: center; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 20px;">
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
                <h2 style="margin:0; color: var(--neon-green); font-family: monospace;">SYSTEM: TARGET_ACQUISITION</h2>
                <p style="color: var(--text-dim); margin: 5px 0 0 0; font-size: 0.8em;">
                    SCANNING ENTITY: ${entity.id} | STATUS: <span style="color: var(--neon-green)">LOCKED</span>
                </p>
            </div>
            ${componentsHtml || '<div class="trait-row" style="text-align:center">NO TARGETABLE COMPONENTS DETECTED</div>'}
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
}
