/**
 * CardsPanel - the gallery of the character cards on disk.
 *
 * The view behind the menu's **Cards** tab. It renders `GET /agent-body/cards`
 * (the same listing the "Create world" screen seeds from and the agent-body
 * designer picks from) as one card per PNG under `data/cards/`: its art, its
 * name, and its description. Nothing else: this tab is the display of what
 * exists. The endpoints it reads are the server's, and the server is the one
 * that knows which cards are there (`src/routes/agentBodyRoutes.js`).
 *
 * The art is fetched per card from `GET /agent-body/cards/:cardId/image` by
 * the `<img>` itself (one request per photo). That route matches the card
 * against the on-disk listing and serves the bytes through the data seam, so
 * a card the listing no longer has simply 404s and the picture comes out
 * blank with the card's name under it - the row never claims what the server
 * no longer says.
 *
 * Why the pure functions are module-level and exported. The grid is the part
 * a reader can get wrong (escaping, the image src, the empty state); building
 * it outside the class means `test/unit/CardsPanel.client.test.js` pins it
 * without a DOM, which this suite does not have.
 *
 * Every string that came from a card file (name, description) is escaped on
 * the way in - those files are written by people this server does not know.
 *
 * @module public/js/CardsPanel
 */
import ClientLogger from '/utils/ClientLogger.js';
import { escapeText } from '/utils/EscapeHtml.js';

/** Where the art of one card is served from (see the route module's header). */
export function cardImageSrc(cardId) {
    return `/agent-body/cards/${encodeURIComponent(cardId)}/image`;
}

/**
 * The gallery as HTML: one row per card (art, name, description), or the
 * honest empty state when there is nothing in `data/cards/`.
 *
 * The description is always rendered, even when empty, as a named absence -
 * a row with nothing under the name looks like the panel ignored the field,
 * when the truth is that nobody wrote the sentence.
 * @param {Array<{cardId: string, name: string, description: string}>} [cards]
 * @returns {string} HTML
 */
export function renderCardGrid(cards = []) {
    const list = Array.isArray(cards) ? cards : [];
    if (list.length === 0) {
        return '<div class="cards-gallery">'
            + '<p class="cards-empty">No card PNG in <code>data/cards/</code> - drop a character card in, then refresh.</p>'
            + '</div>';
    }
    const rows = list.map((card) => {
        const id = String(card.cardId ?? '');
        const name = String(card.name ?? '') || id || 'unnamed';
        const description = String(card.description ?? '');
        return '<div class="cards-row" data-row="' + escapeText(id) + '">'
            + '<img class="cards-photo" src="' + escapeText(cardImageSrc(id)) + '" alt="' + escapeText(name) + '" loading="lazy">'
            + '<div class="cards-row-main">'
            + '<div class="cards-row-head"><span class="cards-id">' + escapeText(name) + '</span></div>'
            + (description
                ? '<p class="cards-desc">' + escapeText(description) + '</p>'
                : '<p class="cards-desc cards-desc--none">This card carries no description in its PNG metadata.</p>')
            + '</div>'
            + '</div>';
    });
    return '<div class="cards-gallery">'
        + '<h3 class="cards-h">Cards (' + list.length + ')</h3>'
        + '<div class="cards-stack">' + rows.join('') + '</div>'
        + '</div>';
}

export class CardsPanel {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.contentEl - Where the gallery is rendered.
     * @param {HTMLElement} options.statusEl - One-line status (errors).
     * @param {HTMLElement} [options.refreshEl] - Refresh button.
     */
    constructor({ contentEl, statusEl, refreshEl }) {
        if (!contentEl || !statusEl) {
            throw new Error('CardsPanel: contentEl and statusEl are required.');
        }
        this._content = contentEl;
        this._status = statusEl;
        /** @private the last `GET /agent-body/cards` answer, which is what the view renders */
        this._cards = null;
        /** @private guards a refresh against a second in-flight fetch */
        this._busy = false;
        if (refreshEl) refreshEl.addEventListener('click', () => this.refresh());
    }

    /**
     * Re-read the listing. Called every time the tab opens: the cards are user
     * files, changed from outside this page, so a cached render is a lie about
     * now.
     * @returns {Promise<void>}
     */
    async refresh() {
        if (this._busy) return;
        this._busy = true;
        try {
            const response = await fetch('/agent-body/cards');
            const payload = await readJson(response);
            if (!response.ok) throw new Error(messageOf(payload, response.status));
            const cards = Array.isArray(payload?.cards) ? payload.cards : [];
            this._cards = cards;
            this._render();
            this._setStatus(`${cards.length} card${cards.length === 1 ? '' : 's'} in data/cards/.`, 'dim');
        } catch (error) {
            ClientLogger.error('CardsPanel', 'card listing failed', error);
            this._cards = null;
            this._render();
            this._setStatus(error.message, 'error');
        } finally {
            this._busy = false;
        }
    }

    /** @private Draw the gallery from the last server answer. */
    _render() {
        this._content.innerHTML = this._cards ? renderCardGrid(this._cards)
            : '<p class="cards-empty">Loading...</p>';
    }

    /** @private */
    _setStatus(text, tone) {
        this._status.textContent = text || '';
        this._status.className = `sim-status sim-status--${text ? tone : 'dim'}`;
    }
}

/**
 * The message a route error body carries, with the status as the fallback.
 * @param {Object|null} payload
 * @param {number} status
 * @returns {string}
 */
function messageOf(payload, status) {
    if (!payload) return `Request failed (${status})`;
    const nested = typeof payload.error === 'object' && payload.error ? payload.error.message : null;
    return nested || payload.message || `Request failed (${status})`;
}

/** @param {Response} res */
async function readJson(res) {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

export default CardsPanel;
