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
 *   - everything is selected by default, because "create a world" has meant
 *     "spawn every card on disk" since this server booted; deselecting is the
 *     exception an operator is here to make.
 *   - an empty selection is allowed and says so. A world with props and no cards
 *     is a real thing to want (a clean room to test in), and the server accepts
 *     it; hiding that behind a disabled button would be the client inventing a
 *     rule the server does not have.
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
            const res = await fetch('/agent-body/cards');
            const payload = await readJson(res);
            if (!res.ok) throw new Error(payload?.error?.message || `cards request failed (${res.status})`);
            this._cards = Array.isArray(payload.cards) ? payload.cards : [];
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
        this._busy = true;
        this._submit.disabled = true;
        this._setStatus(`Creating a world with ${cardIds.length} card(s)...`, 'dim');
        try {
            const res = await fetch('/world/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cardIds })
            });
            const payload = await readJson(res);
            if (!res.ok) throw new Error(payload?.error?.message || `create failed (${res.status})`);
            const spawned = payload.cards?.spawned ?? 0;
            const total = payload.cards?.total ?? 0;
            // `running` is in the answer because it is the point of the button:
            // before this request the server was idle, and now it is simulating.
            this._setStatus(
                `World ${payload.running === false ? 'created (no round is running)' : 'created and running'}: ${payload.despawned ?? 0} entity(ies) removed, ${spawned}/${total} card(s) spawned, round ${payload.round}.`,
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

    /** @private Draw one row per card, all checked. */
    _renderCards() {
        if (!this._cards.length) {
            this._list.innerHTML = '<p class="cw-empty">No card files in <code>data/cards/</code>. Drop a PNG (SillyTavern-style card) there and press Reload.</p>';
            this._submit.disabled = false;
            return;
        }
        this._list.innerHTML = this._cards.map((card) => {
            const description = String(card.description || '').replace(/\s+/g, ' ').slice(0, 140);
            return '' +
                '<label class="cw-row" title="' + escapeText(card.firstMessage || '') + '">' +
                '<input type="checkbox" class="cw-check" value="' + escapeText(card.cardId) + '" checked>' +
                '<span class="cw-name">' + escapeText(card.name || card.cardId) + '</span>' +
                '<span class="cw-id">' + escapeText(card.cardId) + '</span>' +
                '<span class="cw-desc">' + escapeText(description) + (card.description?.length > 140 ? '...' : '') + '</span>' +
                '</label>';
        }).join('');
        for (const box of this._list.querySelectorAll('.cw-check')) {
            box.addEventListener('change', () => this._setStatus(this._countLine(), 'dim'));
        }
    }

    /** @private Flip every checkbox. */
    _setAll(checked) {
        for (const box of this._list.querySelectorAll('.cw-check')) {
            box.checked = checked;
        }
        this._setStatus(this._countLine(), 'dim');
    }

    /** @returns {string[]} the card ids currently checked. */
    _selectedIds() {
        return [...this._list.querySelectorAll('.cw-check')].filter((box) => box.checked).map((box) => box.value);
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

export default CreateWorldPanel;
