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
 *     be written as one mod package (`data/mods/body-<slug>/`). The server re-validates
 *     and the official data files are never touched. Writing the package is not applying
 *     it: the status line names the package and says applying is the Mods panel's act.
 *   - the tree is editable in one place: each non-root node carries a "hides with
 *     parent" tick box, the mount mark the world reads to keep a part out of the
 *     round prose while the part it hangs on is under cloth. Save posts the
 *     EDITED design (a working copy of the server's body), not the raw model
 *     answer: the operator has the last word on a joint, and the model proposed
 *     it, it did not decide it.
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
        // The design Save will post: a working copy of the server's body, editable
        // in the tree. `_lastDesign` stays the raw response - the "Raw response"
        // section shows it, and it must stay exactly what the model said.
        this._workingDesign = null;
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
            '<button id="agent-body-save-button" class="agent-body-btn" type="button" title="Write the last designed body as a mod package (apply it in the Mods panel)">Save</button>';

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

        // One delegated listener for every mount tick box: the tree is re-rendered
        // as HTML strings, so a per-node listener would leak on each design.
        this._body.addEventListener('change', (event) => this._onMountToggle(event));
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
        // What is saved is the WORKING design: the model proposed the body, the
        // operator's tick boxes decide what hangs behind its cloth.
        const design = this._workingDesign;
        if (!design || typeof design !== 'object') return;
        this._saveInFlight = true;
        this._saveButton.disabled = true;
        this._setStatus('Writing the body as a mod package…');
        try {
            // `_workingDesign` IS the design — `structuredClone(payload.body)` was
            // unwrapped when the working copy was taken. Unwrapping a second time
            // posted `undefined` (an empty request body), and the server answered
            // that the design has no blueprintId, no rationale and no structure.
            const result = await this._postSave(design);
            const added = (result.newComponents || []).length;
            const shadows = (result.overlapsOfficial || []).length;
            // The package exists; the world has not moved. Saying "reloaded to see it
            // live" would be a lie about an act nobody performed.
            this._setStatus(
                'Wrote "' + result.blueprintId + '" as ' + result.packageId + ' (' +
                (result.content || []).join(', ') + '), ' + added + ' new component(s). ' +
                (shadows > 0
                    ? shadows + ' definition(s) the official packages also define - move ' +
                      result.packageId + ' above them in the Mods stack for those to win. '
                    : '') +
                'Apply it in the Mods panel to put the body in the world.'
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
        this._saveButton.disabled = this._saveInFlight || !this._workingDesign;
    }

    // ---------------------------------------------------------------- render

    _render(payload, meta = {}) {
        if (!this._body) return;
        const p = (payload && typeof payload === 'object') ? payload : null;
        // The Save action persists the LAST successful design (its body). On an
        // error placeholder we clear it so a stale design can never be saved.
        this._lastDesign = p;
        // A mutable copy of the design, so the tree tick boxes can change what Save
        // posts. Cleared with the design: a stale body can never be written.
        this._workingDesign = (p && p.body && typeof p.body === 'object')
            ? structuredClone(p.body)
            : null;
        this._toggleSaveEnabled();
        if (!p) {
            this._body.innerHTML =
                '<div class="agent-body-placeholder">' + this._esc('Error: ' + (meta.error || 'Unable to load the design.')) + '</div>';
            return;
        }
        const parts = [];
        parts.push(this._headerHtml(p.card));
        // Rendered from the working copy, so what the tick boxes show is what Save
        // posts - not what the model happened to answer.
        const organsByComponent = (p.organsByComponent &&
            typeof p.organsByComponent === 'object' && !Array.isArray(p.organsByComponent))
            ? p.organsByComponent
            : {};
        parts.push(this._designSection(this._workingDesign, organsByComponent));
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

    _designSection(body, organsByComponent = {}) {
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
            ? this._treeHtml(body.structure, '', organsByComponent)
            : '<p class="agent-body-error">malformed structure</p>';
        parts.push(
            '<p class="agent-body-subtitle">Body tree</p>' +
            '<p class="agent-body-note">Tick "hides with parent" on a part that cloth covers: while the part it hangs on wears a garment, the world does not name it. Save writes what you ticked.</p>' +
            tree
        );
        parts.push(
            '<p class="agent-body-note">Organs (internal components) are listed per part that carries one: a world part takes the world recipe, a new part takes this design; a part with no organs is inert and shows nothing.</p>'
        );
        const recipes = Array.isArray(body.components) ? body.components : [];
        if (recipes.length > 0) {
            parts.push(this._section('New components (' + recipes.length + ' — not in the world yet)',
                recipes.map((c) => this._componentCard(c)).join('')));
        } else {
            parts.push('<p class="agent-body-note">No new components — the design uses only existing world components.</p>');
        }
        parts.push(this._garmentsSection(body));
        parts.push(this._outfitSection(body));
        return '<section class="agent-body-section">' + parts.join('') + '</section>';
    }

    /**
     * The garments the design invents: new wearable ITEMS (matter, volume, the free
     * volume a part must have to accept them). Read-only here — unlike a mount tick
     * box, inventing a garment is the model's judgment, and editing one by hand is
     * editing the world by hand.
     * @param {Object} body
     * @returns {string}
     */
    _garmentsSection(body) {
        const garments = Array.isArray(body.garments) ? body.garments : [];
        if (garments.length === 0) {
            return '<p class="agent-body-note">No new garments — this design invents no wearable item.</p>';
        }
        const cards = garments.map((garment) => {
            if (!garment || typeof garment !== 'object') return '<p class="agent-body-error">malformed garment</p>';
            const badges = [];
            if (garment.displayName) badges.push('<span class="agent-body-stat">' + this._esc(garment.displayName) + '</span>');
            if (garment.form && garment.form.volume != null) {
                badges.push('<span class="agent-body-stat">volume ' + this._esc(garment.form.volume) + '</span>');
            }
            if (garment.wear && garment.wear.minVolume != null) {
                badges.push('<span class="agent-body-stat">needs ' + this._esc(garment.wear.minVolume) + ' free volume</span>');
            }
            if (Array.isArray(garment.materials) && garment.materials.length > 0) {
                badges.push('<span class="agent-body-stat">materials: ' + garment.materials
                    .map((m) => this._esc(m.material) + ' ' + this._esc(m.fraction)).join(' + ') + '</span>');
            }
            return '<div class="agent-body-recipe"><strong class="agent-body-component">' +
                this._esc(garment.name) + '</strong> ' + badges.join(' ') + '</div>';
        });
        return this._section('New garments (' + garments.length + ' — items the world does not have yet)', cards.join(''));
    }

    /**
     * What the design says this body is born wearing. The distinction between an
     * EMPTY outfit and NO outfit is the whole point of the section: one means "wears
     * nothing" and the other means "nobody dressed this body, the world default
     * applies" (`wiki/decisions/outfits.md`).
     * @param {Object} body
     * @returns {string}
     */
    _outfitSection(body) {
        if (!Array.isArray(body.outfit)) {
            return this._section('Outfit',
                '<p class="agent-body-note">No clothing claim was authored — this body keeps the world\'s default clothing at spawn.</p>');
        }
        if (body.outfit.length === 0) {
            return this._section('Outfit',
                '<p class="agent-body-note">Authored empty: born wearing nothing. The default clothing of the spawn loadouts stands down for this body.</p>');
        }
        const rows = body.outfit.map((entry) => (!entry || typeof entry !== 'object')
            ? '<p class="agent-body-error">malformed outfit entry</p>'
            : '<div class="agent-body-recipe"><strong class="agent-body-component">' + this._esc(entry.item) +
              '</strong><span class="agent-body-stat">on ' + this._esc(entry.component) + '</span></div>');
        return this._section('Outfit (' + body.outfit.length + ' — worn at spawn)', rows.join(''));
    }

    /**
     * One node of the body tree, plus the tick box that authors its mount.
     *
     * `path` locates the node inside `_workingDesign.structure` (`children.2.children.0`);
     * the root hangs on nothing, so it gets no tick box - a mark there could only
     * ever mean nothing, and a control that does nothing is a lie about the data.
     * @param {Object} node
     * @param {string} path '' for the root, else the steps from the root
     * @param {Object<string, Array<string>>} [organsByComponent] - organs installed
     *   per component name (the create response's display field); a node missing
     *   from it is inert and shows nothing.
     * @returns {string}
     */
    _treeHtml(node, path, organsByComponent = {}) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            return '<span class="agent-body-error">malformed node</span>';
        }
        const slot = node.slot != null
            ? ' <em class="agent-body-slot">(' + this._esc(node.slot) + ')</em>'
            : '';
        const organs =
            (node.component && typeof node.component === 'string' &&
                Object.hasOwn(organsByComponent, node.component))
                ? organsByComponent[node.component]
                : [];
        const organsHtml = organs.length > 0
            ? '<span class="agent-body-stat">organs: ' + organs.map((o) => this._esc(o)).join(', ') + '</span>'
            : '';
        const children = Array.isArray(node.children) ? node.children : [];
        return (
            '<div class="agent-body-node">' +
            '<span class="agent-body-component">' + this._esc(node.component) + '</span>' + slot + organsHtml +
            (path ? this._mountToggleHtml(path, node.hidesWithParent === true) : '') +
            (children.length > 0
                ? '<ul class="agent-body-subtree">' +
                  children.map((child, i) =>
                      this._treeHtml(child, path ? path + '.children.' + i : 'children.' + i, organsByComponent)).join('') +
                  '</ul>'
                : '') +
            '</div>'
        );
    }

    /**
     * The "hides with parent" tick box for one mount (`hidesWithParent`, the mark
     * `entityController` reads onto the instance and `PerceptionController._coveredIds`
     * turns into prose coverage).
     * @param {string} path
     * @param {boolean} checked
     * @returns {string}
     */
    _mountToggleHtml(path, checked) {
        return '<label class="agent-body-hides" title="This part hangs behind whatever covers the part it hangs on">' +
            '<input type="checkbox" data-mount-path="' + this._esc(path) + '"' + (checked ? ' checked' : '') + '>' +
            ' hides with parent</label>';
    }

    /**
     * A tick box changed: write the mark onto the working design (absent, not
     * false - the same rule the world follows for a live instance).
     * @param {Event} event
     */
    _onMountToggle(event) {
        const input = event.target;
        if (!input || input.type !== 'checkbox' || !input.dataset || !input.dataset.mountPath) return;
        const node = this._nodeAtPath(input.dataset.mountPath);
        if (!node) return;
        if (input.checked) {
            node.hidesWithParent = true;
        } else {
            delete node.hidesWithParent;
        }
        this._setStatus(
            'Mount edited: "' + node.component + '" ' + (input.checked ? 'now hides' : 'no longer hides') +
            ' with its parent. Save to write it.'
        );
    }

    /**
     * The design node at `path` (`children.2.children.0`), or null. Paths are the
     * ones this panel generated, so an unparseable one is a bug, not input: it
     * resolves to null and nothing is written.
     * @param {string} path
     * @returns {Object|null}
     */
    _nodeAtPath(path) {
        const structure = this._workingDesign && this._workingDesign.structure;
        if (!structure || typeof path !== 'string' || path === '') return null;
        const steps = path.split('.');
        let node = structure;
        for (let i = 0; i < steps.length; i += 2) {
            if (steps[i] !== 'children') return null;
            const index = Number(steps[i + 1]);
            node = (Array.isArray(node.children) ? node.children[index] : null) || null;
            if (!node || typeof node !== 'object') return null;
        }
        return node;
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
