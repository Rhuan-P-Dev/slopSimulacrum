/**
 * ComponentViewer
 * Manages the 🗿️ component viewer overlay panel.
 * Displays all components of the active droid as clickable cards with stat badges.
 * Each card has a ➕ button to add a stat bar for that specific component.
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
        /** @private {HTMLElement|null} */
        this._overlay = null;
        /** @private {HTMLElement|null} */
        this._content = null;
        /** @private {string|null} */
        this._lastComponentId = null;
    }

    /**
     * Initializes the component viewer overlay DOM element.
     */
    init() {
        this._overlay = document.getElementById('component-viewer-overlay');
        this._content = document.getElementById('component-viewer-content');
    }

    /**
     * Shows the component viewer overlay with the given entity and state.
     * @param {Object} entity - The active droid entity.
     * @param {Object} state - The complete world state.
     */
    show(entity, state) {
        if (!this._overlay) return;

        if (!entity || !entity.components) {
            this._content.innerHTML = '<em style="color: var(--text-dim);">No components found for this entity.</em>';
            this._overlay.style.display = 'block';
            return;
        }

        this._renderComponentGrid(entity, state);
        this._lastComponentId = entity.components?.[0]?.id || null;
        this._overlay.style.display = 'block';
    }

    /**
     * Hides the component viewer overlay.
     */
    hide() {
        if (this._overlay) {
            this._overlay.style.display = 'none';
        }
    }

    /**
     * Toggles the component viewer overlay.
     * @param {Object} entity - The active droid entity.
     * @param {Object} state - The complete world state.
     */
    toggle(entity, state) {
        if (this._overlay && this._overlay.style.display === 'block') {
            this.hide();
        } else {
            this.show(entity, state);
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
     * Renders the component grid inside the overlay content.
     * @param {Object} entity - The active droid entity.
     * @param {Object} state - The complete world state.
     * @private
     */
    _renderComponentGrid(entity, state) {
        if (!this._content) return;

        const instances = state?.components?.instances || {};

        let html = '<div class="component-viewer-grid">';

        for (const comp of entity.components) {
            const stats = instances[comp.id] || {};
            const statsHtml = this._renderStatsAsBadges(stats, comp.id);

            html += `
                <div class="component-card" data-comp-id="${comp.id}">
                    <div class="component-card-header">
                        <span class="component-card-type">${comp.type}</span>
                        <span class="component-card-id" style="color: var(--text-dim); font-size: 0.8em;">${comp.identifier}</span>
                        <button class="component-add-stat-btn" data-comp-id="${comp.id}" title="Add stat bar from this component" style="background: var(--neon-green); color: var(--bg-black); border: none; padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 0.85em; margin-left: 8px;">➕</button>
                    </div>
                    <div class="component-card-stats">
                        ${statsHtml || '<em style="color: var(--text-dim); font-size: 0.8em;">No stats</em>'}
                    </div>
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
     * Gets the display value of a stat from a component's stats object.
     * @param {string} trait - The trait name.
     * @param {string} stat - The stat key.
     * @param {Object} stats - The stats object.
     * @returns {number|string} The stat value.
     * @private
     */
    _getStatDisplayValue(trait, stat, stats) {
        if (!stats || !stats[trait] || stats[trait][stat] === undefined) return 0;
        return stats[trait][stat];
    }

    /**
     * Handles a stat click - opens the add stat dialog pre-filled.
     * @param {string} trait - The trait name.
     * @param {string} stat - The stat key.
     * @param {number} value - The current stat value (suggested max).
     * @param {string} componentId - The component instance ID.
     * @private
     */
    _onStatClick(trait, stat, value, componentId) {
        this._statBarsManager.openAddDialog({
            componentId,
            trait,
            stat,
            max: value,
            label: '',
            color: '',
        });
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