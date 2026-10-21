/**
 * DeltaSummary — unit tests.
 *
 * `buildDeltaSummary` turns a perception delta entry into a single human/LLM
 * readable sentence: counts + representative examples, never a full listing.
 * The chat category ("N message(s) in chat (...)") is the one added for
 * this feature: a line said in the room's chat transcript surfaces in the
 * summary as a count + representative examples.
 *
 * @module test/unit/DeltaSummary
 */

import { describe, it, expect } from 'vitest';
import { buildDeltaSummary } from '../../src/utils/DeltaSummary.js';

/**
 * A minimal delta entry. Every change category is present and defaults to
 * empty, so only the categories the caller fills contribute a clause.
 * `counts` mirrors what DeltaDiff writes (chat counts are part of `total`).
 */
function makeDelta({
    roomId = 'room_main',
    chat = [],
    entities = {},
    items = {},
    dropped = {},
    components = {},
    internal = {},
    equipped = {},
    actions = {}
} = {}) {
    const e = { appeared: [], despawned: [], moved: [], statChanges: [], ...entities };
    const i = { added: [], removed: [], ...items };
    const d = { added: [], removed: [], moved: [], ...dropped };
    const c = { added: [], removed: [], changed: [], ...components };
    const n = { added: [], removed: [], ...internal };
    const q = { added: [], removed: [], ...equipped };
    const a = { performed: [], ...actions };
    const total =
        e.appeared.length +
        e.despawned.length +
        e.moved.length +
        e.statChanges.length +
        i.added.length +
        i.removed.length +
        d.added.length +
        d.removed.length +
        d.moved.length +
        c.added.length +
        c.removed.length +
        c.changed.length +
        n.added.length +
        n.removed.length +
        q.added.length +
        q.removed.length +
        chat.length;
    return {
        kind: 'delta',
        tick: 5,
        sinceTick: 4,
        ts: Date.now(),
        roomId,
        counts: {
            total,
            entities: e.appeared.length + e.despawned.length + e.moved.length + e.statChanges.length,
            items: i.added.length + i.removed.length,
            dropped: d.added.length + d.removed.length + d.moved.length,
            components: c.added.length + c.removed.length + c.changed.length,
            internal: n.added.length + n.removed.length,
            equipped: q.added.length + q.removed.length,
            chat: chat.length,
            actions: 0
        },
        summary: null,
        actions: a,
        entities: e,
        items: i,
        dropped: d,
        components: c,
        internal: n,
        equipped: q,
        chat: { added: chat }
    };
}

describe('buildDeltaSummary — chat category', () => {
    it('chat-only change → "N message(s) in chat (representatives) in <room>"', () => {
        const sum = buildDeltaSummary(
            makeDelta({
                chat: [
                    { id: 'm1', speakerName: 'Bolt', speakerEntityId: 'ent-npc-0001', text: 'hello there', tick: 5, ts: 100 }
                ]
            }),
            'Main Room'
        );
        expect(sum).toBe('1 message in chat (Bolt: "hello there") in Main Room');
    });

    it('pluralizes the count ("2 messages in chat")', () => {
        const sum = buildDeltaSummary(
            makeDelta({
                chat: [
                    { id: 'm1', speakerName: 'Bolt', speakerEntityId: 'ent-npc-0001', text: 'hello' },
                    { id: 'm2', speakerName: 'Player', speakerEntityId: null, text: 'hi' }
                ]
            }),
            'Main Room'
        );
        expect(sum).toContain('2 messages in chat');
        expect(sum).toContain('Bolt: "hello"');
        expect(sum).toContain('Player: "hi"');
        expect(sum).toContain('in Main Room');
    });

    it('caps examples at 3 (the full lines live on the entry, never in the summary)', () => {
        const sum = buildDeltaSummary(
            makeDelta({
                chat: [
                    { id: 'm1', speakerName: 'A', text: 'one' },
                    { id: 'm2', speakerName: 'B', text: 'two' },
                    { id: 'm3', speakerName: 'C', text: 'three' },
                    { id: 'm4', speakerName: 'D', text: 'four' }
                ]
            }),
            'Main Room'
        );
        expect(sum).toContain('4 messages in chat');
        expect(sum).toContain('A: "one"');
        expect(sum).toContain('B: "two"');
        expect(sum).toContain('C: "three"');
        expect(sum).not.toContain('D: "four"');
    });

    it('truncates representative examples to 24 chars (with an ellipsis)', () => {
        const long = 'x'.repeat(40);
        const sum = buildDeltaSummary(
            makeDelta({
                chat: [{ id: 'm1', speakerName: 'A', text: long }]
            }),
            'Main Room'
        );
        // 24 chars shown, then an ellipsis, then the closing quote.
        expect(sum).toBe(`1 message in chat (A: "${'x'.repeat(24)}…") in Main Room`);
    });

    it('joins chat with other change categories in the one sentence', () => {
        const sum = buildDeltaSummary(
            makeDelta({
                entities: { appeared: [{ name: 'Bolt', id: 'e1' }] },
                chat: [{ id: 'm1', speakerName: 'Bolt', text: 'hi' }]
            }),
            'Main Room'
        );
        expect(sum).toContain('1 entity appeared');
        expect(sum).toContain('1 message in chat');
        expect(sum).toContain('Bolt: "hi"');
    });

    it('a chat-only change with a 0-entity delta is still a change the summary names', () => {
        const delta = makeDelta({
            chat: [{ id: 'm1', speakerName: 'Bolt', speakerEntityId: 'ent-npc-0001', text: 'who went there' }]
        });
        expect(delta.counts.total).toBe(1);
        expect(delta.counts.entities).toBe(0);
        expect(delta.counts.chat).toBe(1);
        const sum = buildDeltaSummary(delta, 'Main Room');
        expect(sum).toContain('1 message in chat');
        expect(sum).not.toContain('entity');
    });
});
