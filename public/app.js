let currentWorldState = null;
let activeDroid = null;
let myEntityId = null;
let pendingMovementAction = null;
const VIEW_WIDTH = 800;
const VIEW_HEIGHT = 500;
const CENTER_X = VIEW_WIDTH / 2;
const CENTER_Y = VIEW_HEIGHT / 2;

const socket = io();

async function fetchWorldState() {
    const statusDiv = document.getElementById('status');
    try {
        const response = await fetch('/world-state');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const data = await response.json();
        currentWorldState = data.state;
        
        statusDiv.style.display = 'none';

        // 1. Identify Primary Droid for Navigation
        activeDroid = currentWorldState.entities[myEntityId] || Object.values(currentWorldState.entities || {}).find(e => e.blueprint === 'smallBallDroid');
        
        if (currentWorldState.entities && Object.keys(currentWorldState.entities).length > 0) {
            updateUI();
        } else {
            document.getElementById('current-room-name').textContent = "No Droid Found";
            document.getElementById('current-room-desc').textContent = "The simulation is empty.";
            document.getElementById('nav-buttons').innerHTML = "";
            document.getElementById('active-droid-id').textContent = "None";
            document.getElementById('current-room-coords').textContent = "";
        }

    } catch (error) {
        statusDiv.textContent = 'Connection Error: ' + error.message;
        statusDiv.style.color = 'red';
    }
}

socket.on('incarnate', (data) => {
    console.log('[Socket] Incarnated as:', data.entityId);
    myEntityId = data.entityId;
    fetchWorldState();
    fetchActions();
});

socket.on('world-state-update', (data) => {
    console.log('%c[Socket] ⚡ WORLD STATE UPDATE SIGNAL RECEIVED', 'color: #00ff00; font-weight: bold; font-size: 14px;');
    
    try {
        // Instead of using the pushed state, we trigger an immediate fetch to ensure 
        // the client has the most up-to-date and consistent data from the server.
        fetchWorldState();
        fetchActions();
    } catch (error) {
        console.error('[Socket Error] Crash during world-state-update processing:', error);
    }
});

socket.on('error', (data) => {
    console.error('[Socket Error]:', data.message);
    document.getElementById('status').textContent = data.message;
    document.getElementById('status').style.display = 'block';
});

function updateUI() {
    console.log('%c[UI] 🛠️ updateUI started', 'color: #aaa; font-style: italic;');
    const state = currentWorldState;
    const droid = activeDroid;
    
    if (!droid) {
        console.warn('[UI] updateUI skipped: activeDroid is null');
        return;
    }

    if (!state || !state.rooms || !state.rooms[droid.location]) {
        console.warn(`[UI] updateUI skipped: Room ${droid.location} not found in state`, { droidLocation: droid.location });
        return;
    }
    
    const room = state.rooms[droid.location];
    console.log(`[UI] Rendering room: ${room.name} (ID: ${room.id}) for Droid ${droid.id}`);

    // 1. Update Text Info
    document.getElementById('active-droid-id').textContent = droid.id;
    if (room) {
        document.getElementById('current-room-name').textContent = room.name;
        document.getElementById('current-room-desc').textContent = room.description;
        document.getElementById('current-room-coords').textContent = `Room Size: ${room.width}x${room.height}`;
        
        renderNavButtons(room, droid.id);
    }

    // 2. Update Visuals - Render current room view
    renderCurrentRoom(room);
    renderEntitiesInRoom(room, state.entities);
    renderDroidComponents(droid, state);
    
    console.log('%c[UI] ✅ updateUI completed successfully', 'color: #00ff00; font-weight: bold;');
}

function renderNavButtons(room, entityId) {
    const navEl = document.getElementById('nav-buttons');
    navEl.innerHTML = '';
    const connections = room.connections || {};
    
    if (Object.keys(connections).length === 0) {
        navEl.innerHTML = '<em style="color: #666">No exits available.</em>';
    } else {
        for (const [door, targetId] of Object.entries(connections)) {
            const btn = document.createElement('button');
            btn.className = 'nav-btn';
            btn.textContent = `Go ${door.replace('_', ' ')}`;
            btn.onclick = () => moveDroid(entityId, targetId);
            navEl.appendChild(btn);
        }
    }
}

function renderCurrentRoom(room) {
    const roomLayer = document.getElementById('room-layer');
    roomLayer.innerHTML = '';

    // Calculate room position to center it in the view
    const roomX = CENTER_X - room.width / 2;
    const roomY = CENTER_Y - room.height / 2;

    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    
    // Draw room boundary
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", roomX);
    rect.setAttribute("y", roomY);
    rect.setAttribute("width", room.width);
    rect.setAttribute("height", room.height);
    rect.setAttribute("class", `room-boundary ${activeDroid && activeDroid.location === room.id ? 'active' : ''}`);
    
    // Room label (centered above the room)
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", CENTER_X);
    label.setAttribute("y", roomY - 15);
    label.setAttribute("class", "room-label");
    label.textContent = room.name;

    // Room coordinates
    const coords = document.createElementNS("http://www.w3.org/2000/svg", "text");
    coords.setAttribute("x", CENTER_X);
    coords.setAttribute("y", roomY - 35);
    coords.setAttribute("class", "room-coords");
    coords.textContent = `Room Coords: (${room.x}, ${room.y})`;

    group.appendChild(rect);
    group.appendChild(label);
    group.appendChild(coords);
    roomLayer.appendChild(group);
}

function renderEntitiesInRoom(room, entities) {
    const entitiesLayer = document.getElementById('entities-layer');
    entitiesLayer.innerHTML = '';

    // Find all entities in the current room
    const roomEntities = Object.values(entities || {}).filter(e => e.location === room.id);

    for (const [id, entity] of Object.entries(roomEntities)) {
        // Calculate entity position relative to room center
        // Entity spatial.x/y are offsets from room center (0,0)
        const entityX = CENTER_X + (entity.spatial?.x || 0);
        const entityY = CENTER_Y + (entity.spatial?.y || 0);
        
        const marker = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        marker.setAttribute("cx", entityX);
        marker.setAttribute("cy", entityY);
        marker.setAttribute("r", 12);
        marker.setAttribute("fill", entity.id === activeDroid?.id ? "#fff" : "#00ff00");
        marker.setAttribute("class", `entity-marker ${entity.id === activeDroid?.id ? 'active' : ''}`);
        marker.setAttribute("filter", "url(#glow)");
        
        marker.onclick = () => showEntityDetails(entity, currentWorldState);
        
        entitiesLayer.appendChild(marker);
    }
}

function renderDroidComponents(droid, state) {
    const componentsLayer = document.getElementById('components-layer');
    componentsLayer.innerHTML = '';

    if (!droid || !droid.components || !state.components || !state.components.instances) {
        return;
    }

    // Get room to calculate offsets
    const room = state.rooms[droid.location];
    if (!room) return;

    // Entity center position
    const entityX = CENTER_X + (droid.spatial?.x || 0);
    const entityY = CENTER_Y + (droid.spatial?.y || 0);

    droid.components.forEach(comp => {
        const stats = state.components.instances[comp.id];
        if (!stats || !stats.Spatial) return;

        const compX = entityX + stats.Spatial.x;
        const compY = entityY + stats.Spatial.y;

        // Draw connection line from entity to component
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", entityX);
        line.setAttribute("y1", entityY);
        line.setAttribute("x2", compX);
        line.setAttribute("y2", compY);
        line.setAttribute("class", "component-connection");
        componentsLayer.appendChild(line);

        // Draw component marker
        const marker = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        marker.setAttribute("cx", compX);
        marker.setAttribute("cy", compY);
        marker.setAttribute("r", 5);
        marker.setAttribute("fill", "#66ff66");
        marker.setAttribute("class", "component-marker");
        marker.setAttribute("title", `${comp.type}: ${comp.identifier}`);
        
        marker.onclick = () => showComponentDetails(comp, stats, state);
        
        componentsLayer.appendChild(marker);
    });
}

function showEntityDetails(entity, state) {
    const overlay = document.getElementById('detail-overlay');
    const content = document.getElementById('detail-content');
    
    let componentsHtml = '';
    if (entity.components && state.components && state.components.instances) {
        componentsHtml = '<div class="component-section"><h3>🛠️ Installed Components</h3></div>';
        
        entity.components.forEach(comp => {
            const stats = state.components.instances[comp.id];
            let statsHtml = '';
            
            if (stats) {
                for (const [traitId, properties] of Object.entries(stats)) {
                    let propsHtml = '';
                    for (const [propKey, propVal] of Object.entries(properties)) {
                        propsHtml += `<span class="trait-stat">${propKey}: ${propVal}</span> `;
                    }
                    statsHtml += `
                        <div class="trait-row">
                            <span class="trait-name">${traitId}</span>: ${propsHtml}
                        </div>`;
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

    content.innerHTML = `
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

    overlay.style.display = 'flex';
}

function showComponentDetails(component, stats, state) {
    const overlay = document.getElementById('detail-overlay');
    const content = document.getElementById('detail-content');
    
    let statsHtml = '';
    if (stats) {
        for (const [traitId, properties] of Object.entries(stats)) {
            let propsHtml = '';
            for (const [propKey, propVal] of Object.entries(properties)) {
                propsHtml += `<span class="trait-stat">${propKey}: ${propVal}</span> `;
            }
            statsHtml += `
                <div class="trait-row">
                    <span class="trait-name">${traitId}</span>: ${propsHtml}
                </div>`;
        }
    }

    content.innerHTML = `
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

    overlay.style.display = 'flex';
}

function closeDetails() {
    document.getElementById('detail-overlay').style.display = 'none';
}

async function moveDroid(entityId, targetRoomId) {
    try {
        const response = await fetch('/move-entity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entityId, targetRoomId })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Failed to move droid');
        }

    } catch (error) {
        alert('System Error: ' + error.message);
    }
}

async function fetchActions() {
    try {
        const url = myEntityId ? `/actions?entityId=${myEntityId}` : '/actions';
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const data = await response.json();
        renderActionList(data.actions);
    } catch (error) {
        console.error('Failed to fetch actions:', error);
    }
}

function renderActionList(actions) {
    const actionListEl = document.getElementById('action-list');
    
    if (!actions || Object.keys(actions).length === 0) {
        actionListEl.innerHTML = '<em style="color: #666;">No actions available.</em>';
        return;
    }
    
    let html = '';
    
    for (const [actionName, actionData] of Object.entries(actions)) {
        // Capable entities - make them clickable to trigger the action
        const capableHtml = (actionData.canExecute || []).map(entity => {
            // Determine if this specific action/entity combo is currently selected
            const isSelected = pendingMovementAction && 
                               pendingMovementAction.actionName === actionName && 
                               pendingMovementAction.entityId === entity.entityId;

            // Generate a string showing all requirement statuses for this entity
            const reqStatusText = entity.requirementsStatus
                .map(rs => `${rs.trait}.${rs.stat}: ${rs.current}/${rs.required}`)
                .join('<br>');

            return `
                <div class="action-capable clickable ${isSelected ? 'action-selected' : ''}" onclick="executeAction('${actionName}', '${entity.entityId}', '${entity.componentName}', '${entity.componentIdentifier}')">
                    <span class="component-name">${entity.componentName} (${entity.componentIdentifier})</span>
                    <span class="${entity.requirementsStatus.every(rs => rs.current >= rs.required) ? 'status-ok' : 'status-fail'}">${reqStatusText}</span>
                </div>
            `;
        }).join('');
        
        // In incapable entities list
        const incapableHtml = (actionData.cannotExecute || []).map(entity => {
            let statusText = `${entity.componentName} (${entity.componentIdentifier}) cannot execute`;
            
            if (entity.stats) {
                const statStrings = [];
                // Filter stats to only show those required by the action
                (actionData.requirements || []).forEach(req => {
                    const traitStats = entity.stats[req.trait];
                    if (traitStats && traitStats[req.stat] !== undefined) {
                        statStrings.push(`${req.trait}.${req.stat}=${traitStats[req.stat]}`);
                    }
                });

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
            </div>
        `;
    }
    
    actionListEl.innerHTML = html;
}

async function executeAction(actionName, entityId, componentName, componentIdentifier) {
    // Intercept movement actions to require target selection on map
    if (actionName === 'move' || actionName === 'dash') {
        // Toggle selection: if same action is selected, deselect it
        if (pendingMovementAction && pendingMovementAction.actionName === actionName) {
            pendingMovementAction = null;
            console.log(`Action ${actionName} deselected.`);
        } else {
            pendingMovementAction = {
                actionName: actionName,
                entityId: entityId,
                componentName: componentName,
                componentIdentifier: componentIdentifier
            };
            console.log(`Action ${actionName} selected. Please click on the map to set the target.`);
        }
        
        // Refresh action list immediately to show highlight
        fetchActions();
        return;
    }

    try {
        const response = await fetch('/execute-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                actionName: actionName,
                entityId: entityId,
                params: { componentName, componentIdentifier }
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.result?.error || 'Failed to execute action');
        }

        const result = await response.json();
        
        // Optional: Show success feedback
        console.log('Action executed:', result);
        
    } catch (error) {
        alert('Action failed: ' + error.message);
    }
}

async function moveDroidToTarget(actionName, entityId, targetX, targetY) {
    try {
        const response = await fetch('/execute-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                actionName: actionName,
                entityId: entityId,
                params: { targetX, targetY }
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.result?.error || 'Failed to move droid');
        }

    } catch (error) {
        console.error('Movement failed:', error.message);
    }
}

function setupMapClickListener() {
    const map = document.getElementById('world-map');
    if (!map) return;

    map.addEventListener('click', (event) => {
        if (!myEntityId) return;

        // Only move if a movement action was previously selected
        if (!pendingMovementAction) {
            console.log("No movement action selected. Please select 'move' or 'dash' from the Action Registry first.");
            return;
        }

        // Get SVG coordinates
        const pt = map.createSVGPoint();
        pt.x = event.clientX;
        pt.y = event.clientY;
        const svgP = pt.matrixTransform(map.getScreenCTM().inverse());

        // Translate to room-relative coordinates (offset from center)
        const targetX = svgP.x - CENTER_X;
        const targetY = svgP.y - CENTER_Y;

        // Execute the pending action
        moveDroidToTarget(
            pendingMovementAction.actionName, 
            pendingMovementAction.entityId, 
            targetX, 
            targetY
        );

        // Reset pending action
        pendingMovementAction = null;
    });
}

// Initial load
fetchWorldState();
setupMapClickListener();
