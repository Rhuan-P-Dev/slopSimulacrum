/**
 * CreateWorldPanel - choose the cards, build the world.
 *
 * The view behind the menu's **Create world**: a checkbox per card file in
 * `data/cards/`, then one POST to `/world/create`. Nothing here decides which
 * cards are valid, which cards exist, or what happens to the world that is being
 * replaced - the server answers all of that (`WorldRecreateLogic`), including the
 * refusal that names an unknown card id before anything is destroyed.
 *
 * Two choices live here, and both are UI choices, not rules:
 *   - nothing is selected by default: a create starts from an empty room and
 *     the operator ticks who enters (owner call 2026-07-12, superseding the
 *     old "every card selected" default, which stays one All-click away).
 *   - an empty selection is allowed and says so: a world with props and no
 *     cards is a real thing to want (a clean room to test in), and the
 *     server accepts it; hiding that behind a disabled button would be the
 *     client inventing a rule the server does not have.
 *
 * A third, per-card control: the **its {{user}} is** selector binds a card's `{{user}}`
 * placeholder to another card so that card's agent thinks its user is the target
 * (`wiki/decisions/card-user-mapping.md`). The target may be any card file on
 * disk, not just a selected one; the control is disabled for a card that is not
 * selected, because a binding only reaches a card that actually spawns. The
 * server validates and applies the binding; this view only offers it.
 *
 * The control is also grayed and locked for a card whose prompt carries no
 * `{{user}}` token at all (`cardHasUserPlaceholder` below): there is nothing for
 * a binding to act on, so offering one would be the client inventing a rule the
 * server cannot apply. The check mirrors the server exactly - the effective
 * persona (`buildCardProfile`: personality, else description, else the token-free
 * default) and the literal token the prompt substitution matches.
 *
 * A fresh judgment is also made visible here (owner call): a card whose
 * `{{user}}` relationship was judged - and is still fresh, per the sidecar's
 * persona-hash rule - carries a small badge under its row showing the verdict's
 * label (`judgedBadgeHtml`, the full verdict in the hover title). It reads the
 * same overlay the Cards tab uses (`GET /agent-body/cards/user-relationships`,
 * one endpoint, two panels) and tells the operator, before creating the world,
 * which of the bindings they pick will deliver a relationship to the chosen
 * target (`wiki/decisions/card-user-relationship-context.md`). A failed overlay
 * fetch degrades to "nothing judged" and never blocks the list (E-2).
 *
 * The card list is `/agent-body/cards` - the same read the Agent Body overlay
 * uses. One endpoint, two panels: the fields are the same ones (a card's id is
 * the file's basename either way), and a second list endpoint would be a second
 * answer to "what cards are there".
 *
 * @module public/js/CreateWorldPanel
 */
import ClientLogger from '/utils/ClientLogger.js';
import { escapeText } from '/utils/EscapeHtml.js';

/** How long the success line stays up before the page reloads. */
const RELOAD_DELAY_MS = 1400;

export class CreateWorldPanel {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.contentEl - Where the card list is rendered.
     * @param {HTMLElement} options.statusEl - One-line status (counts, errors).
     * @param {HTMLElement} options.submitEl - The button that creates the world.
     * @param {() => void} options.onCreated - Called after a successful create.
     */
    constructor({ contentEl, statusEl, submitEl, onCreated }) {
        if (!contentEl || !statusEl || !submitEl) {
            throw new Error('CreateWorldPanel: contentEl, statusEl and submitEl are required.');
        }
        this._content = contentEl;
        this._status = statusEl;
        this._submit = submitEl;
        this._onCreated = typeof onCreated === 'function' ? onCreated : () => {};
        /** @private */
        this._cards = [];
        /** @private cardId to the fresh judged relationship (the overlay read; none when the fetch fails or the card is unjudged) */
        this._relationships = {};
        /** @private */
        this._busy = false;
        this._renderControls();
        this._submit.addEventListener('click', () => this.submit());
    }

    /**
     * Load the card list and render it. Called every time the view opens: card
     * files are added by dropping a PNG on the server, so a cached list would be
     * wrong about the world the moment someone does.
     * @returns {Promise<void>}
     */
    async refresh() {
        this._setStatus('Loading cards...', 'dim');
        try {
            const [res, relsRes] = await Promise.all([
                fetch('/agent-body/cards'),
                fetch('/agent-body/cards/user-relationships').catch((error) => {
                    // the list is the primary content; the judgments are an
                    // overlay, so a failure there degrades to none (E-2).
                    ClientLogger.error('CreateWorldPanel', 'relationship overlay failed', error);
                    return null;
                })
            ]);
            const payload = await readJson(res);
            if (!res.ok) throw new Error(payload?.error?.message || `cards request failed (${res.status})`);
            this._cards = Array.isArray(payload.cards) ? payload.cards : [];
            this._relationships = await readRelationships(relsRes);
            this._renderCards();
            this._setStatus(this._countLine(), 'dim');
        } catch (error) {
            ClientLogger.error('CreateWorldPanel', 'could not load cards', error);
            this._content.innerHTML = '';
            this._setStatus(`Could not load cards: ${error.message}`, 'error');
        }
    }

    /**
     * POST the chosen cards. The response is the server's account of what it
     * built: how many entities it removed, how many cards it spawned, and the
     * round the new world starts in.
     * @returns {Promise<void>}
     */
    async submit() {
        if (this._busy) return;
        const cardIds = this._selectedIds();
        const users = this._selectedUsers();
        this._busy = true;
        this._submit.disabled = true;
        const bindingLine = Object.keys(users).length ? `, ${Object.keys(users).length} user binding(s)` : '';
        this._setStatus(`Creating a world with ${cardIds.length} card(s)${bindingLine}...`, 'dim');
        try {
            // `users` is sent only when a binding was made: the server treats an
            // absent field as "no binding", so an empty object would be noise.
            const body = { cardIds };
            if (Object.keys(users).length) body.users = users;
            const res = await fetch('/world/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const payload = await readJson(res);
            if (!res.ok) throw new Error(payload?.error?.message || `create failed (${res.status})`);
            const spawned = payload.cards?.spawned ?? 0;
            const total = payload.cards?.total ?? 0;
            const applied = payload.cards?.users ? Object.keys(payload.cards.users).length : 0;
            const appliedLine = applied ? `, ${applied} user binding(s) applied` : '';
            // `running` is in the answer because it is the point of the button:
            // before this request the server was idle, and now it is simulating.
            this._setStatus(
                `World ${payload.running === false ? 'created (no round is running)' : 'created and running'}: ${payload.despawned ?? 0} entity(ies) removed, ${spawned}/${total} card(s) spawned${appliedLine}, round ${payload.round}.`,
                'ok'
            );
            setTimeout(() => this._onCreated(), RELOAD_DELAY_MS);
        } catch (error) {
            ClientLogger.error('CreateWorldPanel', 'create world failed', error);
            this._setStatus(`Could not create the world: ${error.message}`, 'error');
            this._busy = false;
            this._submit.disabled = false;
        }
    }

    // ---------------------------------------------------------------- rendering

    /** @private Select-all / select-none row, above the list. */
    _renderControls() {
        const bar = document.createElement('div');
        bar.className = 'cw-controls';
        bar.innerHTML =
            '<button type="button" class="sim-btn sim-btn-small" id="cw-all">All</button>' +
            '<button type="button" class="sim-btn sim-btn-small" id="cw-none">None</button>' +
            '<span class="cw-hint">Cards are files in <code>data/cards/</code>. The new world replaces the one running.</span>';
        this._content.replaceChildren(bar);
        bar.querySelector('#cw-all').addEventListener('click', () => this._setAll(true));
        bar.querySelector('#cw-none').addEventListener('click', () => this._setAll(false));
        /** @private */
        this._list = document.createElement('div');
        this._list.className = 'cw-list';
        this._content.appendChild(this._list);
    }

    /** @private Draw one row per card, all unchecked: the create starts empty. */
    _renderCards() {
        if (!this._cards.length) {
            this._list.innerHTML = '<p class="cw-empty">No card files in <code>data/cards/</code>. Drop a PNG (SillyTavern-style card) there and press Reload.</p>';
            this._submit.disabled = false;
            return;
        }
        this._list.innerHTML = this._cards.map((card) => {
            const description = String(card.description || '').replace(/\s+/g, ' ').slice(0, 140);
            // The target of the binding may be any card file on disk, so the
            // options list every card except the row's own (self-binding is a
            // UI mistake; the server stays lenient and accepts it if sent).
            const userOptions = this._cards
                .filter((other) => other.cardId !== card.cardId)
                .map((other) => '<option value="' + escapeText(other.cardId) + '">' + escapeText(other.name || other.cardId) + '</option>')
                .join('');
            // A card whose prompt carries no {{user}} token gets the control
            // grayed and locked for its whole life in the list (css: --locked).
            const hasUser = cardHasUserPlaceholder(card);
            const userTitle = hasUser
                ? 'Whom this card treats as its {{user}}. Applies only while the card is selected to spawn.'
                : 'This card\'s prompt carries no {{user}} token, so there is nothing to bind.';
            const rel = this._relationships[card.cardId] || null;
            return '' +
                '<div class="cw-row">' +
                '<label class="cw-pick">' +
                '<input type="checkbox" class="cw-check" value="' + escapeText(card.cardId) + '">' +
                '<span class="cw-name">' + escapeText(card.name || card.cardId) + '</span>' +
                '<span class="cw-id">' + escapeText(card.cardId) + '</span>' +
                '<span class="cw-desc">' + escapeText(description) + (card.description?.length > 140 ? '...' : '') + '</span>' +
                judgedBadgeHtml(rel) +
                '</label>' +
                '<label class="cw-user' + (hasUser ? '' : ' cw-user--locked') + '" title="' + userTitle + '">' +
                '<span class="cw-user-label">its {{user}} is</span>' +
                '<select class="cw-user-select">' +
                '<option value="">(no binding: leave {{user}} as-is)</option>' +
                userOptions +
                '</select>' +
                '</label>' +
                '</div>';
        }).join('');
        for (const box of this._list.querySelectorAll('.cw-check')) {
            this._syncUserSelect(box);
            box.addEventListener('change', () => {
                this._syncUserSelect(box);
                this._setStatus(this._countLine(), 'dim');
            });
        }
        for (const sel of this._list.querySelectorAll('.cw-user-select')) {
            sel.addEventListener('change', () => this._setStatus(this._countLine(), 'dim'));
        }
    }

    /**
     * @private Keep the row's {{user}} selector in step with its row. A locked
     * control (the card's prompt carries no {{user}} token) stays disabled
     * whatever the checkbox says: there is nothing to bind. Otherwise the
     * selector is enabled only while the card is selected to spawn: a binding is
     * applied at the card's spawn, so an unselected card has nowhere to receive
     * one. The selected value is kept either way, so toggling the box back on
     * restores the operator's earlier choice.
     */
    _syncUserSelect(box) {
        const row = box.closest('.cw-row');
        if (!row) return;
        const user = row.querySelector('.cw-user');
        const sel = row.querySelector('.cw-user-select');
        if (sel) sel.disabled = (user && user.classList.contains('cw-user--locked')) || !box.checked;
    }

    /** @private Flip every checkbox and their {{user}} selectors. */
    _setAll(checked) {
        for (const box of this._list.querySelectorAll('.cw-check')) {
            box.checked = checked;
            this._syncUserSelect(box);
        }
        this._setStatus(this._countLine(), 'dim');
    }

    /** @returns {string[]} the card ids currently checked. */
    _selectedIds() {
        return [...this._list.querySelectorAll('.cw-check')].filter((box) => box.checked).map((box) => box.value);
    }

    /**
     * @returns {Object<string, string>} the {{user}} bindings to send: for each
     * selected card that has a target chosen, `{ [cardId]: targetCardId }`.
     */
    _selectedUsers() {
        const users = {};
        for (const row of this._list.querySelectorAll('.cw-row')) {
            const box = row.querySelector('.cw-check');
            const sel = row.querySelector('.cw-user-select');
            if (!box || !sel || !box.checked) continue;
            if (sel.value) users[box.value] = sel.value;
        }
        return users;
    }

    /** @returns {string} the "N of M selected" line. */
    _countLine() {
        const selected = this._selectedIds().length;
        if (!this._cards.length) return 'No cards on disk.';
        if (selected === 0) return 'No card selected: the world keeps its props and has nobody in it.';
        return `${selected} of ${this._cards.length} card(s) selected.`;
    }

    /** @private */
    _setStatus(text, tone) {
        this._status.textContent = text;
        this._status.className = `sim-status sim-status--${tone}`;
    }
}

/**
 * Whether a card's prompt can carry a `{{user}}` binding - the client-side
 * mirror of the server's effective persona. The agent's system prompt renders
 * the personality when the card has one, otherwise the description
 * (`buildCardProfile`), and the world-create substitution acts on that exact
 * string with the LITERAL `{{user}}` token (`LLMAgentController`); the default
 * profile carries no token, so a card with neither field cannot have one.
 * @param {{personality?: string, description?: string}|null|undefined} card - a
 *   row of `GET /agent-body/cards`.
 * @returns {boolean} true when the prompt the agent would get carries the token.
 */
export function cardHasUserPlaceholder(card) {
    const personality = card && typeof card.personality === 'string' ? card.personality.trim() : '';
    const description = card && typeof card.description === 'string' ? card.description.trim() : '';
    const persona = personality !== '' ? personality : description;
    return persona.includes('{{user}}');
}

/**
 * The judged-relationship badge for one card row, or the empty string when
 * the card has no fresh judgment: the verdict's label in the badge, the full
 * verdict (label, summary, and when) in the `title` attribute. Everything is
 * escaped on the way in - the label and the summary are model output (SEC-6
 * posture, same as the Cards tab's zone), and the card's files are written by
 * people this server does not know.
 * @param {{label?: string, summary?: string, judgedAt?: string|null}|null|undefined} relationship -
 *   the fresh judgment from `GET /agent-body/cards/user-relationships` (only
 *   fresh verdicts are served, so a presence here means "judged and current").
 * @returns {string} HTML (possibly empty)
 */
export function judgedBadgeHtml(relationship) {
    if (!relationship || typeof relationship !== 'object' || Array.isArray(relationship)) return '';
    const label = typeof relationship.label === 'string' ? relationship.label.trim() : '';
    if (label === '') return '';
    const summary = typeof relationship.summary === 'string' ? relationship.summary.trim() : '';
    const when = typeof relationship.judgedAt === 'string' ? ' (judged ' + relationship.judgedAt + ')' : '';
    const title = '{{user}}: ' + label + (summary !== '' ? ' - ' + summary : '') + when;
    return '<span class="cw-judged" title="' + escapeText(title) + '">{{user}}: <b>' + escapeText(label) + '</b></span>';
}

/**
 * Parse a response as JSON without throwing on a body that is not JSON.
 * @param {Response} res
 * @returns {Promise<Object|null>}
 */
async function readJson(res) {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

/**
 * The fresh judged relationships from the overlay endpoint, or none on any
 * failure (a derived overlay: a failed fetch must not blank the list, E-2).
 * Mirrors the Cards tab's own reader of the same endpoint (CHG-2).
 * @param {Response|null} response
 * @returns {Promise<Object<string, {label: string, summary: string, judgedAt: string|null}>>}
 */
async function readRelationships(response) {
    if (!response || !response.ok) return {};
    const payload = await readJson(response);
    const rels = payload && typeof payload.relationships === 'object' && payload.relationships && !Array.isArray(payload.relationships)
        ? payload.relationships
        : {};
    const out = {};
    for (const [cardId, rel] of Object.entries(rels)) {
        if (rel && typeof rel === 'object' && typeof rel.label === 'string' && typeof rel.summary === 'string') {
            out[cardId] = {
                label: rel.label,
                summary: rel.summary,
                judgedAt: typeof rel.judgedAt === 'string' ? rel.judgedAt : null
            };
        }
    }
    return out;
}

export default CreateWorldPanel;
