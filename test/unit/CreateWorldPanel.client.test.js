/**
 * CreateWorldPanel (CLIENT) — the lock on the per-card {{user}} control.
 *
 * The control offers a binding the SERVER applies, so its availability must
 * mirror the server's reach exactly: the prompt substitution acts on the
 * effective persona (personality, else description; the default profile
 * carries no token) and only on the LITERAL `{{user}}` token. That decision
 * lives in the pure `cardHasUserPlaceholder` the render delegates to; the
 * suite has no DOM, so that function is what is pinned here
 * (`wiki/decisions/card-user-mapping.md`, "UI rules"):
 *
 *   1. a personality carrying the token keeps the control live;
 *   2. a description is the fallback the server renders, so a token in it
 *      counts when the card has no personality;
 *   3. a non-empty personality wins over the description — a token only in
 *      the description is out of reach of the substitution and locks the
 *      control;
 *   4. missing or whitespace-only fields fall to the default profile, which
 *      has no token;
 *   5. the token is literal — spacing and case variants do not count.
 *
 * @module test/unit/CreateWorldPanel.client
 */

import { describe, it, expect } from 'vitest';
import { cardHasUserPlaceholder } from '../../public/js/CreateWorldPanel.js';

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
