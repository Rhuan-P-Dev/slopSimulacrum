/**
 * DropSelectorController — Floating window for selecting components to drop an item.
 *
 * Triggered when a user clicks the "Drop" button on an inventory item.
 * Shows a list of all components capable of performing the drop action.
 * User selects components and clicks "Execute" → range indicator appears on map → map click drops item.
 *
 * @module DropSelectorController
 */

export class DropSelectorController {
    /**
     * Creates a new DropSelectorController.
     * @param {Object} eventDispatcher - The EventDispatcher instance.
     * @param {Object} worldStateManager - The WorldStateManager instance.
     * @param {Object} selectionController - The SelectionController instance.
     * @param {Object} uiManager - The UIManager instance.
     * @param {Object} actionManager - The ActionManager instance.
     */
    constructor(eventDispatcher, worldStateManager, selectionController, uiManager, actionManager) {
        /** @private */
        this._eventDispatcher = eventDispatcher;
        /** @private */
        this._worldStateManager = worldStateManager;
        /** @private */
        this._selectionController = selectionController;
        /** @private */
        this._uiManager = uiManager;
        /** @private */
        this._actionManager = actionManager;

        /** @private {HTMLElement|null} */
        this._overlay = null;
        /** @private {HTMLElement|null} */
        this._componentList = null;
        /** @private {HTMLElement|null} */
        this._executeBtn = null;
        /** @private {HTMLElement|null} */
        this._cancelBtn = null;

        /** @private {Object|null} — Pending drop item { actionName, entityId, itemId, itemType } */
        this._pendingDropItem = null;
        /** @private {Object|null} — Pending pick-up item { droppedItemId, itemType, name, volume, id } */
        this._pendingPickUpItem = null;
        /** @private {Array} — Capable components fetched from server */
        this._capableComponents = [];
        /** @private {Set<string>} — Selected component IDs */
        this._selectedComponentIds = new Set();
        /** @private {boolean} */
        this._initialized = false;
        /** @private {Function|null} — Callback for execute action (signals App.js to show range) */
        this._onExecuteCallback = null;
        /** @private {boolean} — Whether in pickup mode (true) or drop mode (false) */
        this._isPickupMode = false;
    }

    /**
     * Gets the overlay DOM element.
     * @returns {HTMLElement|null}
     */
    get overlay() {
        return this._overlay;
    }

    /**
     * Initializes the controller DOM elements and attaches event listeners.
     */
    init() {
        this._overlay = document.getElementById('drop-selector-overlay');
        this._componentList = document.getElementById('drop-component-list');
        this._executeBtn = document.getElementById('drop-execute-btn');
        this._cancelBtn = document.getElementById('drop-cancel-btn');

        if (!this._overlay) {
            console.error('[DropSelectorController] Overlay element #drop-selector-overlay not found.');
            return;
        }

        // Initially hidden
        this._overlay.style.display = 'none';

        // Close button
        const closeBtn = this._overlay.querySelector('.overlay-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hide());
        }

        // Execute button
        if (this._executeBtn) {
            this._executeBtn.addEventListener('click', () => this._onExecute());
        }

        // Cancel button
        if (this._cancelBtn) {
            this._cancelBtn.addEventListener('click', () => this._onCancel());
        }

        this._initialized = true;
        console.info('[DropSelectorController] Initialized.');
    }

    /**
     * Sets a callback to be invoked when Execute is clicked.
     * @param {Function} callback — Function to call (receives selected component IDs and pending item).
     */
    setExecuteCallback(callback) {
        this._onExecuteCallback = callback;
    }

    /**
     * Opens the drop selector panel in drop mode, fetches capable components, and populates the list.
     * @param {Object} data — Drop data object.
     * @param {Object} data.pendingDropItem — The pending drop item { actionName, entityId, itemId, itemType }.
     * @param {Object} [data.entityState] — The entity state (optional).
     */
    async show(data) {
        if (!data?.pendingDropItem) {
            console.warn('[DropSelectorController] No pending drop item provided.');
            return;
        }
        await this._showDropPanel(data);
    }

    /**
     * Opens the drop selector panel in pickup mode, fetches capable components, and populates the list.
     * Mirrors the drop flow: user selects a component, clicks Execute, range indicator appears on map, then map click completes pickup.
     * @param {Object} data — Pick-up data object.
     * @param {Object} data.pendingPickUpItem — The pending pick-up item { droppedItemId, itemType, name, volume, id }.
     * @param {string} data.entityId — The entity ID to pick up the item with.
     */
    async showPickup(data) {
        if (!data?.pendingPickUpItem || !data.entityId) {
            console.warn('[DropSelectorController] No pending pick-up item or entityId provided.');
            return;
        }
        await this._showPickupPanel(data);
    }

    /**
     * Shows the drop selector panel (internal).
     * @param {Object} data — Drop data object.
     * @private
     */
    async _showDropPanel(data) {
        if (!this._initialized || !this._overlay) return;

        this._isPickupMode = false;
        this._pendingDropItem = data.pendingDropItem;
        this._pendingPickUpItem = null;
        this._selectedComponentIds.clear();
        this._capableComponents = [];

        // Update panel title with item name
        const titleEl = this._overlay.querySelector('.overlay-title');
        if (titleEl) {
            titleEl.textContent = `Drop: ${this._pendingDropItem.itemType}`;
        }

        // Disable execute button until components selected
        if (this._executeBtn) {
            this._executeBtn.disabled = true;
        }

        // Fetch capable components from server
        try {
            const entityId = this._pendingDropItem.entityId;
            const response = await fetch(`/inventory/${entityId}/capable-drop-components`);

            if (!response.ok) {
                console.error(`[DropSelectorController] Failed to fetch capable components: HTTP ${response.status}`);
                this._renderEmptyState('Failed to load components.');
                this._overlay.style.display = 'block';
                return;
            }

            const json = await response.json();
            this._capableComponents = json.components || [];
            this._renderComponentList(this._capableComponents);
        } catch (error) {
            console.error(`[DropSelectorController] Error fetching capable components: ${error.message}`);
            this._renderEmptyState('Error loading components.');
        }

        this._overlay.style.display = 'block';
        console.info(`[DropSelectorController] Panel opened for item ${this._pendingDropItem.itemType} (${this._pendingDropItem.itemId}).`);
    }

    /**
     * Renders the component list.
     * @param {Array} components — Array of capable component objects.
     * @private
     */
    _renderComponentList(components) {
        if (!this._componentList) return;

        if (!components || components.length === 0) {
            const msg = this._isPickupMode
                ? 'No components capable of picking up items.'
                : 'No components capable of dropping items.';
            this._renderEmptyState(msg);
            return;
        }

        let html = '';
        for (const comp of components) {
            const compName = comp.name || comp.type || comp.id;
            const compType = comp.type || 'Unknown';
            html += `
                <div class="drop-component-item" data-comp-id="${comp.id}">
                    <div class="drop-component-check"></div>
                    <div class="drop-component-info">
                        <span class="drop-component-name">${compName}</span>
                        <span class="drop-component-type">${compType}</span>
                    </div>
                </div>`;
        }

        this._componentList.innerHTML = html;
        this._attachComponentListeners();
    }

    /**
     * Renders an empty state message.
     * @param {string} message — The message to display.
     * @private
     */
    _renderEmptyState(message) {
        if (!this._componentList) return;
        this._componentList.innerHTML = `<div class="drop-empty-state">${message}</div>`;
    }

    /**
     * Attaches click listeners to component items for selection toggling.
     * @private
     */
    _attachComponentListeners() {
        if (!this._componentList) return;

        const items = this._componentList.querySelectorAll('.drop-component-item');
        items.forEach(item => {
            item.addEventListener('click', () => {
                const compId = item.dataset.compId;
                this._toggleComponentSelection(compId, item);
            });
        });
    }

    /**
     * Toggles a component's selection state.
     * @param {string} compId — The component ID.
     * @param {HTMLElement} itemEl — The DOM element.
     * @private
     */
    _toggleComponentSelection(compId, itemEl) {
        if (this._selectedComponentIds.has(compId)) {
            this._selectedComponentIds.delete(compId);
            itemEl.classList.remove('selected');
        } else {
            this._selectedComponentIds.add(compId);
            itemEl.classList.add('selected');
        }

        // Update execute button state
        if (this._executeBtn) {
            this._executeBtn.disabled = this._selectedComponentIds.size === 0;
        }
    }

    /**
     * Shows the pickup selector panel (internal).
     * @param {Object} data — Pick-up data object.
     * @private
     */
    async _showPickupPanel(data) {
        if (!this._initialized || !this._overlay) return;

        this._isPickupMode = true;
        this._pendingDropItem = null;
        this._pendingPickUpItem = data.pendingPickUpItem;
        this._selectedComponentIds.clear();
        this._capableComponents = [];

        // Update panel title with item name
        const titleEl = this._overlay.querySelector('.overlay-title');
        if (titleEl) {
            titleEl.textContent = `Pick Up: ${this._pendingPickUpItem.name || this._pendingPickUpItem.itemType}`;
        }

        // Disable execute button until component selected
        if (this._executeBtn) {
            this._executeBtn.disabled = true;
        }

        // Fetch capable components from server for pick-up
        try {
            const response = await fetch(`/inventory/${data.entityId}/capable-pickup-components`);

            if (!response.ok) {
                console.error(`[DropSelectorController] Failed to fetch capable pick-up components: HTTP ${response.status}`);
                this._renderEmptyState('Failed to load components.');
                this._overlay.style.display = 'block';
                return;
            }

            const json = await response.json();
            this._capableComponents = json.components || [];
            this._renderComponentList(this._capableComponents);
        } catch (error) {
            console.error(`[DropSelectorController] Error fetching capable pick-up components: ${error.message}`);
            this._renderEmptyState('Error loading components.');
        }

        this._overlay.style.display = 'block';
        console.info(`[DropSelectorController] Pick-up panel opened for item ${this._pendingPickUpItem.itemType}.`);
    }

    /**
     * Handles the Execute button click.
     * In drop mode: closes the panel and dispatches drop-selector:execute event.
     * In pickup mode: closes the panel and dispatches pick-up-selector:execute event.
     * Does NOT interact with the action selection system to avoid preview panel interference.
     * @private
     */
    _onExecute() {
        if (this._selectedComponentIds.size === 0) {
            console.warn('[DropSelectorController] No components selected.');
            return;
        }

        // Capture state BEFORE hiding — hide() calls _clearSelection() which nullifies pending items
        const componentIds = Array.from(this._selectedComponentIds);

        if (this._isPickupMode) {
            const pendingPickUpItem = this._pendingPickUpItem;
            console.info(`[DropSelectorController] Pick-up Execute clicked with ${componentIds.length} component(s).`);

            // Close the panel first
            this.hide();

            // Dispatch custom event — App.js handles range indicator + map click flow
            document.dispatchEvent(new CustomEvent('pick-up-selector:execute', {
                detail: {
                    pendingPickUpItem,
                    componentIds
                }
            }));
        } else {
            const pendingDropItem = this._pendingDropItem;
            console.info(`[DropSelectorController] Execute clicked with ${componentIds.length} component(s).`);

            // Close the panel first
            this.hide();

            // Dispatch custom event — App.js handles range indicator + map click flow
            document.dispatchEvent(new CustomEvent('drop-selector:execute', {
                detail: {
                    pendingDropItem,
                    componentIds
                }
            }));
        }
    }

    /**
     * Handles the Cancel button click.
     * @private
     */
    _onCancel() {
        console.info('[DropSelectorController] Cancel clicked.');
        this._clearSelection();
        this.hide();
    }

    /**
     * Clears the current selection.
     * @private
     */
    _clearSelection() {
        this._selectedComponentIds.clear();
        if (this._componentList) {
            const items = this._componentList.querySelectorAll('.drop-component-item');
            items.forEach(item => item.classList.remove('selected'));
        }
        if (this._executeBtn) {
            this._executeBtn.disabled = true;
        }
        this._pendingDropItem = null;
        this._pendingPickUpItem = null;
        this._capableComponents = [];
        this._isPickupMode = false;
    }

    /**
     * Hides the drop selector panel.
     */
    hide() {
        if (!this._overlay) return;
        this._overlay.style.display = 'none';
        this._clearSelection();
        console.info('[DropSelectorController] Panel hidden.');
    }

    /**
     * Checks if the panel is currently visible.
     * @returns {boolean}
     */
    isActive() {
        return this._overlay && this._overlay.style.display === 'block';
    }
}