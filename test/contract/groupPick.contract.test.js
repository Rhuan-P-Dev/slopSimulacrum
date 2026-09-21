/**
 * Group Pick — data-driven configuration contract tests.
 *
 * The cluster-pickup window (client) reads its cluster radius and trigger
 * threshold from the pickUpItem action definition in data/actions.json. The
 * capability projection (GET /actions / per-entity actions) spreads the raw
 * action data, so the `groupPick` sub-object must survive that projection
 * intact — this contract pins the whole data path on the real world:
 *
 *   1. data/actions.json pickUpItem declares a valid groupPick
 *      (radius > 0, minItems >= 1) — tuning is data-only;
 *   2. the shared capability projection carries it through to the shape the
 *      browser receives;
 *   3. the entity-scoped projection (what the client actually consumes for
 *      the active droid) carries it too.
 *
 * Uses the real buildWorldState() composition (no mocks of world internals —
 * the broadcast service is the only stub), mirroring the crafting contract
 * pattern.
 *
 * @module test/contract/groupPick.contract
 */

import { describe, it, expect, vi } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import DataLoader from '../../src/utils/DataLoader.js';

/**
 * Builds a fresh world (tick system NOT started) with a spied broadcast
 * service installed AFTER world init, so only post-setup operations can
 * trigger broadcasts.
 * @returns {{ worldStateController: import('../../src/controllers/WorldStateController.js'), tickSystem: Object }}
 */
function buildWorld() {
    const tickSystem = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController } = buildWorldState(tickSystem);

    const broadcast = vi.fn();
    worldStateController.setBroadcastService({ broadcast });

    return { worldStateController, tickSystem };
}

describe('Group Pick data-driven configuration contract', () => {
    it('data/actions.json declares a valid pickUpItem.groupPick (radius > 0, minItems >= 1)', async () => {
        const actions = DataLoader.loadJson('data/actions.json');
        const groupPick = actions?.pickUpItem?.groupPick;

        expect(groupPick).toBeDefined();
        expect(Number.isFinite(groupPick.radius)).toBe(true);
        expect(groupPick.radius).toBeGreaterThan(0);
        expect(Number.isInteger(groupPick.minItems)).toBe(true);
        expect(groupPick.minItems).toBeGreaterThanOrEqual(1);

        // The group-pick threshold must make sense relative to the pickup
        // range: a cluster radius larger than the pickup range would let the
        // window open for piles that are entirely unreachable.
        const pickupRange = actions.pickUpItem.range;
        if (typeof pickupRange === 'number') {
            expect(groupPick.radius).toBeLessThanOrEqual(pickupRange);
        }
    });

    it('the shared capability projection carries groupPick through to the client shape', () => {
        const { worldStateController: wsc } = buildWorld();
        const capabilities = wsc.getActionCapabilities();

        expect(capabilities['pickUpItem']).toBeDefined();
        expect(capabilities['pickUpItem'].groupPick).toEqual(
            expect.objectContaining({
                radius: expect.any(Number),
                minItems: expect.any(Number)
            })
        );
    });

    it('the entity-scoped action projection (client consumption path) carries groupPick for a spawned droid', () => {
        const { worldStateController: wsc } = buildWorld();
        const startRoomId = wsc.roomsController.getUidByLogicalId('start_room');
        const entityId = wsc.spawnEntity('smallBallDroid', startRoomId);

        const entityActions = wsc.getActionsForEntity(entityId);
        expect(entityActions['pickUpItem']).toBeDefined();
        expect(entityActions['pickUpItem'].groupPick).toEqual(
            expect.objectContaining({
                radius: expect.any(Number),
                minItems: expect.any(Number)
            })
        );

        // The LLM context projection is deliberately unaffected: it picks
        // known fields only, so the group-pick UI config never leaks into
        // model context.
        const llmActions = wsc.getActionCapabilitiesForLlm
            ? wsc.getActionCapabilitiesForLlm(entityId)
            : null;
        if (llmActions && llmActions['pickUpItem']) {
            expect(llmActions['pickUpItem'].groupPick).toBeUndefined();
        }
    });
});
