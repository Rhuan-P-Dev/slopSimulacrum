/**
 * CardsPanel (CLIENT) - the card gallery as pure render, pinned without a DOM.
 *
 * The gallery shows the cards the server lists (`GET /agent-body/cards`): the
 * art, the name, the description. Each row also carries the judged
 * `{{user}}` relationship zone (the fifth LLM prompt kind) or the button that
 * asks for it. These claims about the render are the ones a reader can get
 * wrong, so they are pinned here over the pure functions the class delegates
 * to (the suite has no DOM):
 *
 *   1. the photo is the card's own bytes, fetched from
 *      `GET /agent-body/cards/:cardId/image` with the card id URL-encoded;
 *   2. every string from a card file (name, description) is escaped on the way
 *      in - those files are written by people this server does not know;
 *   3. the empty and the missing are said, not left as blank holes: no card on
 *      disk is an empty state, and a card without a description says so;
 *   4. the model's judgment (label, summary) is escaped like any other
 *      card-derived string, and a card whose prompt carries no `{{user}}`
 *      token renders the control locked (the card-user-mapping rule).
 *
 * @module test/unit/CardsPanel.client
 */

import { describe, it, expect } from 'vitest';
import { renderCardGrid, cardImageSrc, cardHasUserPlaceholder, renderRelationshipZone } from '../../public/js/CardsPanel.js';

/** A card row in the shape `GET /agent-body/cards` returns. */
const card = (cardId, extra = {}) => ({
    cardId,
    name: String(cardId).toUpperCase(),
    description: 'A character from the file named ' + cardId + '.',
    ...extra
});

describe('cardImageSrc', () => {
    it('builds the per-card image url from the id', () => {
        expect(cardImageSrc('nova')).toBe('/agent-body/cards/nova/image');
    });

    it('URL-encodes the id, so an id with a slash cannot redirect the request', () => {
        expect(cardImageSrc('a/b')).toBe('/agent-body/cards/a%2Fb/image');
    });
});

describe('renderCardGrid', () => {
    it('renders one row per card with the photo, the name and the description', () => {
        const html = renderCardGrid([card('nova'), card('quiet')]);
        expect(html).toContain('Cards (2)');
        expect(html).toContain('data-row="nova"');
        expect(html).toContain('src="/agent-body/cards/nova/image"');
        expect(html).toContain('<span class="cards-id">NOVA</span>');
        expect(html).toContain('A character from the file named nova.');
    });

    it('escapes name and description: a card file is not this page', () => {
        const html = renderCardGrid([card('evil', {
            name: 'Bob <script>alert(1)</script>',
            description: 'He says & <shout> "hi".'
        })]);
        expect(html).not.toContain('<script>');
        expect(html).toContain('Bob &lt;script&gt;alert(1)&lt;/script&gt;');
        expect(html).toContain('He says &amp; &lt;shout&gt; &quot;hi&quot;.');
    });

    it('says so when a card carries no description', () => {
        const html = renderCardGrid([card('quiet', { description: '' })]);
        expect(html).toContain('cards-desc--none');
        expect(html).toContain('This card carries no description in its PNG metadata.');
    });

    it('falls back to the id when the name is missing', () => {
        const html = renderCardGrid([card('ghost', { name: '' })]);
        expect(html).toContain('<span class="cards-id">ghost</span>');
    });

    it('renders the honest empty state when there is no card on disk', () => {
        const html = renderCardGrid([]);
        expect(html).toContain('cards-empty');
        expect(html).toContain('No card PNG in');
        expect(html).not.toContain('Cards (0)');
    });

    it('tolerates a non-array answer instead of crashing the render', () => {
        expect(() => renderCardGrid(null)).not.toThrow();
        expect(renderCardGrid(null)).toContain('cards-empty');
    });

    it('renders the judged relationship inside the card row', () => {
        const html = renderCardGrid([card('nova', { personality: 'I adore {{user}}.' })], {
            nova: { label: 'devoted partner', summary: 'Nova adores {{user}}.', judgedAt: '2026-07-20T12:00:00.000Z' }
        });
        expect(html).toContain('data-rel-judge="nova"');
        expect(html).toContain('<b>devoted partner</b>');
        expect(html).toContain('(judged 2026-07-20T12:00:00.000Z)');
        expect(html).toContain('Re-judge');
    });

    it('shows the judge button for a card that has not been judged yet', () => {
        const html = renderCardGrid([card('nova', { personality: 'I adore {{user}}.' })]);
        expect(html).toContain('Judge {{user}} relationship');
    });

    it('escapes the model verdict like any other card-derived string: the verdict is not this page', () => {
        const html = renderCardGrid([card('evil', { personality: 'x {{user}}' })], {
            evil: { label: 'rival <script>alert(1)</script>', summary: 'He says & "hi".' }
        });
        expect(html).not.toContain('<script>');
        expect(html).toContain('rival &lt;script&gt;alert(1)&lt;/script&gt;');
        expect(html).toContain('&amp; &quot;hi&quot;');
    });
});

describe('cardHasUserPlaceholder', () => {
    it('finds the token in the personality or the description (the Create-World mirror)', () => {
        expect(cardHasUserPlaceholder({ personality: 'I adore {{user}}' })).toBe(true);
        expect(cardHasUserPlaceholder({ description: 'He loathes {{user}}' })).toBe(true);
        expect(cardHasUserPlaceholder({ personality: 'none', description: 'none' })).toBe(false);
        expect(cardHasUserPlaceholder({})).toBe(false);
    });
});

describe('renderRelationshipZone', () => {
    it('locks the control for a card whose prompt carries no {{user}} token (the card-user-mapping rule)', () => {
        const html = renderRelationshipZone({ cardId: 'quiet', personality: 'no token here' }, null);
        expect(html).toContain('cards-rel-zone--locked');
        expect(html).toContain('disabled');
        expect(html).toContain('carries no {{user}} token');
    });

    it('offers the judgment for a token-bearing card that has none yet', () => {
        const html = renderRelationshipZone({ cardId: 'nova', personality: 'I adore {{user}}' }, null);
        expect(html).not.toContain('cards-rel-zone--locked');
        expect(html).toContain('Judge {{user}} relationship');
        expect(html).not.toContain('disabled');
    });
});
