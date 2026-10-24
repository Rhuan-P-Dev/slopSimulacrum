/**
 * AgentViewPanel — "Agent View" dev inspector.
 *
 * Shows, for a chosen NPC agent, exactly what the LLM agent would receive in a
 * live round: resolved NPC config, system prompt, the full tool set (byte-
 * identical to the round runner), the sectioned world context (narrative +
 * structured data + render stats), the live action registry, generated
 * instincts, and the last replayable transcript round (assistant content /
 * reasoning / tool calls + per-call results).
 *
 * Follows the project's floating-overlay pattern (init/show/hide/toggle, driven
 * by OverlayManager). The payload is fetched from GET /llm/agent/:entityId on
 * open (and on manual refresh) — it is never refreshed in the background.
 *
 * @module ui/AgentViewPanel
 */
import ClientLogger from '/utils/ClientLogger.js';

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
        if (p.systemPrompt != null) {
            parts.push(this._section('System Prompt', `<pre class="agent-view-pre">${this._esc(p.systemPrompt)}</pre>`));
        }
        parts.push(this._transcriptSection(p));
        parts.push(this._toolsSection(p));
        parts.push(this._contextSection(p));
        if (p.context && p.context.data != null) {
            parts.push(this._section('Context (structured data)', `<pre class="agent-view-pre">${this._json(p.context.data)}</pre>`));
        }
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
        const stats = p.context && p.context.stats ? p.context.stats : {};
        if (stats.chars != null) {
            badges.push(`<span class="agent-view-stat">context ${stats.chars}</span>`);
            if (stats.budgetChars != null) badges.push(`<span class="agent-view-stat">budget ${stats.budgetChars}</span>`);
        }
        if (stats.truncated && Object.keys(stats.truncated).length) {
            for (const [k, v] of Object.entries(stats.truncated)) if (v === true) badges.push(`<span class="agent-view-stat truncated">trunc:${this._esc(k)}</span>`);
        }
        const roomTag = p.room && p.room.id ? `<span class="agent-view-id">&#9776; ${this._esc(p.room.name || p.room.id)}</span>` : '';
        return `<div class="agent-view-header"><span class="agent-view-name">${this._esc(p.name || p.entityId || 'unknown')}</span><span class="agent-view-id">${this._esc(p.entityId)}</span>${roomTag}</div>` +
            `<div class="agent-view-badges">${badges.join('')}</div>`;
    }

    _transcriptSection(p) {
        const t = p.transcript;
        if (!t) {
            return this._section('Last Round Transcript', '<p class="agent-view-empty">No rounds have been run for this agent yet.</p>');
        }
        const lines = [];
        lines.push(`<p><span class="agent-view-stat">round #${t.round}</span></p>`);
        const content = t.assistant && typeof t.assistant.content === 'string' ? t.assistant.content : null;
        if (content) {
            lines.push(`<pre class="agent-view-pre">${this._esc(content)}</pre>`);
        } else {
            lines.push('<p class="agent-view-empty">— assistant silent (no text) —</p>');
        }
        if (t.assistant && typeof t.assistant.reasoning_content === 'string' && t.assistant.reasoning_content.length > 0) {
            lines.push(this._details('Reasoning (expand)', `<pre class="agent-view-pre">${this._esc(t.assistant.reasoning_content)}</pre>`));
        }
        const calls = t.assistant && Array.isArray(t.assistant.tool_calls) ? t.assistant.tool_calls : [];
        if (calls.length > 0) {
            const per = calls.map(call => {
                const name =
                    (call && call.function && typeof call.function.name === 'string')
                        ? call.function.name
                        : 'unknown';
                const result =
                    (t.toolResults && Array.isArray(t.toolResults))
                        ? (t.toolResults.find(r => r && r.id && r.id === (call && call.id)) || t.toolResults[calls.indexOf(call)])
                        : null;
                const okText = result ? (result.success ? '&#10004; success' : '&#10006; failed') : '';
                const resClass = result ? (result.success ? 'neon' : 'warning') : 'warning';
                return `<div class="agent-view-tool"><div class="agent-view-tool-name">${this._esc(name)}</div>` +
                    (result ? `<p class="agent-view-stat ${resClass}">${okText}</p>` : '') +
                    (result && result.detail ? `<p class="agent-view-note">${this._esc(result.detail)}</p>` : '') +
                    (this._details('args', `<pre class="agent-view-pre">${this._json(this._parseArgs(call))}</pre>`)) +
                    '</div>';
            }).join('');
            lines.push(`<div>${per}</div>`);
        } else {
            lines.push('<p class="agent-view-empty">no tool calls this round</p>');
        }
        if (t.note) lines.push(`<p class="agent-view-note">note: ${this._esc(t.note)}</p>`);
        return this._section('Last Round Transcript', lines.join(''));
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

    _contextSection(p) {
        const ctx = p.context || {};
        const text = (ctx.text == null) ? '' : String(ctx.text);
        const stats = ctx.stats ? ctx.stats : {};
        let badges = '';
        if (stats.chars != null) {
            badges += `<span class="agent-view-stat">context ${stats.chars}</span>`;
            if (stats.budgetChars != null) badges += `<span class="agent-view-stat">budget ${stats.budgetChars}</span>`;
        }
        if (!text) {
            return this._section('World Context (narrative the LLM reads)', `<div>${badges}</div><p class="agent-view-empty">empty</p>`);
        }
        return this._section('World Context (narrative the LLM reads)', `<div>${badges}</div><pre class="agent-view-pre">${this._esc(text)}</pre>`);
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
