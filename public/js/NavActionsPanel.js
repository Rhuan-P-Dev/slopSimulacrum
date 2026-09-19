/**
 * NavActionsPanel
 * Manages the ⚔️ actions floating panel overlay.
 * Displays the action registry with multi-component selection support.
 *
 * Supports multi-component selection with visual highlighting:
 * - Selected components get green highlight (nav-selected)
 * - Locked components get grayed out with lock icon (nav-locked)
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
        /** @private {Set<string>} Action names currently expanded (component list visible) */
        this._expandedActions = new Set();
        /** @private {string} Current filter query for action/component search */
        this._filterQuery = '';
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
     * @param {Object|null} [data] - Data object with keys: actions, entityId, onActionClick, activeActionName, selectedComponentIds, crossActionSelections, onGrayedComponentClick.
     */
    show(data) {
        if (!this.overlay) return;

        const actions = data?.actions || null;
        const entityId = data?.entityId || null;
        const onActionClick = data?.onActionClick || null;
        const activeActionName = data?.activeActionName || null;
        const selectedComponentIds = data?.selectedComponentIds || null;
        const crossActionSelections = data?.crossActionSelections || null;
        const onGrayedComponentClick = data?.onGrayedComponentClick || null;

        this._entityId = entityId;
        this._onActionClick = onActionClick;
        this._onGrayedComponentClick = onGrayedComponentClick;
        this._crossActionSelections = crossActionSelections;

        // Keep the active action visible so the user can continue selecting into it
        if (activeActionName) {
            this._expandedActions.add(activeActionName);
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

        // Preserve scroll position of the actual scrollable containers
        const previousOverlayScrollTop = this.overlay.scrollTop;
        const actionList = this._content.querySelector('#action-list');
        const previousActionListScrollTop = actionList ? actionList.scrollTop : 0;

        // Update stored references if provided
        if (entityId) this._entityId = entityId;
        // Keep the active action visible so the user can continue selecting into it
        if (activeActionName) this._expandedActions.add(activeActionName);
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

        // Restore scroll position on the overlay, clamped to the new scroll height
        this.overlay.scrollTop = Math.min(previousOverlayScrollTop, this.overlay.scrollHeight);

        // Restore scroll position on the action list, clamped to the new scroll height
        const newActionList = this._content.querySelector('#action-list');
        if (newActionList) {
            newActionList.scrollTop = Math.min(previousActionListScrollTop, newActionList.scrollHeight);
        }

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

        const esc = (value) => this._escapeHtmlAttribute(value);

        let html = '<div class="action-list" id="action-list">';

        // Filter input — matches action names and component names/identifiers
        html += `<input type="text" id="nav-actions-filter" class="nav-actions-filter"
            placeholder="🔍 Filter by action or component..."
            value="${this._escapeHtmlAttribute(this._filterQuery)}">`;

        for (const [actionName, actionData] of Object.entries(actions)) {
            const isThisActive = actionName === activeActionName;
            const isExpanded = this._expandedActions.has(actionName);
            const capableCount = (actionData.canExecute || []).length;
            const incapableCount = (actionData.cannotExecute || []).length;

            // Action item wrapper with active highlight
            const actionItemClass = isThisActive ? 'nav-action-item nav-active' : 'nav-action-item';

            html += `
                <div class="${actionItemClass}" data-action-name="${esc(actionName)}">
                    <div class="nav-action-name" title="Click to ${isExpanded ? 'hide' : 'show'} components">
                        <span class="nav-action-caret">${isExpanded ? '▾' : '▸'}</span> ${esc(actionName)}
                    </div>
                    <div class="nav-capable-count">
                        ${capableCount} capable${capableCount !== 1 ? 's' : ''} · ${incapableCount} incapable${incapableCount !== 1 ? 's' : ''}
                    </div>
                    <div class="nav-action-components${isExpanded ? ' nav-expanded' : ''}">`;

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
                        ? `<span class="nav-lock-icon" title="Selected in '${esc(grayedByAction)}'">🔒</span>`
                        : '';

                    // Equipped item indicator (knife icon)
                    const equippedIcon = isEquipped ? '<span class="nav-equipped-icon" title="Equipped item">🔪</span>' : '';

                    html += `
                        <div class="${rowClass}"
                             data-action="${esc(actionName)}"
                             data-entity="${esc(entry.entityId)}"
                             data-comp-id="${esc(entry.componentId)}"
                             data-comp-name="${esc(entry.componentType)}"
                             data-comp-identifier="${esc(entry.componentIdentifier)}"
                             data-can-execute="${canExecute}"
                             data-equipped-type="${isEquipped ? entry.componentType : ''}">
                            ${lockIcon}
                            ${equippedIcon}
                            <span class="nav-comp-type">${esc(entry.componentType)}</span>
                            <span class="nav-comp-identifier">(${esc(entry.componentIdentifier)})</span>
                        </div>`;
                }
            }

            // Close components wrapper and item
            html += '</div></div>';
        }

        html += '</div>';
        return html;
    }

    /**
     * Escapes a string for safe embedding in an HTML attribute value.
     * @param {string} value - Raw string.
     * @returns {string} Escaped string.
     * @private
     */
    _escapeHtmlAttribute(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /**
     * Toggles the component list visibility for an action and syncs the caret.
     * @param {string} actionName - The action to toggle.
     * @private
     */
    _toggleActionExpanded(actionName) {
        const item = this._content?.querySelector(`.nav-action-item[data-action-name="${this._escapeCssIdentifier(actionName)}"]`);
        if (!item) return;

        const comps = item.querySelector('.nav-action-components');
        const expanded = comps ? comps.classList.toggle('nav-expanded') : false;

        if (expanded) {
            this._expandedActions.add(actionName);
        } else {
            this._expandedActions.delete(actionName);
        }

        const caret = item.querySelector('.nav-action-caret');
        if (caret) caret.textContent = expanded ? '▾' : '▸';
    }

    /**
     * Escapes an action name for safe use inside a CSS attribute selector.
     * @param {string} value - Action name.
     * @returns {string} Escaped value.
     * @private
     */
    _escapeCssIdentifier(value) {
        return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
    }

    /**
     * Applies the current filter query to the rendered action list.
     * An action is visible when its name matches or any of its components match.
     * When only components match, the action auto-expands and shows just the matching rows.
     * @private
     */
    _applyFilter() {
        if (!this._content) return;
        const input = this._content.querySelector('#nav-actions-filter');
        const query = (input ? input.value : this._filterQuery || '').trim().toLowerCase();

        this._content.querySelectorAll('.nav-action-item').forEach((item) => {
            const actionName = (item.dataset.actionName || '').toLowerCase();
            const actionMatches = !query || actionName.includes(query);

            let anyComponentMatches = false;
            item.querySelectorAll('.nav-component-row').forEach((row) => {
                const compText = `${row.dataset.compName || ''} ${row.dataset.compIdentifier || ''}`.toLowerCase();
                const rowVisible = !query || actionMatches || compText.includes(query);
                row.style.display = rowVisible ? '' : 'none';
                if (query && !actionMatches && compText.includes(query)) {
                    anyComponentMatches = true;
                }
            });

            item.style.display = !query || actionMatches || anyComponentMatches ? '' : 'none';

            // Auto-expand collapsed actions whose components matched
            if (query && !actionMatches && anyComponentMatches) {
                const comps = item.querySelector('.nav-action-components');
                if (comps && !comps.classList.contains('nav-expanded')) {
                    comps.classList.add('nav-expanded');
                    this._expandedActions.add(item.dataset.actionName);
                    const caret = item.querySelector('.nav-action-caret');
                    if (caret) caret.textContent = '▾';
                }
            }
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
        if (!this._content) return;

        // Action name click — toggle component list (accordion behavior)
        this._content.querySelectorAll('.nav-action-name').forEach((nameEl) => {
            const item = nameEl.closest('.nav-action-item');
            if (item) {
                nameEl.onclick = () => this._toggleActionExpanded(item.dataset.actionName);
            }
        });

        // Filter input — live search by action name or component name/identifier
        const filterInput = this._content.querySelector('#nav-actions-filter');
        if (filterInput) {
            filterInput.value = this._filterQuery || '';
            filterInput.addEventListener('input', () => {
                this._filterQuery = filterInput.value;
                this._applyFilter();
            });
            this._applyFilter();
        }

        if (!this._onActionClick) return;

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
            const grayedCallback = this._grayedComponentCallback || this._onGrayedComponentClick;
            if (grayedByAction && grayedCallback) {
                grayedCallback(grayedByAction, componentId);
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
