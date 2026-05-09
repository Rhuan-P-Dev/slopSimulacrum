/**
 * EventDispatcher
 * A single-responsibility class for socket.io and DOM event listener management.
 * Delegates all business logic to injected handler callbacks.
 *
 * @implements {IEventDispatcher}
 */

/**
 * @typedef {Object} IHandlers
 * @property {function(string): void} [setMyEntityId]
 * @property {function(): Promise<void>} [refreshWorldAndActions]
 * @property {function(Object): void} [handleError]
 * @property {function(string, string, Object): Promise<void>} [moveToTarget]
 * @property {function(string, string, string[], Object): Promise<void>} [executeMultiComponentSpatial]
 * @property {function(Object, number, number): Promise<void>} [executeGrab]
 * @property {function(Object, number, number, Set<string>): Promise<void>} [executePunch]
 */

/**
 * @interface IEventDispatcher
 */
class EventDispatcher {
    /**
     * Creates a new EventDispatcher.
     *
     * @param {Object} socket - Socket.io client instance.
     * @param {Object} config - Application configuration (AppConfig).
     * @param {IHandlers} handlers - Business logic handler callbacks.
     */
    constructor(socket, config, handlers) {
        /** @type {Object} Socket.io client instance. */
        this.socket = socket;

        /** @type {Object} Application configuration. */
        this.config = config;

        /** @type {IHandlers} Business logic handler callbacks. */
        this.handlers = handlers;

        /** @type {Map<string, Array<Function>>} Tracks socket listeners for cleanup. */
        this._socketListeners = new Map();

        /** @type {Array<{element: EventTarget, event: string, listener: Function}>} Tracks DOM listeners for cleanup. */
        this._domListeners = [];
    }

    /**
     * Sets up socket.io listeners for real-time server communication.
     *
     * - 'incarnate': Sets entity ID and triggers full refresh.
     * - 'world-state-update': Triggers full refresh.
     * - 'error': Delegates to error handler.
     */
    setupSocketListeners() {
        const socketHandlers = {
            incarnate: (data) => {
                console.log('[EventDispatcher] Incarnated as:', data.entityId);
                if (this.handlers.setMyEntityId) {
                    this.handlers.setMyEntityId(data.entityId);
                }
                if (this.handlers.refreshWorldAndActions) {
                    this.handlers.refreshWorldAndActions();
                }
            },
            'world-state-update': () => {
                console.log('[EventDispatcher] WORLD STATE UPDATE SIGNAL');
                if (this.handlers.refreshWorldAndActions) {
                    this.handlers.refreshWorldAndActions();
                }
            },
            error: (data) => {
                console.error('[EventDispatcher] Socket error:', data.message);
                if (this.handlers.handleError) {
                    this.handlers.handleError({
                        code: 'SOCKET_ERROR',
                        message: data.message
                    });
                }
            }
        };

        // Register and track all socket listeners
        for (const [event, handler] of Object.entries(socketHandlers)) {
            this.socket.on(event, handler);
            this._socketListeners.set(event, [handler]);
        }

        console.log('[EventDispatcher] Socket listeners setup complete');
    }

    /**
     * Sets up the SVG map click handler for spatial targeting.
     *
     * Uses createSVGPoint + getScreenCTM().inverse() for coordinate transformation.
     * Dispatches to action-specific handlers based on pending targetingType.
     *
     * @param {SVGElement} mapElement - The SVG map element.
     * @param {function(): Object|null} getPendingAction - Callback to get current pending action.
     */
    setupMapClickListener(mapElement, getPendingAction) {
        if (!mapElement) return;

        const clickHandler = (event) => {
            const pending = getPendingAction();
            if (!pending) return;

            // Transform screen coordinates to SVG world coordinates
            const pt = mapElement.createSVGPoint();
            pt.x = event.clientX;
            pt.y = event.clientY;
            const svgP = pt.matrixTransform(mapElement.getScreenCTM().inverse());

            const targetX = svgP.x - this.config.VIEW.CENTER_X;
            const targetY = svgP.y - this.config.VIEW.CENTER_Y;

            if (pending.targetingType === 'spatial') {
                this._handleSpatialClick(pending, targetX, targetY);
            } else if (pending.targetingType === 'component') {
                this._handleComponentClick(pending, targetX, targetY);
            }
        };

        mapElement.addEventListener('click', clickHandler);
        this._domListeners.push({
            element: mapElement,
            event: 'click',
            listener: clickHandler
        });

        console.log('[EventDispatcher] Map click listener setup complete');
    }

    /**
     * Sets up the release handler for grabbed items.
     * Listens for the 'release-component' custom event from the detail overlay.
     *
     * @param {HTMLElement|null} detailOverlayElement - The detail overlay element, or null to auto-find.
     * @param {function(string, string): Promise<void>} releaseCallback - Callback(entityId, componentType).
     */
    setupReleaseHandler(detailOverlayElement, releaseCallback) {
        const attachListener = () => {
            const overlay = detailOverlayElement || document.getElementById('detail-overlay');
            if (!overlay) {
                // Retry after a short delay
                setTimeout(attachListener, 100);
                return;
            }

            const releaseHandler = async (event) => {
                const { componentId: grabbedItemCompId, componentType } = event.detail;
                const entityId = this.handlers?.getMyEntityId?.();
                if (!entityId) {
                    console.error('[EventDispatcher] No active entity to release from');
                    return;
                }

                console.log(`[EventDispatcher] Executing release for ${componentType} (grabbed item: ${grabbedItemCompId})`);

                try {
                    if (releaseCallback) {
                        await releaseCallback(entityId, grabbedItemCompId);
                    }
                } catch (error) {
                    console.error(`[EventDispatcher] Release failed: ${error.message}`);
                    if (this.handlers.handleError) {
                        this.handlers.handleError({
                            code: 'RELEASE_FAILED',
                            message: error.message
                        });
                    }
                }
            };

            overlay.addEventListener('release-component', releaseHandler);
            this._domListeners.push({
                element: overlay,
                event: 'release-component',
                listener: releaseHandler
            });

            console.log('[EventDispatcher] Release handler attached to detail overlay.');
        };

        attachListener();
    }

    /**
     * Handles spatial targeting map clicks.
     * Clears pending, captures multi-component state, dispatches to handlers.
     *
     * @param {Object} pending - The pending action object.
     * @param {number} targetX - Target X coordinate.
     * @param {number} targetY - Target Y coordinate.
     * @private
     */
    _handleSpatialClick(pending, targetX, targetY) {
        // Capture multi-component state before clearing
        const isMultiComponent = this.handlers._isMultiComponent?.() ?? false;
        const componentIdsToExecute = isMultiComponent
            ? this.handlers._getComponentIdsToExecute?.() ?? []
            : [];

        // Clear selections to prevent duplicate execution
        this.handlers._clearAllSelections?.();
        this.handlers._reRenderActionList?.();

        // Execute with captured state
        if (isMultiComponent) {
            if (this.handlers.executeMultiComponentSpatial) {
                this.handlers.executeMultiComponentSpatial(
                    pending.actionName,
                    pending.entityId,
                    componentIdsToExecute,
                    { targetX, targetY }
                );
            }
        } else {
            if (this.handlers.moveToTarget) {
                this.handlers.moveToTarget(
                    pending.actionName,
                    pending.entityId,
                    targetX,
                    targetY
                );
            }
        }
    }

    /**
     * Handles component targeting map clicks.
     * Dispatches to grab/punch handlers based on action name.
     * Uses this.handlers (wired in constructor) for action execution.
     *
     * @param {Object} pending - The pending action object.
     * @param {number} targetX - Target X coordinate.
     * @param {number} targetY - Target Y coordinate.
     * @private
     */
    _handleComponentClick(pending, targetX, targetY) {
        const actionName = pending.actionName;

        if (actionName === 'grab' && this.handlers.executeGrab) {
            this.handlers.executeGrab(pending, targetX, targetY);
        } else if ((actionName === 'cut' || actionName === 'droid punch') && this.handlers.executePunch) {
            this.handlers.executePunch(pending, targetX, targetY);
        }
    }

    /**
     * Destroys all event listeners (cleanup).
     */
    destroy() {
        // Remove all socket listeners
        for (const [event, handlers] of this._socketListeners) {
            for (const handler of handlers) {
                this.socket.off(event, handler);
            }
        }
        this._socketListeners.clear();

        // Remove all DOM listeners
        for (const { element, event, listener } of this._domListeners) {
            element.removeEventListener(event, listener);
        }
        this._domListeners.length = 0;

        console.log('[EventDispatcher] All listeners destroyed');
    }
}

export { EventDispatcher };