/**
 * GroupPickOverlayController
 * Floating window panel for cluster (group) pickup.
 *
 * Why this panel exists: dropped items form piles (broken furniture chunks,
 * generator parts, scattered loot). Picking up a pile one click per item was
 * pure mouse churn. Clicking any marker of a cluster (>= minItems within the
 * data-driven radius) opens THIS window instead of the single-item overlay:
 * items are stacked by type with a quantity stepper, a search filter narrows
 * the list, and one Execute picks the chosen instances through the normal
 * pickup pipeline (component selection → POST /pick-up-item per item).
 *
 * The panel is a view-only shell: stacking, filtering, and selection are the
 * pure functions in public/utils/GroupPick.js. It never talks to the server
 * directly — the orchestrator (App) receives the selected items and routes
 * them through the shared component-selection flow (DropSelector in pickup
 * mode) and the batch executor, exactly like a single pickup. Out-of-range
 * instances are displayed dimmed but unselectable; the server remains the
 * authority on range, volume, and requirements.
 *
 * Pattern: Standalone panel controller compatible with OverlayManager
 * (registered programmatically — no config-bar button, no keyboard shortcut).
 *
 * @module GroupPickOverlayController
 */
import { AppConfig } from './Config.js';
import { groupIntoStacks, matchesFilter, expandSelection, selectionVolume } from '../utils/GroupPick.js';
import ClientLogger from '../utils/ClientLogger.js';

export class GroupPickOverlayController {
    /**
     * Creates a new GroupPickOverlayController.
     * @param {Object} [deps] - Dependency injection object.
     * @param {Function} [deps.onExecute] - Callback triggered when "Pick Up" is clicked. Receives the flat array of selected item objects.
     * @param {Function} [deps.onClose] - Callback triggered when the panel is closed.
     */
    constructor(deps = {}) {
        /** @private */
        this._onExecute = deps.onExecute || (() => {});
        /** @private */
        this._onClose = deps.onClose || (() => {});
        /** @private {HTMLElement|null} */
        this._overlay = null;
        /** @private {Array<Object>} */
        this._items = [];
        /** @private {Array<Object>} */
        this._stacks = [];
        /** @private {Map<string, number>} Chosen quantity per itemType. */
        this._qty = new Map();
        /** @private {string} */
        this._query = '';
        /** @private {boolean} */
        this._isDragInitialized = false;
    }

    /**
     * Gets the overlay element.
     * @returns {HTMLElement|null}
     */
    get overlay() {
        return this._overlay;
    }

    /**
     * Initializes the overlay DOM element.
     */
    init() {
        // Check if overlay already exists in DOM
        this._overlay = document.getElementById('group-pick-overlay');

        if (!this._overlay) {
            this._overlay = this._createOverlay();
            document.body.appendChild(this._overlay);
        }

        // Attach close button listener
        const closeBtn = this._overlay.querySelector('.overlay-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hide());
        }

        // Attach execute button listener
        const execBtn = this._overlay.querySelector('.group-pick-execute-btn');
        if (execBtn) {
            execBtn.addEventListener('click', () => this._handleExecute());
        }

        // Attach search filter listener
        const search = this._overlay.querySelector('.group-pick-search');
        if (search) {
            search.addEventListener('input', (e) => {
                this._query = e.target.value;
                this._render();
            });
        }

        // Initialize drag functionality
        this._initDrag();
    }

    /**
     * Shows the window for a cluster of dropped items. Each item must be
     * pre-annotated with an `inRange` boolean by the caller (App computes it
     * with the same distance semantics the server enforces).
     *
     * Quantities default to "all in-range instances of each type" — opening
     * the window already expresses the intent to clear the pile; the steppers
     * are for dialing back.
     *
     * @param {Array<Object>} items - The cluster (annotated dropped items).
     */
    show(items) {
        this._items = Array.isArray(items) ? items : [];
        // Re-stack from scratch each time the window opens: the cluster is a
        // fresh snapshot (post-refresh), and stale quantities would be
        // meaningless against new instance sets.
        this._stacks = [];
        this._qty = new Map();
        this._query = '';
        const search = this._overlay?.querySelector('.group-pick-search');
        if (search) search.value = '';

        this._stacks = groupIntoStacks(this._items);
        for (const stack of this._stacks) {
            this._qty.set(stack.itemType, stack.inRange.length);
        }

        this._status = '';
        this._render();
        this._overlay.style.display = 'flex';
    }

    /**
     * Sets a transient status line (e.g. batch outcome after a partial
     * success). Cleared when the window is next opened.
     * @param {string} text
     */
    setStatus(text) {
        this._status = text || '';
        const el = this._overlay?.querySelector('.group-pick-status');
        if (el) el.textContent = this._status;
    }

    /**
     * Expands the current quantities into the flat array of item objects to
     * pick, in stack order (type by first appearance, instances by insertion
     * order). Out-of-range instances are never included.
     * @returns {Array<Object>}
     */
    getSelectedItems() {
        const selected = [];
        for (const stack of this._stacks) {
            selected.push(...expandSelection(stack, this._qty.get(stack.itemType) || 0));
        }
        return selected;
    }

    /**
     * Hides the panel and fires the close callback.
     */
    hide() {
        if (!this._overlay) return;
        this._overlay.style.display = 'none';
        this._status = '';
        this._onClose();
    }

    /**
     * Toggles the panel (no-op when there is no cluster loaded).
     */
    toggle() {
        if (!this._overlay) return;
        if (this._overlay.style.display === 'none') {
            if (this._items.length > 0) this._overlay.style.display = 'flex';
        } else {
            this.hide();
        }
    }

    /**
     * Handles the "Pick Up" button: expands the selection and hands it to
     * the orchestrator. The panel stays in a pending-hidden state — the
     * orchestrator re-opens it (with the outcome) if the floor still holds a
     * cluster after the batch, or dismisses it otherwise.
     * @private
     */
    _handleExecute() {
        const items = this.getSelectedItems();
        if (items.length === 0) return;
        this._onExecute(items);
    }

    /**
     * Re-renders the list, summary, and execute button from the current
     * stacks, quantities, and filter.
     * @private
     */
    _render() {
        if (!this._overlay) return;
        const list = this._overlay.querySelector('.group-pick-list');
        const summary = this._overlay.querySelector('.group-pick-summary');
        const status = this._overlay.querySelector('.group-pick-status');
        const execBtn = this._overlay.querySelector('.group-pick-execute-btn');
        if (!list || !summary || !execBtn) return;

        if (status) status.textContent = this._status || '';

        const visible = this._stacks.filter((stack) => matchesFilter(stack, this._query));
        list.textContent = '';

        let selectedCount = 0;
        let selectedVol = 0;

        for (const stack of visible) {
            const qty = this._qty.get(stack.itemType) || 0;
            selectedCount += Math.min(qty, stack.inRange.length);
            selectedVol += Math.min(qty, stack.inRange.length) * stack.unitVolume;

            const row = document.createElement('div');
            row.className = 'group-pick-stack';

            const name = document.createElement('div');
            name.className = 'group-pick-stack-name';
            name.textContent = stack.name;
            if (stack.outOfRange.length > 0) {
                name.title = `${stack.outOfRange.length} out of pickup range (not selectable)`;
            }

            const count = document.createElement('span');
            count.className = 'group-pick-stack-count';
            count.textContent = `×${stack.items.length}`;

            const info = document.createElement('div');
            info.className = 'group-pick-stack-info';
            info.append(name, count);

            const minus = document.createElement('button');
            minus.className = 'group-pick-stepper-btn';
            minus.textContent = '−';
            minus.setAttribute('aria-label', `Less ${stack.name}`);
            minus.addEventListener('click', () => this._bump(stack.itemType, -1));

            const qtyLabel = document.createElement('span');
            qtyLabel.className = 'group-pick-qty';
            qtyLabel.textContent = String(Math.min(qty, stack.inRange.length));

            const plus = document.createElement('button');
            plus.className = 'group-pick-stepper-btn';
            plus.textContent = '+';
            plus.setAttribute('aria-label', `More ${stack.name}`);
            plus.addEventListener('click', () => this._bump(stack.itemType, 1));

            const stepper = document.createElement('div');
            stepper.className = 'group-pick-stepper';
            stepper.append(minus, qtyLabel, plus);
            if (stack.inRange.length === 0) {
                stepper.classList.add('disabled');
            }

            const meta = document.createElement('div');
            meta.className = 'group-pick-stack-meta';
            const chosen = Math.min(qty, stack.inRange.length);
            meta.textContent = `vol ${chosen}×${stack.unitVolume} = ${chosen * stack.unitVolume}`;
            if (stack.outOfRange.length > 0) {
                const oor = document.createElement('span');
                oor.className = 'group-pick-oor-badge';
                oor.textContent = `${stack.outOfRange.length} out of range`;
                meta.appendChild(oor);
            }

            row.append(info, stepper, meta);
            list.appendChild(row);
        }

        const totalInCluster = this._items.length;
        summary.textContent = `${selectedCount} of ${totalInCluster} selected · volume ${selectedVol}`;

        execBtn.textContent = `🎒 Pick Up (${selectedCount})`;
        execBtn.disabled = selectedCount === 0;
    }

    /**
     * Adjusts a stack's quantity by delta, clamped to 0..inRange.length.
     * @private
     */
    _bump(itemType, delta) {
        const stack = this._stacks.find((s) => s.itemType === itemType);
        if (!stack) return;
        const max = stack.inRange.length;
        const current = this._qty.get(itemType) || 0;
        const next = Math.min(Math.max(current + delta, 0), max);
        this._qty.set(itemType, next);
        this._render();
    }

    /**
     * Initializes drag functionality for the overlay.
     * @private
     */
    _initDrag() {
        if (this._isDragInitialized) return;

        // The header is now .overlay-header
        const header = this._overlay.querySelector('.overlay-header');
        if (!header) return;

        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        const onMouseDown = (e) => {
            if (e.target.closest('.overlay-close-btn')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            initialLeft = this._overlay.offsetLeft;
            initialTop = this._overlay.offsetTop;
            // One step above the OverlayManager's active panel (derived, not a
            // third constant, so the layering invariant cannot drift).
            this._overlay.style.zIndex = AppConfig.UI.Z_INDEX_BASE + AppConfig.UI.Z_INDEX_STEP;
            this._overlay.style.transition = 'none';
        };

        const onMouseMove = (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            this._overlay.style.left = `${initialLeft + dx}px`;
            this._overlay.style.top = `${initialTop + dy}px`;
        };

        const onMouseUp = () => {
            if (isDragging) {
                isDragging = false;
                this._overlay.style.transition = '';
            }
        };

        header.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        this._isDragInitialized = true;
    }

    /**
     * Creates the overlay DOM element.
     * @returns {HTMLElement}
     * @private
     */
    _createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'group-pick-overlay';
        overlay.className = 'overlay-panel group-pick-overlay-panel';
        overlay.style.display = 'none';
        overlay.innerHTML = `
            <div class="overlay-header">
                <h3 class="group-pick-title">Group Pick</h3>
                <button class="overlay-close-btn" aria-label="Close">&times;</button>
            </div>
            <div class="overlay-content group-pick-panel-content">
                <input type="search" class="group-pick-search" placeholder="Filter items…" aria-label="Filter items">
                <div class="group-pick-summary"></div>
                <div class="group-pick-list" role="list"></div>
                <div class="group-pick-status" role="status"></div>
                <div class="group-pick-actions">
                    <button class="group-pick-execute-btn" disabled>🎒 Pick Up</button>
                </div>
            </div>
        `;
        return overlay;
    }
}
