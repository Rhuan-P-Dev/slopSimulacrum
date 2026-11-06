/**
 * ActionComponentSubmenu — the anchored component picker for ONE action.
 *
 * Owns: a floating submenu (title, search bar, list of the action's CAPABLE
 * components) placed next to the action row that opened it, its own component
 * search, and its dismissal (close button, Escape, panel hide).
 * Deliberately does NOT own: the action list (`NavActionsPanel`), the selection
 * model (`SelectionController`, reached through the callbacks App.js hands to
 * the panel) or action execution (`ActionManager`). A row click is forwarded,
 * never interpreted here.
 *
 * Why the element lives on `document.body` with `position: fixed`: the actions
 * panel scrolls (`.overlay-panel` is `overflow: auto` in
 * `public/css/floating-windows.css`), so a submenu rendered inside it would be
 * clipped by the panel's own scroll box.
 *
 * Why one row-click does NOT close the submenu: selection is multi-component
 * (`SelectionController.toggleComponent`), so the picker stays open while the
 * user adds or removes components. `refresh()` re-renders the LIST only and
 * never the shell, because the click also re-renders the panel — rebuilding the
 * search input on every refresh would drop the focus and the typed query.
 *
 * Placement tracks the anchor on the panel's scroll and on window resize. The
 * panel's CSS resize handle (`resize: both`) is not observed: the next scroll
 * or list refresh re-places the submenu.
 *
 * Logging: ClientLogger only (no `console.*` on the client).
 *
 * @module public/js/ActionComponentSubmenu
 */
import ClientLogger from '/utils/ClientLogger.js';
import { escapeText } from '/utils/EscapeHtml.js';
import IdResolver from '/utils/IdResolver.js';
import { AppConfig } from './Config.js';

/** Gap between the anchor row and the submenu, in px. */
const ANCHOR_GAP_PX = 8;
/** Minimum distance kept from a viewport edge, in px. */
const VIEWPORT_EDGE_MARGIN_PX = 8;

/** Placeholder of the submenu search bar (English ASCII is the client's UI language). */
const SEARCH_PLACEHOLDER = '🔍 Search components...';

/**
 * Places the submenu beside its anchor row, preferring the right-hand side and
 * flipping to the left when the right side cannot hold it, then clamping
 * vertically so the menu never leaves the viewport.
 * Pure: takes rects and viewport size, returns coordinates.
 *
 * @param {Object} options
 * @param {{right: number, left: number, top: number}} options.anchorRect - Anchor bounding rect.
 * @param {number} options.menuWidth - Measured submenu width in px.
 * @param {number} options.menuHeight - Measured submenu height in px.
 * @param {number} options.viewportWidth - Viewport width in px.
 * @param {number} options.viewportHeight - Viewport height in px.
 * @param {number} [options.gap] - Gap between anchor and submenu in px.
 * @param {number} [options.edgeMargin] - Keep-away distance from a viewport edge in px.
 * @returns {{left: number, top: number}} Fixed-position coordinates for the submenu.
 */
export function computeSubmenuPosition({
    anchorRect,
    menuWidth,
    menuHeight,
    viewportWidth,
    viewportHeight,
    gap = ANCHOR_GAP_PX,
    edgeMargin = VIEWPORT_EDGE_MARGIN_PX,
}) {
    const rightSlot = anchorRect.right + gap;
    const fitsRight = rightSlot + menuWidth <= viewportWidth - edgeMargin;
    const leftSide = anchorRect.left - gap - menuWidth;

    let left = fitsRight ? rightSlot : leftSide;
    if (left + menuWidth > viewportWidth - edgeMargin) {
        left = Math.max(edgeMargin, viewportWidth - edgeMargin - menuWidth);
    }
    left = Math.max(edgeMargin, left);

    let top = anchorRect.top;
    if (top + menuHeight > viewportHeight - edgeMargin) {
        top = viewportHeight - edgeMargin - menuHeight;
    }
    return { left, top: Math.max(edgeMargin, top) };
}

/**
 * Filters capable component entries by the submenu search query.
 * Matches the component type or its identifier, case-insensitively,
 * substring (same fields the old inline list matched).
 * Pure: no DOM, no state.
 *
 * @param {Array<Object>|null} entries - The action's `canExecute` entries.
 * @param {string} query - Raw search text.
 * @returns {Array<Object>} The matching entries (all of them when the query is blank).
 */
export function filterComponentEntries(entries, query) {
    const list = Array.isArray(entries) ? entries : [];
    const needle = String(query ?? '').trim().toLowerCase();
    if (!needle) return [...list];
    return list.filter((entry) => {
        const haystack = `${entry?.componentType ?? ''} ${entry?.componentIdentifier ?? ''}`.toLowerCase();
        return haystack.includes(needle);
    });
}

/**
 * Renders one capable-component row. The markup and the `nav-*` classes are the
 * ones `public/css/actions.css` already styles for the actions panel
 * (`nav-selected`, `nav-locked`, `nav-equipped-item`), so the picker looks like
 * the list it replaced.
 *
 * @param {Object} entry - One `canExecute` entry.
 * @param {string} actionName - The action this row belongs to.
 * @param {boolean} isSelected - Selected in the action the submenu is open for.
 * @param {string|null} grayedByAction - Another action this component is locked to, else null.
 * @returns {string} HTML string for the row.
 */
function buildComponentRowHtml(entry, actionName, isSelected, grayedByAction) {
    const canExecute = Array.isArray(entry.requirementsStatus)
        && entry.requirementsStatus.every((rs) => rs.current >= rs.required);
    const isEquipped = typeof entry.componentId === 'string' && IdResolver.isEquippedId(entry.componentId);

    let rowClass = 'nav-component-row';
    if (isSelected) rowClass += ' nav-selected';
    if (grayedByAction) rowClass += ' nav-locked';
    if (isEquipped) rowClass += ' nav-equipped-item';

    const lockIcon = grayedByAction
        ? `<span class="nav-lock-icon" title="Selected in '${escapeText(grayedByAction)}'">🔒</span>`
        : '';
    const equippedIcon = isEquipped ? '<span class="nav-equipped-icon" title="Equipped item">🔪</span>' : '';

    return `
        <div class="${rowClass}"
             data-action="${escapeText(actionName)}"
             data-entity="${escapeText(entry.entityId)}"
             data-comp-id="${escapeText(entry.componentId)}"
             data-comp-name="${escapeText(entry.componentType)}"
             data-comp-identifier="${escapeText(entry.componentIdentifier)}"
             data-can-execute="${canExecute}"
             data-equipped-type="${isEquipped ? escapeText(entry.componentType) : ''}">
            ${lockIcon}
            ${equippedIcon}
            <span class="nav-comp-type">${escapeText(entry.componentType)}</span>
            <span class="nav-comp-identifier">(${escapeText(entry.componentIdentifier)})</span>
        </div>`;
}

/**
 * Renders the submenu's component rows.
 * Pure: entries in, HTML out.
 *
 * @param {Object} options
 * @param {string} options.actionName - The action the submenu is open for.
 * @param {Array<Object>|null} options.entries - Already-filtered `canExecute` entries.
 * @param {string|null} options.activeActionName - The action currently being selected into.
 * @param {Set<string>|string[]|null} options.selectedComponentIds - Components selected for that action.
 * @param {Map<string, string>|null} options.componentToActionMap - componentId → action it is locked to.
 * @returns {string} HTML string ('' when there is nothing to list).
 */
export function buildComponentRowsHtml({
    actionName,
    entries,
    activeActionName,
    selectedComponentIds,
    componentToActionMap,
}) {
    const selected = selectedComponentIds instanceof Set
        ? selectedComponentIds
        : new Set(selectedComponentIds || []);
    const lockedMap = componentToActionMap instanceof Map ? componentToActionMap : new Map();
    const isActiveAction = activeActionName === actionName;

    return (Array.isArray(entries) ? entries : []).map((entry) => {
        const isSelected = isActiveAction && selected.has(entry.componentId);
        // A component selected in THIS action is not "locked" by itself (same
        // short-circuit the inline list used before the submenu existed).
        const grayedByAction = isSelected ? null : (lockedMap.get(entry.componentId) || null);
        return buildComponentRowHtml(entry, actionName, isSelected, grayedByAction);
    }).join('');
}

/**
 * The floating component submenu. See the module header for what it owns.
 */
export class ActionComponentSubmenu {
    /** Builds an empty, closed submenu (nothing touches the DOM until `open()`). */
    constructor() {
        /** @private {HTMLElement|null} */
        this._el = null;
        /** @private {HTMLElement|null} */
        this._titleEl = null;
        /** @private {HTMLElement|null} */
        this._searchEl = null;
        /** @private {HTMLElement|null} */
        this._listEl = null;
        /** @private {HTMLElement|null} */
        this._hintEl = null;
        /** @private {string|null} The action the submenu is open for (null = closed). */
        this._actionName = null;
        /** @private {HTMLElement|null} The action row the submenu is anchored to. */
        this._anchorEl = null;
        /** @private {Array<Object>} The action's capable entries. */
        this._entries = [];
        /** @private {string} The submenu's own search query. */
        this._query = '';
        /** @private {{activeActionName: string|null, selectedComponentIds: Set<string>, componentToActionMap: Map<string,string>}} */
        this._view = { activeActionName: null, selectedComponentIds: new Set(), componentToActionMap: new Map() };
        /** @private {Function|null} Row click (component selection toggle). */
        this._onRowClick = null;
        /** @private {Function|null} Row click when the component is locked elsewhere. */
        this._onGrayedRowClick = null;
        /** @private {boolean} Whether the document-level listeners are attached. */
        this._listenersAttached = false;
        /** @private {HTMLElement|null} The scroll container whose scroll re-places the submenu. */
        this._scrollHost = null;
    }

    /** @returns {HTMLElement|null} The submenu element (null while closed and never opened). */
    get element() {
        return this._el;
    }

    /** @returns {boolean} True while the submenu is open. */
    get isOpen() {
        return this._actionName !== null;
    }

    /** @returns {string|null} The action name the submenu is open for. */
    get openActionName() {
        return this._actionName;
    }

    /**
     * Opens (or re-points) the submenu at an action.
     *
     * @param {Object} options
     * @param {string} options.actionName - The action to offer components for.
     * @param {Array<Object>} options.entries - That action's `canExecute` entries.
     * @param {HTMLElement} options.anchorEl - The action row to anchor against.
     * @param {string|null} [options.activeActionName] - Action currently being selected into.
     * @param {Set<string>} [options.selectedComponentIds] - Components selected for it.
     * @param {Map<string, Set<string>>} [options.crossActionSelections] - actionName → selected component ids.
     * @param {Function} [options.onRowClick] - `(actionName, entityId, componentId, componentIdentifier)`.
     * @param {Function} [options.onGrayedRowClick] - `(lockedActionName, componentId)`.
     */
    open(options) {
        const actionName = options?.actionName;
        if (!actionName) return;

        // Switching actions is a new search; reopening the same one keeps what
        // was typed (the world-state refresh path calls refresh(), not open()).
        if (this._actionName !== null && this._actionName !== actionName) {
            this._query = '';
        }
        this._actionName = actionName;
        this._anchorEl = options.anchorEl || null;
        this._entries = Array.isArray(options.entries) ? options.entries : [];
        this._onRowClick = options.onRowClick || null;
        this._onGrayedRowClick = options.onGrayedRowClick || null;
        this._view = this._buildView(options);

        this._ensureElement();
        if (this._titleEl) this._titleEl.textContent = actionName;
        this._renderList();
        this._position();
        this._attachDismissListeners();
    }

    /**
     * Updates an OPEN submenu after a world-state / selection change. A closed
     * submenu stays closed. The search input is never rebuilt, so focus and the
     * typed query survive the refresh.
     *
     * @param {Object} options - Same shape as `open()`, minus the search state.
     */
    refresh(options) {
        if (!this.isOpen) return;
        this._anchorEl = options?.anchorEl || this._anchorEl;
        this._entries = Array.isArray(options?.entries) ? options.entries : [];
        this._onRowClick = options?.onRowClick || this._onRowClick;
        this._onGrayedRowClick = options?.onGrayedRowClick || this._onGrayedRowClick;
        this._view = this._buildView(options);
        this._renderList();
        this._position();
    }

    /**
     * Closes the submenu and removes its element and document listeners.
     * Safe to call when already closed.
     */
    close() {
        this._detachDismissListeners();
        if (this._el && this._el.parentNode) {
            this._el.parentNode.removeChild(this._el);
        }
        this._el = null;
        this._titleEl = null;
        this._searchEl = null;
        this._listEl = null;
        this._hintEl = null;
        this._anchorEl = null;
        this._scrollHost = null;
        this._actionName = null;
        this._entries = [];
        this._query = '';
        this._onRowClick = null;
        this._onGrayedRowClick = null;
    }

    /**
     * Recomputes the selection state the rows are drawn from: which components
     * are selected for the active action, and which are locked to another one.
     * @param {Object} options - The `{ activeActionName, selectedComponentIds, crossActionSelections }` triple.
     * @returns {{activeActionName: string|null, selectedComponentIds: Set<string>, componentToActionMap: Map<string,string>}}
     * @private
     */
    _buildView(options) {
        const selectedComponentIds = options?.selectedComponentIds;
        const cross = options?.crossActionSelections;
        const componentToActionMap = new Map();
        if (cross instanceof Map) {
            for (const [actionName, compSet] of cross) {
                if (compSet instanceof Set) {
                    for (const compId of compSet) componentToActionMap.set(compId, actionName);
                }
            }
        }
        return {
            activeActionName: options?.activeActionName ?? null,
            selectedComponentIds: selectedComponentIds instanceof Set
                ? selectedComponentIds
                : new Set(selectedComponentIds || []),
            componentToActionMap,
        };
    }

    /**
     * Creates the submenu element (shell only: title, close, search, list, hint)
     * and appends it to `document.body`. Built once per open; `refresh()` only
     * touches `_listEl`.
     * @private
     */
    _ensureElement() {
        if (this._el) return;
        if (typeof document === 'undefined') return;

        const el = document.createElement('div');
        el.className = 'nav-action-submenu';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Choose components');
        // Above the backdrop (99) and above the manager's active panel (110).
        el.style.zIndex = String(AppConfig.UI.Z_INDEX_BASE + 2 * AppConfig.UI.Z_INDEX_STEP);

        const header = document.createElement('div');
        header.className = 'nav-action-submenu-header';
        this._titleEl = document.createElement('span');
        this._titleEl.className = 'nav-action-submenu-title';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'nav-action-submenu-close';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.textContent = '\u2715';
        closeBtn.addEventListener('click', () => this.close());
        header.appendChild(this._titleEl);
        header.appendChild(closeBtn);

        this._searchEl = document.createElement('input');
        this._searchEl.type = 'text';
        this._searchEl.className = 'nav-action-submenu-search';
        this._searchEl.placeholder = SEARCH_PLACEHOLDER;
        this._searchEl.autocomplete = 'off';
        this._searchEl.value = this._query;
        this._searchEl.addEventListener('input', () => {
            this._query = this._searchEl.value;
            this._renderList();
        });

        this._listEl = document.createElement('div');
        this._listEl.className = 'nav-action-submenu-list';
        // One delegated listener for rows that get re-rendered on every refresh.
        this._listEl.addEventListener('click', (event) => this._onListClick(event));

        this._hintEl = document.createElement('div');
        this._hintEl.className = 'nav-action-submenu-hint';
        this._hintEl.textContent = 'Click components to select them for this action';

        el.appendChild(header);
        el.appendChild(this._searchEl);
        el.appendChild(this._listEl);
        el.appendChild(this._hintEl);

        document.body.appendChild(el);
        this._el = el;
    }

    /**
     * Draws the list body (rows or an empty state) and the selected-count hint.
     * Never touches the search input, so typing survives a click-driven refresh.
     * @private
     */
    _renderList() {
        if (!this._listEl) return;
        const visible = filterComponentEntries(this._entries, this._query);
        const selectedCount = this._selectedCountForOpenAction();

        if (this._hintEl) {
            this._hintEl.textContent = selectedCount > 0
                ? `${selectedCount} selected \u00b7 click a component to toggle it`
                : 'Click components to select them for this action';
        }

        if (visible.length > 0) {
            this._listEl.innerHTML = buildComponentRowsHtml({
                actionName: this._actionName,
                entries: visible,
                activeActionName: this._view.activeActionName,
                selectedComponentIds: this._view.selectedComponentIds,
                componentToActionMap: this._view.componentToActionMap,
            });
            return;
        }
        // textContent (not innerHTML): the query is user text, never markup.
        this._listEl.textContent = this._entries.length === 0
            ? 'No component can perform this action.'
            : `No component matches "${this._query.trim()}".`;
    }

    /**
     * How many components are selected for the action this submenu is open for.
     * @returns {number}
     * @private
     */
    _selectedCountForOpenAction() {
        const selected = this._view.selectedComponentIds;
        if (this._view.activeActionName !== this._actionName) return 0;
        return selected instanceof Set ? selected.size : 0;
    }

    /**
     * Handles a click on a component row: forwards to the grayed-conflict
     * callback when the component is locked to another action, otherwise to the
     * selection-toggle callback. Same routing the inline list had.
     * @param {Event} event - The click event inside the list.
     * @private
     */
    _onListClick(event) {
        const row = event.target && event.target.closest ? event.target.closest('.nav-component-row') : null;
        if (!row) return;

        const { action, entity, compId, compIdentifier } = row.dataset;
        const isSelected = this._view.activeActionName === this._actionName
            && this._view.selectedComponentIds.has(compId);
        const grayedByAction = isSelected ? null : this._view.componentToActionMap.get(compId);

        if (grayedByAction && this._onGrayedRowClick) {
            this._onGrayedRowClick(grayedByAction, compId);
            return;
        }
        if (compId && entity && this._onRowClick) {
            this._onRowClick(action, entity, compId, compIdentifier);
        }
    }

    /**
     * Places the submenu next to its anchor row, clamped to the viewport.
     * @private
     */
    _position() {
        if (!this._el || !this._anchorEl || typeof window === 'undefined') return;
        if (!this._anchorEl.isConnected) return;

        const { left, top } = computeSubmenuPosition({
            anchorRect: this._anchorEl.getBoundingClientRect(),
            menuWidth: this._el.offsetWidth,
            menuHeight: this._el.offsetHeight,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
        });
        this._el.style.left = `${left}px`;
        this._el.style.top = `${top}px`;
    }

    /**
     * Attaches the document-level listeners an open submenu needs: Escape
     * dismissal and re-placement while the actions panel scrolls or the window
     * resizes. Idempotent; every attach has exactly one detach in `close()`.
     * @private
     */
    _attachDismissListeners() {
        if (this._listenersAttached || typeof document === 'undefined') return;
        this._listenersAttached = true;

        document.addEventListener('keydown', this._onDocumentKeyDown, true);
        window.addEventListener('resize', this._onViewportChange);

        const scrollHost = this._anchorEl && this._anchorEl.closest
            ? this._anchorEl.closest('.overlay-panel')
            : null;
        this._scrollHost = scrollHost;
        if (scrollHost) scrollHost.addEventListener('scroll', this._onViewportChange, { passive: true });
    }

    /**
     * Removes the listeners added by `_attachDismissListeners`.
     * @private
     */
    _detachDismissListeners() {
        if (!this._listenersAttached) return;
        this._listenersAttached = false;
        document.removeEventListener('keydown', this._onDocumentKeyDown, true);
        window.removeEventListener('resize', this._onViewportChange);
        if (this._scrollHost) this._scrollHost.removeEventListener('scroll', this._onViewportChange);
        this._scrollHost = null;
    }

    /**
     * Escape closes the submenu BEFORE the panel: the handler runs in the
     * capture phase and stops propagation, so OverlayManager's document-level
     * Escape (which closes the whole panel) is skipped. A second Escape closes
     * the panel, as usual.
     * @param {KeyboardEvent} event
     * @private
     */
    _onDocumentKeyDown = (event) => {
        if (event.key !== 'Escape' || !this.isOpen) return;
        event.stopPropagation();
        this.close();
        ClientLogger.debug('ActionComponentSubmenu', 'Component submenu dismissed.');
    };

    /**
     * Keeps the submenu glued to its anchor row while the panel scrolls or the
     * window resizes.
     * @private
     */
    _onViewportChange = () => {
        this._position();
    };
}
