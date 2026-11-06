/**
 * NavActionsPanel
 * Manages the ⚔️ actions floating panel overlay.
 * Displays the action registry — action names, capability counts and a
 * per-action selected count — under a filter input that matches ACTION NAMES.
 *
 * The components of an action are NOT listed inline. Clicking an action name
 * opens `ActionComponentSubmenu` (`./ActionComponentSubmenu.js`), a flyout
 * anchored to that row with its own component search bar. This panel keeps the
 * action list; the submenu owns the component picker.
 *
 * Multi-component selection state stays visible in two places:
 * - inside the open submenu (green `nav-selected` rows, grayed `nav-locked`
 *   rows with the action they are locked to, `🔪` equipped-item rows)
 * - on the action row itself (`N selected` in its count line), because the rows
 *   are no longer on screen once the submenu closes
 * - the active action gets a yellow border highlight (`nav-active`)
 *
 * Row clicks are forwarded unchanged to the callbacks App.js installed
 * (`setExecuteActionCallback` / `setGrayedComponentCallback`): this module never
 * selects, locks or executes anything itself.
 *
 * @module NavActionsPanel
 */
import { ActionComponentSubmenu } from './ActionComponentSubmenu.js';

/**
 * NavActionsPanel class.
 * Manages the actions floating panel overlay: the action registry list, and the
 * component submenu each of its rows opens.
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
        /** @private {Function|null} Callback for action execution (replaces _onActionClick after delegation) */
        this._actionCallback = null;
        /** @private {Function|null} Callback for grayed component click (replaces _onGrayedComponentClick after delegation) */
        this._grayedComponentCallback = null;
        /** @private {string} Current filter query, matched against action names only */
        this._filterQuery = '';
        /** @private {ActionComponentSubmenu} The anchored component picker (one open at a time) */
        this._submenu = new ActionComponentSubmenu();
    }

    /** @returns {ActionComponentSubmenu} The component submenu this panel opens. */
    get submenu() {
        return this._submenu;
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
     * Shows the actions panel: the action list, filtered by the names still
     * typed in its filter input. No component submenu is opened here — the user
     * opens one by clicking an action name.
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

        // Opening the panel is a fresh start: no submenu is carried over from
        // a previous open (hide() closed it, nothing to reopen here).
        const view = this._buildView(actions, activeActionName, selectedComponentIds, crossActionSelections);

        let html = '';

        // Actions section only (navigation removed — arrows now appear on the map)
        html += '<div>';
        html += '<h3 style="margin: 0 0 10px 0; color: var(--neon-green); font-size: 0.9em;">⚔️ Actions</h3>';
        html += this._buildActionSection(view);
        html += '</div>';

        this._content.innerHTML = html;
        this.overlay.style.display = 'block';

        // Attach listeners after DOM is rendered
        this._attachActionListeners(view);
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
        if (onActionClick) this._onActionClick = onActionClick;
        if (onGrayedComponentClick) this._onGrayedComponentClick = onGrayedComponentClick;

        const view = this._buildView(actions, activeActionName, selectedComponentIds, crossActionSelections);

        let html = '';

        // Actions section only
        html += '<div>';
        html += '<h3 style="margin: 0 0 10px 0; color: var(--neon-green); font-size: 0.9em;">⚔️ Actions</h3>';
        html += this._buildActionSection(view);
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
        this._attachActionListeners(view);

        // Then re-point the open submenu at its NEW anchor row: the innerHTML
        // above replaced every action item, and a submenu anchored to a
        // discarded node would stop following its action.
        this._refreshSubmenu(view);
    }

    /**
     * Hides the actions panel. The component submenu is a child of
     * document.body (it must escape the panel's scroll box), so it is dismissed
     * explicitly here — otherwise it would outlive the panel it belongs to.
     */
    hide() {
        this._submenu.close();
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
     * Bundles the selection/registry state every render path needs, so the
     * click handlers and the submenu receive one object instead of four
     * positional arguments that can be passed in the wrong order.
     *
     * @param {Object} actions - The available actions data.
     * @param {string|null} activeActionName - The action currently being selected into.
     * @param {Set<string>} [selectedComponentIds] - Components currently selected for the active action.
     * @param {Map<string, Set<string>>} [crossActionSelections] - Map of actionName → Set of selected component IDs.
     * @returns {{actions: Object, activeActionName: string|null, selectedComponentIds: Set<string>, crossActionSelections: Map<string, Set<string>>}}
     * @private
     */
    _buildView(actions, activeActionName, selectedComponentIds, crossActionSelections) {
        // Normalize sets/maps with defensive type checking to prevent
        // "function is not iterable" errors from signature mismatches
        return {
            actions: actions || {},
            activeActionName: activeActionName || null,
            selectedComponentIds: selectedComponentIds instanceof Set
                ? selectedComponentIds
                : new Set(selectedComponentIds || []),
            crossActionSelections: crossActionSelections instanceof Map
                ? crossActionSelections
                : new Map(crossActionSelections || []),
        };
    }

    /**
     * Builds the actions list HTML: one row per action, with its capability
     * counts and how many components are already selected for it. The component
     * rows themselves live in the submenu this row opens.
     *
     * @param {{actions: Object, activeActionName: string|null, crossActionSelections: Map<string, Set<string>>}} view - The rendered state (`_buildView`).
     * @returns {string} HTML string.
     * @private
     */
    _buildActionSection(view) {
        const { actions, activeActionName, crossActionSelections } = view;
        if (!actions || Object.keys(actions).length === 0) {
            return '<em style="color: var(--text-dim);">No actions available.</em>';
        }

        const esc = (value) => this._escapeHtmlAttribute(value);

        let html = '<div class="action-list" id="action-list">';

        // Filter input — matches ACTION NAMES; components are searched inside
        // the submenu of the action they belong to.
        html += `<input type="text" id="nav-actions-filter" class="nav-actions-filter"
            placeholder="🔍 Filter actions..."
            value="${this._escapeHtmlAttribute(this._filterQuery)}">`;

        for (const [actionName, actionData] of Object.entries(actions)) {
            const isThisActive = actionName === activeActionName;
            const capableCount = (actionData.canExecute || []).length;
            const incapableCount = (actionData.cannotExecute || []).length;
            // Selection is no longer visible as inline rows, so the count of
            // components already chosen for this action rides on its own line.
            const selectedCount = (crossActionSelections.get(actionName) || new Set()).size;
            const selectedSuffix = selectedCount > 0 ? ` · ${selectedCount} selected` : '';

            // Action item wrapper with active highlight
            const actionItemClass = isThisActive ? 'nav-action-item nav-active' : 'nav-action-item';

            html += `
                <div class="${actionItemClass}" data-action-name="${esc(actionName)}">
                    <div class="nav-action-name" title="Click to choose components">
                        ${esc(actionName)}
                    </div>
                    <div class="nav-capable-count">
                        ${capableCount} capable${capableCount !== 1 ? 's' : ''} · ${incapableCount} incapable${incapableCount !== 1 ? 's' : ''}${selectedSuffix}
                    </div>
                </div>`;
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
     * Opens the component submenu for an action, or closes it when it is already
     * open for that same action (clicking the action name again dismisses it).
     * @param {string} actionName - The action whose component submenu toggles.
     * @param {Object} view - The rendered state (`_buildView`).
     * @private
     */
    _toggleSubmenuFor(actionName, view) {
        if (!actionName) return;
        if (this._submenu.isOpen && this._submenu.openActionName === actionName) {
            this._submenu.close();
            return;
        }
        this._submenu.open(this._submenuArgs(actionName, view));
    }

    /**
     * Re-points an OPEN submenu at the freshly rendered action row. Closes it
     * when the action left the registry (the world changed underneath us).
     * @param {Object} view - The rendered state (`_buildView`).
     * @private
     */
    _refreshSubmenu(view) {
        if (!this._submenu.isOpen) return;
        const actionName = this._submenu.openActionName;
        if (!view.actions || !view.actions[actionName]) {
            this._submenu.close();
            return;
        }
        this._submenu.refresh(this._submenuArgs(actionName, view));
    }

    /**
     * Builds the `ActionComponentSubmenu.open()/refresh()` argument object for
     * one action, anchoring it on that action's row in the rendered list and
     * forwarding row clicks to the callbacks App.js installed.
     *
     * @param {string} actionName - The action the submenu is being pointed at.
     * @param {Object} view - The rendered state (`_buildView`).
     * @returns {Object} The submenu options.
     * @private
     */
    _submenuArgs(actionName, view) {
        const actionData = (view.actions && view.actions[actionName]) || {};
        const anchor = this._content
            ? this._content.querySelector(`.nav-action-item[data-action-name="${this._escapeCssIdentifier(actionName)}"] .nav-action-name`)
            : null;
        return {
            actionName,
            entries: actionData.canExecute || [],
            anchorEl: anchor || null,
            activeActionName: view.activeActionName,
            selectedComponentIds: view.selectedComponentIds,
            crossActionSelections: view.crossActionSelections,
            onRowClick: (name, entityId, componentId, componentIdentifier) => {
                // Prefer the delegated callback (_actionCallback), fall back to legacy (_onActionClick)
                const callback = this._actionCallback || this._onActionClick;
                if (callback) callback(name, entityId, componentId, componentIdentifier);
            },
            onGrayedRowClick: (lockedActionName, componentId) => {
                const callback = this._grayedComponentCallback || this._onGrayedComponentClick;
                if (callback) callback(lockedActionName, componentId);
            },
        };
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
     * Applies the current filter query to the rendered action list. An action is
     * visible when its NAME matches; components are searched inside the submenu
     * of the action they belong to, not here.
     *
     * Dismisses the submenu when its own action gets filtered out: the submenu
     * is anchored to that row, and a picker pointing at a hidden row has no
     * meaning left.
     * @private
     */
    _applyFilter() {
        if (!this._content) return;
        const input = this._content.querySelector('#nav-actions-filter');
        const query = (input ? input.value : this._filterQuery || '').trim().toLowerCase();

        let openActionHidden = false;
        this._content.querySelectorAll('.nav-action-item').forEach((item) => {
            const actionName = (item.dataset.actionName || '').toLowerCase();
            const visible = !query || actionName.includes(query);
            item.style.display = visible ? '' : 'none';
            if (!visible && this._submenu.isOpen && item.dataset.actionName === this._submenu.openActionName) {
                openActionHidden = true;
            }
        });

        if (openActionHidden) this._submenu.close();
    }

    /**
     * Attaches the listeners of the rendered action list.
     * - Click on an action name → open/close its component submenu
     *   (`ActionComponentSubmenu`), which is where the components are chosen
     * - Typing in the filter input → live filter of the action names
     * Component rows are NOT wired here: the submenu owns them and forwards
     * clicks to the execute / grayed-conflict callbacks (see `_submenuArgs`).
     *
     * @param {Object} view - The rendered state (`_buildView`).
     * @private
     */
    _attachActionListeners(view) {
        if (!this._content) return;

        // Action name click — open the component submenu for that action
        this._content.querySelectorAll('.nav-action-name').forEach((nameEl) => {
            const item = nameEl.closest('.nav-action-item');
            if (item) {
                nameEl.onclick = () => this._toggleSubmenuFor(item.dataset.actionName, view);
            }
        });

        // Filter input — live search by action name
        const filterInput = this._content.querySelector('#nav-actions-filter');
        if (filterInput) {
            filterInput.value = this._filterQuery || '';
            filterInput.addEventListener('input', () => {
                this._filterQuery = filterInput.value;
                this._applyFilter();
            });
            this._applyFilter();
        }
    }

}
