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
        this._fromInput = null;
        this._toInput = null;
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
            '<label class="round-prose-label" for="round-prose-from-input">range</label>' +
            '<input id="round-prose-from-input" class="round-prose-input" type="number" min="0" step="1" ' +
            'title="First round of the range (0-based)" autocomplete="off" />' +
            '<span class="round-prose-range-sep" aria-hidden="true">&rarr;</span>' +
            '<input id="round-prose-to-input" class="round-prose-input" type="number" min="0" step="1" ' +
            'title="Last round of the range (0-based)" autocomplete="off" />' +
            '<button id="round-prose-live" class="round-prose-btn" title="Fetch the live round">Live</button>' +
            '<button id="round-prose-refresh" class="round-prose-btn" title="Fetch the selected range">&#8650;</button>';

        this._fromInput = this._controls.querySelector('#round-prose-from-input');
        this._toInput = this._controls.querySelector('#round-prose-to-input');
        this._liveBtn = this._controls.querySelector('#round-prose-live');
        this._refreshBtn = this._controls.querySelector('#round-prose-refresh');

        const onRangeInput = () => this._doLoad();
        const onRangeKeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                onRangeInput();
            }
        };
        this._fromInput.addEventListener('change', onRangeInput);
        this._fromInput.addEventListener('keydown', onRangeKeydown);
        this._toInput.addEventListener('change', onRangeInput);
        this._toInput.addEventListener('keydown', onRangeKeydown);
        if (this._liveBtn) {
            this._liveBtn.addEventListener('click', () => {
                this._setRange(this._currentRoundNumber());
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
        this._setRange(this._currentRoundNumber());
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

    /** Sets both range inputs to the given round (open / Live) — from and to
     * equal by default, so the old single-round UX is preserved. */
    _setRange(round) {
        if (round == null || !Number.isFinite(round)) {
            this._fromInput.value = '';
            this._toInput.value = '';
            return;
        }
        const value = String(Math.max(0, Math.floor(round)));
        this._fromInput.value = value;
        this._toInput.value = value;
    }

    /**
     * Pairs the current range inputs into non-negative integers with `from <=
     * to`, or null when a field is empty / not an integer (e.g. "2.5") or
     * `from > to`. The panel shows an inline hint on null; the server rejects
     * `to` beyond the current round with a message naming it.
     */
    _parseRange() {
        const parsed = (element) => {
            const raw = (element ? String(element.value) : '').trim();
            if (raw === '') return null;
            const n = Number(raw);
            return Number.isInteger(n) && n >= 0 ? n : null;
        };
        const from = parsed(this._fromInput);
        const to = parsed(this._toInput);
        if (from === null || to === null || from > to) {
            return null;
        }
        return { from, to };
    }

    // ---------------------------------------------------------------- data

    async _doLoad() {
        if (!this.isVisible()) return;
        if (this._inFlight) return;
        const range = this._parseRange();
        if (!range) {
            this._renderNoInput();
            return;
        }
        this._inFlight = true;
        try {
            const payload = await this._fetchRange(range.from, range.to);
            this._lastPayload = payload;
            this._renderRange(payload);
        } catch (err) {
            ClientLogger.error('RoundProsePanel', 'load failed:', err);
            const message =
                (err && err.message ? err.message : String(err));
            this._renderRange(null, { error: message });
        } finally {
            this._inFlight = false;
        }
    }

    /** One request for the whole range [from, to] (already-parsed integers). */
    async _fetchRange(from, to) {
        const resp = await fetch('/perception/rounds/' + from + '/' + to);
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

    /**
     * Range payload { from, to, rounds: [ ... ] } — one entry per integer of
     * the range. Observed rounds get the standard header/badges/summary/room
     * layout inside a per-round section; evicted rounds get a one-line marker.
     * Deterministic in input order (the server emits ascending).
     */
    _renderRange(payload, meta = {}) {
        if (!this._content) return;
        const p = (payload && typeof payload === 'object') ? payload : null;
        if (!p || !Array.isArray(p.rounds)) {
            this._content.innerHTML =
                `<div class="round-prose-placeholder"><strong>Error</strong><br>` +
                `${this._esc(meta.error || 'Unable to load the range prose.')}</div>`;
            return;
        }
        const parts = [this._rangeHeaderHtml(p)];
        for (const r of p.rounds) {
            if (r && r.observed === true) {
                parts.push(
                    '<div class="round-prose-round-item">' +
                    this._headerHtml(r) +
                    this._roomBlocksHtml(r) +
                    '</div>'
                );
            } else {
                const n = (r && typeof r.round === 'number') ? r.round : 'n/a';
                parts.push(
                    '<div class="round-prose-round-missing">' +
                    'Round #' + this._esc(String(n)) +
                    ' &mdash; not observed (out of the recent-history window)' +
                    '</div>'
                );
            }
        }
        this._content.innerHTML = parts.join('');
    }

    /** One line above the read: requested bounds + observed vs. evicted. */
    _rangeHeaderHtml(p) {
        const rounds = p.rounds || [];
        const observedCount = rounds.filter((r) => r && r.observed === true).length;
        const missingCount = rounds.length - observedCount;
        const missingPart = missingCount > 0
            ? `<span class="round-prose-stat missing">${missingCount} missing</span>`
            : '';
        return '<div class="round-prose-range">' +
            `<span class="round-prose-stat">range ${this._esc(String(p.from))}&rarr;${this._esc(String(p.to))}</span>` +
            `<span class="round-prose-stat">${observedCount} of ${rounds.length} observed</span>` +
            missingPart +
            '</div>';
    }

    _renderNoInput() {
        if (!this._content) return;
        this._content.innerHTML =
            '<div class="round-prose-placeholder">' +
            'Type a range (from&rarr;to, 0-based) above, or hit <strong>Live</strong>, ' +
            'to load the rounds in range.</div>';
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
