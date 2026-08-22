/**
 * npcAiUtils unit tests — edge cases for `hasDeterministicBrain`.
 *
 * Mirrors the existing M3 edge-case set from test/unit/NpcAIController.test.js
 * so the predicate behaves identically when called directly from the util.
 *
 * @module test/unit/npcAiUtils
 */

import { describe, it, expect } from 'vitest';
import { hasDeterministicBrain } from '../../src/utils/npcAiUtils.js';

describe('hasDeterministicBrain (npcAiUtils)', () => {
    it('true — entity with valid ai.behavior string', () => {
        const entity = { npcConfig: { ai: { behavior: 'chase_attack' } } };
        expect(hasDeterministicBrain(entity)).toBe(true);
    });

    it('false — behavior is empty string', () => {
        const entity = { npcConfig: { ai: { behavior: '' } } };
        expect(hasDeterministicBrain(entity)).toBe(false);
    });

    it('false — ai is null', () => {
        const entity = { npcConfig: { ai: null } };
        expect(hasDeterministicBrain(entity)).toBe(false);
    });

    it('false — npcConfig is empty object (no ai)', () => {
        const entity = { npcConfig: {} };
        expect(hasDeterministicBrain(entity)).toBe(false);
    });

    it('false — entity is undefined', () => {
        expect(hasDeterministicBrain(undefined)).toBe(false);
    });

    it('false — entity is empty object', () => {
        expect(hasDeterministicBrain({})).toBe(false);
    });

    it('false — behavior is a number (not a string)', () => {
        const entity = { npcConfig: { ai: { behavior: 123 } } };
        expect(hasDeterministicBrain(entity)).toBe(false);
    });

    it('false — behavior is null', () => {
        const entity = { npcConfig: { ai: { behavior: null } } };
        expect(hasDeterministicBrain(entity)).toBe(false);
    });

    it('false — npcConfig is undefined', () => {
        const entity = { other: 'data' };
        expect(hasDeterministicBrain(entity)).toBe(false);
    });

    it('true — behavior is non-empty string with special characters', () => {
        const entity = { npcConfig: { ai: { behavior: 'chase_attack_v2' } } };
        expect(hasDeterministicBrain(entity)).toBe(true);
    });
});
