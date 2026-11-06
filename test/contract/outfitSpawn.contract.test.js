/**
 * CONTRACT TEST — a body is born dressed by the outfit registry, and the default
 * clothing stands down for it.
 *
 * `data/mods/core-outfits/outfits.json` names, per blueprint, the garment to wear and
 * the component to wear it on. Two halves are pinned here against a real built world
 * (spawn → wear), because each one breaks in a different direction:
 *
 *   - the outfit is really worn, on the component the data named (not wherever the
 *     volume happened to be free), and it is worn BEFORE the loadout spends that
 *     volume — a shirt cannot go on a body core already holding ten coal;
 *   - the default clothing of the spawn loadout does NOT also land on that body. A
 *     doubled garment is the failure mode this registry was created to avoid, and it
 *     is invisible in prose (both sentences say "wearing a T-Shirt"), so it is pinned
 *     as a COUNT, not as a sentence;
 *   - a blueprint the registry does not mention keeps the default clothing: the new
 *     rule dresses the bodies it names and nobody else;
 *   - determinism: two identically built worlds dress identically.
 *
 * Every expected word and key is DERIVED from the shipped data, never typed here.
 *
 * @module test/contract/outfitSpawn
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import DataLoader from '../../src/utils/DataLoader.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';

/** The shipped outfit: one garment, on one component of one shipped body. */
const OUTFIT_REGISTRY = DataLoader.loadRegistry(REGISTRY_KINDS.OUTFITS);
const DRESSED_BLUEPRINT = 'm1Droid';
const [SHIPPED_OUTFIT] = OUTFIT_REGISTRY[DRESSED_BLUEPRINT] ?? [];
/** The loadout's default clothing (`wear: true` in core-world initialSpawns). */
const DEFAULT_CLOTHING = (DataLoader.loadRegistry(REGISTRY_KINDS.WORLD)?.initialSpawns ?? [])
    .filter((entry) => entry?.wear === true);

/**
 * One fresh world and a spawn helper. Every spawn carries the world's own loadout,
 * which is exactly what makes "the outfit replaces the default" a claim about a real
 * world rather than about a stub.
 * @returns {{ world: Object, spawn: (blueprint: string) => string }}
 */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world } = buildWorldState(tick);
    const room = world.roomsController.getUidByLogicalId('start_room');
    // The server's own cast walks in with every world; this file speaks about
    // spawns it made itself.
    Object.values(world.stateEntityController.entities)
        .filter((entity) => entity.isNPC === true)
        .forEach((entity) => world.despawnEntity(entity.id));
    return {
        world,
        spawn: (blueprint) => world.stateEntityController.spawnEntity(blueprint, room, { name: blueprint })
    };
}

/** What one entity wears, in the shape the wear system reports it. */
const wornOn = (world, entityId) => (world.getWornItems(entityId) ?? [])
    .map((worn) => ({ item: worn.itemType, on: worn.componentType }));

describe('a body is born wearing its outfit, and only it', () => {
    it('the shipped world really has an outfit, and really has default clothing to replace', () => {
        // A fixture that silently lost either half would "pass" every assertion below
        // by never reaching the rule they are about.
        expect(SHIPPED_OUTFIT, 'core-outfits clothes ' + DRESSED_BLUEPRINT).toMatchObject({
            item: expect.any(String),
            component: expect.any(String)
        });
        expect(DEFAULT_CLOTHING.length, 'the loadout authors a default garment').toBeGreaterThan(0);
    });

    it('wears the outfit on the component the outfit named', () => {
        const { world, spawn } = buildWorld();
        const entityId = spawn(DRESSED_BLUEPRINT);
        expect(wornOn(world, entityId)).toEqual([
            { item: SHIPPED_OUTFIT.item, on: SHIPPED_OUTFIT.component }
        ]);
    });

    it('does not also wear the loadout default: one garment, not two', () => {
        const { world, spawn } = buildWorld();
        // A shipped body the registry does NOT mention, so its default clothing is
        // still on duty. Named rather than scanned for: "the first blueprint in file
        // order that has no outfit" would make this test depend on somebody else's
        // new row in a data file.
        const undressedBlueprint = 'smallBallDroid';
        expect(OUTFIT_REGISTRY[undressedBlueprint], 'this body authors no outfit').toBeUndefined();

        const dressed = spawn(DRESSED_BLUEPRINT);
        expect(wornOn(world, dressed), 'the default garment stood down')
            .toHaveLength(DEFAULT_CLOTHING.length);
        const bare = spawn(undressedBlueprint);
        expect(wornOn(world, bare), 'a body nobody dressed still wears the world default')
            .toHaveLength(DEFAULT_CLOTHING.length);
        expect(wornOn(world, bare)[0].item).toBe(DEFAULT_CLOTHING[0].item);
        expect(wornOn(world, bare)[0].on, 'the default keeps choosing its own component (volume fit)')
            .not.toBe(SHIPPED_OUTFIT.component);
    });

    it('is a pure function of the data: two identically built worlds dress identically', () => {
        const firstWorld = buildWorld();
        const secondWorld = buildWorld();
        const first = wornOn(firstWorld.world, firstWorld.spawn(DRESSED_BLUEPRINT));
        const second = wornOn(secondWorld.world, secondWorld.spawn(DRESSED_BLUEPRINT));
        expect(first.length, 'a real body was dressed').toBeGreaterThan(0);
        expect(second).toEqual(first);
    });
});
