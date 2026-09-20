/**
 * EntityAttributeBars — renders WHOLE-ENTITY attributes as bars.
 *
 * Distinct from StatBarsManager (per-component stat bars, user-configured):
 * this renders the attributes an entity declares on itself — currently the M1
 * droid's `Physical.energy` — in a dedicated section below the stat-bars panel.
 * It reads from the entity's `attributes` (live) + `attributesConfig`
 * (declaration) that ride on the entity in the broadcast world state, and only
 * renders attributes that have a display entry in ATTRIBUTE_DISPLAY
 * (EntityAttributeData.js), so it is data-driven end to end.
 *
 * @module EntityAttributeBars
 */
import {
    ATTRIBUTE_DISPLAY,
    getEntityAttribute,
    getEntityAttributeDeclarations,
    flatAttributeKey,
} from './EntityAttributeData.js';

/**
 * EntityAttributeBars - renders the active droid's whole-entity attribute bars.
 */
export class EntityAttributeBars {
    /**
     * @param {import('./WorldStateManager.js').WorldStateManager} worldStateManager
     */
    constructor(worldStateManager) {
        /** @private */
        this._worldStateManager = worldStateManager;
        /** @private {HTMLElement|null} */
        this._container = null;
    }

    /**
     * Binds the persistent container element (created in index.html).
     */
    init() {
        this._container = document.getElementById('entity-attributes-container');
    }

    /**
     * Renders the active droid's entity-attribute bars from the world state.
     * Called on every world-state update, alongside StatBarsManager.updateAll.
     * @param {Object} state - The complete world state object.
     */
    updateAll(state) {
        if (!this._container) return;

        const droid = this._worldStateManager.getActiveDroid();
        if (!droid) {
            this._container.innerHTML = this._emptyHTML();
            return;
        }

        const declarations = getEntityAttributeDeclarations(droid);
        if (!declarations) {
            this._container.innerHTML = this._emptyHTML();
            return;
        }

        let html = '';
        for (const [traitId, group] of Object.entries(declarations)) {
            for (const statName of Object.keys(group)) {
                const key = flatAttributeKey(traitId, statName);
                const display = ATTRIBUTE_DISPLAY[key];
                if (!display) continue; // no display entry -> not a visible attribute
                const value = getEntityAttribute(droid, traitId, statName);
                if (value == null) continue;
                const config = group[statName];
                const max = (config && config.max > 0) ? config.max : (value > 0 ? value : 1);
                const pct = Math.max(0, Math.min(100, (value / max) * 100));
                html += this._buildBarHTML(key, display, value, max, pct);
            }
        }

        this._container.innerHTML = html || this._emptyHTML();
    }

    /**
     * Builds the HTML for a single whole-entity attribute bar.
     * @param {string} key - The flat "Group.stat" key.
     * @param {{label: string, color: string, icon: string}} display
     * @param {number} value - Current value.
     * @param {number} max - Maximum value.
     * @param {number} pct - Fill percentage (0-100).
     * @returns {string}
     * @private
     */
    _buildBarHTML(key, display, value, max, pct) {
        const low = pct <= 20;
        return `
            <div class="entity-attribute-bar${low ? ' entity-attribute-bar--low' : ''}"
                 data-attribute="${key}" data-low="${low ? '1' : '0'}"
                 title="Whole-entity ${display.label}: drains each turn, refilled by the coal generator. The entity dies at 0.">
                <span class="entity-attribute-icon" aria-hidden="true">${display.icon}</span>
                <span class="entity-attribute-label" style="color: ${display.color};">${display.label}</span>
                <div class="entity-attribute-track">
                    <div class="entity-attribute-fill" style="width: ${pct}%; background-color: ${display.color};"></div>
                </div>
                <span class="entity-attribute-value" style="color: ${display.color};">${value} / ${max}</span>
            </div>`;
    }

    /**
     * @returns {string} Placeholder for when the droid declares no attributes.
     * @private
     */
    _emptyHTML() {
        return '<em style="color: var(--text-dim); font-size: 0.85em;">No entity attributes declared.</em>';
    }
}
