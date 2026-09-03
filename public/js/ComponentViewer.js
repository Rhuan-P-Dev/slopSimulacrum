/**
 * ComponentViewer
 * Manages the 🗿️ component viewer overlay panel.
 * Displays all components of the active droid as clickable cards with stat badges.
 * Each card has a ➕ button to add a stat bar for that specific component.
 * Each card has a 🔮 button to expand/collapse internal components.
 * Clicking a stat badge opens the StatBarsManager's add dialog pre-filled with that trait/stat.
 *
 * @module ComponentViewer
 */
import MaterialRegistry from './MaterialRegistry.js';
import ClientLogger from '/utils/ClientLogger.js';
import { directChildrenOf, escapeHtml } from '/utils/ItemTree.js';

/**
 * Maximum containment depth rendered for a droid's carried items. Guards
 * against pathological/cyclic data that would otherwise recurse without bound;
 * real loadouts are far shallower, so the cap is purely defensive.
 */
const MAX_ITEM_NESTING_DEPTH = 12;

/**
 * Collects the set of item IDs currently equipped on an entity.
 * @param {Object} entity - The entity object (may have an `equipped` array).
 * @returns {Set<string>} The equipped item IDs (empty set when none).
 */
export function getEquippedItemIds(entity) {
    const equipped = entity && Array.isArray(entity.equipped) ? entity.equipped : [];
    const ids = new Set();
    for (const entry of equipped) {
        if (entry && entry.itemId) ids.add(entry.itemId);
    }
    return ids;
}

/**
 * Renders the read-only item list for the items directly hosted on a component.
 * Uses the flat per-entity items model: an item's children are the flat items
 * whose hostComponentId equals the item's own id (see directChildrenOf). The
 * result is a pure HTML string — it never mutates the shared item instances,
 * so it can be called on live world-state data safely.
 * @param {Array<Object>} flatItems - The entity's flat items array.
 * @param {string} hostComponentId - The component to render hosted items for.
 * @param {Set<string>|string[]} equippedItemIds - IDs of currently equipped items.
 * @returns {string} HTML string ('' when the host carries no items).
 */
export function renderHostedItemsHtml(flatItems, hostComponentId, equippedItemIds) {
    const allItems = Array.isArray(flatItems) ? flatItems : [];
    const equippedSet = equippedItemIds instanceof Set
        ? equippedItemIds
        : new Set(Array.isArray(equippedItemIds) ? equippedItemIds : []);
    const topItems = directChildrenOf(hostComponentId, allItems);
    if (topItems.length === 0) return '';
    const rows = topItems
        .map((item) => renderReadOnlyItemRow(item, allItems, equippedSet, 0))
        .join('');
    return `<div class="cv-items">${rows}</div>`;
}

/**
 * Renders a single carried item (and its nested container contents) read-only.
 * @param {Object} item - The item instance.
 * @param {Array<Object>} allItems - The full flat items array (for child lookup).
 * @param {Set<string>} equippedSet - Equipped item IDs.
 * @param {number} depth - Current nesting depth (0 = top-level on a component).
 * @returns {string} HTML string.
 * @private
 */
function renderReadOnlyItemRow(item, allItems, equippedSet, depth) {
    if (!item || !item.id) return '';
    const name = item.name || item.type || 'unknown';
    const isEquipped = equippedSet.has(item.id);
    const children = depth < MAX_ITEM_NESTING_DEPTH ? directChildrenOf(item.id, allItems) : [];
    const rowClass = ['cv-item', isEquipped ? 'cv-item-equipped' : '', depth > 0 ? 'cv-item-nested' : '']
        .filter(Boolean)
        .join(' ');
    let html = `<div class="${rowClass}" data-cv-item="${escapeHtml(item.id)}">`;
    html += `<span class="cv-item-name">${isEquipped ? '⚔️ ' : ''}${escapeHtml(name)}</span>`;
    if (item.type && item.type !== name) {
        html += `<span class="cv-item-type">${escapeHtml(item.type)}</span>`;
    }
    html += `</div>`;
    if (children.length > 0) {
        const nested = children
            .map((child) => renderReadOnlyItemRow(child, allItems, equippedSet, depth + 1))
            .join('');
        html += `<div class="cv-item-children">${nested}</div>`;
    }
    return html;
}

export class ComponentViewer {
    /**
     * Creates a new ComponentViewer.
     * @param {import('./UIManager.js').UIManager} uiManager - The UIManager instance.
     * @param {import('./StatBarsManager.js').StatBarsManager} statBarsManager - The StatBarsManager instance.
     */
    constructor(uiManager, statBarsManager) {
        /** @private */
        this._uiManager = uiManager;
        /** @private */
        this._statBarsManager = statBarsManager;
        /** @private {Function|null} Optional callback when a component is clicked for pick-up */
        this._onPickUpComponentClick = null;
        /** @private {Function|null} Optional callback invoked when the panel is hidden */
        this._onHide = null;
        /** @public {HTMLElement|null} */
        this.overlay = null;
        /** @private {HTMLElement|null} */
        this._content = null;
        /** @private {string|null} */
        this._lastComponentId = null;
        /** @private {string|null} */
        this._currentEntityId = null;
        /** @private {Object|null} */
        this._currentEntity = null;
        /** @private {Object<string, Object>} */
        this._internalComponentCache = {};
        /** @private {Object<string, boolean>} */
        this._expandedInternalComponents = {};
        /** @private {number} Render generation for stale-write prevention */
        this._renderGeneration = 0;
    }

    /**
     * Initializes the component viewer overlay DOM element and attaches close button listener.
     */
    init() {
        this.overlay = document.getElementById('component-viewer-overlay');
        this._content = document.getElementById('component-viewer-content');

        // Attach close button listener
        if (this.overlay) {
            const closeBtn = this.overlay.querySelector('.overlay-close-btn');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => this.hide());
            }
        }
    }

    /**
     * Shows the component viewer overlay with the given data.
     * @param {Object} [data] - Data object { entity, state } or legacy positional args.
     */
    async show(data) {
        if (!this.overlay) return;

        // Support both { entity, state } data object and legacy (entity, state) calls
        const entity = data?.entity || (data && arguments[0]);
        const state = data?.state || (data && arguments[1]);

        if (!entity || !entity.components) {
            this._content.innerHTML = '<em style="color: var(--text-dim);">No components found for this entity.</em>';
            this.overlay.style.display = 'block';
            return;
        }

        // Store entity reference for internal component access
        // Using the same entity object ensures we read the same internalComponents source
        this._currentEntityId = entity.id;
        this._currentEntity = entity;
        // Reset cache and expanded state
        this._internalComponentCache = {};
        this._expandedInternalComponents = {};

        this._renderGeneration = (this._renderGeneration || 0) + 1;
        this._renderComponentGrid(entity, state).catch((error) => {
            ClientLogger.error('ComponentViewer', `Failed to render component grid: ${error.message}`);
        });
        this._lastComponentId = entity.components?.[0]?.id || null;
        this.overlay.style.display = 'block';

    }

    /**
     * Hides the component viewer overlay and notifies the registered hide callback, if any.
     */
    hide() {
        if (this.overlay) {
            this.overlay.style.display = 'none';
        }
        this._renderGeneration = (this._renderGeneration || 0) + 1;
        if (this._onHide) this._onHide();
    }

    /**
     * Toggles the component viewer overlay.
     * @param {Object} [data] - Optional data object { entity, state }.
     */
    toggle(data) {
        if (this.overlay && this.overlay.style.display === 'block') {
            this.hide();
        } else {
            this.show(data);
        }
    }

    /**
     * Gets the last displayed component ID.
     * @returns {string|null}
     */
    getActiveComponentId() {
        return this._lastComponentId;
    }

    /**
     * Sets the callback for when a component card is clicked during pick-up flow.
     * @param {Function} callback - Called with (componentId, entity)
     */
    setPickUpComponentCallback(callback) {
        this._onPickUpComponentClick = callback;
    }

    /**
     * Sets the callback invoked whenever the panel is hidden (close button,
     * Escape/backdrop/exclusive close — all funnel through hide()). Used by
     * the orchestrator to clear its one-shot "inspected entity" stash.
     * @param {Function} callback - Called with no arguments when hide() runs.
     */
    setHideCallback(callback) {
        this._onHide = callback;
    }

    /**
     * Renders the component grid inside the overlay content.
     * @param {Object} entity - The active droid entity.
     * @param {Object} state - The complete world state.
     * @private
     */
   async _renderComponentGrid(entity, state) {
       const generation = this._renderGeneration;

       if (!this._content) return;

       // Ensure material registry is loaded for badge rendering
       await MaterialRegistry.ensureLoaded();

       // Abort if superseded by a newer show()/hide() call
       if (generation !== this._renderGeneration) return;

       // Preserve scroll position of the actual scrollable container (the overlay panel)
       const previousScrollTop = this.overlay ? this.overlay.scrollTop : 0;

       const instances = state?.components?.instances || {};

       // Internal components are stored directly on the entity object as entity.internalComponents
       // { [hostComponentId]: [internalComponentInstances] }
       // This is the same source that the map's internal component rendering uses.
       // We must NOT use state.internalComponents[entity.id] because that structure may not
       // be synchronized with the entity object's internalComponents property.
       const entityInternalComponents = entity?.internalComponents || {};

       // Read-only carried-items view: read the entity's flat items array and
       // its equipped set straight from world state (never mutated). Items are
       // grouped per host component below, mirroring the server's flat/
       // polymorphic-host model (see ItemTree.directChildrenOf).
       const entityItems = Array.isArray(entity.items) ? entity.items : [];
       const equippedItemIds = getEquippedItemIds(entity);
       const carriedSummary = entityItems.length > 0
           ? `<div class="component-viewer-items-summary">🎒 Carried items (${entityItems.length})</div>`
           : '';

       let html = carriedSummary + '<div class="component-viewer-grid">';

       for (const comp of entity.components) {
           const stats = instances[comp.id] || {};
           const statsHtml = this._renderStatsAsBadges(stats, comp.id);
           const materialBadges = MaterialRegistry.formatBadges(comp.type);

           // Check if this component has internal components from the entity object
           const compInternalComps = entityInternalComponents[comp.id] || [];
           const hasInternalComps = compInternalComps.length > 0;
           // Read-only items hosted on this component (nested contents included).
           const compItemsHtml = renderHostedItemsHtml(entityItems, comp.id, equippedItemIds);

           html += `
               <div class="component-card" data-comp-id="${comp.id}">
                   <div class="component-card-header">
                       <span class="component-card-type">${comp.type}</span>
                       <span class="component-card-id">${comp.identifier}</span>
                       ${hasInternalComps ? `<button class="component-internal-btn" data-comp-id="${comp.id}" title="View internal components">🔮</button>` : ''}
                       <button class="component-add-stat-btn" data-comp-id="${comp.id}" title="Add stat bar from this component">➕</button>
                   </div>
                   ${materialBadges ? `<div class="component-materials-row">${materialBadges}</div>` : ''}
                   <div class="component-card-stats">
                       ${statsHtml || '<em class="component-stats-placeholder">No stats</em>'}
                   </div>
                   ${hasInternalComps ? `<div class="component-internal-container" data-comp-id="${comp.id}" style="display: none;"></div>` : ''}
                   ${compItemsHtml ? `<div class="component-card-items">${compItemsHtml}</div>` : ''}
               </div>`;
       }

       html += '</div>';
       this._content.innerHTML = html;

       // Restore scroll position on the overlay, clamped to the new scroll height
       if (this.overlay) {
           this.overlay.scrollTop = Math.min(previousScrollTop, this.overlay.scrollHeight);
       }

       // Attach event listeners for the add-stat buttons
       this._content.querySelectorAll('.component-add-stat-btn').forEach((btn) => {
           btn.onclick = (e) => {
               e.stopPropagation();
               this._onAddStatFromComponent(btn.dataset.compId);
           };
       });

       // Attach click listeners to stat badges to open add dialog pre-filled with that stat's current value
       this._content.querySelectorAll('.component-stat-clickable').forEach((badge) => {
           badge.onclick = (e) => {
               e.stopPropagation();
               this._statBarsManager.openAddDialog({
                   componentId: badge.dataset.compId,
                   trait: badge.dataset.trait,
                   stat: badge.dataset.stat,
                   max: parseFloat(badge.dataset.value) || 0,
                   label: `${this._getComponentLabel(badge.dataset.compId)}.${badge.dataset.trait}.${badge.dataset.stat}`,
                   color: '',
               });
           };
       });

       // Attach event listeners for the internal component buttons
       this._content.querySelectorAll('.component-internal-btn').forEach((btn) => {
           btn.onclick = (e) => {
               e.stopPropagation();
               this._onToggleInternalComponents(btn.dataset.compId, entity.internalComponents);
           };
       });

       // Attach click listener to component cards for pick-up flow
       this._content.querySelectorAll('.component-card').forEach((card) => {
           card.onclick = (e) => {
               // Don't trigger if clicking a button
               if (e.target.tagName === 'BUTTON') return;
               const compId = card.dataset.compId;
               if (compId && this._onPickUpComponentClick) {
                   this._onPickUpComponentClick(compId, entity);
               }
           };
       });

       // Attach trait label hover/click interaction listeners
       this._attachTraitInteractionListeners();
   }

    /**
     * Renders stats as clickable badges.
     * @param {Object} stats - The stats object for a component.
     * @param {string} componentId - The component instance ID.
     * @returns {string} HTML string.
     * @private
     */
    _renderStatsAsBadges(stats, componentId) {
        let html = '';

        for (const [trait, properties] of Object.entries(stats)) {
            html += `<div class="trait-group">`;
            html += `<div class="trait-label">${trait}:</div>`;
            html += `<div class="trait-stats collapsed">`;
            for (const [stat, value] of Object.entries(properties)) {
                html += `<span class="component-stat-clickable"
                    data-trait="${trait}"
                    data-stat="${stat}"
                    data-value="${value}"
                    data-comp-id="${componentId}"
                    title="Click to add as stat bar">${this._formatStatKey(trait, stat)}: ${value}</span> `;
            }
            html += `</div>`;
            html += `</div>`;
        }

        return html;
    }

    /**
     * Attaches hover and click event listeners to trait labels for
     * toggling stats visibility. Stats start hidden by default.
     * Hovering temporarily shows stats, clicking pins them open,
     * and clicking again unpins and hides them.
     * @private
     */
    _attachTraitInteractionListeners() {
        this._content.querySelectorAll('.trait-label').forEach((label) => {
            const traitGroup = label.closest('.trait-group');
            if (!traitGroup) return;

            const statsContainer = traitGroup.querySelector('.trait-stats');
            if (!statsContainer) return;

            // Hover: temporarily show stats
            label.addEventListener('mouseenter', () => {
                statsContainer.classList.remove('collapsed');
            });

            // Mouse leave: hide stats again unless trait is pinned
            label.addEventListener('mouseleave', () => {
                if (!traitGroup.classList.contains('pinned')) {
                    statsContainer.classList.add('collapsed');
                }
            });

            // Click: toggle pinned state on the trait-group container
            label.addEventListener('click', (e) => {
                e.stopPropagation();
                const isPinned = traitGroup.classList.toggle('pinned');
                if (isPinned) {
                    statsContainer.classList.remove('collapsed');
                } else {
                    statsContainer.classList.add('collapsed');
                }
            });
        });
    }

    /**
     * Handles the ➕ button click on a component card - opens the add stat dialog
     * pre-filtered to only that component's traits/stats.
     * @param {string} componentId - The component instance ID.
     * @private
     */
    _onAddStatFromComponent(componentId) {
        const state = this._uiManager._worldStateManager?.getState() || null;
        const instances = state?.components?.instances || {};
        const compStats = instances[componentId] || {};

        // Pre-fill with the first available trait/stat from this component
        let firstTrait = null;
        let firstStat = null;
        let firstValue = 0;

        for (const [trait, properties] of Object.entries(compStats)) {
            for (const [stat, value] of Object.entries(properties)) {
                firstTrait = trait;
                firstStat = stat;
                firstValue = value;
                break;
            }
            if (firstTrait) break;
        }

        this._statBarsManager.openAddDialog({
            componentId,
            trait: firstTrait,
            stat: firstStat,
            max: firstValue,
            label: `${this._getComponentLabel(componentId)}.${firstTrait}.${firstStat}`,
            color: '',
        });
    }

    /**
     * Formats a trait.stat key.
     * @param {string} trait - The trait name.
     * @param {string} stat - The stat key.
     * @returns {string} Formatted key.
     * @private
     */
    _formatStatKey(trait, stat) {
        return `${trait}.${stat}`;
    }

    /**
     * Handles the 🔮 button click — toggles internal components panel.
     * Uses the entity internalComponents reference passed from _renderComponentGrid
     * to ensure we read from the same source that rendered the 🔮 button.
     * Falls back to API fetch if entity reference is not available.
     * @param {string} componentId - The host component ID.
     * @param {Object} [entityInternalComponents] - Optional direct reference to entity.internalComponents.
     * @private
     */
    async _onToggleInternalComponents(componentId, entityInternalComponents) {
        const container = this._content.querySelector(`.component-internal-container[data-comp-id="${componentId}"]`);
        if (!container) return;

        const isExpanded = this._expandedInternalComponents[componentId];

        if (isExpanded) {
            // Collapse
            this._expandedInternalComponents[componentId] = false;
            container.style.display = 'none';
            return;
        }

        // Expand
        this._expandedInternalComponents[componentId] = true;

        let internalComps = [];

        // Check cache first
        if (this._internalComponentCache[componentId]) {
            internalComps = this._internalComponentCache[componentId];
        } else {
            // Use the entity internalComponents reference passed from the button click handler
            // This guarantees we read from the same source that _renderComponentGrid used
            if (entityInternalComponents && Array.isArray(entityInternalComponents[componentId])) {
                internalComps = entityInternalComponents[componentId];
                this._internalComponentCache[componentId] = internalComps;
            } else {
                // Fall back to API fetch if entity reference not available
                try {
                    // Phase 4: /api prefix removed — internal component routes now
                    // follow the same unprefixed API convention as every other endpoint
                    // (see src/routes/index.js).
                    const response = await fetch(`/internal-components/${this._currentEntityId}/${componentId}`);
                    if (response.ok) {
                        internalComps = await response.json();
                        this._internalComponentCache[componentId] = internalComps;
                    } else {
                        // API returned error — cache empty to prevent repeated fetches
                        this._internalComponentCache[componentId] = [];
                    }
                } catch (error) {
                    // Fetch failed — cache empty to prevent repeated attempts
                    this._internalComponentCache[componentId] = [];
                }
            }
        }

        this._renderInternalComponentPanel(container, componentId, internalComps);
    }

    /**
     * Renders the internal components panel for a host component.
     * @param {HTMLElement} container - The container element.
     * @param {string} hostComponentId - The host component ID.
     * @param {Array} internalComps - Array of internal component instances.
     * @private
     */
    _renderInternalComponentPanel(container, hostComponentId, internalComps) {
        if (!container || !internalComps || internalComps.length === 0) {
            container.innerHTML = '<div class="internal-components-empty"><em>No internal components</em></div>';
            container.style.display = 'block';
            return;
        }

        let html = '<div class="internal-components-list">';

        for (const ic of internalComps) {
            const description = ic.description || "Error";
            const typeLabel = this._formatInternalComponentType(ic.type);
            const selfExistence = ic.instanceStats?.Physical?.existence;

            html += `
                <div class="internal-component-detail-card">
                    <div class="internal-component-header">
                        <span class="internal-component-type-badge">${typeLabel}</span>
                        <span class="internal-component-host">Host: ${ic.hostComponentType || 'unknown'}</span>
                    </div>
                    <div class="internal-component-description">${description}</div>
                    ${typeof selfExistence === 'number' ? `<div class="internal-component-meta">Existence: ${selfExistence}${ic.broken ? ' (broken)' : ''}</div>` : ''}
                    ${ic.id ? `<div class="internal-component-meta">ID: ${ic.id.substring(0, 12)}...</div>` : ''}
                    ${ic.installedAt ? `<div class="internal-component-meta">Installed: ${new Date(ic.installedAt).toLocaleString()}</div>` : ''}
                </div>`;
        }

        html += '</div>';
        container.innerHTML = html;
        container.style.display = 'block';
    }

    /**
     * Formats an internal component type into a readable label.
     * @param {string} type - The internal component type.
     * @returns {string} Formatted label.
     * @private
     */
    _formatInternalComponentType(type) {
        // Convert camelCase to readable format: repairSphere → Repair Sphere
        const formatted = type
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/^./, str => str.toUpperCase());
        return formatted;
    }

    /**
     * Gets a display label for a component ID.
     * @param {string} componentId - The component instance ID.
     * @returns {string} A readable label.
     * @private
     */
    _getComponentLabel(componentId) {
        // Try to extract a meaningful label from the component ID
        // e.g., "droidArm-left-abc123" → "droidArm-left"
        const parts = componentId.split('-');
        if (parts.length > 1) {
            return parts.slice(0, -1).join('-');
        }
        return componentId.substring(0, 8);
    }
}
