import ClientLogger from '/utils/ClientLogger.js';
import MaterialRegistry from './MaterialRegistry.js';
import { AppConfig } from './Config.js';
import { ID_PREFIXES, isPrefixed } from '../../shared/IdPrefixes.js';
import { DEFAULT_ITEM_VOLUME } from '../../shared/Defaults.js';
import { directChildrenOf } from '/utils/ItemTree.js';
import { filterInventoryView } from '/utils/InventoryFilter.js';
import { STAT_NAMES } from '../../shared/StatVocabulary.js';

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

        /** @private {import('./DropSelectorController.js').DropSelectorController|null} */
        this._dropSelector = null;

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

        /** @private {Object<string, boolean>} */
        this._containerExpanded = {};  // { [containerItemId]: true/false }

        /** @private {{ containsItemOnly: boolean, query: string }} UI-local filter state */
        this._filters = { containsItemOnly: false, query: '' };
        /** @private {Set<string>|null} matched component ids (null = no highlighting yet) */
        this._matchedComponentIds = null;
        /** @private {Set<string>|null} matched item ids (null = no highlighting yet) */
        this._matchedItemIds = null;

        /** Bind methods */
        this._onDrop = this._onDrop.bind(this);
        this._onDragOver = this._onDragOver.bind(this);
        this._onDragLeave = this._onDragLeave.bind(this);
        this._onEquipClick = this._onEquipClick.bind(this);
        this._onUnequipClick = this._onUnequipClick.bind(this);
        this._onDropClick = this._onDropClick.bind(this);
    }

    /**
     * Sets the DropSelectorController instance for drop button integration.
     * @param {import('./DropSelectorController.js').DropSelectorController|null} dropSelector - The DropSelectorController instance.
     */
    setDropSelector(dropSelector) {
        this._dropSelector = dropSelector;
    }

    /**
     * Initializes the inventory manager DOM elements and event listeners.
     */
    init() {
        this._overlay = document.getElementById('inventory-overlay');
        this._content = document.getElementById('inventory-content');
        this._btnInventory = document.getElementById('btn-inventory');

        if (!this._overlay || !this._content) {
            ClientLogger.warn('InventoryManager', ' Overlay or content element not found.');
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

        // Client view filters (UI-local state, bound once). The filter bar is
        // static markup outside the rewritten content root, so the input keeps
        // focus across re-renders; each change re-applies the pure derivation.
        const containsItemCheckbox = document.getElementById('inventory-filter-contains-item');
        if (containsItemCheckbox) {
            containsItemCheckbox.addEventListener('change', (event) => {
                this._filters.containsItemOnly = event.target.checked;
                this._renderIfVisible();
            });
        }

        const searchInput = document.getElementById('inventory-filter-search');
        if (searchInput) {
            searchInput.addEventListener('input', (event) => {
                this._filters.query = event.target.value;
                this._renderIfVisible();
            });
        }

        this._initialized = true;
        ClientLogger.info('InventoryManager', ' Initialized.');
    }

    /**
     * Re-renders the inventory only while the overlay is displayed — the same
     * visibility guard the world-state-change hook uses, so filter changes never
     * render into a hidden panel.
     * @private
     */
    _renderIfVisible() {
        if (!this._overlay || this._overlay.style.display !== 'block') return;
        this._renderInventory();
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
            ClientLogger.error('InventoryManager', ' Failed to load inventory data:', err);
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
                ClientLogger.error('InventoryManager', ' Failed to load item registry. HTTP', response.status, response.statusText);
                this._itemRegistry = {};
                return;
            }
            const data = await response.json();
            this._itemRegistry = data.registry || {};

            // Log the loaded registry for debugging
            const itemTypes = Object.keys(this._itemRegistry);
            ClientLogger.info('InventoryManager', ' Item registry loaded with', itemTypes.length, 'item type(s):', itemTypes);
        } catch (error) {
            ClientLogger.error('InventoryManager', ' Error loading item registry:', error);
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
                ClientLogger.error('InventoryManager', ' Failed to load holding cost registry. HTTP', response.status, response.statusText);
                this._holdingCostRegistry = {};
                this._showToast('Holding cost registry unavailable — equip buttons will not appear. Server may need restart.', 'error');
                return;
            }
            const data = await response.json();
            this._holdingCostRegistry = data.registry || {};

            // Log the loaded registry for debugging
            const itemTypes = Object.keys(this._holdingCostRegistry);
            ClientLogger.info('InventoryManager', ' Holding cost registry loaded with', itemTypes.length, 'item type(s):', itemTypes);

            if (itemTypes.length === 0) {
                ClientLogger.warn('InventoryManager', ' Holding cost registry is empty — no equip buttons will appear.');
            }
        } catch (error) {
            ClientLogger.error('InventoryManager', ' Error loading holding cost registry:', error);
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
                ClientLogger.warn('InventoryManager', ` Failed to load equipped items for entity ${entityId}.`);
                this._equippedItems = {};
                return;
            }
            const data = await response.json();
            // Key by the typed eqId (eq-uuid) — the server's equipped entries carry a
            // typed eqId, not a bare `id`; keying on the wrong field collapses every
            // entry under "undefined". Skip (with a warning) any malformed entry that
            // lacks an eqId rather than collapsing it under "undefined".
            this._equippedItems = {};
            for (const eq of (data.equipped || [])) {
                if (!eq?.eqId) {
                    ClientLogger.warn('InventoryManager', ' Skipping equipped entry with no eqId:', eq);
                    continue;
                }
                this._equippedItems[eq.eqId] = eq;
            }
        } catch (error) {
            ClientLogger.warn('InventoryManager', ` Error loading equipped items for entity ${entityId}:`, error);
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
                ClientLogger.error('InventoryManager', ` Failed to load items for entity ${entityId}. HTTP`, response.status, response.statusText);
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
            ClientLogger.info('InventoryManager', ' Entity items loaded:', totalItems, 'items across', Object.keys(this._currentItems).length, 'component(s)');
        } catch (error) {
            ClientLogger.error('InventoryManager', ` Error loading items for entity ${entityId}:`, error);
            this._currentItems = {};
        }
    }

    /**
     * Renders the full inventory view. The client view filters (contains-item
     * toggle + search) are applied here as a pure derivation, inside the single
     * method every refresh path converges on, so an active filter re-applies
     * automatically on each refresh and can never be lost.
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

        // Resolve each component's display name (a component has no name of its
        // own — the searchable name is the formatted type) and apply the client
        // view filters as a pure derivation. The matched-id sets are stored for
        // the render helpers to highlight hits; null/empty sets mean no highlight.
        const namedComponents = volumeComponents.map((c) => ({
            ...c,
            name: this._formatTypeName(c.type),
        }));
        const filteredView = filterInventoryView({
            components: namedComponents,
            itemsByHost: this._currentItems,
            containsItemOnly: this._filters.containsItemOnly,
            query: this._filters.query,
        });
        this._matchedComponentIds = filteredView.matchedComponentIds;
        this._matchedItemIds = filteredView.matchedItemIds;

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

        // The filters hid every component that existed before filtering — a
        // distinct empty state from the pre-filter "no volume" condition above.
        if (volumeComponents.length > 0 && filteredView.components.length === 0) {
            this._content.innerHTML = `
                <div class="inventory-empty">
                    <span class="inventory-empty-icon">🎒</span>
                    <em>No components match the current filter</em>
                </div>`;
            this._overlay.style.display = 'block';
            return;
        }

        // Build tree from current items (attach children to parents)
        const tree = this._buildItemTree();

        let html = '';

        // Render the visible (filtered) components
        for (const comp of filteredView.components) {
            const compItems = tree[comp.id] || [];
            const volumeInfo = this._calculateVolumeInfo(comp.id, comp.volume, compItems);
            html += this._renderComponentSlot(comp, volumeInfo, compItems);
        }

        this._content.innerHTML = html;
        this._attachDragAndDropListeners();
    }

    /**
     * Build a tree structure from the flat items array.
     * Attaches children to their parent items recursively.
     * @returns {Object} Tree structure: { [compId]: [topLevelItems] } where each item may have children
     * @private
     */
    _buildItemTree() {
        const tree = {};
        for (const [compId, items] of Object.entries(this._currentItems)) {
            tree[compId] = this._attachChildren(items);
        }
        return tree;
    }

    /**
     * Recursively attach children to items.
     * @param {Array} parentItems - Items whose children we need to find
     * @returns {Array} Items with `children` property added
     * @private
     */
    _attachChildren(parentItems) {
        // Collect all items from all components (flat)
        const allItems = [];
        for (const items of Object.values(this._currentItems)) {
            allItems.push(...items);
        }

        return parentItems.map(item => {
            // Find direct children: items whose hostComponentId === this item's id
            // (shared grouping primitive — see ItemTree.directChildrenOf)
            const children = directChildrenOf(item.id, allItems);
            if (children.length > 0) {
                item.children = this._attachChildren(children);
            } else {
                item.children = [];
            }
            return item;
        });
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
        // Use externalVolume for host component space (item footprint on the component)
        // Fall back to hostVolume, then to volume (internal capacity) for backwards compatibility
        const used = items.reduce((sum, item) => sum + (item.externalVolume ?? item.hostVolume ?? DEFAULT_ITEM_VOLUME), 0);
        const percentage = maxVolume > 0 ? (used / maxVolume) * 100 : 0;

        let barClass = 'low';
        if (percentage >= AppConfig.INVENTORY.VOLUME_BAR_THRESHOLDS.FULL) barClass = 'full';
        else if (percentage >= AppConfig.INVENTORY.VOLUME_BAR_THRESHOLDS.HIGH) barClass = 'high';
        else if (percentage >= AppConfig.INVENTORY.VOLUME_BAR_THRESHOLDS.MEDIUM) barClass = 'medium';

        return { used, max: maxVolume, percentage, barClass };
    }

    /**
     * Renders a single component slot with its items.
     * @param {Object} comp - Component info { id, type, volume }.
     * @param {Object} volumeInfo - Volume info { used, max, percentage, barClass }.
     * @param {Array} items - Tree items (with optional children).
     * @returns {string} HTML string.
     * @private
     */
    _renderComponentSlot(comp, volumeInfo, items) {
        const percentageStr = volumeInfo.percentage.toFixed(0);
        const volumeText = `${volumeInfo.used}/${volumeInfo.max}`;
        const itemsHtml = this._renderTreeItems(comp.id, items, 0);
        const hasItems = items.length > 0;
        const itemsContainerClass = `inventory-items-container${hasItems ? ' has-items' : ''}`;
        const compMatchClass = this._matchedComponentIds && this._matchedComponentIds.has(comp.id)
            ? ' inventory-name-match'
            : '';

        return `
            <div class="inventory-component-slot" data-comp-id="${comp.id}" data-comp-volume="${comp.volume}">
                <div class="inventory-component-header">
                    <span class="inventory-component-name">
                        <span class="inventory-component-type-badge${compMatchClass}">${this._formatTypeName(comp.type)}</span>
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
     * Renders items from the tree structure (items may have children).
     * @param {string} hostId - The component ID or container item ID (drop target).
     * @param {Array} items - Tree items (with optional children).
     * @param {number} depth - The nesting depth (0 = top-level inside component, 1 = inside a container item, etc.).
     * @returns {string} HTML string.
     * @private
     */
    _renderTreeItems(hostId, items, depth = 0) {
        if (items.length === 0) {
            return '<div class="inventory-items-empty"><span class="inventory-drag-hint">Drag items here</span></div>';
        }

        let html = '';
        for (const item of items) {
            const itemMatchClass = this._matchedItemIds && this._matchedItemIds.has(item.id)
                ? ' inventory-name-match'
                : '';
            const itemDef = this._itemRegistry ? this._itemRegistry[item.type] : null;
            // Use externalVolume for display on host component (footprint), volume for internal capacity
            const displayVolume = item.externalVolume ?? item.hostVolume ?? DEFAULT_ITEM_VOLUME;
            const internalCapacity = item.volume || (itemDef ? itemDef.volume : 0);
            // An item is a container if it has internal capacity >= CONTAINER_MIN_CAPACITY or has children
            const isContainer = internalCapacity >= AppConfig.INVENTORY.CONTAINER_MIN_CAPACITY || (item.children && item.children.length > 0);
            const hasChildren = item.children && item.children.length > 0;
            const percentageStr = displayVolume > 0 ? '100' : '0';
            // massBurden model: equipability is declared by the model's equipableItems
            // list (the old per-item registry key no longer exists after the
            // recipe→derivation migration). Gate on that list.
            const hasHoldingCost = Array.isArray(this._holdingCostRegistry?.equipableItems)
                && this._holdingCostRegistry.equipableItems.includes(item.type);
            const isEquipped = this._isEquippedByItemId(item.id);
            const materialBadges = MaterialRegistry.formatBadges(item.type);

            // Build equip/unequip button only for items with holding cost
            let equipButtonHtml = '';
            if (hasHoldingCost) {
                const btnText = isEquipped ? '🔓 Unequip' : '⚔️ Equip';
                const btnClass = isEquipped ? 'equip-btn unequip' : 'equip-btn equip';
                const btnTitle = isEquipped
                    ? 'Click to unequip (remove holding cost debuffs)'
                    : `Click to equip (requires: ${this._formatHoldingCost()})`;

                equipButtonHtml = `
                    <button class="${btnClass}"
                            data-item-id="${item.id}"
                            data-item-type="${item.type}"
                            data-is-equipped="${isEquipped ? 'true' : 'false'}"
                            title="${btnTitle}">
                        ${btnText}
                    </button>`;
            }

            // Drop button for all items
            const dropButtonHtml = `
                <button class="equip-btn drop"
                        data-item-id="${item.id}"
                        data-item-type="${item.type}"
                        title="Click to select a component and drop this item">📦 Drop</button>`;

            // Container header with children (if isContainer — has internal capacity or children)
            let containerHtml = '';
            if (isContainer) {
                const capacity = internalCapacity;
                const childrenVolume = item.children.reduce((sum, c) => sum + (c.volume || 0), 0);
                const isExpanded = this._containerExpanded[item.id] !== false;
                const chevron = isExpanded ? '▼' : '▶';
                const usedPercent = capacity > 0 ? Math.round((childrenVolume / capacity) * 100) : 0;
                const barClass = usedPercent >= AppConfig.INVENTORY.VOLUME_BAR_THRESHOLDS.FULL ? 'full'
                    : usedPercent >= AppConfig.INVENTORY.VOLUME_BAR_THRESHOLDS.HIGH ? 'high'
                    : usedPercent >= AppConfig.INVENTORY.VOLUME_BAR_THRESHOLDS.MEDIUM ? 'medium' : 'low';

                containerHtml = `
                    <div class="inventory-container-slot" data-item-id="${item.id}" data-container-capacity="${capacity}">
                        <div class="inventory-container-header" data-container-header="${item.id}">
                            <button class="inventory-container-toggle" data-toggle-container="${item.id}" title="Expand/collapse">${chevron}</button>
                            <span class="inventory-item-name${itemMatchClass}">${item.name || item.type}</span>
                            <span class="inventory-item-volume">${displayVolume}v</span>
                            <span class="inventory-container-capacity-text">${childrenVolume}/${capacity} (${usedPercent}%)</span>
                        </div>
                        <div class="inventory-container-items" style="display: ${isExpanded ? 'block' : 'none'};" data-container-items="${item.id}">
                            <div class="inventory-container-capacity-bar" title="${usedPercent}% capacity used">
                                <div class="inventory-container-capacity-bar-fill ${barClass}" style="width: ${Math.min(usedPercent, 100)}%;"></div>
                            </div>
                            ${this._renderTreeItems(item.id, item.children, depth + 1)}
                        </div>
                    </div>`;
            }

            const depthClass = this._getDepthClass(depth);
            const cardClass = depthClass ? `inventory-item-card ${depthClass}` : 'inventory-item-card';

            html += `
                ${containerHtml}
                <div class="${cardClass}"${isContainer ? ' style="border-left: 3px solid var(--neon-cyan);"' : ''}
                     draggable="true"
                     data-item-id="${item.id}"
                     data-item-type="${item.type}"
                     data-item-volume="${displayVolume}"
                     data-container-capacity="${isContainer ? internalCapacity : ''}"
                     data-is-container="${isContainer}"
                     data-parent-host-id="${hostId}"
                     title="${isContainer ? 'Click header to expand/collapse. Drag to move container to another component.' : 'Drag to move to another component'}">
                    <span class="drag-handle">${isContainer ? '📦' : '⠿'}</span>
                    ${materialBadges ? `<div class="inventory-materials-row">${materialBadges}</div>` : ''}
                    <span class="inventory-item-name${itemMatchClass}">${item.name || item.type}</span>
                    <span class="inventory-item-volume">${displayVolume}v</span>
                    <button class="equip-btn stats-toggle"
                            data-item-id="${item.id}"
                            data-item-type="${item.type}"
                            title="Click to view item stats">📊 Stats</button>
                    ${equipButtonHtml}
                    ${dropButtonHtml}
                </div>
                <!-- Expandable stats panel (hidden by default) -->
                <div class="inventory-item-stats-panel"
                     id="stats-${item.id}"
                     data-item-id="${item.id}"
                     style="display:none;">
                    <div class="stats-loading">Loading stats...</div>
                </div>`;
        }
        return html;
    }

    /**
     * Returns the CSS class name for a given nesting depth.
     * @param {number} depth - The nesting depth.
     * @returns {string} The CSS class name (e.g., `inventory-nested-depth-2`), or empty string for depth 0.
     * @private
     */
    _getDepthClass(depth) {
        if (depth <= 0) {
            return '';
        }
        if (depth >= 5) {
            return 'inventory-nested-depth-5';
        }
        return `inventory-nested-depth-${depth}`;
    }

    /**
     * Formats the holding cost requirements as a readable string.
     * Under the massBurden model the burden is uniform (a single mass lever), so
     * the display is derived from the model's equipGate/carryingCost and does not
     * vary by item type — no per-type parameter is required.
     *
     * The equip gate's own `description` wording from the model is preferred
     * (single source of display copy). When the gate declares no description, a
     * string is synthesized from the gate's numeric ratio, with the stat label
     * taken from the shared stat vocabulary — never hand-typed.
     * @returns {string}
     * @private
     */
    _formatHoldingCost() {
        // massBurden model: the burden is a single mass lever (uniform for all
        // equipable items), so the display is derived from the model's equipGate +
        // carryingCost rather than the removed per-item holdingCost list. Prefer the
        // gate's own description (single source of display copy); only synthesize
        // from the ratio when the model provides none.
        const registry = this._holdingCostRegistry;
        if (!registry || typeof registry !== 'object') return '';
        const parts = [];
        const gate = registry.equipGate;
        if (gate && gate.type === 'strengthToMassRatio') {
            if (typeof gate.description === 'string' && gate.description.length > 0) {
                parts.push(gate.description);
            } else if (typeof gate.requiredStrengthPerUnitMass === 'number') {
                parts.push(`${STAT_NAMES.STRENGTH} ≥ ${gate.requiredStrengthPerUnitMass} × item mass`);
            }
        } else if (gate && gate.description) {
            parts.push(gate.description);
        }
        const cost = registry.carryingCost;
        if (cost && cost.type === 'linearReduction' && typeof cost.reductionPerUnitMass === 'number') {
            const burdened = (Array.isArray(registry.burdenedStats) ? registry.burdenedStats : [])
                .map(s => s?.stat).filter(Boolean).join(' & ');
            if (burdened) parts.push(`carrying reduces ${burdened}`);
        }
        return parts.join(' · ');
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

        // NEW: Attach container header toggle listeners
        // Attach to header divs so clicking anywhere on the header toggles
        const containerHeaders = this._content.querySelectorAll('[data-container-header]');
        containerHeaders.forEach(header => {
            header.addEventListener('click', (e) => {
                e.stopPropagation();
                const containerItemId = header.dataset.containerHeader;
                this._toggleContainer(containerItemId);
            });
        });

        // NEW: Attach dragover/drop to container slots
        const containerSlots = this._content.querySelectorAll('.inventory-container-slot');
        containerSlots.forEach(slot => {
            slot.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this._draggingItemId) {
                    const containerItemId = slot.dataset.itemId;
                    const canFit = this._checkItemFitInContainer(containerItemId, this._draggingItemId);
                    slot.classList.toggle('drop-target-hover', canFit);
                    slot.classList.toggle('drop-target-invalid', !canFit);
                    if (canFit) {
                        this._containerExpanded[containerItemId] = true;
                        this._toggleContainerVisual(containerItemId, true);
                    }
                }
            });
            slot.addEventListener('dragleave', (e) => {
                e.stopPropagation();
                slot.classList.remove('drop-target-hover', 'drop-target-invalid');
            });
            slot.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                slot.classList.remove('drop-target-hover', 'drop-target-invalid');
                const containerItemId = slot.dataset.itemId;
                const itemId = e.dataTransfer.getData('text/plain');
                if (itemId && this._currentEntityId) {
                    this._onContainerDrop(e, containerItemId, itemId);
                }
            });
        });

        // Attach equip/unequip button listeners (exclude drop buttons)
        const equipButtons = this._content.querySelectorAll('.equip-btn.equip, .equip-btn.unequip');
        equipButtons.forEach(btn => {
            const isEquipped = btn.dataset.isEquipped === 'true';
            btn.addEventListener('click', isEquipped ? this._onUnequipClick : this._onEquipClick);
        });

        // Attach drop button listeners
        const dropButtons = this._content.querySelectorAll('.equip-btn.drop');
        dropButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                this._onDropClick(e, btn.closest('.inventory-item-card'));
            });
        });

        // Attach stats toggle button listeners
        const statsButtons = this._content.querySelectorAll('.equip-btn.stats-toggle');
        statsButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                this._onStatsClick(e, btn);
            });
        });
    }

    /**
     * Handles click on the Drop button for an inventory item.
     * Opens the DropSelector floating window.
     * @param {Event} e - The click event.
     * @param {HTMLElement} card - The item card element.
     * @private
     */
    _onDropClick(e, card) {
        e.stopPropagation();
        e.preventDefault();

        if (!card || !this._currentEntityId) {
            ClientLogger.warn('InventoryManager', ' No card or entity ID for drop action.');
            this._showToast('No entity available for drop.', 'error');
            return;
        }

        const itemId = card.dataset.itemId;
        const itemType = card.dataset.itemType;

        if (!itemId || !itemType) {
            ClientLogger.warn('InventoryManager', ' Missing item data on drop button.');
            this._showToast('Invalid item data.', 'error');
            return;
        }

        // Create pending drop object
        const pendingDropItem = {
            actionName: 'dropItem',
            entityId: this._currentEntityId,
            itemId,
            itemType
        };

        // Open the DropSelector panel
        this._dropSelector?.show({ pendingDropItem });
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
            ClientLogger.error('InventoryManager', ' Error equipping item:', error);
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
            ClientLogger.error('InventoryManager', ' Error unequipping item:', error);
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
            ClientLogger.error('InventoryManager', ' Error auto-unequipping dragged item on drop:', error);
        }

        // Auto-unequip any equipped items on the target component
        try {
            await this._autoUnequipOnTarget(targetCompId);
        } catch (error) {
            ClientLogger.error('InventoryManager', ' Error auto-unequipping items on drop:', error);
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
            ClientLogger.error('InventoryManager', ' Error moving item:', error);
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
        const eq = this._findEquippedByItemId(itemId);
        if (!eq) return; // Not equipped, nothing to do

        const { itemType, componentId } = eq;

        try {
            const response = await fetch(`/inventory/${this._currentEntityId}/unequip/${itemId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            if (response.ok) {
                // Update local tracking — delete by the typed eqId (matches the key
                // used in _loadEquippedItems).
                delete this._equippedItems[eq.eqId];
                ClientLogger.info('InventoryManager', ` Auto-unequipped ${itemType} from ${componentId} before move.`);
            }
        } catch (error) {
            ClientLogger.warn('InventoryManager', ` Failed to auto-unequip dragged item ${itemId}:`, error);
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

        // Find equipped items on the target component (iterate by eqId)
        const equippedOnTarget = [];
        for (const [eqId, eq] of Object.entries(this._equippedItems)) {
            if (eq.componentId === targetCompId) {
                equippedOnTarget.push({ eqId, itemId: eq.itemId });
            }
        }

        // Unequip each one
        for (const { eqId, itemId } of equippedOnTarget) {
            try {
                const response = await fetch(`/inventory/${this._currentEntityId}/unequip/${itemId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });

                if (response.ok) {
                    // Update local tracking — delete by eqId
                    delete this._equippedItems[eqId];
                }
            } catch (error) {
                ClientLogger.warn('InventoryManager', ` Failed to auto-unequip item ${itemId} on drop:`, error);
            }
        }
    }

    /**
     * Checks if an item is currently equipped (searches _equippedItems by itemId).
     * @param {string} itemId - The item ID.
     * @returns {boolean}
     * @private
     */
    _isEquippedByItemId(itemId) {
        for (const eq of Object.values(this._equippedItems)) {
            if (eq.itemId === itemId) return true;
        }
        return false;
    }

    /**
     * Finds an equipped item by its itemId.
     * @param {string} itemId - The item ID.
     * @returns {Object|null} The equipped item or null.
     * @private
     */
    _findEquippedByItemId(itemId) {
        for (const eq of Object.values(this._equippedItems)) {
            if (eq.itemId === itemId) return eq;
        }
        return null;
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
                    // Use externalVolume for host component space
                    itemVolume = found.externalVolume ?? found.hostVolume ?? DEFAULT_ITEM_VOLUME;
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
        // Use externalVolume for host component space
        const usedVolume = itemsInTarget.reduce((sum, i) => sum + (i.externalVolume ?? i.hostVolume ?? DEFAULT_ITEM_VOLUME), 0);

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
     * Handles click on the Stats button for an inventory item.
     * Toggles the stats panel and loads stats from server if first open.
     * @param {Event} e - The click event.
     * @param {HTMLElement} btn - The stats toggle button.
     * @private
     */
    async _onStatsClick(e, btn) {
        e.stopPropagation();
        const itemId = btn.dataset.itemId;
        const panel = document.getElementById(`stats-${itemId}`);

        if (!panel) return;

        // Toggle visibility
        if (panel.style.display === 'none') {
            panel.style.display = 'block';

            // Only fetch from server if panel hasn't been loaded yet
            const hasLoaded = panel.dataset.loaded === 'true';
            if (!hasLoaded) {
                await this._loadItemStats(itemId, panel);
                panel.dataset.loaded = 'true';
            }
        } else {
            panel.style.display = 'none';
        }
    }

    /**
     * Loads item stats from server and renders them in the panel.
     * @param {string} itemId - The item ID.
     * @param {HTMLElement} panel - The stats panel element.
     * @returns {Promise<void>}
     * @private
     */
    async _loadItemStats(itemId, panel) {
        if (!this._currentEntityId) {
            panel.innerHTML = '<div class="stats-error">No entity ID available.</div>';
            return;
        }

        try {
            const response = await fetch(`/inventory/${this._currentEntityId}/item-stats/${itemId}`);
            if (!response.ok) {
                panel.innerHTML = `<div class="stats-error">Failed to load stats (HTTP ${response.status})</div>`;
                return;
            }

            const data = await response.json();
            if (!data.success || !data.stats) {
                panel.innerHTML = '<div class="stats-error">No stats available.</div>';
                return;
            }

            const stats = data.stats;
            this._renderItemStats(panel, stats);
        } catch (error) {
            ClientLogger.error('InventoryManager', ' Error loading item stats:', error);
            panel.innerHTML = '<div class="stats-error">Network error</div>';
        }
    }

    /**
     * Renders stat entries in the stats panel with merged view.
     * When both base and dynamic values exist for a stat, shows: dynamic / base (percentage%)
     * When only base exists (no dynamic), shows just the base value.
     * @param {HTMLElement} panel - The stats panel element.
     * @param {Object} stats - The stats object from server { _baseStats, _dynamicStats?, _holdingCostRequirements?, ...flatStats }.
     * @private
     */
    _renderItemStats(panel, stats) {
        const isEquipped = stats._isEquipped;
        const baseStats = stats._baseStats && Object.keys(stats._baseStats).length > 0 ? stats._baseStats : {};
        const dynamicStats = isEquipped && stats._dynamicStats && Object.keys(stats._dynamicStats).length > 0 ? stats._dynamicStats : {};
        const holdingCostRequirements = isEquipped && stats._holdingCostRequirements && stats._holdingCostRequirements.length > 0 ? stats._holdingCostRequirements : [];

        if (Object.keys(baseStats).length === 0 && Object.keys(dynamicStats).length === 0 && holdingCostRequirements.length === 0) {
            panel.innerHTML = '<div class="stats-empty">No stats available for this item.</div>';
            return;
        }

        let html = '';

        // Section: Stats (merged base + dynamic into unified list)
        if (Object.keys(baseStats).length > 0 || Object.keys(dynamicStats).length > 0) {
            html += '<div class="stats-section">';
            html += '<div class="stats-section-title">📊 Stats</div>';
            html += '<div class="stats-grid">';

            // Collect all unique stat names from both base and dynamic
            const allStatNames = new Set([...Object.keys(baseStats), ...Object.keys(dynamicStats)]);

            for (const statName of allStatNames) {
                const baseValue = baseStats[statName];
                const dynamicValue = dynamicStats[statName];
                const hasBoth = typeof baseValue === 'number' && typeof dynamicValue === 'number';

                let displayValue;
                let valueClass = 'stats-value';

                if (hasBoth) {
                    // Show merged: current / max (percentage%)
                    const ratio = baseValue !== 0 ? Math.abs(dynamicValue / baseValue) * 100 : 0;
                    const percentage = Math.round(Math.min(ratio, 999) * 10) / 10;
                    displayValue = `${dynamicValue} / ${baseValue} (${percentage}%)`;

                    // Red if below 100%, green if at 100%, yellow if between 50-100%
                    if (dynamicValue < 0) {
                        valueClass = 'stats-value negative';
                    } else if (ratio < 100) {
                        valueClass = 'stats-value warning';
                    } else {
                        valueClass = 'stats-value healthy';
                    }
                } else if (typeof dynamicValue === 'number') {
                    // Only dynamic (no base) — show dynamic value
                    displayValue = dynamicValue;
                    if (dynamicValue < 0) valueClass = 'stats-value negative';
                } else {
                    // Only base — show base value
                    displayValue = baseValue;
                }

                html += `
                    <div class="stats-entry">
                        <span class="stats-name">${this._formatStatName(statName)}</span>
                        <span class="${valueClass}">${displayValue}</span>
                    </div>`;
            }

            html += '</div></div>';
        }

        // Section: Holding Cost Requirements (shown when equipped)
        if (holdingCostRequirements.length > 0) {
            html += '<div class="stats-section">';
            html += '<div class="stats-section-title">🔒 Holding Cost Requirements</div>';
            html += '<div class="stats-grid">';
            for (const req of holdingCostRequirements) {
                html += `
                    <div class="stats-entry">
                        <span class="stats-name">${this._formatStatName(req.stat)}</span>
                        <span class="stats-value">≥${req.value}</span>
                    </div>`;
            }
            html += '</div></div>';
        }

        // Show equipped badge if equipped
        if (isEquipped) {
            html += '<div class="stats-equipped-badge">⚔️ Equipped</div>';
        }

        panel.innerHTML = html;
    }

    /**
     * Formats a camelCase/kebab-case stat name to readable format.
     * @param {string} name - The stat name.
     * @returns {string}
     * @private
     */
    _formatStatName(name) {
        return name
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/-/g, ' ')
            .replace(/^./, str => str.toUpperCase());
    }

    /**
     * Handles world state changes - re-renders if entity items changed.
     * Also refreshes any open stats panels for equipped items so live stat changes
     * (e.g., sharpness drain) are reflected without closing the panel.
     * @private
     */
    async _onWorldStateChange() {
        if (!this._overlay || this._overlay.style.display !== 'block') return;
        if (!this._currentEntityId) return;

        // If we're viewing inventory, re-render to show any changes
        await this._loadEntityItems(this._currentEntityId).catch((err) => {
            ClientLogger.warn('InventoryManager', ' Failed to refresh inventory on state change:', err);
        });
        this._renderInventory();

        // Refresh any open stats panels for equipped items so live stat changes
        // (e.g., sharpness drain from cut action) are reflected immediately.
        await this._refreshOpenStatsPanels();
    }

    /**
     * Refreshes stats data for all currently visible (open) stats panels on equipped items.
     * Used to update live stats after world state changes (e.g., sharpness drain).
     * @returns {Promise<void>}
     * @private
     */
    async _refreshOpenStatsPanels() {
        if (!this._currentEntityId) return;

        // Find all open stats panels (display !== 'none')
        const panels = this._content?.querySelectorAll('.inventory-item-stats-panel[style*="display: block"]') || [];

        for (const panel of panels) {
            const itemId = panel.dataset.itemId;
            if (!itemId) continue;

            // Only refresh if the item is equipped (search by itemId)
            if (!this._isEquippedByItemId(itemId)) continue;

            try {
                const response = await fetch(`/inventory/${this._currentEntityId}/item-stats/${itemId}`);
                if (!response.ok) continue;

                const data = await response.json();
                if (data.success && data.stats) {
                    this._renderItemStats(panel, data.stats);
                }
            } catch {
                // Silently ignore errors for panel refresh — don't break the UI
            }
        }
    }

    // =========================================================================
    // NESTED INVENTORY — CONTAINER METHODS
    // =========================================================================

    /**
     * Toggles the expanded/collapsed state of a container.
     * @param {string} containerItemId - The container item ID.
     * @private
     */
    _toggleContainer(containerItemId) {
        this._containerExpanded[containerItemId] = !this._containerExpanded[containerItemId];
        const isExpanded = this._containerExpanded[containerItemId];

        // Find the container items div to toggle visibility
        const containerItemsEl = this._content?.querySelector(`[data-container-items="${containerItemId}"]`);
        if (containerItemsEl) {
            containerItemsEl.style.display = isExpanded ? 'block' : 'none';
        }

        // Find the toggle button inside the header to update the chevron
        const headerEl = this._content?.querySelector(`[data-container-header="${containerItemId}"]`);
        if (headerEl) {
            const toggleBtn = headerEl.querySelector('.inventory-container-toggle');
            if (toggleBtn) {
                toggleBtn.textContent = isExpanded ? '\u25BC' : '\u25B6';
            }
        }
    }

    /**
     * Updates the visual state of a container toggle without full re-render.
     * @param {string} containerItemId - The container item ID.
     * @param {boolean} isExpanded - Whether the container should be expanded.
     * @private
     */
    _toggleContainerVisual(containerItemId, isExpanded) {
        const containerItemsEl = this._content?.querySelector(`[data-container-items="${containerItemId}"]`);
        if (containerItemsEl) {
            containerItemsEl.style.display = isExpanded ? 'block' : 'none';
        }
    }

    /**
     * Get direct children of a container from the current items tree.
     * @param {string} parentId - Container item ID or component ID
     * @returns {Array}
     * @private
     */
    _getChildrenFromTree(parentId) {
        // For component ID: get from _currentItems[parentId]
        if (isPrefixed(parentId, ID_PREFIXES.COMPONENT)) {
            return this._currentItems[parentId] || [];
        }
        // For item ID: find the item in the tree and get its children
        const allItems = [];
        for (const items of Object.values(this._currentItems)) {
            allItems.push(...items);
        }
        const findWithChildren = (items) => {
            for (const item of items) {
                if (item.id === parentId) return item.children || [];
                if (item.children) {
                    const found = findWithChildren(item.children);
                    if (found) return found;
                }
            }
            return null;
        };
        const result = findWithChildren(allItems);
        return result || [];
    }

    /**
     * Checks if a dragged item can fit in a container.
     * @param {string} containerItemId - The container item ID.
     * @param {string} draggedItemId - The dragged item ID.
     * @returns {boolean}
     * @private
     */
    _checkItemFitInContainer(containerItemId, draggedItemId) {
        // Get the dragged item volume from the card (already uses externalVolume via displayVolume)
        const draggedCard = this._content?.querySelector(`[data-item-id="${draggedItemId}"]`);
        if (!draggedCard) return false;
        const draggedVolume = parseInt(draggedCard.dataset.itemVolume) || 0;

        // Get the container item internal capacity from the slot
        const containerSlot = this._content?.querySelector(`[data-item-id="${containerItemId}"]`);
        if (!containerSlot) return false;
        const containerVolume = parseInt(containerSlot.dataset.containerCapacity) || 0;

        // Get current children volume for this container (children use their own externalVolume for internal space)
        const currentChildren = this._getChildrenFromTree(containerItemId);
        const usedVolume = currentChildren.reduce((sum, i) => sum + (i.externalVolume ?? i.hostVolume ?? DEFAULT_ITEM_VOLUME), 0);

        return (usedVolume + draggedVolume) <= containerVolume;
    }

    /**
     * Handles dropping an item onto a container item.
     * @param {DragEvent} e - The drag event.
     * @param {string} containerItemId - The container item ID.
     * @param {string} itemId - The item ID being dropped.
     * @private
     */
    async _onContainerDrop(e, containerItemId, itemId) {
        if (!this._currentEntityId) return;
        if (itemId === containerItemId) return; // Prevent self-drop

        try {
            const response = await fetch(`/inventory/${this._currentEntityId}/container/${containerItemId}/move-in/${itemId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                this._showToast(result.message || 'Failed to move item into container', 'error');
                return;
            }

            this._showToast('Item moved into container', 'success');

            // Expand the container
            this._containerExpanded[containerItemId] = true;
            this._toggleContainerVisual(containerItemId, true);

            // Reload and re-render
            await this._loadEntityItems(this._currentEntityId);
            this._renderInventory();

        } catch (error) {
            ClientLogger.error('InventoryManager', ' Error moving item into container:', error);
            this._showToast('Failed to move item into container', 'error');
        }
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