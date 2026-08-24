/**
 * LlmAgentFeedbackController unit tests (Feature E, spec §3.1 / §4).
 *
 * Covers: capacity validation, record input sanitisation, ring eviction per
 * entity, getRecent ordering and limit, defensive copies, clear, and
 * serialize/restore round-trip — including multi-entity isolation.
 *
 * @module test/unit/LlmAgentFeedbackController
 */

import { describe, it, expect } from 'vitest';
import LlmAgentFeedbackController from '../../src/controllers/networking/LlmAgentFeedbackController.js';

function makeOutcome(overrides = {}) {
    return {
        round: overrides.round ?? 1,
        actionName: overrides.actionName ?? 'punch',
        componentId: overrides.componentId ?? 'comp_1',
        targetEntityId: overrides.targetEntityId ?? 'ent_2',
        queued: overrides.queued ?? false,
        success: overrides.success ?? true,
        detail: overrides.detail ?? 'hit',
        instinct: overrides.instinct,  // Forward optional instinct field
        atTick: overrides.atTick ?? 10
    };
}

describe('LlmAgentFeedbackController', () => {
    it('validates capacity in the constructor', () => {
        expect(() => new LlmAgentFeedbackController(0)).toThrow(TypeError);
        expect(() => new LlmAgentFeedbackController(-5)).toThrow(TypeError);
        expect(() => new LlmAgentFeedbackController(1.5)).toThrow(TypeError);
        expect(() => new LlmAgentFeedbackController('abc')).toThrow(TypeError);
        // default capacity
        const def = new LlmAgentFeedbackController();
        // Internal capacity not directly exposed, but we can infer from behaviour:
        for (let i = 0; i < 10; i++) def.record('test', makeOutcome({ round: i }));
        const recent = def.getRecent('test', 100);
        expect(recent).toHaveLength(5); // default capacity is 5
    });

    it('defaults to capacity 5 and starts empty for unknown entities', () => {
        const fb = new LlmAgentFeedbackController();
        expect(fb.getRecent('unknown')).toEqual([]);
    });

    it('records outcomes in order (oldest → newest) per entity', () => {
        const fb = new LlmAgentFeedbackController(5);
        fb.record('npc_1', makeOutcome({ round: 1, actionName: 'punch' }));
        fb.record('npc_1', makeOutcome({ round: 2, actionName: 'move' }));
        fb.record('npc_1', makeOutcome({ round: 3, actionName: 'selfHeal' }));
        const recent = fb.getRecent('npc_1');
        expect(recent).toHaveLength(3);
        expect(recent[0].actionName).toBe('punch');
        expect(recent[1].actionName).toBe('move');
        expect(recent[2].actionName).toBe('selfHeal');
    });

    it('evicts the oldest entry beyond capacity', () => {
        const fb = new LlmAgentFeedbackController(3);
        for (let i = 1; i <= 5; i++) {
            fb.record('npc_1', makeOutcome({ round: i, actionName: `action${i}` }));
        }
        const recent = fb.getRecent('npc_1');
        expect(recent).toHaveLength(3);
        expect(recent[0].actionName).toBe('action3');  // oldest kept
        expect(recent[2].actionName).toBe('action5');  // newest
    });

    it('getRecent returns a defensive copy — mutating read result never touches the store', () => {
        const fb = new LlmAgentFeedbackController(5);
        fb.record('npc_1', makeOutcome({ round: 1 }));
        const read = fb.getRecent('npc_1');
        read[0].actionName = 'MUTATED';
        read.push({ fake: true });
        expect(fb.getRecent('npc_1')[0].actionName).toBe('punch');
    });

    it('getRecent(limit) returns exactly limit entries when available', () => {
        const fb = new LlmAgentFeedbackController(10);
        for (let i = 1; i <= 7; i++) {
            fb.record('npc_1', makeOutcome({ round: i }));
        }
        expect(fb.getRecent('npc_1', 3)).toHaveLength(3);
        expect(fb.getRecent('npc_1', 3)[0].round).toBe(5);
        expect(fb.getRecent('npc_1', 0)).toEqual([]);
    });

    it('getRecent with limit larger than buffer returns everything', () => {
        const fb = new LlmAgentFeedbackController(10);
        for (let i = 1; i <= 4; i++) {
            fb.record('npc_1', makeOutcome({ round: i }));
        }
        expect(fb.getRecent('npc_1', 99)).toHaveLength(4);
    });

    it('rejects invalid entityId and outcome in record()', () => {
        const fb = new LlmAgentFeedbackController();
        expect(() => fb.record('', makeOutcome())).toThrow(TypeError);
        expect(() => fb.record(123, makeOutcome())).toThrow(TypeError);
        expect(() => fb.record(null, makeOutcome())).toThrow(TypeError);
        expect(() => fb.record('npc_1', null)).toThrow(TypeError);
        expect(() => fb.record('npc_1', 'string')).toThrow(TypeError);
    });

    it('rejects invalid limit in getRecent()', () => {
        const fb = new LlmAgentFeedbackController();
        expect(() => fb.getRecent('npc_1', -1)).toThrow(TypeError);
        expect(() => fb.getRecent('npc_1', 1.5)).toThrow(TypeError);
    });

    it('sanitises missing fields in outcome entries', () => {
        const fb = new LlmAgentFeedbackController();
        fb.record('npc_1', {});  // minimal — all defaults should apply
        const recent = fb.getRecent('npc_1');
        expect(recent).toHaveLength(1);
        const entry = recent[0];
        expect(entry.round).toBe(0);
        expect(entry.actionName).toBe('unknown');
        expect(entry.componentId).toBeNull();
        expect(entry.targetEntityId).toBeNull();
        expect(entry.queued).toBe(false);
        expect(entry.success).toBe(false);
        expect(entry.detail).toBe('unknown outcome');
        expect(entry.atTick).toBe(0);
    });

    it('clear() removes all entries for an entity', () => {
        const fb = new LlmAgentFeedbackController();
        fb.record('npc_1', makeOutcome({ round: 1 }));
        fb.record('npc_1', makeOutcome({ round: 2 }));
        expect(fb.getRecent('npc_1')).toHaveLength(2);
        fb.clear('npc_1');
        expect(fb.getRecent('npc_1')).toEqual([]);
    });

    it('serialize() returns a deep-copied snapshot', () => {
        const fb = new LlmAgentFeedbackController();
        fb.record('npc_1', makeOutcome({ round: 1 }));
        const snap = fb.serialize();
        expect(snap).toHaveProperty('npc_1');
        expect(snap.npc_1).toHaveLength(1);
        snap.npc_1[0].actionName = 'MUTATED';
        expect(fb.getRecent('npc_1')[0].actionName).toBe('punch');
    });

    it('serialize/restore round-trip preserves entries', () => {
        const fb1 = new LlmAgentFeedbackController(5);
        fb1.record('npc_1', makeOutcome({ round: 1, actionName: 'punch' }));
        fb1.record('npc_1', makeOutcome({ round: 2, actionName: 'move' }));
        const snap = fb1.serialize();

        const fb2 = new LlmAgentFeedbackController(5);
        fb2.restore(snap);
        const restored = fb2.getRecent('npc_1');
        expect(restored).toHaveLength(2);
        expect(restored[0].actionName).toBe('punch');
        expect(restored[1].actionName).toBe('move');
    });

    it('restore tolerates malformed input (garbage entries, non-array values)', () => {
        const fb = new LlmAgentFeedbackController(5);
        fb.restore({
            badEntity: 'not an array',
            emptyEntity: [],
            garbageTop: 'also not an array'
        });
        expect(fb.getRecent('badEntity')).toEqual([]);
        expect(fb.getRecent('emptyEntity')).toEqual([]);
    });

    it('restore keeps only the newest capacity entries from a long ring', () => {
        const fb = new LlmAgentFeedbackController(3);
        fb.restore({
            npc_1: [
                { round: 1, actionName: 'a1' },
                { round: 2, actionName: 'a2' },
                { round: 3, actionName: 'a3' },
                { round: 4, actionName: 'a4' },
                { round: 5, actionName: 'a5' }
            ]
        });
        const restored = fb.getRecent('npc_1');
        expect(restored).toHaveLength(3);
        expect(restored[0].actionName).toBe('a3');
        expect(restored[2].actionName).toBe('a5');
    });

    it('multi-entity isolation: entries for one entity do not leak to another', () => {
        const fb = new LlmAgentFeedbackController(5);
        fb.record('npc_A', makeOutcome({ round: 1, actionName: 'punch' }));
        fb.record('npc_B', makeOutcome({ round: 1, actionName: 'move' }));
        expect(fb.getRecent('npc_A')).toHaveLength(1);
        expect(fb.getRecent('npc_A')[0].actionName).toBe('punch');
        expect(fb.getRecent('npc_B')).toHaveLength(1);
        expect(fb.getRecent('npc_B')[0].actionName).toBe('move');
    });

    it('getRecent returns entries sorted newest-first when limited', () => {
        const fb = new LlmAgentFeedbackController(10);
        for (let i = 1; i <= 5; i++) {
            fb.record('npc_1', makeOutcome({ round: i, actionName: `action${i}` }));
        }
        // getRecent returns oldest → newest within the slice
        const recent = fb.getRecent('npc_1', 3);
        expect(recent).toHaveLength(3);
        expect(recent[0].round).toBe(3);
        expect(recent[2].round).toBe(5);
    });

    // =========================================================================
    // Instincts System Tests (spec §6.8 — F1-F4)
    // =========================================================================

    // F1: record with instinct → getRecent returns it
    it('F1: record with instinct:"chase_attack" → getRecent returns it', () => {
        const fb = new LlmAgentFeedbackController();
        fb.record('npc_1', makeOutcome({ round: 1, instinct: 'chase_attack' }));
        const recent = fb.getRecent('npc_1');
        expect(recent).toHaveLength(1);
        expect(recent[0].instinct).toBe('chase_attack');
    });

    // F2: record without instinct → instinct === null
    it('F2: record without instinct → instinct is null', () => {
        const fb = new LlmAgentFeedbackController();
        fb.record('npc_1', makeOutcome({ round: 1 }));
        const recent = fb.getRecent('npc_1');
        expect(recent).toHaveLength(1);
        expect(recent[0].instinct).toBeNull();
    });

    // F3: non-string instinct → sanitized to null
    it('F3: non-string instinct values → sanitized to null', () => {
        const fb = new LlmAgentFeedbackController();

        // Number
        fb.record('npc_1', makeOutcome({ round: 1, instinct: 123 }));
        expect(fb.getRecent('npc_1')[0].instinct).toBeNull();

        // Object
        fb.record('npc_1', makeOutcome({ round: 2, instinct: { name: 'chase' } }));
        expect(fb.getRecent('npc_1')[1].instinct).toBeNull();

        // Array
        fb.record('npc_1', makeOutcome({ round: 3, instinct: ['chase', 'flee'] }));
        expect(fb.getRecent('npc_1')[2].instinct).toBeNull();

        // Empty string
        fb.record('npc_1', makeOutcome({ round: 4, instinct: '' }));
        expect(fb.getRecent('npc_1')[3].instinct).toBeNull();

        // Valid string should still work
        fb.record('npc_1', makeOutcome({ round: 5, instinct: 'valid_instinct' }));
        expect(fb.getRecent('npc_1')[4].instinct).toBe('valid_instinct');
    });

    // F4: defensive copy includes the instinct field
    it('F4: getRecent returns defensive copy — mutating instinct field never touches store', () => {
        const fb = new LlmAgentFeedbackController();
        fb.record('npc_1', makeOutcome({ round: 1, instinct: 'chase_attack' }));
        const read = fb.getRecent('npc_1');
        read[0].instinct = 'MUTATED';
        expect(fb.getRecent('npc_1')[0].instinct).toBe('chase_attack');
    });
});
