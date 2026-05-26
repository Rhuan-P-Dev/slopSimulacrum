/**
 * InventoryManager - Client-side inventory management module.
 * Manages the inventory overlay panel displaying entity components as containers
 * with drag-and-drop items inside. Shows volume bars at component-level and item-level.
 *
 * @module InventoryManager
 */
export class InventoryManager {
    /**
     * Creates a new InventoryManager.
     * @param {import('./WorldStateManager.js').WorldStateManager} worldStateManager - The WorldStateManager instance.
     * @param {import('./UIManager.js').UIManager} uiManager - The UIManager instance.
     * @param {import('./StatBarsManager.js').StatBarsManager} statBarsManager - The StatBarsManager instance.
     */
    constructor(worldStateManager, uiManager, statBarsManager) {
        /** @private */
        this._worldStateManager = worldStateManager;
        /** @private */
        this._uiManager = uiManager;
        /** @private */
        this._statBarsManager = statBarsManager;

        /** @private {HTMLElement|null} */
        this._overlay = null;
        /** @private {HTMLElement|null} */
        this._content = null;
        /** @private {HTMLElement|null} */
        this._btnInventory = null;

        /** @private {string|null} */
        this._currentEntityId = null;
        /** @private {Object|null} */
        this._itemRegistry = null;
        /** @private {Object} */
        this._currentItems = {};
        /** @private {string|null} */
        this._draggingItemId = null;

        /** @private {boolean} */
        this._initialized = false;

        /** @private {Object|null} */
        this._holdingCostRegistry = null;

        /** @private {Object} */
        this._equippedItems = {};

        /** Bind methods */
        this._onDrop = this._onDrop.bind(this);
        this._onDragOver = this._onDragOver.bind(this);
        this._onDragLeave = this._onDragLeave.bind(this);
        this._onEquipClick = this._onEquipClick.bind(this);
        this._onUnequipClick = this._onUnequipClick.bind(this);
    }

    /**
     * Initializes the inventory manager DOM elements and event listeners.
     */
    init() {
        this._overlay = document.getElementById('inventory-overlay');
        this._content = document.getElementById('inventory-content');
        this._btnInventory = document.getElementById('btn-inventory');

        if (!this._overlay || !this._content) {
            console.warn('[InventoryManager] Overlay or content element not found.');
            return;
        }

        // Close button
        const closeBtn = this._overlay.querySelector('.overlay-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hide());
        }

        // NOTE: Config bar button click is handled by ConfigBarManager, not here.
        // InventoryManager stores reference to _btnInventory for potential future use
        // but does NOT attach a click listener to avoid double-toggle with ConfigBarManager.

        this._initialized = true;
        console.log('[InventoryManager] Initialized.');
    }

    /**
     * Shows the inventory overlay.
     */
    show() {
        if (!this._overlay) return;

        // Use the user's entity (myEntityId) as the inventory target
        const entityId = this._worldStateManager.getMyEntityId();
        // Fallback: try activeDroid if myEntityId not set yet
        const entity = this._worldStateManager.getActiveDroid();

        if (!entityId && !entity) {
            this._content.innerHTML = '<div class="inventory-empty"><span class="inventory-empty-icon">🎒</span><em>No entity available. Wait for connection.</em></div>';
            this._overlay.style.display = 'block';
            return;
        }

        this._currentEntityId = entityId || entity.id;
        this._overlay.style.display = 'block';

        // Load registry, holding cost definitions, and items
        Promise.all([
            this._loadItemRegistry(),
            this._loadHoldingCostRegistry(),
            this._loadEntityItems(this._currentEntityId),
            this._loadEquippedItems(this._currentEntityId)
        ]).then(() => {
            this._renderInventory();
        }).catch((err) => {
            console.error('[InventoryManager] Failed to load inventory data:', err);
            this._showToast('Failed to load inventory data', 'error');
        });
    }

    /**
     * Hides the inventory overlay.
     */
    hide() {
        if (!this._overlay) return;
        this._overlay.style.display = 'none';
        this._currentEntityId = null;
    }

    /**
     * Toggles the inventory overlay visibility.
     */
    toggle() {
        if (this._overlay && this._overlay.style.display === 'block') {
            this.hide();
        } else {
            this.show();
        }
    }

    /**
     * Loads the item type registry from the server.
     * @returns {Promise<void>}
     * @private
     */
    async _loadItemRegistry() {
        try {
            const response = await fetch('/inventory/registry');
            if (!response.ok) {
                console.error('[InventoryManager] Failed to load item registry. HTTP', response.status, response.statusText);
                this._itemRegistry = {};
                return;
            }
            const data = await response.json();
            this._itemRegistry = data.registry || {};

            // Log the loaded registry for debugging
            const itemTypes = Object.keys(this._itemRegistry);
            console.log('[InventoryManager] Item registry loaded with', itemTypes.length, 'item type(s):', itemTypes);
        } catch (error) {
            console.error('[InventoryManager] Error loading item registry:', error);
            this._itemRegistry = {};
        }
    }

    /**
     * Loads the holding cost definitions from the server.
     * @returns {Promise<void>}
     * @private
     */
    async _loadHoldingCostRegistry() {
        try {
            const response = await fetch('/inventory/holding-cost-registry');
            if (!response.ok) {
                console.error('[InventoryManager] Failed to load holding cost registry. HTTP', response.status, response.statusText);
                this._holdingCostRegistry = {};
                this._showToast('Holding cost registry unavailable — equip buttons will not appear. Server may need restart.', 'error');
                return;
            }
            const data = await response.json();
            this._holdingCostRegistry = data.registry || {};

            // Log the loaded registry for debugging
            const itemTypes = Object.keys(this._holdingCostRegistry);
            console.log('[InventoryManager] Holding cost registry loaded with', itemTypes.length, 'item type(s):', itemTypes);

            if (itemTypes.length === 0) {
                console.warn('[InventoryManager] Holding cost registry is empty — no equip buttons will appear.');
            }
        } catch (error) {
            console.error('[InventoryManager] Error loading holding cost registry:', error);
            this._holdingCostRegistry = {};
        }
    }

    /**
     * Loads equipped items for the entity.
     * @param {string} entityId - The entity ID.
     * @returns {Promise<void>}
     * @private
     */
    async _loadEquippedItems(entityId) {
        try {
            const response = await fetch(`/inventory/${entityId}/equipped`);
            if (!response.ok) {
                console.warn(`[InventoryManager] Failed to load equipped items for entity ${entityId}.`);
                this._equippedItems = {};
                return;
            }
            const data = await response.json();
            this._equippedItems = {};
            for (const eq of (data.equipped || [])) {
                this._equippedItems[eq.itemId] = eq;
            }
        } catch (error) {
            console.warn(`[InventoryManager] Error loading equipped items for entity ${entityId}:`, error);
            this._equippedItems = {};
        }
    }

    /**
     * Loads entity inventory items from the server.
     * @param {string} entityId - The entity ID.
     * @returns {Promise<void>}
     * @private
     */
    async _loadEntityItems(entityId) {
        try {
            const response = await fetch(`/inventory/${entityId}`);
            if (!response.ok) {
                console.error(`[InventoryManager] Failed to load items for entity ${entityId}. HTTP`, response.status, response.statusText);
                this._currentItems = {};
                return;
            }
            const data = await response.json();
            this._currentItems = data.items || {};

            // Log loaded items for debugging
            let totalItems = 0;
            for (const compId of Object.keys(this._currentItems)) {
                totalItems += Array.isArray(this._currentItems[compId]) ? this._currentItems[compId].length : 0;
            }
            console.log('[InventoryManager] Entity items loaded:', totalItems, 'items across', Object.keys(this._currentItems).length, 'component(s)');
        } catch (error) {
            console.error(`[InventoryManager] Error loading items for entity ${entityId}:`, error);
            this._currentItems = {};
        }
    }

    /**
     * Renders the full inventory view.
     * @private
     */
    _renderInventory() {
        if (!this._content) return;

        // Get state
        const state = this._worldStateManager.getState();

        // Build list of components that have volume from state components instances
        // Entity structure: state.entities[entityId] has components array of component IDs
        // Component structure: state.components.instances[compId] has { id, type, stats }
        const entityComponents = state?.entities?.[this._currentEntityId];
        const componentInstances = state?.components?.instances || {};

        // entityComponents might be the entity object or undefined
        if (!entityComponents) {
            this._content.innerHTML = `
                <div class="inventory-empty">
                    <span class="inventory-empty-icon">🎒</span>
                    <em>Entity not found in state.</em>
                </div>`;
            this._overlay.style.display = 'block';
            return;
        }

        // Get component IDs from entity
        // entityComponents.components might be: array of objects { id, type }, or array of strings (comp IDs)
        let compIds = [];
        let compTypeMap = {};

        if (Array.isArray(entityComponents.components)) {
            for (const compRef of entityComponents.components) {
                if (typeof compRef === 'string') {
                    // Array of component ID strings
                    compIds.push(compRef);
                } else if (compRef && typeof compRef === 'object') {
                    // Array of objects { id, type, identifier }
                    compIds.push(compRef.id);
                    if (compRef.type) compTypeMap[compRef.id] = compRef.type;
                }
            }
        }

        // Build list of components with volume from componentInstances
        const volumeComponents = [];
        for (const compId of compIds) {
            const compData = componentInstances[compId] || {};
            // Component instances have Physical traits at the top level (e.g., { Physical: { volume: 10, ... }, Spatial: { ... } })
            const physicalStats = compData.Physical || {};
            const volume = physicalStats.volume || 0;

            // Only show components with volume > 0
            if (volume > 0) {
                volumeComponents.push({
                    id: compId,
                    type: compTypeMap[compId] || compData.type || compData.entityComponentType || 'unknown',
                    volume: volume
                });
            }
        }

        // Check if there's anything to display
        const hasItems = Object.values(this._currentItems).some(
            (items) => Array.isArray(items) && items.length > 0
        );
        const hasVolumeComponents = volumeComponents.length > 0;

        if (!hasItems && !hasVolumeComponents) {
            this._content.innerHTML = `
                <div class="inventory-empty">
                    <span class="inventory-empty-icon">🎒</span>
                    <em>No components with volume found for this entity.</em>
                </div>`;
            this._overlay.style.display = 'block';
            return;
        }

        let html = '';

        // Render all volume components (even if empty)
        for (const comp of volumeComponents) {
            const compItems = this._currentItems[comp.id] || [];
            const volumeInfo = this._calculateVolumeInfo(comp.id, comp.volume, compItems);
            html += this._renderComponentSlot(comp, volumeInfo, compItems);
        }

        this._content.innerHTML = html;
        this._attachDragAndDropListeners();
    }

    /**
     * Checks if the entity has any components with volume.
     * @returns {boolean}
     * @private
     */
    // NOTE: _hasVolumeComponents removed — now handled inline in _renderInventory()
    // to use the correct state path structure

    /**
     * Calculates volume info for a component.
     * @param {string} componentId - The component ID.
     * @param {number} maxVolume - The max volume.
     * @param {Array} items - The items in this component.
     * @returns {{ used: number, max: number, percentage: number, barClass: string }}
     * @private
     */
    _calculateVolumeInfo(componentId, maxVolume, items) {
        const used = items.reduce((sum, item) => sum + (item.volume || 0), 0);
        const percentage = maxVolume > 0 ? (used / maxVolume) * 100 : 0;

        let barClass = 'low';
        if (percentage >= 100) barClass = 'full';
        else if (percentage >= 75) barClass = 'high';
        else if (percentage >= 40) barClass = 'medium';

        return { used, max: maxVolume, percentage, barClass };
    }

    /**
     * Renders a single component slot with its items.
     * @param {Object} comp - Component info { id, type, volume }.
     * @param {Object} volumeInfo - Volume info { used, max, percentage, barClass }.
     * @param {Array} items - Items in this component.
     * @returns {string} HTML string.
     * @private
     */
    _renderComponentSlot(comp, volumeInfo, items) {
        const percentageStr = volumeInfo.percentage.toFixed(0);
        const volumeText = `${volumeInfo.used}/${volumeInfo.max}`;
        const itemsHtml = this._renderItems(comp.id, items);
        const hasItems = items.length > 0;
        const itemsContainerClass = `inventory-items-container${hasItems ? ' has-items' : ''}`;

        return `
            <div class="inventory-component-slot" data-comp-id="${comp.id}" data-comp-volume="${comp.volume}">
                <div class="inventory-component-header">
                    <span class="inventory-component-name">
                        <span class="inventory-component-type-badge">${this._formatTypeName(comp.type)}</span>
                    </span>
                    <div class="inventory-component-meta">
                        <div class="inventory-volume-bar" title="${percentageStr}% volume used">
                            <div class="inventory-volume-bar-fill ${volumeInfo.barClass}" style="width: ${Math.min(volumeInfo.percentage, 100)}%;"></div>
                        </div>
                        <span class="inventory-volume-text">${volumeText} (${percentageStr}%)</span>
                    </div>
                </div>
                <div class="${itemsContainerClass}" data-comp-id="${comp.id}">
                    ${itemsHtml}
                </div>
            </div>`;
    }

    /**
     * Renders the items list for a component.
     * @param {string} componentId - The component ID (drop target).
     * @param {Array} items - Items in this component.
     * @returns {string} HTML string.
     * @private
     */
    _renderItems(componentId, items) {
        if (items.length === 0) {
            return '<div class="inventory-items-empty"><span class="inventory-drag-hint">Drag items here</span></div>';
        }

        let html = '';
        for (const item of items) {
            const itemDef = this._itemRegistry ? this._itemRegistry[item.type] : null;
            const itemVolume = item.volume || (itemDef ? itemDef.volume : 0);
            const percentageStr = itemVolume > 0 ? '100' : '0';
            const hasHoldingCost = this._holdingCostRegistry && this._holdingCostRegistry[item.type];
            const isEquipped = this._equippedItems[item.id];

            // Build equip/unequip button only for items with holding cost
            let equipButtonHtml = '';
            if (hasHoldingCost) {
                const btnText = isEquipped ? '🔓 Unequip' : '⚔️ Equip';
                const btnClass = isEquipped ? 'equip-btn unequip' : 'equip-btn equip';
                const btnTitle = isEquipped
                    ? 'Click to unequip (remove holding cost debuffs)'
                    : `Click to equip (requires: ${this._formatHoldingCost(item.type)})`;

                equipButtonHtml = `
                    <button class="${btnClass}"
                            data-item-id="${item.id}"
                            data-item-type="${item.type}"
                            data-is-equipped="${isEquipped ? 'true' : 'false'}"
                            title="${btnTitle}">
                        ${btnText}
                    </button>`;
            }

            html += `
                <div class="inventory-item-card"
                     draggable="true"
                     data-item-id="${item.id}"
                     data-item-type="${item.type}"
                     data-item-volume="${itemVolume}"
                     title="${hasHoldingCost ? 'Drag to move to another component' : 'Drag to move to another component'}">
                    <span class="drag-handle">⠿</span>
                    <span class="inventory-item-name">${item.name || item.type}</span>
                    <span class="inventory-item-volume">${itemVolume}v</span>
                    ${equipButtonHtml}
                </div>`;
        }
        return html;
    }

    /**
     * Formats the holding cost requirements as a readable string.
     * @param {string} itemType - The item type.
     * @returns {string}
     * @private
     */
    _formatHoldingCost(itemType) {
        const def = this._holdingCostRegistry?.[itemType];
        if (!def?.holdingCost) return '';
        return def.holdingCost.map(entry => `${entry.stat}≥${entry.value}`).join(', ');
    }

    /**
     * Formats a camelCase type name to readable format.
     * @param {string} type - The type name.
     * @returns {string} Formatted name.
     * @private
     */
    _formatTypeName(type) {
        return type
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/^./, str => str.toUpperCase());
    }

    /**
     * Attaches drag and drop event listeners to item cards and drop zones.
     * @private
     */
    _attachDragAndDropListeners() {
        // Attach drag start to item cards
        const itemCards = this._content.querySelectorAll('.inventory-item-card');
        itemCards.forEach(card => {
            card.addEventListener('dragstart', (e) => {
                this._onDragStart(e, card);
            });
            card.addEventListener('dragend', (e) => {
                this._onDragEnd(e);
            });
        });

        // Attach drop zone listeners to items containers
        const containers = this._content.querySelectorAll('.inventory-items-container');
        containers.forEach(container => {
            container.addEventListener('dragover', this._onDragOver);
            container.addEventListener('dragleave', this._onDragLeave);
            container.addEventListener('drop', this._onDrop);
        });

        // Attach equip/unequip button listeners
        const equipButtons = this._content.querySelectorAll('.equip-btn');
        equipButtons.forEach(btn => {
            const isEquipped = btn.dataset.isEquipped === 'true';
            btn.addEventListener('click', isEquipped ? this._onUnequipClick : this._onEquipClick);
        });
    }

    /**
     * Handles equip button click.
     * @param {Event} e - The click event.
     * @private
     */
    async _onEquipClick(e) {
        e.stopPropagation();
        const btn = e.currentTarget;
        const itemId = btn.dataset.itemId;
        const itemType = btn.dataset.itemType;
        if (!this._currentEntityId) return;

        // Find target component from the nearest container
        const card = btn.closest('.inventory-item-card');
        const container = card?.closest('.inventory-items-container');
        const targetCompId = container?.dataset.compId;
        if (!targetCompId) {
            this._showToast('No component found to equip to', 'error');
            return;
        }

        try {
            const response = await fetch(`/inventory/${this._currentEntityId}/equip/${itemId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ itemType, componentId: targetCompId })
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                this._showToast(result.message || 'Failed to equip item', 'error');
                return;
            }

            this._showToast('Item equipped successfully', 'success');

            // Reload BOTH item data and equipped state in parallel to avoid stale data
            await Promise.all([
                this._loadEntityItems(this._currentEntityId),
                this._loadEquippedItems(this._currentEntityId)
            ]);
            await this._statBarsManager?.refreshCurrentEntity?.();
            this._renderInventory();

        } catch (error) {
            console.error('[InventoryManager] Error equipping item:', error);
            this._showToast('Failed to equip item', 'error');
        }
    }

    /**
     * Handles unequip button click.
     * @param {Event} e - The click event.
     * @private
     */
    async _onUnequipClick(e) {
        e.stopPropagation();
        const btn = e.currentTarget;
        const itemId = btn.dataset.itemId;
        if (!this._currentEntityId) return;

        try {
            const response = await fetch(`/inventory/${this._currentEntityId}/unequip/${itemId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                this._showToast(result.message || 'Failed to unequip item', 'error');
                return;
            }

            this._showToast('Item unequipped successfully', 'success');

            // Reload BOTH item data and equipped state in parallel to avoid stale data
            await Promise.all([
                this._loadEntityItems(this._currentEntityId),
                this._loadEquippedItems(this._currentEntityId)
            ]);
            await this._statBarsManager?.refreshCurrentEntity?.();
            this._renderInventory();

        } catch (error) {
            console.error('[InventoryManager] Error unequipping item:', error);
            this._showToast('Failed to unequip item', 'error');
        }
    }

    /**
     * Handles drag start on an item card.
     * @param {DragEvent} e - The drag event.
     * @param {HTMLElement} card - The card element being dragged.
     * @private
     */
    _onDragStart(e, card) {
        this._draggingItemId = card.dataset.itemId;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', this._draggingItemId);
    }

    /**
     * Handles drag end on an item card.
     * @param {DragEvent} e - The drag event.
     * @private
     */
    _onDragEnd(e) {
        e.target.classList.remove('dragging');
        this._draggingItemId = null;

        // Remove all drop hover classes
        this._content.querySelectorAll('.drop-hover, .drop-invalid, .drop-target-hover, .drop-target-invalid').forEach(el => {
            el.classList.remove('drop-hover', 'drop-invalid', 'drop-target-hover', 'drop-target-invalid');
        });
    }

    /**
     * Handles drag over on a drop zone (items container).
     * @param {DragEvent} e - The drag event.
     * @private
     */
    _onDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        const container = e.currentTarget;
        const targetCompId = container.dataset.compId;

        // Check if the dragged item can fit in this component
        if (this._draggingItemId) {
            const canFit = this._checkItemFit(this._draggingItemId, targetCompId);
            container.classList.toggle('drop-target-hover', canFit);
            container.classList.toggle('drop-target-invalid', !canFit);

            // Also highlight the component slot
            const slot = this._content.querySelector(`.inventory-component-slot[data-comp-id="${targetCompId}"]`);
            if (slot) {
                slot.classList.toggle('drop-hover', canFit);
                slot.classList.toggle('drop-invalid', !canFit);
            }
        }
    }

    /**
     * Handles drag leave from a drop zone.
     * @param {DragEvent} e - The drag event.
     * @private
     */
    _onDragLeave(e) {
        const container = e.currentTarget;
        container.classList.remove('drop-target-hover', 'drop-target-invalid');

        const targetCompId = container.dataset.compId;
        const slot = this._content.querySelector(`.inventory-component-slot[data-comp-id="${targetCompId}"]`);
        if (slot) {
            slot.classList.remove('drop-hover', 'drop-invalid');
        }
    }

    /**
     * Handles drop on a drop zone.
     * If the target component has any equipped items, they are auto-unequipped
     * before moving the dragged item.
     * @param {DragEvent} e - The drop event.
     * @private
     */
    async _onDrop(e) {
        e.preventDefault();
        const container = e.currentTarget;
        const targetCompId = container.dataset.compId;
        const itemId = e.dataTransfer.getData('text/plain');

        // Remove hover classes
        container.classList.remove('drop-target-hover', 'drop-target-invalid');

        if (!itemId || !this._currentEntityId) {
            return;
        }

        // Check if target is the same component
        const sourceCompId = this._getCurrentComponentForItem(itemId);
        if (sourceCompId === targetCompId) {
            // Same component, no move needed
            return;
        }

        // Auto-unequip the dragged item if it's equipped (before it moves)
        try {
            await this._autoUnequipDraggedItem(itemId);
        } catch (error) {
            console.error('[InventoryManager] Error auto-unequipping dragged item on drop:', error);
        }

        // Auto-unequip any equipped items on the target component
        try {
            await this._autoUnequipOnTarget(targetCompId);
        } catch (error) {
            console.error('[InventoryManager] Error auto-unequipping items on drop:', error);
        }

        // Send move request to server
        try {
            const response = await fetch(`/inventory/${this._currentEntityId}/move/${itemId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetComponentId: targetCompId })
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                this._showToast(result.message || 'Failed to move item: volume exceeded', 'error');
                return;
            }

            this._showToast('Item moved successfully', 'success');

            // Reload and re-render
            await this._loadEntityItems(this._currentEntityId);
            this._renderInventory();

        } catch (error) {
            console.error('[InventoryManager] Error moving item:', error);
            this._showToast('Failed to move item', 'error');
        }
    }

    /**
     * Auto-unequips the dragged item if it is currently equipped.
     * This ensures the item is unequipped before it moves to a new component.
     * @param {string} itemId - The item ID being dragged.
     * @returns {Promise<void>}
     * @private
     */
    async _autoUnequipDraggedItem(itemId) {
        if (!this._currentEntityId) return;
        if (!this._equippedItems[itemId]) return; // Not equipped, nothing to do

        const eq = this._equippedItems[itemId];
        const { itemType, componentId } = eq;

        try {
            const response = await fetch(`/inventory/${this._currentEntityId}/unequip/${itemId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            if (response.ok) {
                // Update local tracking
                delete this._equippedItems[itemId];
                console.log(`[InventoryManager] Auto-unequipped ${itemType} from ${componentId} before move.`);
            }
        } catch (error) {
            console.warn(`[InventoryManager] Failed to auto-unequip dragged item ${itemId}:`, error);
        }
    }

    /**
     * Auto-unequips all items equipped on a specific target component.
     * @param {string} targetCompId - The target component ID.
     * @returns {Promise<void>}
     * @private
     */
    async _autoUnequipOnTarget(targetCompId) {
        if (!this._currentEntityId) return;

        // Find equipped items on the target component
        const equippedOnTarget = [];
        for (const [itemId, eq] of Object.entries(this._equippedItems)) {
            if (eq.componentId === targetCompId) {
                equippedOnTarget.push(itemId);
            }
        }

        // Unequip each one
        for (const itemId of equippedOnTarget) {
            try {
                const response = await fetch(`/inventory/${this._currentEntityId}/unequip/${itemId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });

                if (response.ok) {
                    // Update local tracking
                    delete this._equippedItems[itemId];
                }
            } catch (error) {
                console.warn(`[InventoryManager] Failed to auto-unequip item ${itemId} on drop:`, error);
            }
        }
    }

    /**
     * Checks if a dragged item can fit in a target component.
     * @param {string} itemId - The item ID.
     * @param {string} targetCompId - The target component ID.
     * @returns {boolean}
     * @private
     */
    _checkItemFit(itemId, targetCompId) {
        // Find the item in current items
        let item = null;
        let itemVolume = 0;

        for (const items of Object.values(this._currentItems)) {
            if (Array.isArray(items)) {
                const found = items.find(i => i.id === itemId);
                if (found) {
                    item = found;
                    itemVolume = found.volume || 0;
                    break;
                }
            }
        }

        if (!item) return false;

        // Get target component max volume
        const slot = this._content.querySelector(`.inventory-component-slot[data-comp-id="${targetCompId}"]`);
        if (!slot) return false;

        const maxVolume = parseInt(slot.dataset.compVolume) || 0;
        const itemsInTarget = this._currentItems[targetCompId] || [];
        const usedVolume = itemsInTarget.reduce((sum, i) => sum + (i.volume || 0), 0);

        return (usedVolume + itemVolume) <= maxVolume;
    }

    /**
     * Gets the current component for an item.
     * @param {string} itemId - The item ID.
     * @returns {string|null}
     * @private
     */
    _getCurrentComponentForItem(itemId) {
        for (const [compId, items] of Object.entries(this._currentItems)) {
            if (Array.isArray(items)) {
                if (items.some(i => i.id === itemId)) {
                    return compId;
                }
            }
        }
        return null;
    }

    /**
     * Handles world state changes - re-renders if entity items changed.
     * @private
     */
    _onWorldStateChange() {
        if (!this._overlay || this._overlay.style.display !== 'block') return;
        if (!this._currentEntityId) return;

        // If we're viewing inventory, re-render to show any changes
        this._loadEntityItems(this._currentEntityId).then(() => {
            this._renderInventory();
        }).catch((err) => {
            console.warn('[InventoryManager] Failed to refresh inventory on state change:', err);
        });
    }

    /**
     * Shows a toast notification.
     * @param {string} message - The message to display.
     * @param {'success'|'error'} type - The toast type.
     * @private
     */
    _showToast(message, type = 'success') {
        // Remove existing toasts
        const existing = document.querySelectorAll('.inventory-toast');
        existing.forEach(t => t.remove());

        const toast = document.createElement('div');
        toast.className = `inventory-toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        // Auto-remove after 2.5 seconds
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 2500);
    }
}