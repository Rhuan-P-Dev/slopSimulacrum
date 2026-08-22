/**
 * NpcAIController — durability DESYNC reproduction (bug: the NPC keeps
 * attacking the SAME component even after its durability went deeply
 * negative, and never reselects a target component).
 *
 * Unlike test/unit/NpcAIController.test.js (which mocks the facade with
 * hand-crafted fixtures that carry a FLAT `stats` object on each component),
 * this file builds the REAL controller chain via buildWorldState() — the
 * same pattern as test/contract/TurnSystem.contract.test.js — and drives the
 * deterministic brain exactly as src/server.js does:
 *
 *     turnSystemController.setNpcAgent((npcEntityId, round) => {
 *         const entity = worldStateController.getEntity(npcEntityId);
 *         if (NpcAIController.hasDeterministicBrain(entity)) {
 *             return Promise.resolve(npcAIController.think(npcEntityId, round, entity));
 *         }
 *         ...
 *     })
 *
 * Damage is applied with the EXACT call DamageConsequenceHandler makes:
 *     componentController.updateComponentStatDelta(compId, 'Physical', 'durability', delta)
 * (src/controllers/consequences/DamageConsequenceHandler.js:72 →
 *  src/controllers/core/componentController.js:121)
 *
 * What the tests document:
 *   - Durability has TWO storage layers:
 *       (1) authoritative NESTED store:  ComponentStatsController
 *           { [compId]: { Physical: { durability: n } } }   ← damage lands here
 *       (2) entity copy:  stateEntityController.entities[id].components[]
 *           built by EntityController.createEntityFromBlueprint() with ONLY
 *           { type, identifier, id } — NO stats field at all.
 *   - The AI's `_readDurability` reads layer (2) via `comp.stats['Physical.durability']`,
 *     which does not exist at runtime → always `undefined` → the broken-component
 *     reselection branch in `_selectTargetComponent` is unreachable → the AI
 *     always returns `components[0]` (the same component every round).
 *
 * Test 1 documents the desync (passes before AND after the fix — the entity
 * copy intentionally keeps no stats; the fix is on the reader side).
 * Test 2 encodes the DESIRED behavior: after the authoritative store shows
 * durability < 1, the brain must not attack that component. It FAILS against
 * the current code and is the regression test for the fix.
 *
 * @module test/unit/NpcAIController.durabilityDesync
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import NpcAIController from '../../src/controllers/ai/NpcAIController.js';

// =========================================================================
// Helpers (mirror the contract-test buildWorld pattern + server.js wiring)
// =========================================================================

/**
 * Builds a fresh world with the REAL composition root (all sub-controllers,
 * spawn observers, stat-change listeners, capability scan). Tick is NOT
 * started — everything is driven synchronously.
 */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world, subControllers } = buildWorldState(tick);
    return { world, tick, subControllers };
}

/**
 * Recording stand-in for the turn system — captures queueAction() calls
 * exactly like the mock in test/unit/NpcAIController.test.js, while the
 * FACADE (entities + component stats) is the real one.
 */
function makeRecordingTurns() {
    const queued = [];
    return {
        queued,
        getRoundState: () => ({ phase: 'planning', roundNumber: 1 }),
        queueAction: (entityId, actionName, params, source) => {
            queued.push({ entityId, actionName, params, source });
            return { success: true, queueId: `q-${queued.length}` };
        }
    };
}

/**
 * Spawns an attacker NPC (deterministic chase_attack brain, exactly like
 * data/npcs.json → WorldStateController._spawnNpcs) and a victim droid in
 * the SAME (initially empty) room, within punch range (dist 30 ≤ 100).
 */
function spawnAttackerAndVictim(world) {
    const roomUid = world.roomsController.getUidByLogicalId('far_right_room');
    const npcId = world.stateEntityController.spawnEntity('smallBallDroid', roomUid, {
        isNPC: true,
        name: 'TestDroid',
        npcConfig: { personality: 'test', ai: { behavior: 'chase_attack' } }
    });
    const victimId = world.stateEntityController.spawnEntity('smallBallDroid', roomUid);
    world.stateEntityController.updateEntitySpatial(npcId, { x: 100, y: 100 });
    world.stateEntityController.updateEntitySpatial(victimId, { x: 130, y: 100 });
    return { npcId, victimId };
}

/**
 * Applies damage to a component through the REAL damage path — the exact
 * call DamageConsequenceHandler._handleDamageComponent() makes for a
 * 'target'-typed damageComponent consequence (DamageConsequenceHandler.js:72).
 */
function dealDamage(world, compId, delta) {
    return world.componentController.updateComponentStatDelta(compId, 'Physical', 'durability', delta);
}

/**
 * Drives the brain exactly as src/server.js:75 does:
 *     npcAIController.think(npcEntityId, round, <live entity from getEntity>)
 */
function think(world, turns, npcId, round) {
    const ai = new NpcAIController({ worldStateController: world, turnSystemController: turns });
    return ai.think(npcId, round, world.getEntity(npcId));
}

// =========================================================================
// Tests
// =========================================================================

describe('NpcAIController durability desync (real controller chain)', () => {
    it('documents the desync: damage lands in the NESTED store; the entity components copy has NO stats field at all', () => {
        const { world } = buildWorld();
        const { victimId } = spawnAttackerAndVictim(world);

        const victim = world.stateEntityController.getEntity(victimId);
        const comp0 = victim.components[0];
        // First component of the smallBallDroid blueprint (data/blueprints.json).
        expect(comp0.type).toBe('centralBall');

        // The entity-side component copy has no stats field (EntityController
        // only stores { type, identifier, id }). Nothing anywhere in the
        // damage path writes one.
        expect('stats' in comp0).toBe(false);

        // The authoritative nested store has the full blueprint stats.
        expect(world.getComponentStats(comp0.id).Physical.durability).toBe(100);

        // Apply the real damage call (e.g. two punches of 87.5 → -75).
        const ok = dealDamage(world, comp0.id, -175);
        expect(ok).toBe(true);

        // Layer (1) — nested store: now deeply negative.
        expect(world.getComponentStats(comp0.id).Physical.durability).toBe(-75);

        // Layer (2) — entity copy: still no stats field. The AI reads this
        // shape, so it is blind to the damage.
        const after = world.stateEntityController.getEntity(victimId).components[0];
        expect('stats' in after).toBe(false);
    });

    it('REGRESSION (currently failing): brain must NOT attack a component whose authoritative durability < 1', () => {
        const { world } = buildWorld();
        const { npcId, victimId } = spawnAttackerAndVictim(world);

        const comp0 = world.stateEntityController.getEntity(victimId).components[0];
        expect(world.getComponentStats(comp0.id).Physical.durability).toBe(100);

        // Break the first component: 100 → -75 via the real damage path.
        dealDamage(world, comp0.id, -175);
        expect(world.getComponentStats(comp0.id).Physical.durability).toBe(-75);

        const turns = makeRecordingTurns();
        const result = think(world, turns, npcId, 1);

        // The brain must have found the in-range victim and decided to punch...
        expect(result.acted).toBe(true);
        expect(turns.queued).toHaveLength(1);
        expect(turns.queued[0].actionName).toBe('droid punch');

        // ...but it must NOT target the broken component (reselect among the
        // usable components, per _selectTargetComponent's broken rule).
        expect(turns.queued[0].params.targetComponentId).not.toBe(comp0.id);
    });
});
