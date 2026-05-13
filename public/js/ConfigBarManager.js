/**
 * ConfigBarManager
 * Manages the top configuration bar with:
 * - 🗿️ Component Viewer toggle
 * - 👍 Actions toggle
 * - 🌐 World Map toggle
 * - ➕ Add Stat Bar dialog
 * - 🎨 Color Scheme panel (placeholder)
 *
 * @module ConfigBarManager
 */
import { EventDispatcher } from './EventDispatcher.js';

export class ConfigBarManager extends EventDispatcher {
    /**
     * Creates a new ConfigBarManager.
     * @param {Object} options - Configuration options.
     * @param {import('./UIManager.js').UIManager} options.uiManager - The UIManager instance.
     * @param {import('./ComponentViewer.js').ComponentViewer} options.componentViewer - The ComponentViewer instance.
     * @param {import('./StatBarsManager.js').StatBarsManager} options.statBarsManager - The StatBarsManager instance.
     * @param {import('./NavActionsPanel.js').NavActionsPanel} options.navActionsPanel - The NavActionsPanel instance.
     * @param {import('./WorldMapView.js').WorldMapView} options.worldMapView - The WorldMapView instance.
     * @param {import('./WorldStateManager.js').WorldStateManager} options.worldStateManager - The WorldStateManager instance.
     * @param {Function} options.onMoveEntity - Callback for entity movement (entityId, targetRoomId).
     */
    constructor(options) {
        super();
        /** @private */
        this._uiManager = options.uiManager;
        /** @private */
        this._componentViewer = options.componentViewer;
        /** @private */
        this._statBarsManager = options.statBarsManager;
        /** @private */
        this._navActionsPanel = options.navActionsPanel;
        /** @private */
        this._worldMapView = options.worldMapView || null;
        /** @private */
        this._worldStateManager = options.worldStateManager;
        /** @private */
        this._onMoveEntity = options.onMoveEntity || null;
        /** @private */
        this._onExecuteAction = options.onExecuteAction || null;
        /** @private {Function|null} */
        this._onGetSelectionState = options.onGetSelectionState || null;
        /** @private {Function|null} */
        this._onGrayedComponentCallback = options.onGrayedComponentCallback || null;
        /** @private {Function|null} */
        this._onToggleWorldMap = options.onToggleWorldMap || null;
        /** @private {HTMLElement|null} */
        this._configBar = null;
    }

    /**
     * Initializes the config bar by setting up DOM references and event listeners.
     */
    init() {
        this._configBar = document.getElementById('config-bar');
        this._setupListeners();
    }

    /**
     * Sets up all button click listeners for the config bar.
     * @private
     */
    _setupListeners() {
        const btnComponentViewer = document.getElementById('btn-component-viewer');
        const btnNavActions = document.getElementById('btn-nav-actions');
        const btnWorldMap = document.getElementById('btn-world-map');
        const btnAddStat = document.getElementById('btn-add-stat');
        const btnColorScheme = document.getElementById('btn-color-scheme');

        if (btnComponentViewer) {
            btnComponentViewer.onclick = () => this._onComponentViewerClick();
        }
        if (btnNavActions) {
            btnNavActions.onclick = () => this._onNavActionsClick();
        }
        if (btnWorldMap) {
            btnWorldMap.onclick = () => this._onWorldMapClick();
        }
        if (btnAddStat) {
            btnAddStat.onclick = () => this._onAddStatClick();
        }
        if (btnColorScheme) {
            btnColorScheme.onclick = () => this._onColorSchemeClick();
        }
    }

    /**
     * Handles the 🗿️ Component Viewer button click.
     * Toggles the component viewer overlay, showing current droid components.
     * @private
     */
    _onComponentViewerClick() {
        const droid = this._worldStateManager.getActiveDroid();
        const state = this._worldStateManager.getState();

        if (this._componentViewer) {
            this._componentViewer.toggle(droid, state);
        }
    }

    /**
     * Handles the 👍 Actions button click.
     * Toggles the actions overlay, showing current actions.
     * If the panel is already open, updates the content instead of re-showing.
     * @private
     */
    _onNavActionsClick() {
        const droid = this._worldStateManager.getActiveDroid();
        const state = this._worldStateManager.getState();

        // Check if panel is already open
        const isPanelOpen = this._navActionsPanel?._overlay?.style.display === 'block';

        // Fetch actions from server
        this._fetchActionsForPanel().then((actions) => {
            if (this._navActionsPanel) {
                // Get selection state from the app if available
                const selection = this._onGetSelectionState ? this._onGetSelectionState() : null;
                const activeActionName = selection?.activeActionName ?? null;
                const selectedComponentIds = selection?.selectedComponentIds ?? new Set();
                const crossActionSelections = selection?.crossActionSelections ?? new Map();
                const onGrayedComponentClick = this._onGrayedComponentCallback ?? null;

                if (isPanelOpen) {
                    // Panel is open - update content without re-showing
                    this._navActionsPanel.updateRoom(
                        actions,
                        droid?.id,
                        this._onExecuteAction,
                        activeActionName,
                        selectedComponentIds,
                        crossActionSelections,
                        onGrayedComponentClick
                    );
                } else {
                    // Panel is closed - show it fresh
                    this._navActionsPanel.show(actions, droid?.id, this._onExecuteAction, activeActionName, selectedComponentIds, crossActionSelections, onGrayedComponentClick);
                }
            }
        }).catch(() => {
            // If fetch fails, show with empty actions
            if (this._navActionsPanel) {
                const selection = this._onGetSelectionState ? this._onGetSelectionState() : null;
                const activeActionName = selection?.activeActionName ?? null;
                const selectedComponentIds = selection?.selectedComponentIds ?? new Set();
                const crossActionSelections = selection?.crossActionSelections ?? new Map();
                const onGrayedComponentClick = this._onGrayedComponentCallback ?? null;

                if (isPanelOpen) {
                    this._navActionsPanel.updateRoom(
                        {},
                        droid?.id,
                        this._onExecuteAction,
                        activeActionName,
                        selectedComponentIds,
                        crossActionSelections,
                        onGrayedComponentClick
                    );
                } else {
                    this._navActionsPanel.show({}, droid?.id, this._onExecuteAction, activeActionName, selectedComponentIds, crossActionSelections, onGrayedComponentClick);
                }
            }
        });
    }

    /**
     * Handles the 🌐 World Map button click.
     * Toggles the world map overlay.
     * @private
     */
    _onWorldMapClick() {
        if (this._onToggleWorldMap) {
            this._onToggleWorldMap();
        } else if (this._worldMapView) {
            this._worldMapView.toggle();
        }
    }

    /**
     * Fetches available actions for the nav/actions panel.
     * @returns {Promise<Object>} The available actions.
     * @private
     */
    async _fetchActionsForPanel() {
        try {
            const entityId = this._worldStateManager.getMyEntityId();
            if (!entityId) return {};

            const response = await fetch(`/actions?entityId=${entityId}`);
            if (!response.ok) return {};
            const data = await response.json();
            return data.actions || {};
        } catch {
            return {};
        }
    }

    /**
     * Handles the ➕ Add Stat button click.
     * Opens the add stat dialog, pre-filtered to the currently selected component
     * (if any) from the ComponentViewer or SelectionController.
     * @private
     */
    _onAddStatClick() {
        if (!this._statBarsManager) return;

        // Try to get component context from ComponentViewer (if overlay is open)
        let componentId = null;
        if (this._componentViewer) {
            const activeCompId = this._componentViewer.getActiveComponentId?.();
            if (activeCompId) {
                componentId = activeCompId;
            }
        }

        // Fallback: get from SelectionController via onGetSelectionState
        if (!componentId && this._onGetSelectionState) {
            const selection = this._onGetSelectionState();
            if (selection?.selectedComponentIds?.size === 1) {
                componentId = Array.from(selection.selectedComponentIds)[0];
            }
        }

        this._statBarsManager.openAddDialog({ componentId });
    }

    /**
     * Handles the 🎨 Color Scheme button click.
     * Placeholder for future color scheme customization.
     * @private
     */
    _onColorSchemeClick() {
        console.log('[ConfigBarManager] 🎨 Color scheme panel (placeholder)');
        // Future: open a color scheme configuration panel
    }

    /**
     * Closes the component viewer overlay.
     */
    closeComponentViewer() {
        if (this._componentViewer) {
            this._componentViewer.hide();
        }
    }

    /**
     * Closes the nav/actions overlay.
     */
    closeNavActions() {
        if (this._navActionsPanel) {
            this._navActionsPanel.hide();
        }
    }

    /**
     * Closes the world map overlay.
     */
    closeWorldMap() {
        if (this._worldMapView) {
            this._worldMapView.hide();
        }
    }

    /**
     * Closes all overlays.
     */
    closeAllOverlays() {
        this.closeComponentViewer();
        this.closeNavActions();
        this.closeWorldMap();
    }

    /**
     * Toggles one panel while closing the other.
     * @param {string} panel - The panel to toggle ('component' or 'nav').
     * @param {...*} args - Arguments to pass to the panel's show/toggle method.
     */
    togglePanel(panel, ...args) {
        const isComponentOpen = this._componentViewer?._overlay?.style.display === 'block';
        const isNavOpen = this._navActionsPanel?._overlay?.style.display === 'block';

        if (panel === 'component') {
            if (isNavOpen) this.closeNavActions();
            if (this._componentViewer) this._componentViewer.show(...args);
        } else if (panel === 'nav') {
            if (isComponentOpen) this.closeComponentViewer();
            if (this._navActionsPanel) this._navActionsPanel.show(...args);
        }
    }
}