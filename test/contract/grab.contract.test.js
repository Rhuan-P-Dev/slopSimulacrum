/**
 * Feature: GRAB action — CONTRACT test.
 *
 * Builds a real world (buildWorldState, tick system NOT started) and asserts, with a
 * full action round-trip, that the new "grab" action (declared in
 * data/systems/actions.json) drains the TARGET's locomotion:
 *
 *   - grab is a close-range, component-targeting action (range 50, targetingType
 *     "component") gated on Physical.strength >= 1.
 *   - On success it applies a `updateComponentStatDelta` self-effect to the
 *     TARGET component: Movement.move -= 5 (the "grab" pulls the victim's move
 *     down so it slows to a crawl; it does NOT hurt the attacker).
 *   - Out-of-range execution fails and does NOT drain the target's move
 *     (a failed action must not fire its consequences).
 *
 * Expected values are derived from the SAME data the server reads (the target
 * component's live Movement.move) so the assertion is formula-exact, not a
 * hard-coded balance number.
 *
 * @module test/contract/grab
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readJson = (rel) =>
    JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf-8'));

/** A fresh, not-started world. */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const world = buildWorldState(tick).worldStateController;
    // Pin the onDamage Bernoulli stream (design §7.4) so the world is byte-for-byte
    // deterministic even though the grab suite never triggers damage. Always-fail ->
    // the world is identical to the pre-feature world; no assertion depends on it.
    if (world.onDamageDropListener) {
        world.onDamageDropListener._randomFn = () => 1;
    }
    return world;
}

const GRAB = readJson('data/systems/actions.json').grab;
const moveOf = (world, compId) => world.getComponentStats(compId)?.Movement?.move;

/** First droidRollingBall (moveCore host) of an entity. */
const ballOf = (world, id) => world.getEntity(id).components.find((c) => c.type === 'droidRollingBall');

/** Spawns an attacker at (0,0) and a victim at (vx,0); returns their ids. */
function spawnPair(world, roomId, vx = 50) {
    const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
    const victimId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
    world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
    world.stateEntityController.updateEntitySpatial(victimId, { x: vx, y: 0 });
    return { attackerId, victimId };
}

describe('Feature: grab action drains the target move (contract, full round-trip)', () => {
    it('the registry declares grab with the expected contract', () => {
        expect(GRAB, 'the grab action must be declared in data/systems/actions.json').toBeTruthy();
        expect(GRAB.targetingType, 'grab must be a component-targeting action').toBe('component');
        expect(Number.isFinite(GRAB.range), 'grab must declare a range').toBe(true);
        expect(
            GRAB.requirements.some((r) => r.trait === 'Physical' && r.stat === 'strength' && r.minValue >= 1),
            'grab must require Physical.strength'
        ).toBe(true);
        expect(
            GRAB.consequences.some((c) =>
                c.type === 'updateComponentStatDelta' &&
                c.target === 'target' &&
                c.params.trait === 'Movement' &&
                c.params.stat === 'move' &&
                c.params.value === -5
            ),
            'grab must drain the target Movement.move by 5 via updateComponentStatDelta'
        ).toBe(true);
    });

    it('grabs in range and drains the target component move by exactly 5 (the attacker keeps its own)', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        // vx=40 keeps the target strictly inside grab's data-driven range (50).
        const { attackerId, victimId } = spawnPair(world, roomId, 40);

        const victimBall = ballOf(world, victimId);
        expect(victimBall, 'the target should carry a droidRollingBall (the moveCore host)').toBeTruthy();
        const attackerBall = ballOf(world, attackerId);

        const beforeVictimMove = moveOf(world, victimBall.id);
        const beforeAttackerMove = attackerBall ? moveOf(world, attackerBall.id) : undefined;
        expect(beforeVictimMove, 'the target should start with a positive move stat').toBeGreaterThan(0);

        const result = world.actionController.executeAction('grab', attackerId, {
            targetEntityId: victimId,
            targetComponentId: victimBall.id
        });
        expect(result.success, `grab should succeed: ${JSON.stringify(result.error)}`).toBe(true);

        const afterVictimMove = moveOf(world, victimBall.id);
        expect(
            afterVictimMove,
            'the target move should drop by exactly 5 (formula-exact from the live stat)'
        ).toBeCloseTo(beforeVictimMove - 5, 6);
        expect(afterVictimMove, 'the drain is an integer delta of exactly -5').toBe(beforeVictimMove - 5);

        // grab is a self-effect on the TARGET: the attacker loses no move of its own.
        if (attackerBall) {
            const afterAttackerMove = moveOf(world, attackerBall.id);
            expect(
                afterAttackerMove,
                'the attacker should keep its own move (grab does not drain itself)'
            ).toBe(beforeAttackerMove);
        }
    });

    it('fails out of range and does NOT drain the target move', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        // Far apart: outside grab's range (50), so the action must reject.
        const { attackerId, victimId } = spawnPair(world, roomId, 300);

        const victimBall = ballOf(world, victimId);
        const beforeVictimMove = moveOf(world, victimBall.id);
        expect(beforeVictimMove, 'the target should start with a positive move stat').toBeGreaterThan(0);

        const result = world.actionController.executeAction('grab', attackerId, {
            targetEntityId: victimId,
            targetComponentId: victimBall.id
        });
        expect(result.success, 'grab out of range must fail (not silently no-op the move)').toBe(false);
        expect(
            moveOf(world, victimBall.id),
            'a failed grab must not fire its consequence (no move drained)'
        ).toBe(beforeVictimMove);
    });
});
