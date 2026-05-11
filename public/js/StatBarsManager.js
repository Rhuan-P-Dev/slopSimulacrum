/**
 * StatBarsManager
 * Manages runtime stat bars for the active droid.
 * Does not persist to localStorage; all state is ephemeral.
 *
 * Each stat bar represents a trait/stat pair from a component instance,
 * displaying its current value as a percentage of its maximum.
 *
 * @module StatBarsManager
 */
import { AppConfig } from './Config.js';

/**
 * Default color mapping for trait types.
 * @readonly
 * @type {Record<string, string>}
 */
const TRAIT_DEFAULT_COLORS = Object.freeze({
    Physical: '#22c55e',
    Mind: '#3b82f6',
    Spatial: '#6b7280',
    Movement: '#f59e0b',
});

/**
 * StatBarsManager - Manages a collection of visual stat bars.
 */
export class StatBarsManager {
    /**
     * Creates a new StatBarsManager.
     * @param {import('./UIManager.js').UIManager} uiManager - The UI manager instance.
     * @param {import('./WorldStateManager.js').WorldStateManager} worldStateManager - The world state manager.
     */
    constructor(uiManager, worldStateManager) {
        /** @private */
        this._uiManager = uiManager;
        /** @private */
        this._worldStateManager = worldStateManager;
        /** @private {Map<string, StatBarConfig>} */
        this._bars = new Map();
        /** @private {HTMLElement|null} */
        this._container = null;
        /** @private {HTMLElement|null} */
        this._dialog = null;
        /** @private {HTMLElement|null} */
        this._dialogOverlay = null;
        /** @private {Function|null} */
        this._pendingConfirmCallback = null;
        /** @private {string|null} */
        this._pendingComponentId = null;
    }

    /**
     * Initializes the stat bars container DOM element.
     */
    init() {
        this._dialog = document.getElementById('add-stat-dialog');
        this._dialogOverlay = document.getElementById('add-stat-dialog-overlay');
        this._setupDialogListeners();
    }

    /**
     * Sets up dialog close/confirm/cancel listeners.
     * @private
     */
    _setupDialogListeners() {
        if (!this._dialog || !this._dialogOverlay) return;

        const btnCancel = document.getElementById('btn-cancel-add-stat');
        const btnConfirm = document.getElementById('btn-confirm-add-stat');
        const colorInput = document.getElementById('stat-color-input');
        const colorHex = document.getElementById('stat-color-hex');

        if (btnCancel) {
            btnCancel.onclick = () => this.closeAddDialog();
        }
        if (btnConfirm) {
            btnConfirm.onclick = () => this._confirmAddStat();
        }
        if (this._dialogOverlay) {
            this._dialogOverlay.onclick = () => this.closeAddDialog();
        }
        if (colorInput && colorHex) {
            colorInput.addEventListener('input', (e) => {
                colorHex.textContent = e.target.value;
            });
        }
    }

    /**
     * Adds a new stat bar with the given configuration.
     * @param {string} trait - The trait name (e.g., 'Physical').
     * @param {string} stat - The stat key (e.g., 'mass').
     * @param {number} max - The maximum value for percentage calculation.
     * @param {string} color - The bar color (hex).
     * @param {string} [label] - Optional display label (defaults to 'trait.stat').
     * @returns {string} The bar ID.
     */
    addBar(trait, stat, max, color, label, componentId) {
        const barId = crypto.randomUUID();
        const barConfig = {
            id: barId,
            componentId: componentId || null,
            trait,
            stat,
            max: typeof max === 'number' && max > 0 ? max : null,
            color: color || TRAIT_DEFAULT_COLORS[trait] || '#ff00ff',
            label: label || `${trait}.${stat}`,
        };
        this._bars.set(barId, barConfig);
        this._ensureContainer();
        this._renderAllBars();
        // Immediately update bar value with current state
        const state = this._worldStateManager.getState();
        if (state) {
            this.updateAll(state);
        }
        return barId;
    }

    /**
     * Removes a stat bar by ID.
     * @param {string} barId - The bar ID to remove.
     */
    removeBar(barId) {
        this._bars.delete(barId);
        this._renderAllBars();
        // Update remaining bars with current state
        const state = this._worldStateManager.getState();
        if (state) {
            this.updateAll(state);
        }
    }

    /**
     * Edits an existing stat bar's configuration.
     * @param {string} barId - The bar ID to edit.
     * @param {Object} updates - Partial updates (max, color, label).
     */
    editBar(barId, updates) {
        const bar = this._bars.get(barId);
        if (!bar) return;
        if (updates.max !== undefined) bar.max = updates.max;
        if (updates.color !== undefined) bar.color = updates.color;
        if (updates.label !== undefined) bar.label = updates.label;
        this._renderAllBars();
        // Update bar values with current state after edits
        const state = this._worldStateManager.getState();
        if (state) {
            this.updateAll(state);
        }
    }

    /**
     * Updates all stat bar fill percentages based on current world state.
     * Called on every 'world-state-update' socket event.
     * @param {Object} state - The complete world state object.
     */
    updateAll(state) {
        if (!state || !state.components || !state.components.instances) return;

        const droid = this._worldStateManager.getActiveDroid();
        if (!droid) return;

        const instances = state.components.instances;

        for (const [barId, bar] of this._bars) {
            let totalValue = 0;

            // If this bar is tied to a specific component, read from that component only
            if (bar.componentId) {
                const stats = instances[bar.componentId];
                if (stats && stats[bar.trait] && stats[bar.trait][bar.stat] !== undefined) {
                    totalValue = stats[bar.trait][bar.stat];
                }
            } else {
                // Fallback: sum across all droid components that have this trait
                for (const comp of (droid.components || [])) {
                    const stats = instances[comp.id];
                    if (stats && stats[bar.trait] && stats[bar.trait][bar.stat] !== undefined) {
                        totalValue += stats[bar.trait][bar.stat];
                    }
                }
            }

            const effectiveMax = bar.max || totalValue;
            const rawPercentage = effectiveMax > 0 ? (totalValue / effectiveMax) * 100 : 0;
            const displayPercentage = Math.min(rawPercentage, 100);
            const percentageText = rawPercentage > 0 ? ` (${Math.round(rawPercentage)}%)` : '';
            const color = this._getTraitColor(bar.trait, bar.color);

            this._updateBarFill(barId, displayPercentage, totalValue, `${totalValue} / ${effectiveMax}${percentageText}`, state);
        }
    }

    /**
     * Updates a single bar's fill via DOM.
     * @param {string} barId - The bar ID.
     * @param {number} percentage - Fill percentage (0-100).
     * @param {number} currentValue - Current displayed value.
     * @param {string} valueText - Display text for value.
     * @param {Object} [state] - Optional world state for color lookup.
     * @private
     */
    _updateBarFill(barId, percentage, currentValue, valueText, state) {
        const fill = document.getElementById(`stat-fill-${barId}`);
        const valueEl = document.getElementById(`stat-value-${barId}`);
        const labelEl = document.getElementById(`stat-label-${barId}`);

        if (fill) {
            fill.style.width = `${percentage}%`;
            fill.style.backgroundColor = this._getTraitColor(
                state && state.components?.locked ? '' : '',
                state ? this._getTraitColorFromState(state) : null
            ) || fill.dataset.color || '#00ff00';
        }
        if (valueEl) {
            valueEl.textContent = valueText;
            valueEl.style.color = fill?.dataset?.color || '#fff';
        }
        if (labelEl) {
            labelEl.style.color = fill?.dataset?.color || '#fff';
        }
    }

    /**
     * Gets the resolved color for a trait.
     * @param {string} trait - The trait name.
     * @param {string} [customColor] - Optional custom color.
     * @returns {string} The resolved color.
     * @private
     */
    _getTraitColor(trait, customColor) {
        if (customColor) return customColor;
        return TRAIT_DEFAULT_COLORS[trait] || '#ff00ff';
    }

    /**
     * Gets trait color from world state context.
     * @param {Object} state - World state.
     * @returns {string|null}
     * @private
     */
    _getTraitColorFromState(state) {
        return null;
    }

    /**
     * Removes all stat bars.
     */
    clearAll() {
        this._bars.clear();
        this._renderAllBars();
    }

    /**
     * Ensures the container element exists.
     * @private
     */
    _ensureContainer() {
        const section = document.getElementById('stat-bars-section');
        if (!section) return;

        if (!this._container) {
            this._container = document.getElementById('stat-bars-container');
            if (!this._container) {
                this._container = document.createElement('div');
                this._container.id = 'stat-bars-container';
                section.appendChild(this._container);
            }
        }
    }

    /**
     * Re-renders all stat bars in the container.
     * @private
     */
    _renderAllBars() {
        this._ensureContainer();
        if (!this._container) return;

        if (this._bars.size === 0) {
            this._container.innerHTML =
                '<em style="color: var(--text-dim); font-size: 0.85em;">No stat bars configured. Click "➕ Add Stat" to begin.</em>';
            return;
        }

        let html = '';
        for (const bar of this._bars.values()) {
            html += this._buildBarHTML(bar);
        }
        this._container.innerHTML = html;

        // Attach event listeners
        this._container.querySelectorAll('.stat-bar-btn-edit').forEach((btn) => {
            btn.onclick = (e) => {
                e.stopPropagation();
                this._openEditDialog(btn.dataset.barId);
            };
        });
        this._container.querySelectorAll('.stat-bar-btn-delete').forEach((btn) => {
            btn.onclick = (e) => {
                e.stopPropagation();
                this.removeBar(btn.dataset.barId);
            };
        });
        this._container.querySelectorAll('.color-swatch').forEach((swatch) => {
            swatch.onclick = (e) => {
                e.stopPropagation();
                this._openColorPicker(e.target);
            };
        });
    }

    /**
     * Builds HTML for a single stat bar.
     * @param {StatBarConfig} bar - Bar configuration.
     * @returns {string} HTML string.
     * @private
     */
    _buildBarHTML(bar) {
        const color = this._getTraitColor(bar.trait, bar.color);
        return `
            <div class="stat-bar-item" data-bar-id="${bar.id}" data-component-id="${bar.componentId || ''}">
                <span class="stat-bar-label" id="stat-label-${bar.id}" style="color: ${color};">${bar.label}</span>
                <div class="stat-bar-track">
                    <div class="stat-bar-fill" id="stat-fill-${bar.id}" data-color="${color}" style="width: 0%; background-color: ${color};"></div>
                </div>
                <span class="stat-bar-value" id="stat-value-${bar.id}" style="color: ${color};">0%</span>
                <div class="stat-bar-controls">
                    <button class="stat-bar-btn stat-bar-btn-edit" data-bar-id="${bar.id}" title="Edit max">✏️</button>
                    <button class="stat-bar-btn stat-bar-btn-delete" data-bar-id="${bar.id}" title="Remove">🗑️</button>
                </div>
            </div>`;
    }

    /**
     * Returns a bar config by ID.
     * @param {string} barId - The bar ID.
     * @returns {StatBarConfig|undefined}
     */
    getBar(barId) {
        return this._bars.get(barId);
    }

    /**
     * Returns all bar configs as an array.
     * @returns {StatBarConfig[]}
     */
    getBars() {
        return Array.from(this._bars.values());
    }

    /**
     * Returns the number of configured stat bars.
     * @returns {number}
     */
    getBarCount() {
        return this._bars.size;
    }

    /**
     * Scans world state for available traits and their stats.
     * Optionally filters to a specific component by ID.
     * @param {string} [componentId] - Optional component instance ID to filter by.
     * @returns {Object} Map of trait -> Array of stat keys.
     */
    getAvailableTraitsAndStats(componentId) {
        const result = {};
        const state = this._worldStateManager.getState();
        if (!state || !state.components || !state.components.instances) return result;

        const targetInstances = componentId
            ? { [componentId]: state.components.instances[componentId] }
            : state.components.instances;

        for (const [, stats] of Object.entries(targetInstances)) {
            if (!stats) continue;
            for (const [trait, properties] of Object.entries(stats)) {
                if (!result[trait]) {
                    result[trait] = new Set();
                }
                for (const stat of Object.keys(properties)) {
                    result[trait].add(stat);
                }
            }
        }

        // Convert Sets to Arrays for easier use in selects
        for (const trait of Object.keys(result)) {
            result[trait] = Array.from(result[trait]);
        }

        return result;
    }

    /**
     * Opens the add stat dialog with pre-filled values.
     * Populates the component selector dropdown from the active entity's components.
     * @param {Object} [preFill] - Optional pre-fill { componentId, trait, stat, max, label, color }.
     * @param {Function} [onConfirm] - Optional callback on confirm (overrides default addBar).
     */
    openAddDialog(preFill, onConfirm) {
        if (!this._dialog || !this._dialogOverlay) return;

        const componentSelect = document.getElementById('add-stat-component-select');
        const traitSelect = document.getElementById('stat-trait-select');
        const statSelect = document.getElementById('stat-select');
        const maxInput = document.getElementById('stat-max-input');
        const labelInput = document.getElementById('stat-label-input');
        const colorInput = document.getElementById('stat-color-input');
        const colorHex = document.getElementById('stat-color-hex');

        // Get pre-filled componentId
        const prefillComponentId = preFill?.componentId || null;

        // Populate component dropdown from active entity's components
        if (componentSelect) {
            const state = this._worldStateManager.getState();
            const entityId = this._worldStateManager.getMyEntityId();
            const entity = entityId ? state?.entities?.[entityId] : null;
            const components = entity?.components || [];

            componentSelect.innerHTML = '<option value="">-- Select Component --</option>';
            for (const comp of components) {
                const opt = document.createElement('option');
                opt.value = comp.id;
                opt.textContent = `${comp.type}${comp.identifier ? ` (${comp.identifier})` : ''}`;
                componentSelect.appendChild(opt);
            }

            // Wire component change to populate trait dropdown
            componentSelect.onchange = () => {
                const selectedCompId = componentSelect.value;
                this._populateTraitsForComponent(selectedCompId, traitSelect, statSelect);
            };

            // Pre-select the component if provided
            if (prefillComponentId) {
                componentSelect.value = prefillComponentId;
                // Trigger trait population for selected component
                if (componentSelect.onchange) componentSelect.onchange();
            }
        }

        // If no component pre-filled, populate traits from all components (legacy behavior)
        if (!prefillComponentId) {
            this._populateTraitsAllComponents(traitSelect, statSelect);
        }

        // Wire trait change to populate stat dropdown (for when no component is selected)
        if (traitSelect) {
            traitSelect.onchange = () => {
                const selectedCompId = componentSelect?.value;
                if (!selectedCompId) {
                    // No component selected - populate stats from all components
                    this._populateStatsFromTrait(traitSelect, statSelect);
                }
                // If component IS selected, stats are already populated by component change handler
            };
        }

        // Pre-fill values
        if (preFill) {
            if (traitSelect && preFill.trait) {
                traitSelect.value = preFill.trait;
                // Trigger trait change to populate stats
                if (traitSelect.onchange) traitSelect.onchange();
            }
            if (statSelect && preFill.stat) {
                statSelect.value = preFill.stat;
            }
            if (maxInput && preFill.max !== undefined) {
                maxInput.value = preFill.max;
            }
            if (labelInput && preFill.label) {
                labelInput.value = preFill.label;
            }
            if (colorInput && preFill.color) {
                colorInput.value = preFill.color;
                if (colorHex) colorHex.textContent = preFill.color;
            }
        }

        // Store the onConfirm callback and componentId for the confirm button
        this._pendingConfirmCallback = onConfirm || null;
        this._pendingComponentId = prefillComponentId;

        this._dialog.style.display = 'block';
        this._dialogOverlay.style.display = 'block';
    }

    /**
     * Populates trait and stat dropdowns for a specific component.
     * @param {string} componentId - The component instance ID.
     * @param {HTMLSelectElement} traitSelect - The trait dropdown element.
     * @param {HTMLSelectElement} statSelect - The stat dropdown element.
     * @private
     */
    _populateTraitsForComponent(componentId, traitSelect, statSelect) {
        if (!componentId || !traitSelect || !statSelect) return;

        const state = this._worldStateManager.getState();
        const instances = state?.components?.instances || {};
        const compStats = instances[componentId] || {};

        traitSelect.innerHTML = '<option value="">-- Select Trait --</option>';
        const traitSets = {};

        for (const [trait, properties] of Object.entries(compStats)) {
            traitSets[trait] = new Set();
            traitSelect.innerHTML += `<option value="${trait}">${trait}</option>`;
            for (const stat of Object.keys(properties)) {
                traitSets[trait].add(stat);
            }
        }

        // Store trait->stats mapping on the traitSelect for later use
        traitSelect._traitStatsMap = traitSets;

        // Wire trait change to populate stat dropdown
        traitSelect.onchange = () => {
            const selectedTrait = traitSelect.value;
            statSelect.innerHTML = '<option value="">-- Select Stat --</option>';
            if (selectedTrait && traitSets[selectedTrait]) {
                for (const stat of traitSets[selectedTrait]) {
                    const opt = document.createElement('option');
                    opt.value = stat;
                    opt.textContent = stat;
                    statSelect.appendChild(opt);
                }
            }
        };
    }

    /**
     * Populates trait dropdown from all components (legacy behavior when no component selected).
     * @param {HTMLSelectElement} traitSelect - The trait dropdown element.
     * @param {HTMLSelectElement} statSelect - The stat dropdown element.
     * @private
     */
    _populateTraitsAllComponents(traitSelect, statSelect) {
        const available = this.getAvailableTraitsAndStats();

        traitSelect.innerHTML = '<option value="">-- Select Trait --</option>';
        for (const trait of Object.keys(available).sort()) {
            const opt = document.createElement('option');
            opt.value = trait;
            opt.textContent = trait;
            traitSelect.appendChild(opt);
        }

        // Wire trait change to populate stat dropdown
        traitSelect.onchange = () => {
            this._populateStatsFromTrait(traitSelect, statSelect);
        };
    }

    /**
     * Populates stat dropdown for the currently selected trait (from all components).
     * @param {HTMLSelectElement} traitSelect - The trait dropdown element.
     * @param {HTMLSelectElement} statSelect - The stat dropdown element.
     * @private
     */
    _populateStatsFromTrait(traitSelect, statSelect) {
        const selectedTrait = traitSelect.value;
        statSelect.innerHTML = '<option value="">-- Select Stat --</option>';
        if (selectedTrait) {
            const available = this.getAvailableTraitsAndStats();
            if (available[selectedTrait]) {
                for (const stat of available[selectedTrait]) {
                    const opt = document.createElement('option');
                    opt.value = stat;
                    opt.textContent = stat;
                    statSelect.appendChild(opt);
                }
            }
        }
    }

    /**
     * Closes the add stat dialog.
     */
    closeAddDialog() {
        if (this._dialog) this._dialog.style.display = 'none';
        if (this._dialogOverlay) this._dialogOverlay.style.display = 'none';
        this._pendingConfirmCallback = null;
        this._pendingComponentId = null;
    }

    /**
     * Handles the confirm button click in the add stat dialog.
     * Reads the selected componentId from the dropdown at confirm time.
     * @private
     */
    _confirmAddStat() {
        const componentSelect = document.getElementById('add-stat-component-select');
        const traitSelect = document.getElementById('stat-trait-select');
        const statSelect = document.getElementById('stat-select');
        const maxInput = document.getElementById('stat-max-input');
        const labelInput = document.getElementById('stat-label-input');
        const colorInput = document.getElementById('stat-color-input');

        const componentId = componentSelect?.value || null;
        const trait = traitSelect?.value;
        const stat = statSelect?.value;

        if (!trait || !stat) {
            console.warn('[StatBarsManager] Trait and stat must be selected.');
            return;
        }

        const maxVal = maxInput ? parseFloat(maxInput.value) : null;
        const label = labelInput?.value?.trim() || '';
        const color = colorInput?.value || '#ff00ff';

        // Use custom callback if provided, otherwise default addBar
        if (this._pendingConfirmCallback) {
            this._pendingConfirmCallback({ trait, stat, max: maxVal, label, color });
        } else {
            this.addBar(trait, stat, maxVal, color, label, componentId);
        }

        this.closeAddDialog();
    }

    /**
     * Opens the edit dialog for a bar.
     * @param {string} barId - The bar ID to edit.
     * @private
     */
    _openEditDialog(barId) {
        const bar = this._bars.get(barId);
        if (!bar) return;

        // Simple prompt-based editing for max value
        const newMax = prompt(`Enter new maximum for "${bar.label}" (current: ${bar.max || 'auto'}):`, bar.max || '');
        if (newMax !== null) {
            const parsed = parseFloat(newMax);
            this.editBar(barId, { max: (isNaN(parsed) || parsed <= 0) ? null : parsed });
        }
    }

    /**
     * Opens a color picker for a bar via the color swatch.
     * @param {HTMLElement} swatchEl - The clicked swatch element.
     * @private
     */
    _openColorPicker(swatchEl) {
        const barId = swatchEl.closest('.stat-bar-item')?.dataset?.barId;
        if (!barId) return;

        const bar = this._bars.get(barId);
        if (!bar) return;

        const newColor = prompt(`Enter new color hex for "${bar.label}" (current: ${bar.color}):`, bar.color);
        if (newColor && /^#[0-9A-Fa-f]{6}$/.test(newColor.trim())) {
            this.editBar(barId, { color: newColor.trim() });
        }
    }
}