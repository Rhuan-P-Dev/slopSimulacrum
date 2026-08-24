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
     */
    constructor({ handleError } = {}) {
        /** @type {Function|null} */
        this._handleError = typeof handleError === 'function' ? handleError : null;

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
            const url = `${AppConfig.ENDPOINTS.WORLD_EVENTS}?limit=${AppConfig.EVENTS.HISTORY_LIMIT}`;
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
            this._listEl.appendChild(row);
        }
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
