/**
 * AppListeners — the ClientApp event-listener registration, extracted from
 * ClientApp._setupListeners (T10, plans/FIX-PLAN-2026-09.md).
 *
 * House shape (the app instance as first argument — the convention ruling
 * in plans/FIX-PLAN-2026-09.md T9, applied to the client): the registration
 * runs during the ClientApp constructor (step 13), when every collaborator
 * (dispatcher, socket, worldState, executor, ui, turns, roomChat) is already
 * assigned, so the function only ever reads those stored references and
 * registers callbacks that read the app lazily at event time.
 *
 * Registration order is part of the contract: listener order is observable
 * through stopPropagation/preventDefault interactions and handler
 * sequencing, so the original order is preserved exactly.
 *
 * Callback bodies are moved verbatim (only `this.` became `app.`); no
 * behaviour changed.
 */

import ClientLogger from '../utils/ClientLogger.js';
import { SOCKET_EVENTS } from '../../shared/SocketProtocol.js';

/**
 * Sets up all event listeners after module instantiation.
 * @param {import('./App.js').ClientApp} app - the app instance (constructor step 13)
 */
export function setupListeners(app) {
    app.dispatcher.setupSocketListeners();

    // Listen for drop selector execute event
    document.addEventListener('drop-selector:execute', (event) => {
        app._onDropSelectorExecute(event.detail);
    });

    // Listen for ESC key to cancel pending actions
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            app._cancelPendingAction();
        }
    });

    // Listen for Alt key to restore previous action
    // Use event.code instead of event.key because browsers (especially on Linux)
    // may not fire keydown with event.key==='Alt' for bare modifier keys.
    document.addEventListener('keydown', (event) => {
        if (event.code === 'AltLeft' || event.code === 'AltRight') {
            event.preventDefault();
            app._restorePreviousAction().catch(err => {
                // Suppress unhandled promise rejection for key handler
                ClientLogger.error('App', 'Error restoring previous action:', err);
            });
        }
    });

    const map = document.getElementById('world-map');
    if (map) {
        app.dispatcher.setupMapClickListener(
            map,
            () => app.actions.getPendingAction(),
            {
                hasPendingDropAction: () => app._pendingDropItem !== null,
                onDropItemClick: (targetX, targetY) => {
                    const pending = app._pendingDropItem;
                    if (pending) {
                        const droid = app.worldState.getActiveDroid();
                        const state = app.worldState.getState();
                        app.executor.executeDropItem(pending, targetX, targetY, droid, state);
                        app._pendingDropItem = null;
                        if (droid) {
                            app.ui.renderRangeIndicator(droid, 0, 'red', 'drop');
                        }
                    }
                },
                hasPendingPickUpAction: () => app._pendingPickUpSelector !== null,
                onPickUpItemClick: (targetX, targetY) => {
                    app._onPickUpMapClick(targetX, targetY);
                }
            }
        );
    }

    app.socket.on('dropped-items-update', (_data) => {
        // Dropped items are refreshed when world-map is opened via /world-map-with-items
    });

    // Listen for pick-up selector execute event (mirrors drop-selector:execute)
    document.addEventListener('pick-up-selector:execute', (event) => {
        app._onPickUpSelectorExecute(event.detail);
    });

    // Feature A: dedicated turn transition event (phase/round flips).
    // The payload does NOT carry queues — just re-read the latest full state
    // (a full-state broadcast follows on the same tick for resolutions).
    app.socket.on(SOCKET_EVENTS.TURN_ROUND_UPDATE, (payload) => {
        try {
            app.turns.onTransition(payload);
        } catch (err) {
            ClientLogger.error('App', 'turn-round-update handler failed:', err);
        }
    });

    // Feature D: GLOBAL room-chat broadcast (spec §7.3) — the payload
    // carries the roomId; the controller filters by focused room.
    app.socket.on(SOCKET_EVENTS.ROOM_CHAT_MESSAGE, (message) => {
        try {
            app.roomChat.onRoomChatMessage(message);
        } catch (err) {
            ClientLogger.error('App', 'room-chat-message handler failed:', err);
        }
    });
}
