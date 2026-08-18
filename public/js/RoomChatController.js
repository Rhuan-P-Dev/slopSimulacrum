/**
 * RoomChatController
 * Feature D (spec §7.4): the per-room chat overlay UI.
 *
 * Responsibilities:
 *   - render the focused room's chat history (GET /rooms/:roomId/chat)
 *   - accept player input (fixed speaker name "Player" — spec §7.3) and
 *     POST it (POST /rooms/:roomId/chat { message })
 *   - consume the global Socket.IO `room-chat-message` broadcast, filtering
 *     by the focused room
 *   - track unread messages while the panel is closed (badge count)
 *
 * The "focused room" is the active droid's current room — the same room
 * every other part of the client renders (UIManager.updateWorldView). When
 * the droid moves, App.js calls setFocusedRoom() with the new room UID.
 *
 * DOM contract (see public/index.html):
 *   #room-chat-overlay.overlay-panel
 *     .overlay-header  (h3.overlay-title "Room Chat", .room-chat-room-name,
 *                       #room-chat-badge, .overlay-close-btn)
 *     #room-chat-messages.room-chat-messages
 *     .overlay-footer  > #room-chat-input.room-chat-input
 *
 * Follows the client patterns: no console.* (ClientLogger), no app.locals —
 * plain dependency injection, one CSS file per feature (chat.css).
 *
 * @module RoomChatController
 */
import { AppConfig } from './Config.js';
import ClientLogger from '/utils/ClientLogger.js';

export class RoomChatController {
    /**
     * @param {Object} deps
     * @param {() => Object|null} [deps.getState] - Returns the client world state.
     * @param {Function} [deps.handleError] - Error surface (ClientErrorController.handleError).
     */
    constructor({ getState, handleError } = {}) {
        /** @type {() => Object|null} */
        this._getState = typeof getState === 'function' ? getState : () => null;
        /** @type {Function|null} */
        this._handleError = typeof handleError === 'function' ? handleError : null;

        /** @type {HTMLElement|null} */
        this.overlay = null;
        /** @type {HTMLElement|null} */
        this._messagesEl = null;
        /** @type {HTMLElement|null} */
        this._inputEl = null;
        /** @type {HTMLElement|null} */
        this._badgeEl = null;
        /** @type {HTMLElement|null} */
        this._roomNameEl = null;

        /** @type {string|null} Focused room UID (active droid's room). */
        this._focusedRoomId = null;
        /** @type {number} Unread count while the panel is closed. */
        this._unread = 0;
        /** @type {string|null} Currently displayed room UID. */
        this._displayedRoomId = null;
        /**
         * @type {Map<string, number>} Dedupe ledger for rendered messages
         * (the REST echo of a send and the socket broadcast carry the same
         * message — render it only once).
         */
        this._renderedKeys = new Map();
    }

    /**
     * Initializes the DOM references and input listeners. Safe to call when
     * the panel is absent (logs once and no-ops) — the app must never break
     * because an optional panel is missing.
     */
    init() {
        this.overlay = document.getElementById('room-chat-overlay');
        if (!this.overlay) {
            ClientLogger.warn('RoomChatController', 'init: #room-chat-overlay not found — chat UI disabled.');
            return;
        }
        this._messagesEl = document.getElementById('room-chat-messages');
        this._inputEl = document.getElementById('room-chat-input');
        this._badgeEl = document.getElementById('room-chat-badge');
        this._roomNameEl = this.overlay.querySelector('.room-chat-room-name');

        const closeBtn = this.overlay.querySelector('.overlay-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hide());
        }
        if (this._inputEl) {
            this._inputEl.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    this._sendMessage();
                }
            });
        }
    }

    /**
     * Updates the focused room (called by App.js whenever the world refreshes
     * and the active droid's room may have changed). Re-loads history when
     * the room actually changed.
     * @param {string|null} roomId - The new focused room UID.
     */
    setFocusedRoom(roomId) {
        if (roomId === this._focusedRoomId) return;
        this._focusedRoomId = roomId;
        // The unread badge is room-scoped: switching rooms resets it.
        this._unread = 0;
        this._updateBadge();
        this._displayedRoomId = roomId;
        this._updateRoomLabel(roomId);

        if (!this.overlay || !roomId) return;
        if (this.isVisible()) {
            // Panel open: silently follow the new room with fresh history.
            this._loadHistory(roomId);
        }
    }

    /**
     * Handles a global `room-chat-message` broadcast. Messages from other
     * rooms are ignored; when the panel is closed they bump the badge.
     * @param {Object} message - { roomId, speakerName, speakerEntityId, text, tick }
     */
    onRoomChatMessage(message) {
        if (!message || !this.overlay) return;
        if (message.roomId !== this._focusedRoomId) return;

        if (this.isVisible()) {
            this._appendMessage(message);
        } else {
            this._unread += 1;
            this._updateBadge();
        }
    }

    /**
     * Shows the panel for the focused room and loads its history.
     * @param {*} [_data] - Unused (OverlayManager may pass fetch data).
     */
    show(_data) {
        if (!this.overlay) return;
        this.overlay.style.display = 'block';
        this._unread = 0;
        this._updateBadge();
        this._displayedRoomId = this._focusedRoomId;
        this._updateRoomLabel(this._focusedRoomId);
        if (this._focusedRoomId) {
            this._loadHistory(this._focusedRoomId);
        } else if (this._messagesEl) {
            this._renderEmpty('(no room focused)');
        }
        if (this._inputEl) {
            this._inputEl.focus();
        }
    }

    /** Hides the panel (keeps the unread count reset). */
    hide() {
        if (this.overlay) {
            this.overlay.style.display = 'none';
        }
    }

    /** Toggles the panel. */
    toggle() {
        if (this.overlay && this.overlay.style.display === 'block') {
            this.hide();
        } else {
            this.show();
        }
    }

    /**
     * Whether the panel is currently visible.
     * @returns {boolean}
     */
    isVisible() {
        return Boolean(this.overlay && this.overlay.style.display === 'block');
    }

    /**
     * Resolves the display name for a room UID from the world state.
     * @param {string|null} roomId
     * @returns {string}
     */
    _roomDisplayName(roomId) {
        const state = this._getState();
        const room = state?.rooms?.[roomId];
        return room?.name || roomId || 'Unknown Room';
    }

    /**
     * Updates the header's room label.
     * @private
     */
    _updateRoomLabel(roomId) {
        if (this._roomNameEl) {
            this._roomNameEl.textContent = this._roomDisplayName(roomId);
        }
    }

    /**
     * Fetches and renders the history for a room (oldest → newest).
     * @private
     */
    async _loadHistory(roomId) {
        if (!this._messagesEl) return;
        try {
            const url = `${AppConfig.ENDPOINTS.ROOM_CHAT_HISTORY}/${encodeURIComponent(roomId)}/chat?limit=${AppConfig.ROOM_CHAT.HISTORY_LIMIT}`;
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            const messages = Array.isArray(data?.messages) ? data.messages : [];
            // Guard: a slow fetch may resolve after the room has moved on.
            if (this._displayedRoomId !== roomId) return;
            if (messages.length === 0) {
                this._renderEmpty('(no messages yet)');
            } else {
                this._renderMessages(messages);
            }
        } catch (error) {
            ClientLogger.error('RoomChatController', `Failed to load chat history for ${roomId}:`, error);
            this._renderEmpty('(failed to load history)');
        }
    }

    /**
     * Renders a full message list, clearing previous content.
     * @param {Object[]} messages
     * @private
     */
    _renderMessages(messages) {
        if (!this._messagesEl) return;
        this._messagesEl.innerHTML = '';
        this._renderedKeys.clear();
        for (const message of messages) {
            this._appendMessage(message);
        }
        this._scrollToBottom();
    }

    /**
     * Appends a single message row: speaker name (bold, colored for NPCs)
     * + text. Speaker names are HTML-escaped.
     * @param {Object} message
     * @private
     */
    _appendMessage(message) {
        if (!this._messagesEl) return;
        // Dedupe: the same message arrives twice (POST response echo +
        // socket broadcast). Key = the server-assigned message.id
        // (chat-<uuid>) when present — the legacy tick+speaker+text key
        // swallowed two IDENTICAL messages sent in the same tick.
        const key = typeof message.id === 'string' && message.id !== ''
            ? message.id
            : `${message.roomId}|${message.tick ?? ''}|${message.speakerName ?? ''}|${message.text ?? ''}`;
        if (this._renderedKeys.has(key)) return;
        this._renderedKeys.set(key, 1);
        if (this._renderedKeys.size > 200) {
            const first = this._renderedKeys.keys().next().value;
            if (first !== undefined) this._renderedKeys.delete(first);
        }

        const row = document.createElement('div');
        row.className = 'room-chat-row';

        const speaker = document.createElement('span');
        speaker.className = 'room-chat-speaker';
        if (message.speakerEntityId) {
            speaker.classList.add('room-chat-speaker-npc');
        }
        speaker.textContent = message.speakerName || '???';

        const text = document.createElement('span');
        text.className = 'room-chat-text';
        text.textContent = message.text || '';

        row.appendChild(speaker);
        row.appendChild(text);
        this._messagesEl.appendChild(row);
        this._scrollToBottom();
    }

    /**
     * Replaces the message list with a single muted placeholder row.
     * @param {string} placeholder
     * @private
     */
    _renderEmpty(placeholder) {
        if (!this._messagesEl) return;
        this._messagesEl.innerHTML = '';
        const row = document.createElement('div');
        row.className = 'room-chat-row room-chat-empty';
        row.textContent = placeholder;
        this._messagesEl.appendChild(row);
    }

    /**
     * Scrolls the message list to the newest entry.
     * @private
     */
    _scrollToBottom() {
        if (this._messagesEl) {
            this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
        }
    }

    /**
     * Submits the input (Enter key). Enforces the client-side cap that
     * matches the server (200 chars) for instant feedback.
     * @private
     */
    async _sendMessage() {
        if (!this._inputEl) return;
        const text = this._inputEl.value.trim();
        if (!text) return;

        const roomId = this._focusedRoomId;
        if (!roomId) {
            ClientLogger.warn('RoomChatController', 'send skipped: no focused room.');
            return;
        }
        if (text.length > AppConfig.CHAT_MAX_LENGTH) {
            ClientLogger.warn('RoomChatController', `Message too long (${text.length}/${AppConfig.CHAT_MAX_LENGTH}).`);
            this._surfaceError(`Message too long (max ${AppConfig.CHAT_MAX_LENGTH} characters).`);
            return;
        }

        try {
            const response = await fetch(`${AppConfig.ENDPOINTS.ROOM_CHAT_SEND}/${encodeURIComponent(roomId)}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // Spec §7.4: the client sends its fixed speaker name explicitly.
                body: JSON.stringify({ message: text, speakerName: AppConfig.PLAYER_NAME })
            });
            const data = await response.json().catch(() => null);
            if (!response.ok) {
                const message = data?.error || `Send failed (HTTP ${response.status})`;
                this._surfaceError(message);
                return;
            }
            this._inputEl.value = '';
            // The broadcast arrives via Socket.IO; the REST response is the
            // authoritative echo, so render it here — the dedupe ledger in
            // _appendMessage() absorbs the duplicate when the socket copy
            // follows moments later.
            if (data?.message) {
                this._appendMessage(data.message);
            }
        } catch (error) {
            ClientLogger.error('RoomChatController', 'Failed to send room chat message:', error);
            this._surfaceError(error.message);
        }
    }

    /**
     * Surfaces a send/feedback error through the app's error controller.
     * @param {string} message
     * @private
     */
    _surfaceError(message) {
        if (this._handleError) {
            this._handleError({ code: 'ROOM_CHAT_SEND_FAILED', message });
        } else {
            ClientLogger.warn('RoomChatController', message);
        }
    }

    /**
     * Updates the badge element (visible only when unread > 0 and panel closed).
     * @private
     */
    _updateBadge() {
        if (!this._badgeEl) return;
        if (this._unread > 0 && !this.isVisible()) {
            this._badgeEl.textContent = this._unread > 99 ? '99+' : String(this._unread);
            this._badgeEl.style.display = 'inline-block';
        } else {
            this._badgeEl.style.display = 'none';
        }
    }
}
