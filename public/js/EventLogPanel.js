/**
 * EventLogPanel
 * Feature (Events tab): read-only world event log overlay panel.
 *
 * Responsibilities:
 *   - fetch recent events from GET /world-events?limit=N
 *   - render them newest-first as plain text rows
 *   - no input, no badge, no dedupe logic
 *
 * DOM contract (see public/index.html):
 *   #events-overlay.overlay-panel
 *     .overlay-header  > h3 "📜 Events", .overlay-close-btn
 *     #event-log-list.event-log-list
 *
 * @module EventLogPanel
 */
import { AppConfig } from './Config.js';
import ClientLogger from '/utils/ClientLogger.js';

export class EventLogPanel {
    /** @type {number} Monotonically increasing sequence token for staleness detection. */
    _refreshSeq = 0;

    /**
     * @param {Object} deps
     * @param {Function} [deps.handleError] - Error surface (ClientErrorController.handleError).
     * @param {Function} [deps.getEntityId] - Returns the incarnated/active entity ID
     *   (or null) so the request can be enriched with the current room context.
     */
    constructor({ handleError, getEntityId } = {}) {
        /** @type {Function|null} */
        this._handleError = typeof handleError === 'function' ? handleError : null;
        /** @type {Function|null} */
        this._getEntityId = typeof getEntityId === 'function' ? getEntityId : null;

        /** @type {HTMLElement|null} */
        this.overlay = null;
        /** @type {HTMLElement|null} */
        this._listEl = null;
    }

    /**
     * Initializes the DOM references. Safe to call when the panel is absent
     * (logs once and no-ops) — the app must never break because an optional
     * panel is missing.
     */
    init() {
        this.overlay = document.getElementById('events-overlay');
        if (!this.overlay) {
            ClientLogger.warn('EventLogPanel', 'init: #events-overlay not found — events panel disabled.');
            return;
        }
        this._listEl = document.getElementById('event-log-list');

        const closeBtn = this.overlay.querySelector('.overlay-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hide());
        }
    }

    /**
     * Shows the panel and loads events.
     * @param {*} [_data] - Unused (OverlayManager may pass fetch data).
     */
    show(_data) {
        if (!this.overlay) return;
        this.overlay.style.display = 'block';
        this.refresh();
    }

    /** Hides the panel. */
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
     * Fetches fresh events from the server and renders them.
     * Uses a monotonically increasing sequence token to discard stale responses
     * (mirrors RoomChatController._loadHistory staleness guard).
     */
    async refresh() {
        if (!this.isVisible()) return;
        const seq = ++this._refreshSeq;
        try {
            // Send the active entity so the server can attach the current room
            // context (spec: better text & vision). Omitted when unknown.
            let url = `${AppConfig.ENDPOINTS.WORLD_EVENTS}?limit=${AppConfig.EVENTS.HISTORY_LIMIT}`;
            const entityId = this._getEntityId?.() || null;
            if (entityId) {
                url += `&entityId=${encodeURIComponent(entityId)}`;
            }
            const response = await fetch(url);
            if (!response.ok) {
                // Discard stale / post-hide responses.
                if (seq !== this._refreshSeq || !this.isVisible()) return;
                this._handleError?.({ code: 'EVENTS_LOAD_FAILED', message: 'Could not load events.' });
                ClientLogger.error('EventLogPanel', `Failed to load events (HTTP ${response.status})`);
                this._renderError();
                return;
            }
            const data = await response.json();
            // Discard stale responses (a newer refresh completed while we awaited).
            if (seq !== this._refreshSeq || !this.isVisible()) return;
            const events = Array.isArray(data?.events) ? data.events : [];
            if (events.length === 0) {
                this._renderEmpty();
            } else {
                this._renderEvents(events);
            }
        } catch (error) {
            if (seq !== this._refreshSeq || !this.isVisible()) return;
            this._handleError?.({ code: 'EVENTS_LOAD_FAILED', message: 'Could not load events.' });
            ClientLogger.error('EventLogPanel', 'Failed to load events:', error);
            this._renderError();
        }
    }

    /**
     * Renders the event list (newest first).
     * @private
     * @param {Array} events - Event records { tick, action, targetId, message, level, ts }.
     */
    _renderEvents(events) {
        if (!this._listEl) return;
        this._listEl.innerHTML = '';

        const reversed = [...events].reverse();
        for (const event of reversed) {
            const row = document.createElement('div');
            row.className = 'event-log-row';
            if (event.level === 'warn') {
                row.classList.add('event-log-row-warn');
            }

            const timeSpan = document.createElement('span');
            timeSpan.className = 'event-log-time';
            const d = new Date(event.ts);
            const timeStr = Number.isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString('en-GB', { hour12: false });
            timeSpan.textContent = `[${timeStr}]`;

            const messageSpan = document.createElement('span');
            messageSpan.className = 'event-log-message';
            messageSpan.textContent = event.message || '';

            row.appendChild(timeSpan);
            row.appendChild(messageSpan);

            // Enriched current-room context sub-line (spec: better text & vision).
            if (event.context) {
                const ctxSpan = document.createElement('span');
                ctxSpan.className = 'event-log-context';
                ctxSpan.textContent = this._formatContext(event.context);
                row.appendChild(ctxSpan);
            }

            this._listEl.appendChild(row);
        }
    }

    /**
     * Formats the enriched room context as a compact one-line summary.
     * @private
     * @param {Object} context - Enriched context object from /world-events.
     * @returns {string}
     */
    _formatContext(context) {
        const size = (context.roomWidth != null && context.roomHeight != null)
            ? ` ${context.roomWidth}x${context.roomHeight}`
            : '';
        const you = (context.playerPosition)
            ? ` you: (${Math.round(context.playerPosition.x)}, ${Math.round(context.playerPosition.y)})`
            : '';
        const others = this._formatOthers(context.entities);
        const items = Array.isArray(context.droppedItems) ? context.droppedItems.length : 0;
        const exits = Array.isArray(context.exits) && context.exits.length > 0
            ? ` | exits: ${context.exits.map(e => `${e.door}→${e.targetRoomName}`).join(', ')}`
            : '';
        return `@ ${context.roomName || 'unknown'}${size}${you} | ${others} | items: ${items}${exits}`;
    }

    /**
     * Renders the `others:` segment of the context sub-line: each other same-room
     * entity by name with its position, e.g. `others: Droid A (10, 20), Droid B (5, 5)`.
     *
     * Entities lacking a position render as the bare name (no coordinate slot).
     * The list is capped at AppConfig.EVENTS.CONTEXT_MAX_ENTITIES (mirrors the
     * server-side CONTEXT_MAX_ENTITIES); beyond that the remainder is collapsed
     * into a trailing `… +N` marker to keep the line compact.
     * @private
     * @param {Array<{name?: string, x?: number|null, y?: number|null}>|*} entities
     *   - The same-room entity records from the event context.
     * @returns {string} The `others: …` segment (always non-empty).
     */
    _formatOthers(entities) {
        if (!Array.isArray(entities) || entities.length === 0) {
            return 'others: none';
        }
        const max = AppConfig.EVENTS.CONTEXT_MAX_ENTITIES;
        const shown = entities.slice(0, max);
        const overflow = entities.length - shown.length;

        const parts = shown.map(e => {
            const name = e?.name || 'Droid';
            const hasCoords = typeof e?.x === 'number' && typeof e?.y === 'number';
            return hasCoords
                ? `${name} (${Math.round(e.x)}, ${Math.round(e.y)})`
                : name;
        });

        const tail = overflow > 0 ? ` … +${overflow}` : '';
        return `others: ${parts.join(', ')}${tail}`;
    }

    /**
     * Renders an empty state when no events exist.
     * @private
     */
    _renderEmpty() {
        if (!this._listEl) return;
        this._listEl.innerHTML = '';
        const row = document.createElement('div');
        row.className = 'event-log-row event-log-empty';
        row.textContent = 'No recent events.';
        this._listEl.appendChild(row);
    }

    /**
     * Renders a failure state when the fetch fails.
     * @private
     */
    _renderError() {
        if (!this._listEl) return;
        this._listEl.innerHTML = '';
        const row = document.createElement('div');
        row.className = 'event-log-row event-log-empty';
        row.textContent = 'Could not load events.';
        this._listEl.appendChild(row);
    }
}
