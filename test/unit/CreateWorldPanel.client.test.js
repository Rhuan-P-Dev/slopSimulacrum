/**
 * CreateWorldPanel (CLIENT) - the per-card {{user}} rules, pinned without a DOM.
 *
 * Two claims live in pure functions the render delegates to (the suite has no
 * DOM, same posture as CardsPanel.client):
 *
 *   - the LOCK on the per-card {{user}} control: the control offers a binding
 *     the SERVER applies, so its availability must mirror the server's reach
 *     exactly: the prompt substitution acts on the effective persona
 *     (personality, else description; the default profile carries no token)
 *     and only on the LITERAL `{{user}}` token. That decision is the pure
 *     `cardHasUserPlaceholder` (`wiki/decisions/card-user-mapping.md`,
 *     "UI rules"):
 *
 *     1. a personality carrying the token keeps the control live;
 *     2. a description is the fallback the server renders, so a token in it
 *        counts when the card has no personality;
 *     3. a non-empty personality wins over the description - a token only in
 *        the description is out of reach of the substitution and locks the
 *        control;
 *     4. missing or whitespace-only fields fall to the default profile, which
 *        has no token;
 *     5. the token is literal - spacing and case variants do not count.
 *
 *   - the JUDGED-RELATIONSHIP badge (`judgedBadgeHtml`): a card with a fresh
 *     judgment shows the verdict's label (the full verdict in the title
 *     attribute); no judgment, none - and the model's words are escaped on
 *     the way in, because they are not this page.
 *
 * @module test/unit/CreateWorldPanel.client
 */

import { describe, it, expect } from 'vitest';
import { cardHasUserPlaceholder, judgedBadgeHtml } from '../../public/js/CreateWorldPanel.js';

describe('cardHasUserPlaceholder mirrors the server effective persona', () => {
    it('sees the token in the personality, description absent', () => {
        expect(cardHasUserPlaceholder({ cardId: 'a', personality: 'You love {{user}}' })).toBe(true);
    });

    it('counts a token in the description when the card has no personality (the server renders that)', () => {
        expect(cardHasUserPlaceholder({ cardId: 'a', personality: '', description: 'My {{user}} is the star.' })).toBe(true);
    });

    it('locks when the personality is present but only the description carries the token', () => {
        // The server renders the non-empty personality and never reads the
        // description, so a token that lives only there can never be bound.
        expect(cardHasUserPlaceholder({ cardId: 'a', personality: 'Plain droid.', description: 'About {{user}}' })).toBe(false);
    });

    it('locks for a card with neither field (the default profile has no token)', () => {
        expect(cardHasUserPlaceholder({ cardId: 'a' })).toBe(false);
        expect(cardHasUserPlaceholder(null)).toBe(false);
        expect(cardHasUserPlaceholder({ personality: '   ', description: '  ' })).toBe(false);
    });

    it('treats the token as literal: spacing and case variants do not count', () => {
        expect(cardHasUserPlaceholder({ personality: 'He calls you {{ user }}.' })).toBe(false);
        expect(cardHasUserPlaceholder({ personality: 'He calls you {{User}}.' })).toBe(false);
        expect(cardHasUserPlaceholder({ personality: '{{user}} and {{user}} again' })).toBe(true);
    });
});

describe('judgedBadgeHtml', () => {
    it('renders the verdict\'s label in the badge and the full verdict in the title', () => {
        const html = judgedBadgeHtml({ label: 'devoted partner', summary: 'Nova adores {{user}}.', judgedAt: '2026-07-20T12:00:00.000Z' });
        expect(html).toContain('class="cw-judged"');
        expect(html).toContain('<b>devoted partner</b>');
        expect(html).toContain('title="{{user}}: devoted partner - Nova adores {{user}}. (judged 2026-07-20T12:00:00.000Z)"');
    });

    it('yields the empty string when there is no judgment (the normal state)', () => {
        expect(judgedBadgeHtml(null)).toBe('');
        expect(judgedBadgeHtml(undefined)).toBe('');
        expect(judgedBadgeHtml({})).toBe('');
    });

    it('yields the empty string for a malformed judgment (an empty label is not a verdict)', () => {
        expect(judgedBadgeHtml({ label: '', summary: 's' })).toBe('');
        expect(judgedBadgeHtml({ label: '   ', summary: 's' })).toBe('');
        expect(judgedBadgeHtml({ summary: 's' })).toBe('');
    });

    it('escapes the model\'s words: the verdict is not this page', () => {
        const html = judgedBadgeHtml({ label: 'rival <script>alert(1)</script>', summary: 'He says & "hi".' });
        expect(html).not.toContain('<script>');
        expect(html).toContain('<b>rival &lt;script&gt;alert(1)&lt;/script&gt;</b>');
        expect(html).toContain('He says &amp; &quot;hi&quot;.');
    });

    it('keeps the title honest when the summary or the timestamp are missing', () => {
        const html = judgedBadgeHtml({ label: 'ally' });
        expect(html).toContain('title="{{user}}: ally"');
    });
});
