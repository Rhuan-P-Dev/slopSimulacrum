/**
 * NavActionsPanel
 * Manages the ⚔️ actions floating panel overlay.
 * Displays the action registry with multi-component selection support.
 *
 * Supports multi-component selection with visual highlighting:
 * - Selected components get green highlight (action-selected)
 * - Locked components get grayed out with lock icon (component-locked)
 * - Active action gets yellow border highlight
 *
 * @module NavActionsPanel
 */
import { AppConfig } from './Config.js';
import IdResolver from '/utils/IdResolver.js';

/**
 * NavActionsPanel class.
 * Manages the actions floating panel overlay.
 * Displays the action registry with multi-component selection support.
 */
export class NavActionsPanel {
    /**
     * Creates a new NavActionsPanel.
     * @param {import('./UIManager.js').UIManager} uiManager - The UIManager instance.
     */
    constructor(uiManager) {
        /** @private */
        this._uiManager = uiManager;
        /** @public {HTMLElement|null} */
        this.overlay = null;
        /** @private {HTMLElement|null} */
        this._content = null;
        /** @private {string|null} */
        this._entityId = null;
        /** @private {Function|null} */
        this._onActionClick = null;
        /** @private {Function|null} */
        this._onGrayedComponentClick = null;
        /** @private {Map<string, Set<string>>|null} */
        this._crossActionSelections = null;
        /** @private {Function|null} Callback for action execution (replaces _onActionClick after delegation) */
        this._actionCallback = null;
        /** @private {Function|null} Callback for grayed component click (replaces _onGrayedComponentClick after delegation) */
        this._grayedComponentCallback = null;
    }

    /**
     * Initializes the overlay DOM element and attaches close button listener.
     */
    init() {
        this.overlay = document.getElementById('nav-actions-overlay');
        this._content = document.getElementById('nav-actions-content');

        // Attach close button listener
        if (this.overlay) {
            const closeBtn = this.overlay.querySelector('.overlay-close-btn');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => this.hide());
            }
        }
    }

    /**
     * Sets the action execution callback (called when a component row is clicked).
     * @param {Function} callback - The callback function.
     */
    setExecuteActionCallback(callback) {
        this._actionCallback = callback;
    }

    /**
     * Sets the grayed component click callback.
     * @param {Function} callback - The callback function.
     */
    setGrayedComponentCallback(callback) {
        this._grayedComponentCallback = callback;
    }

    /**
     * Shows the actions panel.
     * Renders the available actions with component selection state.
     *
     * @param {Object} [data] - Data object with keys: actions, entityId, onActionClick, activeActionName, selectedComponentIds, crossActionSelections, onGrayedComponentClick.
     */
    show(data) {
        if (!this.overlay) return;

        // Support both { ...data } object and legacy positional arguments
        const actions = data?.actions || (arguments[0] && !arguments[0].actions ? arguments[0] : null);
        const entityId = data?.entityId || arguments[1];
        const onActionClick = data?.onActionClick || arguments[2];
        const activeActionName = data?.activeActionName || arguments[3];
        const selectedComponentIds = data?.selectedComponentIds || arguments[4];
        const crossActionSelections = data?.crossActionSelections || arguments[5];
        const onGrayedComponentClick = data?.onGrayedComponentClick || arguments[6];

        // If data is provided, use it; otherwise fall back to legacy positional args
        if (data && data.actions) {
            this._entityId = data.entityId || null;
            this._onActionClick = data.onActionClick || null;
            this._onGrayedComponentClick = data.onGrayedComponentClick || null;
            this._crossActionSelections = data.crossActionSelections || null;
        } else if (actions !== null) {
            this._entityId = entityId || null;
            this._onActionClick = onActionClick || null;
            this._onGrayedComponentClick = onGrayedComponentClick || null;
            this._crossActionSelections = crossActionSelections || null;
        }

        let html = '';

        // Actions section only (navigation removed — arrows now appear on the map)
        html += '<div>';
        html += '<h3 style="margin: 0 0 10px 0; color: var(--neon-green); font-size: 0.9em;">⚔️ Actions</h3>';
        html += this._buildActionSection(actions, activeActionName, selectedComponentIds, crossActionSelections);
        html += '</div>';

        this._content.innerHTML = html;
        this.overlay.style.display = 'block';

        // Attach listeners after DOM is rendered
        this._attachActionListeners();
    }

    /**
     * Updates the stored callbacks and cross-action selections.
     * @private
     */
    _updateCallbacks(onActionClick, onGrayedComponentClick, crossActionSelections) {
        if (onActionClick) this._onActionClick = onActionClick;
        if (onGrayedComponentClick) this._onGrayedComponentClick = onGrayedComponentClick;
        if (crossActionSelections) this._crossActionSelections = crossActionSelections;
    }

    /**
     * Updates the actions panel content without re-showing it.
     * Used when the panel is already open and data needs refreshing.
     *
     * @param {Object} actions - The available actions data.
     * @param {string} entityId - The active droid entity ID.
     * @param {Function} onActionClick - Callback for action component clicks.
     * @param {string|null} [activeActionName] - The action currently being selected into.
     * @param {Set<string>} [selectedComponentIds] - Components currently selected for the active action.
     * @param {Map<string, Set<string>>} [crossActionSelections] - Map of actionName → Set of selected component IDs.
     * @param {Function} [onGrayedComponentClick] - Callback when a grayed (locked) component is clicked.
     */
    updateRoom(actions, entityId, onActionClick, activeActionName, selectedComponentIds, crossActionSelections, onGrayedComponentClick) {
        if (!this.overlay || !this._content) return;

        // Update stored references if provided
        if (entityId) this._entityId = entityId;
        if (onActionClick) this._onActionClick = onActionClick;
        if (onGrayedComponentClick) this._onGrayedComponentClick = onGrayedComponentClick;
        if (crossActionSelections) this._crossActionSelections = crossActionSelections;

        let html = '';

        // Actions section only
        html += '<div>';
        html += '<h3 style="margin: 0 0 10px 0; color: var(--neon-green); font-size: 0.9em;">⚔️ Actions</h3>';
        html += this._buildActionSection(actions, activeActionName, selectedComponentIds, crossActionSelections);
        html += '</div>';

        this._content.innerHTML = html;

        // Re-attach listeners after re-rendering DOM
        this._attachActionListeners();
    }

    /**
     * Hides the actions panel.
     */
    hide() {
        if (this.overlay) {
            this.overlay.style.display = 'none';
        }
    }

    /**
     * Toggles the actions panel.
     * @param {Object} [data] - Optional data object for show().
     */
    toggle(data) {
        if (this.overlay && this.overlay.style.display === 'block') {
            this.hide();
        } else {
            this.show(data);
        }
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

        // Normalize sets/maps with defensive type checking to prevent
        // "function is not iterable" errors from signature mismatches
        const selectedSet = selectedComponentIds instanceof Set
            ? selectedComponentIds
            : new Set(selectedComponentIds || []);

        const crossMap = crossActionSelections instanceof Map
            ? crossActionSelections
            : new Map(crossActionSelections || []);

        // Build a map: componentId → actionName (for cross-action graying)
        const componentToActionMap = new Map();
        for (const [actionName, compSet] of crossMap) {
            if (compSet instanceof Set) {
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

                    // Detect equipped items (uses typed eq- prefix)
                    const isEquipped = typeof entry.componentId === 'string' && IdResolver.isEquippedId(entry.componentId);
                    if (isEquipped) {
                        rowClass += ' nav-equipped-item';
                    }

                    // Lock icon with tooltip showing which action it's locked to
                    const lockIcon = grayedByAction
                        ? `<span class="nav-lock-icon" title="Selected in '${grayedByAction}'">🔒</span>`
                        : '';

                    // Equipped item indicator (knife icon)
                    const equippedIcon = isEquipped ? '<span class="nav-equipped-icon" title="Equipped item">🔪</span>' : '';

                    html += `
                        <div class="${rowClass}"
                             data-action="${actionName}"
                             data-entity="${entry.entityId}"
                             data-comp-id="${entry.componentId}"
                             data-comp-name="${entry.componentType}"
                             data-comp-identifier="${entry.componentIdentifier}"
                             data-can-execute="${canExecute}"
                             data-equipped-type="${isEquipped ? entry.componentType : ''}">
                            ${lockIcon}
                            ${equippedIcon}
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
     * Attaches click listeners to action component rows for multi-component selection.
     * - Click on grayed (locked) component → clear conflict (calls _onGrayedComponentClick)
     * - Click on non-grayed capable component → toggle selection (calls _onActionClick)
     * - Does NOT auto-execute on component click
     * @private
     */
    _attachActionListeners() {
        if (!this._onActionClick || !this._content) return;

        // Build component-to-action map for detecting grayed components
        // Defensive: ensure _crossActionSelections is a Map
        const actionCrossMap = this._crossActionSelections instanceof Map
            ? this._crossActionSelections
            : new Map(this._crossActionSelections || []);

        const componentToActionMap = new Map();
        for (const [actionName, compSet] of actionCrossMap) {
            if (compSet instanceof Set) {
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

            // Check if this component is grayed (locked to another action)
            const grayedByAction = componentToActionMap.get(componentId);

            // If grayed (locked to another action), handle conflict resolution
            if (grayedByAction && this._onGrayedComponentClick) {
                this._onGrayedComponentClick(grayedByAction, componentId);
                return;
            }

            // Call the action click callback for selection toggling
            // Prefer the new delegated callback (_actionCallback), fall back to legacy (_onActionClick)
            if (componentId && entityId) {
                const callback = this._actionCallback || this._onActionClick;
                if (callback) {
                    callback(actionName, entityId, componentId, componentIdentifier);
                }
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
