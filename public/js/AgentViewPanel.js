/**
 * AgentViewPanel — "Agent View" dev inspector.
 *
 * Two context views, and only one of them is the truth about the prompt
 * (wiki/decisions/inspector-shows-last-request.md):
 *   "Last request to the LLM" — the EXACT message array the model last
 *     received (`payload.lastRequest`, reconstructed server-side from the
 *     stored transcript: the replay plus the saved `round N` anchor).
 * There is no standing room-composition section: it showed a fresh composition
 * of the ROOM, which no agent was ever sent, and the title it carried ("World
 * Context (narrative the LLM reads)") is what made a correct agent read look
 * broken. The one exception is the fallback — when there is no stored request
 * (the transcript is in memory, so after a restart there is none until the
 * agent's next round), `Context (recomposed now — NOT sent to any agent)` shows
 * what the room holds, titled as what it is, so the panel is never left with no
 * context at all. wiki/decisions/inspector-shows-last-request.md and
 * wiki/decisions/round-scoped-context.md.
 *
 * Also shows, for a chosen NPC agent: resolved NPC config, system prompt (the
 * recomputed one only while no request carries its own copy), the full tool set
 * (byte-identical to the round runner), the live action registry, generated
 * instincts, and the full transcript history: every stored round (the
 * inspector cap), newest first, each anchored by its user message (round
 * number + context snapshot) and each with all of its in-round LLM calls —
 * the loop's subcalls (assistant content / reasoning / tool calls) and
 * per-call results.
 *
 * Follows the project's floating-overlay pattern (init/show/hide/toggle, driven
 * by OverlayManager). The payload is fetched from GET /llm/agent/:entityId on
 * open (and on manual refresh) — it is never refreshed in the background.
 *
 * @module ui/AgentViewPanel
 */
import ClientLogger from '/utils/ClientLogger.js';

/** How many messages of a reconstructed request the panel renders (the replay
 * window is a count, not a budget — see _lastRequestSection). */
const RENDERED_MESSAGE_TAIL = 12;

export class AgentViewPanel {

    /**
     * @param {{ worldStateManager?: Object }} [opts] — source of the live entity
     *   list used to build the agent picker.
     */
    constructor({ worldStateManager = null } = {}) {
        this._ws = worldStateManager || null;
        this._overlay = null;
        this._controls = null;
        this._content = null;
        this._picker = null;
        this._initialized = false;
        this._selectedId = null;
        this._lastPayload = null;
        this._inFlight = false;
    }

    // ---------------------------------------------------------------- init

    init() {
        if (this._initialized) return;
        this._overlay = document.getElementById('agent-view-overlay');
        this._content = document.getElementById('agent-view-content');
        if (!this._overlay || !this._content) {
            throw new Error('AgentViewPanel: #agent-view-overlay / #agent-view-content not found.');
        }

        const controls = document.getElementById('agent-view-controls');
        this._controls = controls
            ? controls
            : (function () {
                const el = document.createElement('div');
                el.id = 'agent-view-controls';
                el.className = 'agent-view-controls';
                this._overlay.insertBefore(el, this._content);
                return el;
            }.call(this));
        this._controls.innerHTML =
            '<select id="agent-view-picker" class="agent-view-picker" title="Choose the agent to inspect"></select>' +
            '<button id="agent-view-refresh" class="agent-view-btn" title="Re-fetch the payload">&#8650;</button>';

        this._picker = this._controls.querySelector('#agent-view-picker');
        const refreshBtn = this._controls.querySelector('#agent-view-refresh');

        this._picker.addEventListener('change', () => {
            this._selectedId = this._picker.value || null;
            this._doLoad();
        });
        if (refreshBtn) refreshBtn.addEventListener('click', () => this._doLoad());

        this._initialized = true;
        this._overlay.style.display = 'none';
    }

    // ---------------------------------------------------------------- show/hide

    /**
     * Called by OverlayManager.open() (with a data argument this ignores — the
     * panel owns its selection and re-fetches on every open).
     */
    show(data) {
        void data;
        this.init();
        if (!this._overlay) return;
        this._overlay.style.display = 'block';
        this._reconcileSelection();
        this._rebuildPicker();
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

    /** Manually refresh without re-opening. */
    refresh() {
        this._doLoad();
    }

    // ---------------------------------------------------------------- state

    /**
     * Keeps the selection valid: re-pick when the chosen entity is gone or no
     * selection exists yet. Prefers the player's own entity when it is an NPC,
     * otherwise the first NPC in the world state.
     */
    _reconcileSelection() {
        if (!this._ws) return;
        const state = this._ws.getState() || {};
        const entities = state.entities || {};
        if (this._selectedId && entities[this._selectedId]) return;
        const npcs = Object.values(entities).filter(e => e && e.isNPC === true);
        if (npcs.length === 0) {
            this._selectedId = null;
            return;
        }
        const myId = this._ws.getMyEntityId ? this._ws.getMyEntityId() : null;
        this._selectedId =
            (myId && entities[myId] && entities[myId].isNPC === true)
                ? myId
                : npcs[0].id;
    }

    /**
     * (Re)build the NPC-only dropdown. Only called on open (never on
     * refresh), so it never clobbers a selection the user picked.
     */
    _rebuildPicker() {
        if (!this._picker || !this._ws) return;
        const state = this._ws.getState() || {};
        const entities = state.entities || {};
        const npcs = Object.values(entities).filter(e => e && e.isNPC === true);
        this._picker.innerHTML = '';
        if (npcs.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'No NPC agents in world state';
            this._picker.appendChild(opt);
            return;
        }
        for (const e of npcs) {
            const opt = document.createElement('option');
            opt.value = e.id;
            const label = e.name || e.id || 'unknown';
            opt.textContent = label.length > 52 ? label.slice(0, 52) + '…' : label;
            this._picker.appendChild(opt);
        }
        // Restore the (reconciled) selection if still present.
        if (this._selectedId && this._picker.value !== this._selectedId) {
            this._picker.value = this._selectedId;
        }
    }

    // ---------------------------------------------------------------- data

    async _doLoad() {
        if (!this.isVisible()) return;
        const id = this._selectedId;
        if (!id) {
            this._renderNoNpcs();
            return;
        }
        if (this._inFlight) return;
        this._inFlight = true;
        try {
            const payload = await this._fetchAgent(id);
            this._lastPayload = payload;
            this._render(payload);
        } catch (err) {
            ClientLogger.error('AgentViewPanel', 'load failed:', err);
            this._render(null, { error: String(err && err.message ? err.message : err) });
        } finally {
            this._inFlight = false;
        }
    }

    async _fetchAgent(entityId) {
        const resp = await fetch('/llm/agent/' + encodeURIComponent(entityId));
        if (!resp.ok) {
            const body = await resp.json().catch(() => null);
            throw new Error(body && body.error ? body.error : `HTTP ${resp.status}`);
        }
        return resp.json();
    }

    // ---------------------------------------------------------------- render

    _render(payload, meta = {}) {
        if (!this._content) return;
        const p = (payload && typeof payload === 'object') ? payload : null;
        const c = this._content;
        if (!p) {
            c.innerHTML = `<div class="agent-view-placeholder"><strong>Error</strong><br><span class="agent-view-empty">${this._esc(meta.error || 'Unable to load the agent payload.')}</span></div>`;
            return;
        }
        const parts = [];
        parts.push(this._headerHtml(p));
        if (p.error && p.error !== 'ENTITY_NOT_FOUND') {
            parts.push(this._section('Error', `<p class="agent-view-note">${this._esc(p.error)}</p>`));
        }
        // The standalone System Prompt section is the recomputed one; when the
        // last request is on screen its own copy is shown there instead, so the
        // operator never sees two "the" system prompts.
        if (p.systemPrompt != null && !(p.lastRequest && p.lastRequest.system != null)) {
            parts.push(this._section('System Prompt (recomputed now)', `<pre class="agent-view-pre">${this._esc(p.systemPrompt)}</pre>`));
        }
        parts.push(this._lastRequestSection(p));
        // There is no stored request to show: the operator is not left with a
        // panel that contains no context at all. What the room holds right now
        // goes on screen instead, under a title that says what it is — built now,
        // for this round, sent to nobody. With a stored request this section is
        // not rendered: the exact array is above it and two context blocks, one
        // of them a lie by omission, is how this panel got distrusted once.
        if (!this._hasStoredRequest(p)) {
            parts.push(this._liveContextSection(p));
        }
        parts.push(this._transcriptSection(p));
        parts.push(this._toolsSection(p));
        // No room-tail section and no structured-context section: both rendered a
        // fresh recomposition of the ROOM, which is not what any agent was sent
        // (wiki/decisions/inspector-shows-last-request.md). What the room holds
        // lives behind GET /world-events and GET /rooms/:id/chat.
        if (p.registry && Object.keys(p.registry).length > 0) {
            parts.push(this._section('Action registry (execute_action candidates)', `<pre class="agent-view-pre">${this._json(p.registry)}</pre>`));
        }
        if (p.instincts && Array.isArray(p.instincts) && p.instincts.length > 0) {
            parts.push(this._section('Instincts (use_instinct enum)', `<pre class="agent-view-pre">${this._json(p.instincts)}</pre>`));
        }
        c.innerHTML = parts.join('');
    }

    _renderNoNpcs() {
        if (!this._content) return;
        this._content.innerHTML = `<div class="agent-view-placeholder">No NPC agents in the world state yet — wait for the world to spawn them, then pick one.</div>`;
    }

    _headerHtml(p) {
        const badges = [];
        if (p.isNpc) badges.push('<span class="agent-view-badge neon">NPC</span>');
        if (p.deterministicBrain) {
            badges.push('<span class="agent-view-badge warning">DETERMINISTIC AI — LLM does not run</span>');
        }
        // The size badge describes the REQUEST the model actually received, not a
        // recomposition (the room-tail section it used to measure is gone —
        // wiki/decisions/inspector-shows-last-request.md).
        const req = p.lastRequest;
        if (req && Array.isArray(req.messages)) {
            const chars = req.messages.reduce((n, m) => n + String(m.content || '').length, 0);
            badges.push(`<span class="agent-view-stat">request ${this._esc(String(chars))} chars / ${this._esc(String(req.messages.length))} msgs</span>`);
        }
        const roomTag = p.room && p.room.id ? `<span class="agent-view-id">&#9776; ${this._esc(p.room.name || p.room.id)}</span>` : '';
        return `<div class="agent-view-header"><span class="agent-view-name">${this._esc(p.name || p.entityId || 'unknown')}</span><span class="agent-view-id">${this._esc(p.entityId)}</span>${roomTag}</div>` +
            `<div class="agent-view-badges">${badges.join('')}</div>`;
    }

    _transcriptSection(p) {
        const rounds = (p.transcriptRounds && Array.isArray(p.transcriptRounds)) ? p.transcriptRounds : [];
        if (rounds.length === 0) {
            return this._section('Transcript (all rounds)', '<p class="agent-view-empty">No rounds have been run for this agent yet.</p>');
        }
        // Server stores oldest → newest; the inspector reads newest first.
        const ordered = Array.from(rounds).reverse();
        const parts = ordered.map((t, i) => this._roundHtml(t, i === 0));
        return this._section(`Transcript (${rounds.length} round${rounds.length > 1 ? 's' : ''} stored)`, parts.join(''));
    }

    _roundHtml(t, isLatest) {
        const lines = [];
        lines.push(`<div class="agent-view-round-header"><span class="agent-view-stat">round #${t.round == null ? '?' : this._esc(t.round)}</span>` +
            (isLatest ? '<span class="agent-view-badge neon">latest</span>' : '') +
            (t.note ? `<span class="agent-view-badge info">${this._esc(t.note)}</span>` : '') +
            (t.error ? `<span class="agent-view-badge warning">${this._esc(t.error)}</span>` : '') +
            '</div>');
        // The context snapshot saved for that round — what the LLM saw, in
        // the same round-anchored form as the replay. Collapsed (the exact
        // request is the "Last request to the LLM" section; the Room tail
        // section is NOT a prompt — see the module header). The tab renders
        // every round the server exposes and imposes no cap of its own — the
        // stored buffer is capped server-side, see llm-memory-window.md.
        if (typeof t.context === 'string' && t.context.length > 0) {
            lines.push(this._details('context snapshot (round ' +
                (t.round == null ? '?' : String(t.round)) + ')',
                `<pre class="agent-view-pre">${this._esc(t.context)}</pre>`));
        }
        const groups = Array.isArray(t.groups) ? t.groups : [];
        if (groups.length === 0) {
            lines.push('<p class="agent-view-empty">no LLM calls this round</p>');
        }
        for (let i = 0; i < groups.length; i += 1) {
            lines.push(this._groupHtml(groups[i], i + 1, groups.length));
        }
        return `<div class="agent-view-round${isLatest ? ' agent-view-round-latest' : ''}">${lines.join('')}</div>`;
    }

    _groupHtml(g, index, total) {
        const lines = [];
        lines.push(`<div class="agent-view-group-header"><span class="agent-view-stat">LLM call ${index}${total > 1 ? ` of ${total}` : ''}</span></div>`);
        const content = g && typeof g.content === 'string' ? g.content : null;
        if (content) {
            lines.push(`<pre class="agent-view-pre">${this._esc(content)}</pre>`);
        } else {
            lines.push('<p class="agent-view-empty">— assistant silent (no text) —</p>');
        }
        if (g && typeof g.reasoning_content === 'string' && g.reasoning_content.length > 0) {
            lines.push(this._details('Reasoning (expand)', `<pre class="agent-view-pre">${this._esc(g.reasoning_content)}</pre>`));
        }
        const calls = (g && Array.isArray(g.tool_calls)) ? g.tool_calls : [];
        if (calls.length > 0) {
            const results = (g && Array.isArray(g.results)) ? g.results : [];
            const per = calls.map((call, ci) => {
                const name =
                    (call && call.function && typeof call.function.name === 'string')
                        ? call.function.name
                        : 'unknown';
                // Match the per-call result by id first; positional fallback
                // when the model omitted one (results are stored per call).
                const result =
                    (results.find(r => r && r.id && r.id === (call && call.id))
                        || results[ci]
                        || null);
                const okText = result ? (result.success ? '&#10004; success' : '&#10006; failed') : '';
                const resClass = result ? (result.success ? 'neon' : 'warning') : 'warning';
                const listInfo = (result && Array.isArray(result.list)) ? ` (${result.list.length} entries)` : '';
                const listPre = (result && typeof result.list === 'string' && result.list.length > 0)
                    ? this._details('result list', `<pre class="agent-view-pre">${this._esc(result.list)}</pre>`)
                    : '';
                return `<div class="agent-view-tool"><div class="agent-view-tool-name">${this._esc(name)}</div>` +
                    (result ? `<p class="agent-view-stat ${resClass}">${okText}${listInfo}</p>` : '') +
                    (result && result.detail ? `<p class="agent-view-note">${this._esc(result.detail)}</p>` : '') +
                    listPre +
                    (this._details('args', `<pre class="agent-view-pre">${this._json(this._parseArgs(call))}</pre>`)) +
                    '</div>';
            }).join('');
            lines.push(`<div>${per}</div>`);
        } else {
            lines.push('<p class="agent-view-empty">no tool calls</p>');
        }
        return `<div class="agent-view-group">${lines.join('')}</div>`;
    }

    _toolsSection(p) {
        const tools = (p.tools && Array.isArray(p.tools)) ? p.tools : [];
        if (tools.length === 0) {
            return this._section('Tools', '<p class="agent-view-empty">none (agent unavailable or no rounds yet)</p>');
        }
        const cards = tools.map(t => {
            // OpenAI schema: { type:'function', function:{name, description, parameters} }.
            // Fall back to a flattened shape if it ever appears.
            const fn = (t && t.function && typeof t.function === 'object') ? t.function : (t && typeof t === 'object' ? t : {});
            const name = (fn && fn.name && typeof fn.name === 'string') ? fn.name : 'unknown';
            const params = (fn && fn.parameters && typeof fn.parameters === 'object')
                ? fn.parameters
                : (fn && fn.schema && typeof fn.schema === 'object') ? fn.schema : null;
            const desc = (fn && fn.description)
                ? `<p class="agent-view-tool-desc">${this._esc(fn.description)}</p>`
                : '';
            const paramsHtml = params
                ? this._details('parameters (JSON Schema)', `<pre class="agent-view-pre">${this._json(params)}</pre>`) 
                : '';
            const enumNote = name === 'execute_action' ? this._actionEnumNote(fn) : '';
            return `<div class="agent-view-tool"><div class="agent-view-tool-name">${this._esc(name)}</div>${desc}${paramsHtml}${enumNote}</div>`;
        }).join('');
        return this._section(`Tools (${tools.length})`, cards);
    }

    _actionEnumNote(fn) {
        const props = (fn && fn.parameters && fn.parameters.properties) ? fn.parameters.properties : {};
        const actionProp = props.actionName;
        const enumArr = (actionProp && Array.isArray(actionProp.enum)) ? actionProp.enum : null;
        if (!enumArr) return '';
        const names = enumArr.map(a => this._esc(String(a)));
        return `<p class="agent-view-stat">execute_action.enum (${names.length}):</p><p class="agent-view-note">${names.join(' &middot; ')}</p>`;
    }

    /**
     * The exact request the model last received, as the server reconstructed it
     * (`payload.lastRequest`). Nothing here is recomposed: the message array is
     * the one that went out.
     *
     * Renders the tail of the array only. The replay window is a COUNT, not a
     * budget (llm-memory-window.md), so a long-running world can carry thousands
     * of replayed rounds — printing every message would freeze the tab, which is
     * the failure that note already warns about.
     */
    _lastRequestSection(p) {
        const req = p.lastRequest;
        if (!this._hasStoredRequest(p)) {
            // Naming the reason is the section. "Nothing has been sent" read as
            // "the feature is broken"; what actually happened is that the request
            // lives in memory, so a restart empties it, or the server answering
            // this request is older than the field itself.
            const why = !('lastRequest' in p)
                ? 'This server did not answer a <code>lastRequest</code> field at all — the running process is older than this view. Restart the server.'
                : 'No LLM round has been stored for this agent since the server started. The transcript is in memory: a restart empties it, and the next round the agent runs fills this in.';
            return this._section('Last request to the LLM',
                `<p class="agent-view-empty">${why}</p>`);
        }
        const messages = req.messages;
        const total = messages.length;
        const shown = messages.slice(-RENDERED_MESSAGE_TAIL);
        const head = `<p class="agent-view-note">Round <strong>${this._esc(String(req.round))}</strong> — the message array the model received, reconstructed from the stored transcript (not recomposed).</p>`;
        const sys = req.system != null
            ? this._details('system prompt', `<pre class="agent-view-pre">${this._esc(req.system)}</pre>`, false)
            : '';
        const skipped = total - shown.length;
        const skippedNote = skipped > 0
            ? `<p class="agent-view-note">${skipped} earlier message${skipped > 1 ? 's' : ''} of this request not rendered (replay window is a count, not a budget — llm-memory-window.md). Total: ${total}.</p>`
            : '';
        // Absolute position of each rendered message in the request (the tail
        // starts at skipped + 1), so the chips number the array as sent and
        // _messageHtml can tell the live anchor from a replayed one.
        const body = shown.map((m, i) => this._messageHtml(m, skipped + i + 1, total)).join('');
        return this._section(`Last request to the LLM (round ${req.round})`,
            `${head}${sys}${skippedNote}${body || '<p class="agent-view-empty">no messages</p>'}`);
    }

    /**
     * Whether the payload carries a reconstructed request at all. `messages` is
     * the part that renders, so a payload without it is the same case as none.
     * @param {Object} p - the agent payload
     * @returns {boolean}
     */
    _hasStoredRequest(p) {
        return !!(p && p.lastRequest && Array.isArray(p.lastRequest.messages));
    }

    /**
     * The live room composition, for the case where no stored request exists:
     * `payload.context`, built by the server at this moment (the same
     * `buildContext(entityId, { observe: false })` the routes use — which now
     * means the round in force, framed once, the same rows a reader of that
     * round gets).
     *
     * It is labelled as what it is. The old section here was titled "World
     * Context (narrative the LLM reads)", and that title is what made a correct
     * agent read look broken (wiki/decisions/inspector-shows-last-request.md);
     * the section is back only as an explicitly-unlabelled-as-a-prompt fallback,
     * and only when there is nothing true to show instead
     * (wiki/decisions/round-scoped-context.md).
     * @param {Object} p - the agent payload
     * @returns {string}
     */
    _liveContextSection(p) {
        const ctx = p && p.context && typeof p.context === 'object' ? p.context : null;
        const text = ctx && typeof ctx.text === 'string' ? ctx.text : '';
        if (!text) return '';
        // The size goes in the body, not the title: `_section` escapes its title,
        // so markup handed to it renders as literal text.
        const size = ctx.stats && Number.isFinite(ctx.stats.chars)
            ? ` <span class="agent-view-stat">context ${this._esc(String(ctx.stats.chars))} chars</span>`
            : '';
        const note = '<p class="agent-view-note">Composed from the world as it is right now, for the round in force. '
            + `No model received this — it is not a prompt.${size}</p>`;
        return this._section('Context (recomposed now — NOT sent to any agent)',
            `${note}<pre class="agent-view-pre">${this._esc(text)}</pre>`);
    }

    /**
     * One request message: role chip, content, and the tool calls it carries.
     * The anchor user message keeps the round-anchored form the runner sends
     * ("round N" then the context snapshot), so what is on screen is what went
     * out, delimiters included.
     */
    _messageHtml(m, index, total) {
        const role = this._esc(String(m && m.role != null ? m.role : '?'));
        const chip = `<span class="agent-view-badge info">${role}</span>` +
            `<span class="agent-view-stat">#${index}/${total}</span>`;
        const lines = [`<div class="agent-view-msg-header">${chip}</div>`];
        const content = (m && typeof m.content === 'string') ? m.content : null;
        // The last user message is the live round's anchor: open. Everything
        // replayed stays collapsed so the operator reads the newest first.
        const isLastUser = index === total && m && m.role === 'user';
        if (content != null && content.length > 0) {
            const pre = `<pre class="agent-view-pre">${this._esc(content)}</pre>`;
            lines.push(isLastUser ? pre : this._details(`${content.length} chars of content`, pre, false));
        } else if (content === null) {
            lines.push('<p class="agent-view-empty">content: null (tool-call message)</p>');
        }
        const calls = (m && Array.isArray(m.tool_calls)) ? m.tool_calls : [];
        for (const call of calls) {
            const name = (call && call.function && call.function.name) ? call.function.name : '?';
            lines.push(`<p class="agent-view-stat">tool_call ${this._esc(String(name))}</p>` +
                `<pre class="agent-view-pre">${this._esc(JSON.stringify(this._parseArgs(call), null, 2))}</pre>`);
        }
        const results = (m && Array.isArray(m.results)) ? m.results : [];
        for (const res of results) {
            lines.push(`<pre class="agent-view-pre">${this._json(res)}</pre>`);
        }
        return `<div class="agent-view-msg">${lines.join('')}</div>`;
    }



    // ---------------------------------------------------------------- helpers

    _section(title, inner) {
        return `<section class="agent-view-section"><h4>${this._esc(title)}</h4>${inner}</section>`;
    }

    _details(label, inner, open = false) {
        return `<details class="agent-view-details" ${open ? 'open' : ''}><summary>${this._esc(label)}</summary>${inner}</details>`;
    }

    _esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, m => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m]));
    }

    _json(v) {
        return this._esc(JSON.stringify(v == null ? null : v, null, 2));
    }

    _parseArgs(call) {
        const raw = (call && call.function) ? call.function.arguments : null;
        if (raw == null) return null;
        if (typeof raw === 'string') {
            try {
                return JSON.parse(raw);
            } catch {
                return raw;
            }
        }
        return raw;
    }

}

export default AgentViewPanel;
