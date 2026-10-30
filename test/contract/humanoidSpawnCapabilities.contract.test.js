/**
 * Spawned-body capability contract — full real world (data files + composition
 * root), no network, no mocks.
 *
 * Regression guard for the "the droid that spawns cannot dash, punch or pick
 * anything up" defect. The panel reported, for the incarnated humanoid droid:
 *
 *     move / dash / selfHeal / grab / droid punch / dropItem / pickUpItem /
 *     placeMachine / retrieveMachine   ->  0 capable, 1 incapable
 *     cut / shootT1 / touch             ->  working
 *
 * Cause: an organ allowlist that never learned the new blueprint keys. The
 * humanoid recipes declare their function organs (`maleArm: ["strengthCore"]`,
 * `maleLeg: ["moveCore"]`), but `strengthCore`/`moveCore` in
 * data/components/internalComponents.json listed only the older blueprint keys, and
 * `InternalComponentController.autoInstallOnEntitySpawn` vetoes the install when the
 * entity's top-level blueprint key is missing. Matter stats (existence, sharpness,
 * mass) are derived from the material, so `cut` / `shootT1` / `touch` kept working;
 * function stats exist ONLY where an organ installed, so every strength- or
 * movement-gated action lost all of its components. Same veto hit the card body
 * blueprint, whose key is the card's display name.
 *
 * @module test/contract/humanoidSpawnCapabilities.contract
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { DEFAULT_PLAYER_BLUEPRINT } from '../../shared/Defaults.js';

/** Actions whose requirements read a FUNCTION stat (granted by an organ only). */
const FUNCTION_GATED_ACTIONS = [
    'move', 'dash', 'selfHeal', 'grab', 'droid punch',
    'dropItem', 'placeMachine', 'retrieveMachine', 'pickUpItem',
];

describe('Spawned humanoid body keeps its function stats (real world, data-driven)', () => {
    let wsc;

    beforeAll(() => {
        // Mirror src/server.js: the world is built by the composition root, which
        // runs world init + the initial capability scan. The player is incarnated on
        // the socket-connect path, replicated here exactly as the
        // playerInitialSpawns contract does it.
        const tickSystem = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
        ({ worldStateController: wsc } = buildWorldState(tickSystem));
    });

    /**
     * Spawns one entity from a committed blueprint and returns it with its
     * function-stat census (how many of its components carry movement/strength).
     * @param {string} blueprintName
     * @returns {{ entityId: string, entity: Object, moveComponents: number, strengthComponents: number }}
     */
    function spawnAndCensus(blueprintName) {
        const entityId = wsc.spawnEntity(blueprintName, wsc.getRoomUidByLogicalId('start_room'));
        const entity = wsc.getEntity(entityId);
        let moveComponents = 0;
        let strengthComponents = 0;
        for (const component of entity.components) {
            const stats = wsc.getComponentStats(component.id) || {};
            if ((stats.Movement?.move ?? 0) >= 5) moveComponents++;
            if ((stats.Physical?.strength ?? 0) >= 15) strengthComponents++;
        }
        return { entityId, entity, moveComponents, strengthComponents };
    }

    it('grants the incarnated player droid both movement and strength stats', () => {
        const { entity, moveComponents, strengthComponents } = spawnAndCensus(DEFAULT_PLAYER_BLUEPRINT);

        expect(entity.blueprint).toBe(DEFAULT_PLAYER_BLUEPRINT);
        // Two legs carry a locomotion core, two arms a strength core.
        expect(moveComponents).toBe(2);
        expect(strengthComponents).toBe(2);
    });

    it('offers every strength- or movement-gated action to the incarnated player droid', () => {
        const { entityId } = spawnAndCensus(DEFAULT_PLAYER_BLUEPRINT);
        const actions = wsc.getActionsForEntity(entityId);

        for (const actionName of FUNCTION_GATED_ACTIONS) {
            const entry = actions[actionName];
            expect(entry, `action "${actionName}" missing from the entity's actions`).toBeDefined();
            expect(entry.canExecute.length, `action "${actionName}" has no capable component`).toBeGreaterThan(0);
            expect(entry.cannotExecute, `action "${actionName}" still marks the entity incapable`).toEqual([]);
        }
    });

    it('grants the same organs to a card body blueprint (keyed by display name)', () => {
        // A card body is a blueprint registered under the card's display name, so a
        // hand-maintained allowlist has to name it as well; the shipped example is
        // the committed `Minako` body (minakoarm / minakoleg declare the organs).
        const { entityId, entity, moveComponents, strengthComponents } = spawnAndCensus('Minako');

        expect(entity.components.length).toBeGreaterThan(1);
        expect(moveComponents).toBeGreaterThan(0);
        expect(strengthComponents).toBeGreaterThan(0);

        const actions = wsc.getActionsForEntity(entityId);
        for (const actionName of ['move', 'grab', 'droid punch']) {
            expect(actions[actionName].canExecute.length, `action "${actionName}" has no capable component`)
                .toBeGreaterThan(0);
        }
    });
});
