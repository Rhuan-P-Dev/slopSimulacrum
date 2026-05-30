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

        this._renderComponentGrid(entity, state);
        this._lastComponentId = entity.components?.[0]?.id || null;
        this.overlay.style.display = 'block';

    }

    /**
     * Hides the component viewer overlay.
     */
    hide() {
        if (this.overlay) {
            this.overlay.style.display = 'none';
        }
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
     * Renders the component grid inside the overlay content.
     * @param {Object} entity - The active droid entity.
     * @param {Object} state - The complete world state.
     * @private
     */
    async _renderComponentGrid(entity, state) {
        if (!this._content) return;

        const instances = state?.components?.instances || {};

        // Internal components are stored directly on the entity object as entity.internalComponents
        // { [hostComponentId]: [internalComponentInstances] }
        // This is the same source that the map's internal component rendering uses.
        // We must NOT use state.internalComponents[entity.id] because that structure may not
        // be synchronized with the entity object's internalComponents property.
        const entityInternalComponents = entity?.internalComponents || {};

        let html = '<div class="component-viewer-grid">';

        for (const comp of entity.components) {
            const stats = instances[comp.id] || {};
            const statsHtml = this._renderStatsAsBadges(stats, comp.id);

            // Check if this component has internal components from the entity object
            const compInternalComps = entityInternalComponents[comp.id] || [];
            const hasInternalComps = compInternalComps.length > 0;

            html += `
                <div class="component-card" data-comp-id="${comp.id}">
                    <div class="component-card-header">
                        <span class="component-card-type">${comp.type}</span>
                        <span class="component-card-id" style="color: var(--text-dim); font-size: 0.8em;">${comp.identifier}</span>
                        ${hasInternalComps ? `<button class="component-internal-btn" data-comp-id="${comp.id}" title="View internal components" style="background: var(--neon-cyan); color: var(--bg-black); border: none; padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 0.85em; margin-left: 4px;">🔮</button>` : ''}
                        <button class="component-add-stat-btn" data-comp-id="${comp.id}" title="Add stat bar from this component" style="background: var(--neon-green); color: var(--bg-black); border: none; padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 0.85em; margin-left: 4px;">➕</button>
                    </div>
                    <div class="component-card-stats">
                        ${statsHtml || '<em style="color: var(--text-dim); font-size: 0.8em;">No stats</em>'}
                    </div>
                    ${hasInternalComps ? `<div class="component-internal-container" data-comp-id="${comp.id}" style="display: none;"></div>` : ''}
                </div>`;
        }

        html += '</div>';
        this._content.innerHTML = html;

        // Attach event listeners for the add-stat buttons
        this._content.querySelectorAll('.component-add-stat-btn').forEach((btn) => {
            btn.onclick = (e) => {
                e.stopPropagation();
                this._onAddStatFromComponent(btn.dataset.compId);
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
            html += `<div style="margin-top: 6px; margin-bottom: 2px; color: var(--neon-green); font-size: 0.8em; font-weight: bold;">${trait}:</div>`;
            for (const [stat, value] of Object.entries(properties)) {
                html += `<span class="component-stat-clickable"
                    data-trait="${trait}"
                    data-stat="${stat}"
                    data-value="${value}"
                    data-comp-id="${componentId}"
                    title="Click to add as stat bar">${this._formatStatKey(trait, stat)}: ${value}</span> `;
            }
        }

        return html;
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
     * Gets a human-readable description for an internal component type.
     * @param {string} type - The internal component type.
     * @returns {string} Description string.
     * @private
     */
    _getInternalComponentDescription(type) {
        // Description is always generic — registry lookup removed as dead code
        return 'Passive internal component.';
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
                    const response = await fetch(`/api/internal-components/${this._currentEntityId}/${componentId}`);
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
            container.innerHTML = '<div class="internal-components-empty"><em style="color: var(--text-dim); font-size: 0.85em;">No internal components</em></div>';
            container.style.display = 'block';
            return;
        }

        let html = '<div class="internal-components-list">';

        for (const ic of internalComps) {
            const description = this._getInternalComponentDescription(ic.type);
            const typeLabel = this._formatInternalComponentType(ic.type);

            html += `
                <div class="internal-component-detail-card">
                    <div class="internal-component-header">
                        <span class="internal-component-type-badge">${typeLabel}</span>
                        <span class="internal-component-host" style="color: var(--text-dim); font-size: 0.8em;">Host: ${ic.hostComponentType || 'unknown'}</span>
                    </div>
                    <div class="internal-component-description">${description}</div>
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
        // Convert camelCase to readable format: durabilityRepairSphere → Durability Repair Sphere
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
