/**
 * NavActionsPanel
 * Manages the 👍 navigation & actions floating panel overlay.
 * Displays room navigation buttons and the action registry.
 *
 * Supports multi-component selection with visual highlighting:
 * - Selected components get green highlight (action-selected)
 * - Locked components get grayed out with lock icon (component-locked)
 * - Active action gets yellow border highlight
 *
 * @module NavActionsPanel
 */
import { AppConfig } from './Config.js';

/**
 * NavActionsPanel class.
 * Manages the navigation & actions floating panel overlay.
 * Displays room navigation buttons and the action registry with multi-component selection support.
 */
export class NavActionsPanel {
    /**
     * Creates a new NavActionsPanel.
     * @param {import('./UIManager.js').UIManager} uiManager - The UIManager instance.
     */
    constructor(uiManager) {
        /** @private */
        this._uiManager = uiManager;
        /** @private {HTMLElement|null} */
        this._overlay = null;
        /** @private {HTMLElement|null} */
        this._content = null;
        /** @private {string|null} */
        this._entityId = null;
        /** @private {Function|null} */
        this._onNavClick = null;
        /** @private {Function|null} */
        this._onActionClick = null;
        /** @private {Function|null} */
        this._onGrayedComponentClick = null;
        /** @private {Map<string, Set<string>>|null} */
        this._crossActionSelections = null;
    }

    /**
     * Initializes the overlay DOM element.
     */
    init() {
        this._overlay = document.getElementById('nav-actions-overlay');
        this._content = document.getElementById('nav-actions-content');
    }

    /**
     * Shows the nav/actions panel.
     * Renders the room navigation and available actions with component selection state.
     *
     * @param {Object} room - The current room data.
     * @param {Object} actions - The available actions data.
     * @param {string} entityId - The active droid entity ID.
     * @param {Function} onNavClick - Callback for navigation clicks (entityId, targetRoomId).
     * @param {Function} onActionClick - Callback for action component clicks (actionName, entityId, componentId, componentIdentifier).
     * @param {string|null} [activeActionName] - The action currently being selected into.
     * @param {Set<string>} [selectedComponentIds] - Components currently selected for the active action.
     * @param {Map<string, Set<string>>} [crossActionSelections] - Map of actionName → Set of selected component IDs (for other actions).
     * @param {Function} [onGrayedComponentClick] - Callback when a grayed (locked) component is clicked (lockedActionName, componentId).
     */
    show(room, actions, entityId, onNavClick, onActionClick, activeActionName, selectedComponentIds, crossActionSelections, onGrayedComponentClick) {
        if (!this._overlay) return;

        this._entityId = entityId;
        this._onNavClick = onNavClick;
        this._onActionClick = onActionClick;
        this._onGrayedComponentClick = onGrayedComponentClick;
        this._crossActionSelections = crossActionSelections;

        let html = '';

        // Navigation section
        html += '<div style="margin-bottom: 20px;">';
        html += '<h3 style="margin: 0 0 10px 0; color: var(--neon-green); font-size: 0.9em;">🕹️ Navigation</h3>';
        html += this._buildNavSection(room);
        html += '</div>';

        // Actions section
        html += '<div>';
        html += '<h3 style="margin: 0 0 10px 0; color: var(--neon-green); font-size: 0.9em;">⚔️ Actions</h3>';
        html += this._buildActionSection(actions, activeActionName, selectedComponentIds, crossActionSelections);
        html += '</div>';

        this._content.innerHTML = html;
        this._overlay.style.display = 'block';

        // Attach listeners after DOM is rendered
        this._attachNavListeners();
        this._attachActionListeners();
    }

    /**
     * Updates the stored callbacks and cross-action selections.
     * @private
     */
    _updateCallbacks(onNavClick, onActionClick, onGrayedComponentClick, crossActionSelections) {
        if (onNavClick) this._onNavClick = onNavClick;
        if (onActionClick) this._onActionClick = onActionClick;
        if (onGrayedComponentClick) this._onGrayedComponentClick = onGrayedComponentClick;
        if (crossActionSelections) this._crossActionSelections = crossActionSelections;
    }

    /**
     * Updates the nav/actions panel content without re-showing it.
     * Used when the panel is already open and data needs refreshing (e.g., after room change).
     *
     * @param {Object} room - The current room data.
     * @param {Object} actions - The available actions data.
     * @param {string} entityId - The active droid entity ID.
     * @param {Function} onNavClick - Callback for navigation clicks (entityId, targetRoomId).
     * @param {Function} onActionClick - Callback for action component clicks (actionName, entityId, componentId, componentIdentifier).
     * @param {string|null} [activeActionName] - The action currently being selected into.
     * @param {Set<string>} [selectedComponentIds] - Components currently selected for the active action.
     * @param {Map<string, Set<string>>} [crossActionSelections] - Map of actionName → Set of selected component IDs (for other actions).
     * @param {Function} [onGrayedComponentClick] - Callback when a grayed (locked) component is clicked (lockedActionName, componentId).
     */
    updateRoom(room, actions, entityId, onNavClick, onActionClick, activeActionName, selectedComponentIds, crossActionSelections, onGrayedComponentClick) {
        if (!this._overlay || !this._content) return;

        // Update stored references if provided
        if (entityId) this._entityId = entityId;
        if (onNavClick) this._onNavClick = onNavClick;
        if (onActionClick) this._onActionClick = onActionClick;
        if (onGrayedComponentClick) this._onGrayedComponentClick = onGrayedComponentClick;
        if (crossActionSelections) this._crossActionSelections = crossActionSelections;

        let html = '';

        // Navigation section
        html += '<div style="margin-bottom: 20px;">';
        html += '<h3 style="margin: 0 0 10px 0; color: var(--neon-green); font-size: 0.9em;">🕹️ Navigation</h3>';
        html += this._buildNavSection(room);
        html += '</div>';

        // Actions section
        html += '<div>';
        html += '<h3 style="margin: 0 0 10px 0; color: var(--neon-green); font-size: 0.9em;">⚔️ Actions</h3>';
        html += this._buildActionSection(actions, activeActionName, selectedComponentIds, crossActionSelections);
        html += '</div>';

        this._content.innerHTML = html;

        // Re-attach listeners after re-rendering DOM
        this._attachNavListeners();
        this._attachActionListeners();
    }

    /**
     * Hides the nav/actions panel.
     */
    hide() {
        if (this._overlay) {
            this._overlay.style.display = 'none';
        }
    }

    /**
     * Toggles the nav/actions panel.
     * @param {Object} room - The current room data.
     * @param {Object} actions - The available actions data.
     * @param {string} entityId - The active droid entity ID.
     * @param {Function} onNavClick - Callback for navigation clicks.
     * @param {Function} onActionClick - Callback for action clicks.
     * @param {string|null} [activeActionName] - The action currently being selected into.
     * @param {Set<string>} [selectedComponentIds] - Components currently selected for the active action.
     * @param {Map<string, Set<string>>} [crossActionSelections] - Cross-action selection map.
     * @param {Function} [onGrayedComponentClick] - Callback when a grayed (locked) component is clicked.
     */
    toggle(room, actions, entityId, onNavClick, onActionClick, activeActionName, selectedComponentIds, crossActionSelections, onGrayedComponentClick) {
        if (this._overlay && this._overlay.style.display === 'block') {
            this.hide();
        } else {
            this.show(room, actions, entityId, onNavClick, onActionClick, activeActionName, selectedComponentIds, crossActionSelections, onGrayedComponentClick);
        }
    }

    /**
     * Builds the navigation buttons HTML.
     * @param {Object} room - The current room.
     * @returns {string} HTML string.
     * @private
     */
    _buildNavSection(room) {
        if (!room) {
            return '<em style="color: var(--text-dim);">No room data.</em>';
        }

        const connections = room.connections || {};
        const navButtonsHtml = Object.entries(connections).map(([door, targetId]) => {
            const btnId = `nav-btn-${targetId.replace(/[^a-zA-Z0-9]/g, '')}`;
            return `
                <button class="nav-btn" id="${btnId}" data-target="${targetId}" style="margin-bottom: 6px; display: block; width: 100%;">
                    Go ${door.replace('_', ' ')}
                </button>`;
        }).join('');

        return `
            <div class="room-info" style="margin-bottom: 10px;">
                <div class="room-name" style="color: var(--text-main); font-weight: bold;">${room.name || 'Unknown'}</div>
                <div class="room-desc" style="color: var(--text-dim); font-size: 0.85em; margin: 5px 0;">${room.description || ''}</div>
            </div>
            <div class="nav-buttons" id="nav-buttons">
                ${Object.keys(connections).length === 0
                    ? '<em style="color: var(--text-dim);">No exits available.</em>'
                    : navButtonsHtml
                }
            </div>`;
    }

    /**
     * Builds the actions list HTML with multi-component selection support.
     * Renders interactive component rows with selection highlighting and lock indicators.
     *
     * @param {Object} actions - The available actions data.
     * @param {string|null} activeActionName - The action currently being selected into.
     * @param {Set<string>} [selectedComponentIds] - Components currently selected for the active action.
     * @param {Map<string, Set<string>>} [crossActionSelections] - Map of actionName → Set of selected component IDs.
     * @returns {string} HTML string.
     * @private
     */
    _buildActionSection(actions, activeActionName, selectedComponentIds, crossActionSelections) {
        if (!actions || Object.keys(actions).length === 0) {
            return '<em style="color: var(--text-dim);">No actions available.</em>';
        }

        // Normalize sets for safe access
        const selectedSet = selectedComponentIds ? new Set(selectedComponentIds) : new Set();

        // Build a map: componentId → actionName (for cross-action graying)
        const componentToActionMap = new Map();
        if (crossActionSelections) {
            for (const [actionName, compSet] of crossActionSelections) {
                for (const compId of compSet) {
                    componentToActionMap.set(compId, actionName);
                }
            }
        }

        let html = '<div class="action-list" id="action-list">';

        for (const [actionName, actionData] of Object.entries(actions)) {
            const isThisActive = actionName === activeActionName;
            const capableCount = (actionData.canExecute || []).length;
            const incapableCount = (actionData.cannotExecute || []).length;

            // Action item wrapper with active highlight
            const actionItemClass = isThisActive ? 'nav-action-item nav-active' : 'nav-action-item';

            html += `
                <div class="${actionItemClass}" data-action-name="${actionName}">
                    <div class="nav-action-name">${actionName}</div>
                    <div class="nav-capable-count">
                        ${capableCount} capable${capableCount !== 1 ? 's' : ''} · ${incapableCount} incapable${incapableCount !== 1 ? 's' : ''}
                    </div>`;

            // Render capable components as interactive rows
            if (capableCount > 0) {
                for (const entry of actionData.canExecute) {
                    const canExecute = entry.requirementsStatus.every(rs => rs.current >= rs.required);
                    const isSelected = isThisActive && selectedSet.has(entry.componentId);
                    const grayedByAction = isSelected ? null : componentToActionMap.get(entry.componentId);

                    // Determine row class
                    let rowClass = 'nav-component-row';
                    if (isSelected) rowClass += ' nav-selected';
                    if (grayedByAction) rowClass += ' nav-locked';

                    // Lock icon with tooltip showing which action it's locked to
                    const lockIcon = grayedByAction
                        ? `<span class="nav-lock-icon" title="Selected in '${grayedByAction}'">🔒</span>`
                        : '';

                    html += `
                        <div class="${rowClass}"
                             data-action="${actionName}"
                             data-entity="${entry.entityId}"
                             data-comp-id="${entry.componentId}"
                             data-comp-name="${entry.componentType}"
                             data-comp-identifier="${entry.componentIdentifier}"
                             data-can-execute="${canExecute}">
                            ${lockIcon}
                            <span class="nav-comp-type">${entry.componentType}</span>
                            <span class="nav-comp-identifier">(${entry.componentIdentifier})</span>
                        </div>`;
                }
            }

            html += '</div>';
        }

        html += '</div>';
        return html;
    }

    /**
     * Attaches click listeners to navigation buttons.
     * @private
     */
    _attachNavListeners() {
        if (!this._onNavClick || !this._content) return;

        this._content.querySelectorAll('.nav-btn').forEach((btn) => {
            btn.onclick = () => {
                const targetId = btn.dataset.target;
                if (targetId && this._entityId) {
                    this._onNavClick(this._entityId, targetId);
                }
            };
        });
    }

    /**
     * Attaches click listeners to action component rows for multi-component selection.
     * - Click on grayed (locked) component → clear conflict (calls _onGrayedComponentClick)
     * - Click on non-grayed capable component → toggle selection (calls _onActionClick)
     * - Does NOT auto-execute on component click
     * @private
     */
    _attachActionListeners() {
        if (!this._onActionClick || !this._content) return;

        // Build component-to-action map for detecting grayed components
        const componentToActionMap = new Map();
        if (this._crossActionSelections) {
            for (const [actionName, compSet] of this._crossActionSelections) {
                for (const compId of compSet) {
                    componentToActionMap.set(compId, actionName);
                }
            }
        }

        this._content.querySelectorAll('.nav-component-row').forEach((row) => {
            row.onclick = () => {
                const actionName = row.dataset.action;
                const entityId = row.dataset.entity;
                const componentId = row.dataset.compId;
                const componentIdentifier = row.dataset.compIdentifier;
                const canExecute = row.dataset.canExecute === 'true';

                // Check if this component is grayed (locked to another action)
                const grayedByAction = componentToActionMap.get(componentId);

                // If grayed (locked to another action), handle conflict resolution
                if (grayedByAction && this._onGrayedComponentClick) {
                    this._onGrayedComponentClick(grayedByAction, componentId);
                    return;
                }

                // Only allow toggling capable non-grayed components
                if (!canExecute) return;

                // Call the action click callback for selection toggling
                if (componentId && entityId) {
                    this._onActionClick(actionName, entityId, componentId, componentIdentifier);
                }
            };
        });
    }

    /**
     * Public setter for cross-action selections (used by updateRoom after re-render).
     * @param {Map<string, Set<string>>} crossActionSelections
     */
    setCrossActionSelections(crossActionSelections) {
        this._crossActionSelections = crossActionSelections;
    }
}
