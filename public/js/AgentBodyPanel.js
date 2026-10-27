/**
 * AgentBodyPanel — "Create Agent Body" dev overlay (RP-1 prompt kind
 * `agent-body-design`; the server judges, this panel inspects).
 *
 * Owns the DOM for #agent-body-overlay and its lifecycle:
 *   - init/show/hide/toggle/isVisible (wired by OverlayManager via App.js)
 *   - the card picker, fed by GET /agent-body/cards
 *   - the one-shot "Design body" action (POST /agent-body/create, in-flight
 *     guard), which renders the design: identity, rationale, body tree,
 *     new-component recipes, LLM call meta, and the captured prompts.
 *   - the one-shot "Save" action (POST /agent-body/save), enabled only after a
 *     design has been rendered: sends the last design's body to the server to
 *     be persisted into the world (blueprint registry + component recipes).
 *     The server re-validates and decides on collisions (overwrite, with a
 *     timestamped backup); a reload makes the new blueprint visible.
 *
 * No design on open (an LLM call costs; the Agent View re-fetches for free,
 * this one does not). Save is a deliberate, separate click — it writes
 * world data and is NOT part of the Design body action.
 * @module public/js/AgentBodyPanel
 */

import ClientLogger from '/utils/ClientLogger.js';

export class AgentBodyPanel {
    constructor() {
        this._initialized = false;
        this._overlay = null;
        this._content = null;
        this._picker = null;
        this._designButton = null;
        this._saveButton = null;
        this._lastDesign = null;
        this._saveInFlight = false;
        this._status = null;
        this._body = null;
        this._inFlight = false;
    }

    // ---------------------------------------------------------------- init

    init() {
        if (this._initialized) {
            return;
        }
        this._overlay = document.getElementById('agent-body-overlay');
        this._content = document.getElementById('agent-body-content');
        if (!this._overlay || !this._content) {
            throw new Error('AgentBodyPanel: #agent-body-overlay / #agent-body-content not found.');
        }

        const controls = document.getElementById('agent-body-controls');
        this._controls = controls
            ? controls
            : (function () {
                const el = document.createElement('div');
                el.id = 'agent-body-controls';
                el.className = 'agent-body-controls';
                this._overlay.insertBefore(el, this._content);
                return el;
            }.call(this));

        this._controls.innerHTML =
            '<span class="agent-body-label" title="Choose the character card">Card:</span>' +
            '<select id="agent-body-picker" class="agent-body-picker" title="Choose the character card"></select>' +
            '<button id="agent-body-design-button" class="agent-body-btn" type="button" title="Ask the LLM to design a body for this card">Design body</button>' +
            '<button id="agent-body-save-button" class="agent-body-btn" type="button" title="Persist the last designed body to the world data files">Save</button>';

        this._picker = this._controls.querySelector('#agent-body-picker');
        this._designButton = this._controls.querySelector('#agent-body-design-button');
        this._saveButton = this._controls.querySelector('#agent-body-save-button');

        const status = document.createElement('p');
        status.className = 'agent-body-status';
        status.id = 'agent-body-status';
        status.textContent = 'No design yet.';
        this._status = status;

        const body = document.createElement('div');
        body.className = 'agent-body-result';
        this._body = body;

        const layout = document.createElement('div');
        layout.className = 'agent-body-layout';
        layout.append(this._status, this._body);
        this._content.append(layout);

        this._picker.addEventListener('change', () => this._toggleDesignEnabled());
        this._designButton.addEventListener('click', () => void this._design());
        this._saveButton.addEventListener('click', () => void this._save());
        this._toggleSaveEnabled();

        this._initialized = true;
        this._overlay.style.display = 'none';
    }

    // ---------------------------------------------------------------- show/hide

    /**
     * Called by OverlayManager.open(). The card list is re-fetched on every
     * open (cards are user files; they may have changed on disk). No design is
     * issued automatically — that is the user's click, and it costs an LLM call.
     */
    show(data) {
        void data;
        this.init();
        if (!this._overlay) return;
        this._overlay.style.display = 'block';
        void this._loadCards();
    }

    hide() {
        if (this._overlay) this._overlay.style.display = 'none';
    }

    toggle() {
        if (this._overlay && this._overlay.style.display === 'block') {
            this.hide();
        } else {
            this.show();
        }
    }

    isVisible() {
        return !!this._overlay && this._overlay.style.display === 'block';
    }

    /** Manually re-fetch the card list without re-opening. */
    refresh() {
        if (!this._picker) return;
        void this._loadCards();
    }

    // ---------------------------------------------------------------- data

    async _loadCards() {
        try {
            const resp = await fetch('/agent-body/cards');
            const payload = await resp.json().catch(() => null);
            if (!resp.ok || !payload || !Array.isArray(payload.cards)) {
                throw new Error(
                    payload && typeof payload.error === 'object' && payload.error.message
                        ? payload.error.message
                        : 'HTTP ' + resp.status
                );
            }
            this._renderCards(payload.cards);
        } catch (err) {
            ClientLogger.error('AgentBodyPanel', 'card list load failed:', err);
            this._renderCards([]);
        }
    }

    _renderCards(cards) {
        if (!this._picker) return;
        this._picker.innerHTML = '';
        if (cards.length === 0) {
            const opt = document.createElement('option');
            opt.disabled = true;
            opt.value = '';
            opt.textContent = 'No card PNGs in data/cards/ — drop a card in, then reload';
            this._picker.appendChild(opt);
        } else {
            for (const c of cards) {
                const opt = document.createElement('option');
                opt.value = c.cardId;
                opt.textContent = (c.name || c.cardId) + '  [' + c.cardId + ']';
                this._picker.appendChild(opt);
            }
        }
        this._toggleDesignEnabled();
    }

    _toggleDesignEnabled() {
        if (!this._designButton) return;
        this._designButton.disabled = this._inFlight || !this._picker || this._picker.value === '';
    }

    async _design() {
        if (this._inFlight) return;
        const cardId = this._picker.value;
        if (!cardId) return;
        this._inFlight = true;
        this._designButton.disabled = true;
        this._setStatus('Designing the body for ' + cardId + ' (one LLM call — this may take a while…');
        try {
            const payload = await this._postDesign(cardId);
            this._render(payload);
            this._setStatus('Design complete — pick a different card to design it again.');
        } catch (err) {
            const message = (err && err.message) ? err.message : String(err);
            ClientLogger.error('AgentBodyPanel', 'design failed:', message);
            this._render(null, { error: message });
            this._setStatus('Design failed: ' + message);
        } finally {
            this._inFlight = false;
            this._toggleDesignEnabled();
        }
    }

    async _postDesign(cardId) {
        const resp = await fetch('/agent-body/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cardId })
        });
        const payload = await resp.json().catch(() => null);
        if (!resp.ok) {
            throw new Error(
                payload && typeof payload.error === 'object' && payload.error.message
                    ? payload.error.message
                    : 'HTTP ' + resp.status + (payload && payload.error ? ' (' + payload.error + ')' : '')
            );
        }
        return payload;
    }

    // ---------------------------------------------------------------- save

    async _save() {
        if (this._saveInFlight) return;
        const design = this._lastDesign;
        if (!design || !design.body || typeof design.body !== 'object') return;
        this._saveInFlight = true;
        this._saveButton.disabled = true;
        this._setStatus('Saving the body to the world…');
        try {
            const result = await this._postSave(design.body);
            const overwrote = (result.blueprintOverwritten || []).length;
            const added = (result.newComponents || []).length;
            this._setStatus(
                'Saved "' + result.blueprintId + '". ' + overwrote +
                ' part definition(s) overwritten, ' + added +
                ' new component added. Reload to see it live.'
            );
        } catch (err) {
            const message = (err && err.message) ? err.message : String(err);
            ClientLogger.error('AgentBodyPanel', 'save failed:', message);
            this._setStatus('Save failed: ' + message);
        } finally {
            this._saveInFlight = false;
            this._toggleSaveEnabled();
        }
    }

    async _postSave(design) {
        const resp = await fetch('/agent-body/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(design)
        });
        const payload = await resp.json().catch(() => null);
        if (!resp.ok) {
            throw new Error(
                payload && typeof payload.error === 'object' && payload.error.message
                    ? payload.error.message
                    : 'HTTP ' + resp.status + (payload && payload.error ? ' (' + payload.error + ')' : '')
            );
        }
        return payload;
    }

    _toggleSaveEnabled() {
        if (!this._saveButton) return;
        this._saveButton.disabled = this._saveInFlight || !this._lastDesign;
    }

    // ---------------------------------------------------------------- render

    _render(payload, meta = {}) {
        if (!this._body) return;
        const p = (payload && typeof payload === 'object') ? payload : null;
        // The Save action persists the LAST successful design (its body). On an
        // error placeholder we clear it so a stale design can never be saved.
        this._lastDesign = p;
        this._toggleSaveEnabled();
        if (!p) {
            this._body.innerHTML =
                '<div class="agent-body-placeholder">' + this._esc('Error: ' + (meta.error || 'Unable to load the design.')) + '</div>';
            return;
        }
        const parts = [];
        parts.push(this._headerHtml(p.card));
        parts.push(this._designSection(p.body));
        parts.push(this._callMetaSection(p.meta));
        parts.push(this._promptsSection(p.meta));
        parts.push(this._section('Raw response (JSON)', '<pre class="agent-body-pre">' + this._json(p) + '</pre>'));
        this._body.innerHTML = parts.join('');
    }

    _headerHtml(card) {
        const parts = [];
        if (card && typeof card === 'object') {
            if (card.name) parts.push('<span class="agent-body-name">' + this._esc(card.name) + '</span>');
            if (card.cardId) parts.push('<span class="agent-body-id">' + this._esc(card.cardId) + '</span>');
            if (card.description) {
                parts.push('<span class="agent-body-desc">' + this._esc(this._clamp(card.description, 160)) + '</span>');
            }
        }
        return '<div class="agent-body-header">' + (parts.length ? parts.join('') : 'no card') + '</div>';
    }

    _clamp(text, maxChars) {
        return text.length <= maxChars ? text : text.slice(0, maxChars) + '…';
    }

    _designSection(body) {
        if (!body || typeof body !== 'object') {
            return this._section('Design', '<p class="agent-body-empty">no design returned</p>');
        }
        const parts = [];
        if (body.blueprintId) {
            parts.push('<p class="agent-body-id">blueprint id: <strong>' + this._esc(body.blueprintId) + '</strong></p>');
        }
        if (body.rationale) {
            parts.push('<p class="agent-body-rationale">' + this._esc(body.rationale) + '</p>');
        }
        const tree = body.structure && typeof body.structure === 'object'
            ? this._treeHtml(body.structure)
            : '<p class="agent-body-error">malformed structure</p>';
        parts.push('<p class="agent-body-subtitle">Body tree</p>' + tree);
        const recipes = Array.isArray(body.components) ? body.components : [];
        if (recipes.length > 0) {
            parts.push(this._section('New components (' + recipes.length + ' — not in the world yet)',
                recipes.map((c) => this._componentCard(c)).join('')));
        } else {
            parts.push('<p class="agent-body-note">No new components — the design uses only existing world components.</p>');
        }
        return '<section class="agent-body-section">' + parts.join('') + '</section>';
    }

    _treeHtml(node) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            return '<span class="agent-body-error">malformed node</span>';
        }
        const slot = node.slot != null
            ? ' <em class="agent-body-slot">(' + this._esc(node.slot) + ')</em>'
            : '';
        const children = Array.isArray(node.children) ? node.children : [];
        return (
            '<div class="agent-body-node">' +
            '<span class="agent-body-component">' + this._esc(node.component) + '</span>' + slot +
            (children.length > 0
                ? '<ul class="agent-body-subtree">' + children.map((c) => this._treeHtml(c)).join('') + '</ul>'
                : '') +
            '</div>'
        );
    }

    _componentCard(component) {
        if (!component || typeof component !== 'object') {
            return '<p class="agent-body-error">malformed recipe</p>';
        }
        const parts = ['<strong class="agent-body-component">' + this._esc(component.name) + '</strong>'];
        if (component.form) {
            parts.push('<span class="agent-body-stat">volume ' + this._esc(component.form.volume) + '</span>');
            if (component.form.position) {
                parts.push('<span class="agent-body-stat">position (' +
                    this._esc(component.form.position.x) + ', ' + this._esc(component.form.position.y) + ')</span>');
            }
        }
        if (Array.isArray(component.materials) && component.materials.length > 0) {
            parts.push('<span class="agent-body-stat">materials: ' + component.materials
                .map((m) => this._esc(m.material) + ' ' + this._esc(m.fraction))
                .join(' + ') + '</span>');
        }
        if (Array.isArray(component.internalComponents) && component.internalComponents.length > 0) {
            parts.push('<span class="agent-body-stat">organs: ' + component.internalComponents
                .map((ic) => typeof ic === 'string' ? this._esc(ic) : this._esc(ic.type) + ' ' + this._json(ic.grants))
                .join(', ') + '</span>');
        }
        if (component.energyCapacity != null) {
            parts.push('<span class="agent-body-stat">energy capacity ' + this._esc(component.energyCapacity) + '</span>');
        }
        return '<div class="agent-body-recipe">' + parts.join(' ') + '</div>';
    }

    _callMetaSection(meta) {
        if (!meta || typeof meta !== 'object') {
            return this._section('LLM call (meta)', '<p class="agent-body-empty">no meta</p>');
        }
        const badges = [];
        if (meta.promptKind) badges.push('<span class="agent-body-stat">kind: ' + this._esc(meta.promptKind) + '</span>');
        if (meta.promptVersion) badges.push('<span class="agent-body-stat">prompt v' + this._esc(meta.promptVersion) + '</span>');
        if (meta.model) badges.push('<span class="agent-body-stat">model: ' + this._esc(meta.model) + '</span>');
        if (meta.finishReason != null) badges.push('<span class="agent-body-stat">finish: ' + this._esc(meta.finishReason) + '</span>');
        if (meta.latencyMs != null) badges.push('<span class="agent-body-stat">latency: ' + this._esc(meta.latencyMs) + ' ms</span>');
        return this._section('LLM call (meta)', '<div class="agent-body-badge-row">' + badges.join('') + '</div>');
    }

    _promptsSection(meta) {
        const messages = (meta && Array.isArray(meta.promptMessages)) ? meta.promptMessages : [];
        const html = messages
            .map((m, i) => this._details(
                'Prompt — ' + (i === 0 ? 'system' : 'user') + ' (' + String(m ? (m.content ? m.content.length : 0) : 0) + ' chars)',
                '<pre class="agent-body-pre">' + this._esc(m && typeof m.content === 'string' ? m.content : '') + '</pre>',
                i === 0
            ))
            .join('');
        return this._section('Prompts used (agent-body-design)', html || '<p class="agent-body-empty">no prompts captured</p>');
    }

    _setStatus(text) {
        if (this._status) {
            this._status.textContent = text;
        }
    }

    // ---------------------------------------------------------------- helpers

    _section(title, inner) {
        return '<section class="agent-body-section"><h4>' + this._esc(title) + '</h4>' + inner + '</section>';
    }

    _details(label, inner, open = false) {
        return '<details class="agent-body-details" ' + (open ? 'open' : '') + '>' +
            '<summary>' + this._esc(label) + '</summary>' + inner + '</details>';
    }

    _esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, m => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m]));
    }

    _json(v) {
        return this._esc(JSON.stringify(v == null ? null : v, null, 2));
    }
}

export default AgentBodyPanel;
