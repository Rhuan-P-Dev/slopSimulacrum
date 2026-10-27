/**
 * RoundProsePanel — "Round Prose" dev inspector.
 *
 * Shows, for a chosen round, the natural-prose reconstruction that the round-prose
 * reader assembles from perception's per-room delta stream: a one-line round summary
 * (change count + live/settled wording, tick window) plus one flowing prose
 * paragraph per room that saw activity in the round's tick window. The payload is
 * fetched live on open (and on any manual re-fetch / while-open refresh) from
 * GET /perception/round/:roundNumber — it is never derived from the broadcast and
 * never refreshed in the background without the live-round refresh hook.
 *
 * Follows the project's floating-overlay pattern (init/show/hide/toggle, driven
 * by OverlayManager). The current round is pre-filled from state.turns.roundNumber
 * (the world-state `turns` block) when available, else 0; the user can type any
 * 0-based round to revisit an earlier one.
 *
 * @module ui/RoundProsePanel
 */
import ClientLogger from '/utils/ClientLogger.js';

export class RoundProsePanel {
    /**
     * @param {{ worldStateManager?: Object }} [opts] — source of the live world
     *   state (state.turns.roundNumber) used to pre-fill the round picker.
     */
    constructor({ worldStateManager = null } = {}) {
        this._ws = worldStateManager || null;
        this._overlay = null;
        this._controls = null;
        this._content = null;
        this._input = null;
        this._liveBtn = null;
        this._refreshBtn = null;
        this._initialized = false;
        this._inFlight = false;
        this._lastPayload = null;
    }

    // ---------------------------------------------------------------- init

    init() {
        if (this._initialized) return;
        this._overlay = document.getElementById('round-prose-overlay');
        this._content = document.getElementById('round-prose-content');
        if (!this._overlay || !this._content) {
            throw new Error('RoundProsePanel: #round-prose-overlay / #round-prose-content not found.');
        }

        const controls =
            document.getElementById('round-prose-controls')
            || (function () {
                const el = document.createElement('div');
                el.id = 'round-prose-controls';
                el.className = 'round-prose-controls';
                this._overlay.insertBefore(el, this._content);
                return el;
            }.call(this));
        this._controls = controls;
        this._controls.innerHTML =
            '<label class="round-prose-label" for="round-prose-round-input">round</label>' +
            '<input id="round-prose-round-input" class="round-prose-input" type="number" min="0" step="1" ' +
            'title="Round number to visualize (0-based)" autocomplete="off" />' +
            '<button id="round-prose-live" class="round-prose-btn" title="Fetch the live round">Live</button>' +
            '<button id="round-prose-refresh" class="round-prose-btn" title="Fetch the selected round">&#8650;</button>';

        this._input = this._controls.querySelector('#round-prose-round-input');
        this._liveBtn = this._controls.querySelector('#round-prose-live');
        this._refreshBtn = this._controls.querySelector('#round-prose-refresh');

        this._input.addEventListener('change', () => this._doLoad());
        this._input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this._doLoad();
            }
        });
        if (this._liveBtn) {
            this._liveBtn.addEventListener('click', () => {
                this._setRound(this._currentRoundNumber());
                this._doLoad();
            });
        }
        if (this._refreshBtn) {
            this._refreshBtn.addEventListener('click', () => this._doLoad());
        }

        this._initialized = true;
        this._overlay.style.display = 'none';
    }

    // ---------------------------------------------------------------- show/hide

    /**
     * Called by OverlayManager.open() (with a data argument this ignores — the
     * panel owns its round selection and re-fetches on every open).
     */
    show(data) {
        void data;
        this.init();
        if (!this._overlay) return;
        this._overlay.style.display = 'block';
        this._setRound(this._currentRoundNumber());
        this._doLoad();
    }

    hide() {
        if (this._overlay) this._overlay.style.display = 'none';
    }

    toggle() {
        if (this._overlay && this._overlay.style.display === 'block') this.hide();
        else this.show();
    }

    isVisible() {
        return !!this._overlay && this._overlay.style.display === 'block';
    }

    /** Re-fetches whatever round is in the input (no-op when hidden or in flight). */
    refresh() {
        this._doLoad();
    }

    // ---------------------------------------------------------------- state

    /**
     * The round the client currently sees as live (state.turns.roundNumber), or
     * null when there is no state / no turn block yet. The world-state refresh
     * keeps this fresh, so a "Live" fetch always targets the real current round.
     */
    _currentRoundNumber() {
        const turns = this._ws ? this._ws.getState()?.turns : null;
        return turns && Number.isFinite(turns.roundNumber) ? turns.roundNumber : null;
    }

    _setRound(round) {
        if (round == null || !Number.isFinite(round)) {
            this._input.value = '';
            return;
        }
        this._input.value = String(Math.max(0, Math.floor(round)));
    }

    /**
     * Parses the current input to a non-negative integer round, or null when the
     * field is empty / not an integer (e.g. "2.5" or "1e2").
     */
    _parseRound() {
        const raw = this._input ? String(this._input.value) : '';
        const trimmed = raw.trim();
        if (trimmed === '') return null;
        const n = Number(raw);
        return Number.isInteger(n) && n >= 0 ? n : null;
    }

    // ---------------------------------------------------------------- data

    async _doLoad() {
        if (!this.isVisible()) return;
        if (this._inFlight) return;
        const round = this._parseRound();
        if (round == null) {
            this._renderNoInput();
            return;
        }
        this._inFlight = true;
        try {
            const payload = await this._fetchRound(round);
            this._lastPayload = payload;
            this._render(payload);
        } catch (err) {
            ClientLogger.error('RoundProsePanel', 'load failed:', err);
            const message =
                (err && err.message ? err.message : String(err));
            this._render(null, { error: message, round });
        } finally {
            this._inFlight = false;
        }
    }

    async _fetchRound(round) {
        const resp = await fetch('/perception/round/' + encodeURIComponent(round));
        if (!resp.ok) {
            const body = await resp.json().catch(() => null);
            const message =
                (body && (body.message || body.error))
                ? (body.message || body.error)
                : `HTTP ${resp.status}`;
            throw new Error(message);
        }
        return resp.json();
    }

    // ---------------------------------------------------------------- render

    _render(payload, meta = {}) {
        if (!this._content) return;
        const p = (payload && typeof payload === 'object') ? payload : null;
        if (!p) {
            this._content.innerHTML =
                `<div class="round-prose-placeholder"><strong>Error</strong><br>` +
                `${this._esc(meta.error || 'Unable to load the round prose.')}</div>`;
            return;
        }
        const parts = [this._headerHtml(p)];
        const roomBlocks = this._roomBlocksHtml(p);
        if (roomBlocks) parts.push(roomBlocks);
        this._content.innerHTML = parts.join('');
    }

    _renderNoInput() {
        if (!this._content) return;
        this._content.innerHTML =
            '<div class="round-prose-placeholder">' +
            'Type a round number (0-based) above, or hit <strong>Live</strong>, ' +
            'to load a round\'s prose.</div>';
    }

    _headerHtml(p) {
        const badges = [];
        badges.push(
            p.live
                ? '<span class="round-prose-badge neon">LIVE</span>'
                : '<span class="round-prose-badge info">SETTLED</span>'
        );
        badges.push(`<span class="round-prose-stat">ticks ${this._esc(String(p.startTick))}&ndash;${this._esc(String(p.endTick))}</span>`);
        badges.push(`<span class="round-prose-stat">${this._esc(String(p.entryCount))} change${this._esc(String(p.entryCount)) === '1' ? '' : 's'}</span>`);
        return `<div class="round-prose-header"><span class="round-prose-round">Round #${this._esc(String(p.round))}</span></div>` +
            `<div class="round-prose-badges">${badges.join('')}</div>` +
            `<p class="round-prose-summary">${this._esc(p.summary)}</p>`;
    }

    /**
     * One block per room that has prose in the round (deterministic order:
     * room name, then uid), so repeated fetches lay out the same way.
     */
    _roomBlocksHtml(p) {
        const rooms = (p.rooms && typeof p.rooms === 'object') ? p.rooms : {};
        const ids = Object.keys(rooms);
        if (ids.length === 0) return '';
        const ordered = ids.sort((a, b) => {
            const an = (rooms[a] && typeof rooms[a].name === 'string' && rooms[a].name) || a;
            const bn = (rooms[b] && typeof rooms[b].name === 'string' && rooms[b].name) || b;
            if (an < bn) return -1;
            if (an > bn) return 1;
            return (a < b) ? -1 : (a > b) ? 1 : 0;
        });
        return ordered.map((uid) => {
            const r = rooms[uid] || {};
            const name = (r.name && r.name) ? r.name : uid;
            const count = Number.isFinite(r.entryCount) ? r.entryCount : 0;
            const text = (typeof r.text === 'string' && r.text) ? r.text : '';
            return `<div class="round-prose-room"><div class="round-prose-room-header">` +
                `<span class="round-prose-room-name">${this._esc(name)}</span>` +
                `<span class="round-prose-stat">${this._esc(String(count))} ${count === 1 ? 'entry' : 'entries'}</span>` +
                `</div>` +
                (text
                    ? `<p class="round-prose-text">${this._esc(text)}</p>`
                    : '<p class="round-prose-empty">no prose for this room</p>') +
                `</div>`;
        }).join('');
    }

    // ---------------------------------------------------------------- helpers

    _esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, (m) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[m]));
    }
}

export default RoundProsePanel;
