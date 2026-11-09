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
 * Each row also shows the card's judged relationship with its `{{user}}`
 * placeholder (the fifth LLM prompt kind, `card-user-relationship`, RP-1): a
 * free-form label plus one short sentence, judged by one LLM call per click
 * (SEC-9) and persisted by the server as a sidecar next to the card's PNG -
 * never into the PNG itself (the language policy) and never into the world
 * definition. The row's button asks for (or re-asks) the judgment; a card
 * whose prompt carries no `{{user}}` token shows the control locked - the
 * same rule the Create-World `{{user}}` binding applies
 * (wiki/decisions/card-user-mapping.md,
 * wiki/decisions/card-user-relationship.md).
 *
 * When a judgment completes, THE TAB THAT ASKED IS NOTIFIED (owner decision:
 * no broadcast, no socket event - the other tabs simply re-read on open, the
 * way they already do): the row is updated in place, the status line carries
 * the verdict (green), and the row flashes once (`cards-row--judged`).
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
 * Every string that came from a card file (name, description) or from the
 * model's judgment (label, summary) is escaped on the way in - the card files
 * are written by people this server does not know, and the judgment is
 * model output.
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
 * The `{{user}}` token in the card's *effective* prompt — a mirror of the
 * server's judgment rule (and of `CreateWorldPanel.cardHasUserPlaceholder`,
 * CHG-2): the world gives the character the first non-empty of `personality`
 * then `description` (trimmed); a card whose effective prompt carries no
 * literal `{{user}}` token has no relationship to judge, so the row's control
 * renders locked and grayed.
 * @param {{personality?: string, description?: string}|null|undefined} card - a
 *   row of `GET /agent-body/cards`.
 * @returns {boolean}
 */
export function cardHasUserPlaceholder(card) {
    const personality = card && typeof card.personality === 'string' ? card.personality.trim() : '';
    const description = card && typeof card.description === 'string' ? card.description.trim() : '';
    const persona = personality !== '' ? personality : description;
    return persona.includes('{{user}}');
}

/**
 * The per-card relationship zone: the judged verdict (a free-form label plus
 * one short sentence, and when it was judged) or the button that asks for it.
 * `relationship` is the fresh judgment the server reported for this card, or
 * `null`/`undefined` when the card has none (the normal state before the
 * first click).
 * @param {{cardId: string, name?: string, personality?: string, description?: string}} card
 * @param {{label: string, summary: string, judgedAt?: string|null}|null|undefined} relationship
 * @returns {string} HTML
 */
export function renderRelationshipZone(card, relationship) {
    const id = escapeText(String(card.cardId ?? ''));
    const hasToken = cardHasUserPlaceholder(card);
    const locked = hasToken ? '' : ' cards-rel-zone--locked';
    if (relationship && hasToken) {
        const when = relationship.judgedAt
            ? ' <span class="cards-rel-when">(judged ' + escapeText(String(relationship.judgedAt)) + ')</span>'
            : '';
        return '<div class="cards-rel-zone' + locked + '">'
            + '<span class="cards-rel-label">{{user}} relationship: <b>' + escapeText(String(relationship.label)) + '</b>' + when + '</span>'
            + '<button type="button" class="cards-rel-btn" data-rel-judge="' + id + '">Re-judge</button>'
            + '<p class="cards-rel-summary">' + escapeText(String(relationship.summary)) + '</p>'
            + '</div>';
    }
    const caption = hasToken
        ? 'Ask the LLM which relationship this character has with its {{user}}. One call per click; the verdict is saved next to the card.'
        : 'This card\'s prompt carries no {{user}} token, so there is nothing to judge.';
    return '<div class="cards-rel-zone' + locked + '">'
        + '<button type="button" class="cards-rel-btn"' + (hasToken ? '' : ' disabled') + ' data-rel-judge="' + id + '">'
        + (relationship ? 'Re-judge' : 'Judge {{user}} relationship')
        + '</button>'
        + '<p class="cards-rel-hint">' + caption + '</p>'
        + '</div>';
}

/**
 * The gallery as HTML: one row per card (art, name, description, the judged
 * `{{user}}` relationship or its button), or the honest empty state when
 * there is nothing in `data/cards/`.
 *
 * The description is always rendered, even when empty, as a named absence -
 * a row with nothing under the name looks like the panel ignored the field,
 * when the truth is that nobody wrote the sentence.
 * @param {Array<{cardId: string, name: string, description: string, personality?: string}>} [cards]
 * @param {Object<string, {label: string, summary: string, judgedAt?: string|null}>} [relationships] - cardId to the fresh judgment (empty = nothing judged yet).
 * @returns {string} HTML
 */
export function renderCardGrid(cards = [], relationships = {}) {
    const list = Array.isArray(cards) ? cards : [];
    if (list.length === 0) {
        return '<div class="cards-gallery">'
            + '<p class="cards-empty">No card PNG in <code>data/cards/</code> - drop a character card in, then refresh.</p>'
            + '</div>';
    }
    const rels = (relationships && typeof relationships === 'object' && !Array.isArray(relationships)) ? relationships : {};
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
            + renderRelationshipZone(card, rels[id] ?? null)
            + '</div>'
            + '</div>';
    });
    return '<div class="cards-gallery">'
        + '<h3 class="cards-h">Cards (' + list.length + ')</h3>'
        + '<div class="cards-stack">' + rows.join('') + '</div>'
        + '</div>';
}

/**
 * The status-line notice a completed judgment writes in the tab that asked
 * for it: the card's name, the verdict's label in quotes, and the fact that
 * the judgment is saved (the sidecar persists server-side, so a reload shows
 * it again). The card's own text is escaped by the caller's existing escape
 * on the way into the DOM (`_setStatus` writes textContent, so the string
 * here is plain data - no HTML).
 * @param {string} name - the card display name the server reported
 * @param {string} label - the verdict's label (free-form, model output)
 * @returns {string}
 */
export function judgedNoticeMessage(name, label) {
    const n = typeof name === 'string' && name.trim() !== '' ? name.trim() : 'the card';
    const l = typeof label === 'string' && label.trim() !== '' ? label.trim() : 'its {{user}} relationship';
    return `${n}'s {{user}} relationship was judged: "${l}".`;
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
        /** @private cardId to the last judged relationship the server reported (the panel's overlay) */
        this._relationships = {};
        /** @private the card ids with a judgment in flight (one click, one call) */
        this._judging = new Set();
        /** @private guards a refresh against a second in-flight fetch */
        this._busy = false;
        if (refreshEl) refreshEl.addEventListener('click', () => this.refresh());
        this._content.addEventListener('click', (event) => {
            const btn = event.target && event.target.closest ? event.target.closest('[data-rel-judge]') : null;
            if (!btn || btn.disabled) return;
            this._judge(btn.dataset.relJudge, btn);
        });
    }

    /**
     * Re-read the listing and the judged relationships. Called every time the
     * tab opens: the cards are user files, changed from outside this page, so
     * a cached render is a lie about now. The relationships are a derived
     * overlay (the sidecars next to the PNGs); a failure there degrades to
     * "nothing judged yet" instead of blanking the gallery (E-2).
     * @returns {Promise<void>}
     */
    async refresh() {
        if (this._busy) return;
        this._busy = true;
        try {
            const [cardsResponse, relsResponse] = await Promise.all([
                fetch('/agent-body/cards'),
                fetch('/agent-body/cards/user-relationships').catch((error) => {
                    // why: the gallery is the panel's primary content; the
                    // judgments are an overlay. A failed overlay must not
                    // blank the gallery, so it degrades to none (E-2).
                    ClientLogger.error('CardsPanel', 'relationship overlay failed', error);
                    return null;
                })
            ]);
            const payload = await readJson(cardsResponse);
            if (!cardsResponse.ok) throw new Error(messageOf(payload, cardsResponse.status));
            const cards = Array.isArray(payload?.cards) ? payload.cards : [];
            this._cards = cards;
            this._relationships = await readRelationships(relsResponse);
            this._render();
            const judged = Object.keys(this._relationships).length;
            this._setStatus(
                `${cards.length} card${cards.length === 1 ? '' : 's'} in data/cards/.${judged ? ` ${judged} judged.` : ''}`,
                'dim'
            );
        } catch (error) {
            ClientLogger.error('CardsPanel', 'card listing failed', error);
            this._cards = null;
            this._relationships = {};
            this._render();
            this._setStatus(error.message, 'error');
        } finally {
            this._busy = false;
        }
    }

    /** @private Draw the gallery from the last server answer. */
    _render() {
        this._content.innerHTML = this._cards ? renderCardGrid(this._cards, this._relationships)
            : '<p class="cards-empty">Loading...</p>';
    }

    /**
     * @private Replace one card's relationship zone in place after a
     * judgment, so the photo's `<img>` keeps its loaded state instead of a
     * full re-render re-fetching it.
     * @param {string} cardId
     */
    _updateRelationshipZone(cardId) {
        const card = (this._cards || []).find((c) => String(c?.cardId ?? '') === cardId);
        if (!card) return;
        const row = Array.from(this._content.querySelectorAll('.cards-row'))
            .find((r) => r.dataset.row === cardId);
        if (!row) {
            // The row is gone (a concurrent refresh re-rendered the panel):
            // fall back to a full render with the fresh map.
            this._render();
            return;
        }
        const zone = row.querySelector('.cards-rel-zone');
        if (zone) zone.outerHTML = renderRelationshipZone(card, this._relationships[cardId] ?? null);
    }

    /**
     * @private One judgment for one card: one POST, one LLM call (SEC-9 -
     * the route rate-limits it; the provider timeout is the LLM seam's). On
     * success the verdict lands in the panel at once (it is persisted
     * server-side, so a reload shows it again). On failure the button is
     * re-enabled and the status line says what broke.
     * @param {string} cardId
     * @param {HTMLButtonElement} btn - The button that was clicked.
     */
    async _judge(cardId, btn) {
        if (this._judging.has(cardId)) return;
        this._judging.add(cardId);
        btn.disabled = true;
        try {
            const response = await fetch(`/agent-body/cards/${encodeURIComponent(cardId)}/user-relationship`, {
                method: 'POST'
            });
            const payload = await readJson(response);
            if (!response.ok) {
                ClientLogger.error('CardsPanel', 'relationship judgment failed', payload || response.status);
                btn.disabled = false;
                this._setStatus(`Judgment failed: ${messageOf(payload, response.status)}`, 'error');
                return;
            }
            const rel = payload && typeof payload.relationship === 'object' && payload.relationship ? payload.relationship : {};
            this._relationships[cardId] = {
                label: typeof rel.label === 'string' ? rel.label : '',
                summary: typeof rel.summary === 'string' ? rel.summary : '',
                judgedAt: typeof payload.judgedAt === 'string' ? payload.judgedAt : null
            };
            this._updateRelationshipZone(cardId);
            const name = payload?.card?.name || cardId;
            // The notice in the tab that asked (no broadcast - owner decision,
            // see the module header): the green status line says the verdict
            // out loud, and the row flashes once so it is seen without a
            // re-read of the whole gallery.
            this._setStatus(judgedNoticeMessage(name, this._relationships[cardId].label || ''), 'ok');
            this._flashJudgedRow(cardId);
        } catch (error) {
            ClientLogger.error('CardsPanel', 'relationship judgment threw', error);
            btn.disabled = false;
            this._setStatus(`Judgment failed: ${error.message}`, 'error');
        } finally {
            this._judging.delete(cardId);
        }
    }

    /**
     * @private Highlight the judged card's row once: the CSS animation runs
     * to the end and removes the class itself (the `animationend` listener is
     * one-shot), so nothing lingers and no timer has to be torn down (A-3).
     * @param {string} cardId
     */
    _flashJudgedRow(cardId) {
        const row = Array.from(this._content.querySelectorAll('.cards-row'))
            .find((r) => r.dataset.row === cardId);
        if (!row) return;
        row.classList.add('cards-row--judged');
        row.addEventListener('animationend', () => row.classList.remove('cards-row--judged'), { once: true });
    }

    /** @private */
    _setStatus(text, tone) {
        this._status.textContent = text || '';
        this._status.className = `sim-status sim-status--${text ? tone : 'dim'}`;
    }
}

/**
 * The judged relationships from the overlay endpoint, or none on any failure
 * (a derived overlay: see `refresh`).
 * @param {Response|null} response
 * @returns {Promise<Object<string, {label: string, summary: string, judgedAt?: string|null}>>}
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
