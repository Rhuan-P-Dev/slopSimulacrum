/**
 * WorldStateController.getKnowledge — unit tests (wiki/subMDs/frontend/knowledge_viewer.md).
 *
 * Covers the facade's knowledge passthrough in both wiring states:
 *   - wired: getKnowledge() returns the knowledge controller's payload
 *     (passthrough + defensive deep copy).
 *   - unwired: getKnowledge() returns the total empty-shape payload (NEVER null)
 *     — spec §4.3: the client renders per-section empty states, not an error,
 *     on a wiring miss (Finding #8 fix: the facade must not emit { knowledge: null }).
 *
 * Harness mirrors test/unit/WorldStateController.getMaterialRegistry.test.js
 * (same buildWorldState / UniversalTickSystem setup).
 *
 * @module test/unit/WorldStateController.getKnowledge
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { emptyKnowledgePayload } from '../../src/controllers/knowledge/KnowledgeController.js';
import { TRAIT_GROUPS } from '../../shared/StatVocabulary.js';

// =========================================================================
// Helpers
// =========================================================================

/** Build a minimal world for testing. */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const result = buildWorldState(tick);
    return { world: result.worldStateController, tick, subControllers: result.subControllers };
}

/** Sorted top-level section keys of the codex payload (spec §3). */
function topLevelKeys(payload) {
    return Object.keys(payload).sort();
}

// =========================================================================
// Tests — getKnowledge()
// =========================================================================

describe('WorldStateController.getKnowledge', () => {
    it('wired facade: getKnowledge() returns the knowledge controller payload (passthrough) as a deep copy', () => {
        const { world, subControllers } = buildWorld();

        const viaFacade = world.getKnowledge();
        const viaSubController = subControllers.knowledgeController.getKnowledge();

        // Deep-equal passthrough of the sub-controller's payload.
        expect(viaFacade).toEqual(viaSubController);
        expect(viaFacade).not.toBeNull();

        // Deep-copy check: mutate a returned nested value, call again, mutation is gone.
        viaFacade.items[0].name = 'MUTATED';
        viaFacade.traitStats.vocabulary.stats.push('hacked');
        const again = world.getKnowledge();
        expect(again.items[0].name).not.toBe('MUTATED');
        expect(again.traitStats.vocabulary.stats).not.toEqual(viaFacade.traitStats.vocabulary.stats);
    });

    it('unwired facade: getKnowledge() returns the total empty-shape payload, never null (spec §4.3)', () => {
        const { world } = buildWorld();

        // Test-side seam: drop the wired knowledge controller (the facade stores
        // it on this.knowledgeController; precedent: the contract test writes _ fields).
        world.knowledgeController = null;

        const payload = world.getKnowledge();

        expect(payload).not.toBeNull();
        expect(payload).toEqual(emptyKnowledgePayload());
        expect(topLevelKeys(payload)).toEqual(['items', 'recipes', 'traitStats']);
        expect(payload.traitStats.vocabulary.traitGroups).toEqual(Object.values(TRAIT_GROUPS));
    });

    it('unwired facade: the JSON envelope the route would send is well-formed', () => {
        const { world } = buildWorld();
        world.knowledgeController = null;

        // The route does JSON.parse(JSON.stringify(res)) before sending; mirror it.
        const body = JSON.parse(JSON.stringify({ knowledge: world.getKnowledge() }));

        expect(body.knowledge).not.toBeNull();
        expect(topLevelKeys(body.knowledge)).toEqual(['items', 'recipes', 'traitStats']);
    });
});
