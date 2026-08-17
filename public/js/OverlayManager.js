/**
 * OverlayManager
 * Central coordinator for all floating window overlay panels.
 * Manages exclusive visibility, keyboard shortcuts, and config bar button wiring.
 * Replaces ConfigBarManager entirely.
 *
 * Pattern: Singleton registry with delegation to individual panel controllers.
 * Single Responsibility: Coordinate overlay visibility only — no business logic.
 *
 * @module OverlayManager
 */
import ClientLogger from '/utils/ClientLogger.js';

export class OverlayManager {
    /**
     * Creates a new OverlayManager.
     * @param {import('./EventDispatcher.js').EventDispatcher} eventDispatcher - The EventDispatcher instance.
     */
    constructor(eventDispatcher) {
        /** @private */
        this._eventDispatcher = eventDispatcher;
        /** @private {Map<string, Object>} */
        this._panels = new Map();
        /** @private {string|null} */
        this._activePanelId = null;
        /** @private {HTMLElement|null} */
        this._backdrop = null;

        /** @private {number} Base z-index for overlay panels */
        this._baseZIndex = 100;

        /** @private {Object<string, Object>} Cache for panel positions */
        this._panelPositions = {};
    }

    /**
     * Registers a panel with its controller and config bar button.
     * @param {string} panelId - Unique identifier (e.g., 'component-viewer').
     * @param {Object} controller - Panel controller with init()/show()/hide()/toggle() methods.
     * @param {string} buttonId - Config bar button element ID.
     * @param {string} [shortcutKey] - Keyboard shortcut key (e.g., '1').
     * @param {Function} [showData] - Optional async data fetcher called before show(). Returns data for show().
     */
    register(panelId, controller, buttonId, shortcutKey, showData) {
        this._panels.set(panelId, { controller, buttonId, shortcutKey, showData });
    }

    /**
     * Initializes the overlay manager: attaches button listeners, creates backdrop, sets up keyboard shortcuts.
     */
    init() {
        // Create shared backdrop element
        this._backdrop = document.createElement('div');
        this._backdrop.id = 'overlay-backdrop';
        this._backdrop.className = 'overlay-backdrop';
        this._backdrop.style.display = 'none';
        document.body.appendChild(this._backdrop);

        // Attach click listeners to config bar buttons
        for (const [panelId, { buttonId }] of this._panels.entries()) {
            const btn = document.getElementById(buttonId);
            if (btn) {
                btn.addEventListener('click', () => this.toggle(panelId));
            }
        }

        // Setup click-outside dismissal
        this._backdrop.addEventListener('click', () => this.closeAll());

        // Setup keyboard shortcuts
        this._setupKeyboardShortcuts();
    }

    /**
     * Toggles a registered panel (exclusive — closes others).
     * @param {string} panelId - Panel identifier.
     * @param {*} [data] - Optional data to pass to show().
     */
    toggle(panelId, data) {
        const panel = this._panels.get(panelId);
        if (!panel) return;

        if (this._activePanelId === panelId) {
            this.close(panelId);
        } else {
            if (this._activePanelId) {
                this.close(this._activePanelId);
            }
            this.open(panelId, data);
        }
    }

    /**
     * Opens a registered panel (exclusive — closes currently active).
     * If registered with a showData callback, fetches data first then passes it to show().
     * @param {string} panelId - Panel identifier.
     * @param {*} [data] - Optional fallback data (only used if no showData callback registered).
     */
    async open(panelId, data) {
        const panel = this._panels.get(panelId);
        if (!panel) return;

        // Close currently active panel first
        if (this._activePanelId && this._activePanelId !== panelId) {
            this._doClose(this._activePanelId);
        }

        // Fetch data via showData callback if registered, otherwise use passed data
        let showData = panel.showData;
        let panelData;
        try {
            panelData = showData ? await showData() : data;
        } catch (error) {
            ClientLogger.error('OverlayManager', `Error fetching data for panel '${panelId}':`, error);
            panel.controller.show(null);
            return;
        }

        // Show the requested panel
        panel.controller.show(panelData);
        this._activePanelId = panelId;

        // Show backdrop
        if (this._backdrop) {
            this._backdrop.style.display = 'block';
        }

        // Update z-index for active panel
        this._updateZIndex(panelId);

        // Initialize drag and resize for the panel
        this._initPanelDrag(panelId);
    }

    /**
     * Closes a registered panel.
     * @param {string} panelId - Panel identifier.
     */
    close(panelId) {
        if (this._activePanelId !== panelId) return;
        this._doClose(panelId);
    }

    /**
     * Closes all open panels.
     */
    closeAll() {
        if (this._activePanelId) {
            this._doClose(this._activePanelId);
        }
        if (this._backdrop) {
            this._backdrop.style.display = 'none';
        }
    }

    /**
     * Internal close logic.
     * @param {string} panelId - Panel identifier.
     * @private
     */
    _doClose(panelId) {
        const panel = this._panels.get(panelId);
        if (!panel) return;

        panel.controller.hide();
        this._activePanelId = null;

        if (this._backdrop) {
            this._backdrop.style.display = 'none';
        }
    }

    /**
     * Updates z-index so the active panel is on top.
     * @param {string} panelId - Panel identifier.
     * @private
     */
    _updateZIndex(panelId) {
        const panel = this._panels.get(panelId);
        if (!panel) return;

        const overlay = panel.controller.overlay;
        if (overlay) {
            overlay.style.zIndex = this._baseZIndex + 10;
        }

        // Reset other panels
        for (const [id, { controller }] of this._panels.entries()) {
            if (id !== panelId) {
                if (controller.overlay) {
                    controller.overlay.style.zIndex = this._baseZIndex;
                }
            }
        }
    }

    /**
     * Sets up keyboard shortcuts.
     * @private
     */
    _setupKeyboardShortcuts() {
        document.addEventListener('keydown', (event) => {
            // Escape closes all panels
            if (event.key === 'Escape') {
                this.closeAll();
                return;
            }

            // Number keys 1-4 toggle registered panels
            const key = event.key;
            if (key >= '1' && key <= '4') {
                for (const [panelId, { shortcutKey }] of this._panels.entries()) {
                    if (shortcutKey === key) {
                        this.toggle(panelId);
                        return;
                    }
                }
            }
        });
    }

    /**
     * Initializes drag functionality for a panel.
     * @param {string} panelId - Panel identifier.
     * @private
     */
    _initPanelDrag(panelId) {
        const panel = this._panels.get(panelId);
        if (!panel) return;

        const overlay = panel.controller.overlay;
        if (!overlay) return;

        const header = overlay.querySelector('.overlay-header');
        if (!header) return;

        // If already initialized, just ensure it's on top
        if (overlay._isDragInitialized) {
            overlay.style.zIndex = this._baseZIndex + 10;
            return;
        }

        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        const onMouseDown = (e) => {
            if (e.target.closest('.overlay-close-btn')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            initialLeft = overlay.offsetLeft;
            initialTop = overlay.offsetTop;
            overlay.style.zIndex = this._baseZIndex + 10;
            overlay.style.transition = 'none';
        };

        const onMouseMove = (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            overlay.style.left = `${initialLeft + dx}px`;
            overlay.style.top = `${initialTop + dy}px`;
        };

        const onMouseUp = () => {
            if (isDragging) {
                isDragging = false;
                overlay.style.transition = '';
                // Save position
                this._panelPositions[panelId] = {
                    left: overlay.style.left,
                    top: overlay.style.top
                };
            }
        };

        header.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        overlay._isDragInitialized = true;
        overlay._dragListeners = { onMouseDown, onMouseMove, onMouseUp };

        // Restore saved position if available
        if (this._panelPositions[panelId]) {
            overlay.style.left = this._panelPositions[panelId].left;
            overlay.style.top = this._panelPositions[panelId].top;
        }
    }

    /**
     * Gets the currently active panel ID.
     * @returns {string|null}
     */
    getActivePanelId() {
        return this._activePanelId;
    }

    /**
     * Checks if a specific panel is currently open.
     * @param {string} panelId - Panel identifier.
     * @returns {boolean}
     */
    isPanelOpen(panelId) {
        return this._activePanelId === panelId;
    }

    /**
     * Gets all registered panels.
     * @returns {Map<string, Object>}
     */
    getRegisteredPanels() {
        return new Map(this._panels);
    }
}
