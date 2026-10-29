/**
 * view API integration tests — the GET /view/:id payload against a FULL real
 * world (real committed data files, real world spawn, real overTime organs).
 *
 * The unit layer (test/unit/ViewController.test.js + test/unit/viewRoutes.test.js)
 * drives the controller and route seams with hand-built fakes. Here we boot the
 * actual world (buildWorldState, same as the other integration tests) and
 * verify the payload against REAL data:
 *   - ENTITY view: the real "Knife Generator" static object — its component
 *     (generatorCore) with real recipe materials, the auto-installed
 *     knifeGeneratorIC organ (description generated from the real definition),
 *     live stats, and a non-empty inventory after the organ has produced knives;
 *   - COMPONENT view: the same component viewed directly (same node shape as
 *     inside the entity view);
 *   - ITEM view: a REAL knife produced by the organ — registry data (name,
 *     description, materials iron/wood, form volume) plus live instance data
 *     (owner, host component, volume);
 *   - the clothing rule does NOT misfire in the real world: nothing is
 *     equipped at boot, so the generator's component stays a 'component'
 *     node (the clothing branch is exercised deterministically by
 *     test/unit/ViewController.test.js).
 *
 * No LLM involved: the turn loop is never driven (runRound is never touched) —
 * the deterministic overTime hook (internalComponentController.processTurnEffects,
 * the same entry point the turn system fires via setTurnStartHook each round)
 * is called directly, which is what produces the knives.
 *
 * @module test/integration/viewIntegration
 */
import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

/**
 * Boots a fresh real world (tick system NOT started) and returns the facade.
 * Real data files, real spawn — the knife generator lands in the first room
 * with its knifeGeneratorIC auto-installed.
 */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const world = buildWorldState(tick);
    return world.worldStateController;
}

/**
 * Drives the deterministic round-start organ hook for `rounds` rounds — the
 * same path the turn system fires via setTurnStartHook (the overTime hook
 * itself is the real hook; only its firing is being simulated).
 */
function runRounds(wsc, rounds) {
    for (let r = 1; r <= rounds; r += 1) {
        wsc.internalComponentController.processTurnEffects(r);
    }
}

describe('view API — real world', () => {
    it('ENTITY view: a real spawned object shows its component (materials, organ, live stats) and a filled inventory after rounds', () => {
        const wsc = buildWorld();
        const gen = Object.values(wsc.getAll().entities).find(e => e && e.blueprint === 'knifeGenerator');
        expect(gen).not.toBeNull();

        runRounds(wsc, 3);

        const view = wsc.getViewData(gen.id, 'ENTITY');
        expect(view.kind).toBe('entity');
        expect(view.entity.id).toBe(gen.id);
        expect(view.entity.name).toBe('Knife Generator');
        expect(view.entity.isStatic).toBe(true);

        const comp = view.components[0];
        expect(comp).not.toBeNull();
        expect(comp.kind).toBe('component');
        expect(comp.type).toBe('generatorCore');
        expect(comp.name).toBe('Knife Generator Core');
        expect(comp.exists).toBe(true);
        expect(comp.broken).toBe(false);
        expect(comp.existence).toBe(1);
        expect(comp.materials).toEqual([{ material: 'iron', fraction: 1.0 }]);
        expect(comp.stats.Physical.volume).toBe(10);

        // Real organ, description generated from the real knifeGeneratorIC
        // definition (overTime generateItem, intervalTurns 1, itemsPerInterval 1).
        expect(comp.internalComponents).toHaveLength(1);
        const organ = comp.internalComponents[0];
        expect(organ.type).toBe('knifeGeneratorIC');
        expect(organ.description).toBe('Every 1 turn, produces 1 knife.');

        // After 3 driven rounds, the generator has produced knives into its core.
        expect(view.inventory.used).toBeGreaterThan(0);
        expect(view.inventory.capacity).toBe(10);
        expect(view.inventory.percent).toBeGreaterThan(0);
        expect(view.items.length).toBeGreaterThan(0);
        for (const item of view.items) {
            expect(item.type).toBe('knife');
            expect(item.worn).toBe(false);
            expect(item.hostComponentId).toBe(comp.id);
        }
    });

    it('COMPONENT view: the generator core viewed directly shows the same node, and nothing is worn (clothing rule must not misfire)', () => {
        const wsc = buildWorld();
        const gen = Object.values(wsc.getAll().entities).find(e => e && e.blueprint === 'knifeGenerator');
        expect(gen).not.toBeNull();

        runRounds(wsc, 3);

        const compId = gen.components[0].id;
        const view = wsc.getViewData(compId, 'COMPONENT');
        expect(view.kind).toBe('component');
        expect(view.id).toBe(compId);
        expect(view.type).toBe('generatorCore');
        expect(view.materials).toEqual([{ material: 'iron', fraction: 1.0 }]);
        expect(view.internalComponents[0].type).toBe('knifeGeneratorIC');

        // Nothing is equipped at boot in this world → the component node must
        // stay a component node (not a clothing node): the rule only fires for
        // wear.minVolume clothing.
        expect(view).not.toHaveProperty('worn');
        const worn = wsc.getWornItems ? wsc.getWornItems(gen.id) : null;
        expect(worn).toHaveLength(0);
    });

    it('ITEM view: a real knife produced by the organ shows registry data + live instance data', () => {
        const wsc = buildWorld();
        const gen = Object.values(wsc.getAll().entities).find(e => e && e.blueprint === 'knifeGenerator');
        expect(gen).not.toBeNull();

        runRounds(wsc, 3);

        // getAll() returns a deep clone, so re-read the fresh store after the
        // rounds have stored knives in the host entity (a pre-round clone
        // would still have no items key).
        const fresh = wsc.getAll().entities[gen.id];
        const knives = (fresh.items || []).filter(i => i.type === 'knife');
        expect(knives).toHaveLength(3); // 3 driven rounds x 1 knife/interval

        const item = knives[0];
        const view = wsc.getViewData(item.id, 'ITEM');
        expect(view.kind).toBe('item');
        expect(view.id).toBe(item.id);
        expect(view.itemId).toBe(item.id);
        expect(view.entityType).toBe(gen.id);
        expect(view.itemType).toBe('knife');
        expect(view.name).toBe('Knife');
        expect(view.itemType).toBe('knife');
        expect(view.description).toBe('A sharp blade capable of cutting. Its sharpness is a depletable quality of the iron edge — it thins as the blade\'s edge matter is consumed by the cut channel.');
        expect(view.materials).toEqual([
            { material: 'iron', fraction: 0.6, role: 'blade' },
            { material: 'wood', fraction: 0.4, role: 'handle' },
        ]);
        expect(view.form).toEqual({ volume: 1 });
        expect(view.volume).toBe(1);
        expect(view.worn).toBe(false);
        expect(view.contents).toBeNull();
        expect(view.hostComponentId).toBe(gen.components[0].id);
        expect(view.traits).not.toBeNull();
    });
});
