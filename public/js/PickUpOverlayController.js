/**
 * PickUpOverlayController
 * Floating window panel showing dropped item info with "Pick Up" action.
 * Displays item name, description, volume, and pick-up button.
 * When "Pick Up" is clicked, triggers component selection for the pickup action.
 *
 * Pattern: Standalone panel controller compatible with OverlayManager.
 * Single Responsibility: Display dropped item details and trigger pick-up flow.
 *
 * @module PickUpOverlayController
 */
import { AppConfig } from './Config.js';

export class PickUpOverlayController {
    /**
     * Creates a new PickUpOverlayController.
     * @param {Object} [deps] - Dependency injection object.
     * @param {Function} [deps.onPickUp] - Callback triggered when "Pick Up" is clicked. Receives droppedItemInfo.
     * @param {Function} [deps.onClose] - Callback triggered when panel is closed.
     */
    constructor(deps = {}) {
        /** @private */
        this._onPickUp = deps.onPickUp || (() => {});
        /** @private */
        this._onClose = deps.onClose || (() => {});
        /** @private {HTMLElement|null} */
        this._overlay = null;
        /** @private {Object|null} */
        this._currentItem = null;
        /** @private {boolean} */
        this._isDragInitialized = false;
    }

    /**
     * Gets the overlay element.
     * @returns {HTMLElement|null}
     */
    get overlay() {
        return this._overlay;
    }

    /**
     * Initializes the overlay DOM element.
     */
    init() {
        // Check if overlay already exists in DOM
        this._overlay = document.getElementById('pick-up-overlay');

        if (!this._overlay) {
            this._overlay = this._createOverlay();
            document.body.appendChild(this._overlay);
        }

        // Attach close button listener
        const closeBtn = this._overlay.querySelector('.overlay-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hide());
        }

        // Attach pick-up button listener
        const pickUpBtn = this._overlay.querySelector('.pick-up-action-btn');
        if (pickUpBtn) {
            pickUpBtn.addEventListener('click', () => this._handlePickUp());
        }

        // Initialize drag functionality
        this._initDrag();
    }

    /**
     * Initializes drag functionality for the overlay.
     * @private
     */
       /**
     * Initializes drag functionality for the overlay.
     * @private
     */
    _initDrag() {
        if (this._isDragInitialized) return;
        
        // The header is now .overlay-header
        const header = this._overlay.querySelector('.overlay-header');
        if (!header) return;

        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        const onMouseDown = (e) => {
            if (e.target.closest('.overlay-close-btn')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            initialLeft = this._overlay.offsetLeft;
            initialTop = this._overlay.offsetTop;
            // One step above the OverlayManager's active panel (derived, not a
            // third constant, so the layering invariant cannot drift).
            this._overlay.style.zIndex = AppConfig.UI.Z_INDEX_BASE + AppConfig.UI.Z_INDEX_STEP;
            this._overlay.style.transition = 'none';
        };

        const onMouseMove = (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            this._overlay.style.left = `${initialLeft + dx}px`;
            this._overlay.style.top = `${initialTop + dy}px`;
        };

        const onMouseUp = () => {
            if (isDragging) {
                isDragging = false;
                this._overlay.style.transition = '';
            }
        };

        header.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        this._isDragInitialized = true;
    }

    /**
     * Creates the overlay DOM element.
     * @returns {HTMLElement}
     * @private
     */
       /**
     * Creates the overlay DOM element.
     * @returns {HTMLElement}
     * @private
     */
    _createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'pick-up-overlay';
        overlay.className = 'overlay-panel pick-up-overlay-panel';
        overlay.style.display = 'none';
        overlay.innerHTML = `
            <div class="overlay-header">
                <h3 class="pick-up-item-name">Item Name</h3>
                <button class="overlay-close-btn" aria-label="Close">&times;</button>
            </div>
            <div class="overlay-content pick-up-panel-content">
                <div class="pick-up-item-details">
                    <p class="pick-up-item-description"></p>
                    <div class="pick-up-item-stats">
                        <span class="pick-up-item-type"><strong>Type:</strong> <span class="item-type-value"></span></span>
                        <span class="pick-up-item-volume"><strong>Volume:</strong> <span class="item-volume-value"></span></span>
                    </div>
                </div>
                <div class="pick-up-panel-actions">
                    <button class="pick-up-action-btn">🎒 Pick Up</button>
                </div>
            </div>
        `;
        return overlay;
    }

    /**
     * Shows the pick-up panel with item information.
     * @param {Object} droppedItemInfo - The dropped item data.
     * @param {string} droppedItemInfo.id - The dropped item ID.
     * @param {string} droppedItemInfo.itemType - The item type.
     * @param {string} droppedItemInfo.name - The item name.
     * @param {string} droppedItemInfo.description - The item description.
     * @param {number} droppedItemInfo.volume - The item volume.
     * @param {number} droppedItemInfo.x - World X coordinate.
     * @param {number} droppedItemInfo.y - World Y coordinate.
     */
    show(droppedItemInfo) {
        if (!this._overlay) this.init();
        if (!this._overlay) return;

        this._currentItem = droppedItemInfo;

        // Populate item information
        const nameEl = this._overlay.querySelector('.pick-up-item-name');
        const descEl = this._overlay.querySelector('.pick-up-item-description');
        const typeEl = this._overlay.querySelector('.item-type-value');
        const volumeEl = this._overlay.querySelector('.item-volume-value');

        if (nameEl) nameEl.textContent = droppedItemInfo.name || droppedItemInfo.itemType;
        if (descEl) descEl.textContent = droppedItemInfo.description || 'No description available.';
        if (typeEl) typeEl.textContent = droppedItemInfo.itemType;
        if (volumeEl) volumeEl.textContent = droppedItemInfo.volume || 1;

        this._overlay.style.display = 'flex';
    }

    /**
     * Hides the pick-up panel.
     */
    hide() {
        if (!this._overlay) return;
        this._overlay.style.display = 'none';
        this._currentItem = null;
        this._onClose();
    }
    /**
    * Returns the currently stored item info.
    * @returns {Object|null}
    */
    _getCurrentItem() {
    return this._currentItem;
    }


    /**
     * Toggles the pick-up panel visibility.
     */
    toggle() {
        if (this._overlay && this._overlay.style.display === 'flex') {
            this.hide();
        } else {
            this.show(this._currentItem);
        }
    }

    /**
     * Handles the "Pick Up" button click.
     * @private
     */
    _handlePickUp() {
        if (!this._currentItem) return;
        this._onPickUp(this._currentItem);
    }
}