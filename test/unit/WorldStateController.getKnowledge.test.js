/**
 * WorldStateController.getKnowledge — unit tests (wiki/subMDs/frontend/knowledge_viewer.md).
 *
 * Covers the facade's knowledge passthrough in both wiring states:
 *   - wired: getKnowledge() returns the knowledge controller's payload
 *     (passthrough + defensive deep copy).
 *   - unwired: getKnowledge() returns the total empty-shape payload (NEVER null)
 *     — spec §4.3: the client renders per-section empty states, not an error,
 *     on a wiring miss (Finding #8 fix: the facade must not emit { knowledge: null }).
 *   - the wired path carries the shipped action definitions with their stat gates
 *     (the composition wiring for the `actions` section — an empty section is a
 *     legal state, so it needs a positive pin).
 *   - the wired path carries the Entities rows too, and NOT the kinds that already
 *     have a tab of their own (the composition wiring for the `definitions`
 *     section, knowledge_viewer.md Sec. 12 — same reason: an empty section is a
 *     legal state, so only a positive pin tells a dropped injection apart from one).
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

        // The composition wires the action registry into the codex: a real world
        // carries the shipped action definitions, each with the stat gate the
        // engine checks. Without this, dropping the injected registry would leave
        // the Actions tab silently empty (an empty section is a legal state).
        expect(viaFacade.actions.length).toBeGreaterThan(0);
        const cut = viaFacade.actions.find((a) => a.name === 'cut');
        expect(cut.requirements).toEqual([{ trait: 'Physical', stat: 'sharpness', minValue: 20 }]);
        const universal = viaFacade.actions.filter((a) => a.requirements.length === 0);
        expect(universal.map((a) => a.name).length).toBeGreaterThan(0);

        // The composition wires the Entities registries into the codex too
        // (knowledge_viewer.md Sec. 12): a real world answers with definitions, so
        // dropping the injected registries cannot pass unnoticed here. Counted, not
        // snapshotted - the install directory may carry a mod this change has not seen.
        expect(viaFacade.definitions.length).toBeGreaterThan(0);
        const kinds = new Set(viaFacade.definitions.map((row) => row.kind));
        expect(kinds.has('components')).toBe(true);
        expect(kinds.has('rooms')).toBe(true);
        // The kinds with their own tab are not repeated as bare rows.
        for (const owned of ['traits', 'materials', 'crafting', 'inventoryItems', 'actions']) {
            expect(kinds.has(owned)).toBe(false);
        }

        // Every row's kind has a tab of its own: a definition whose kind has no tab
        // is a definition the reader cannot reach (knowledge_viewer.md Sec. 12).
        const tabbed = new Set(viaFacade.definitionGroups.flatMap((group) => group.kinds));
        expect(tabbed.size).toBeGreaterThan(0);
        for (const kind of kinds) expect(tabbed.has(kind)).toBe(true);

        // Deep-copy check: mutate a returned nested value, call again, mutation is gone.
        viaFacade.items[0].name = 'MUTATED';
        viaFacade.traitStats.vocabulary.stats.push('hacked');
        viaFacade.definitions[0].definition.MUTATED = true;
        const again = world.getKnowledge();
        expect(again.items[0].name).not.toBe('MUTATED');
        expect(again.traitStats.vocabulary.stats).not.toEqual(viaFacade.traitStats.vocabulary.stats);
        expect(again.definitions[0].definition.MUTATED).toBeUndefined();
    });

    it('unwired facade: getKnowledge() returns the total empty-shape payload, never null (spec §4.3)', () => {
        const { world } = buildWorld();

        // Test-side seam: drop the wired knowledge controller (the facade stores
        // it on this.knowledgeController; precedent: the contract test writes _ fields).
        world.knowledgeController = null;

        const payload = world.getKnowledge();

        expect(payload).not.toBeNull();
        expect(payload).toEqual(emptyKnowledgePayload());
        expect(topLevelKeys(payload))
            .toEqual(['actions', 'definitionGroups', 'definitions', 'items', 'recipes', 'traitStats']);
        expect(payload.traitStats.vocabulary.traitGroups).toEqual(Object.values(TRAIT_GROUPS));
    });

    it('unwired facade: the JSON envelope the route would send is well-formed', () => {
        const { world } = buildWorld();
        world.knowledgeController = null;

        // The route does JSON.parse(JSON.stringify(res)) before sending; mirror it.
        const body = JSON.parse(JSON.stringify({ knowledge: world.getKnowledge() }));

        expect(body.knowledge).not.toBeNull();
        expect(topLevelKeys(body.knowledge))
            .toEqual(['actions', 'definitionGroups', 'definitions', 'items', 'recipes', 'traitStats']);
    });
});
