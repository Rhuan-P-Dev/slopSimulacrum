/**
 * CONTRACT TEST — a body designed with an inborn effect arrives carrying it.
 *
 * Three commits wrote three halves. The design pipeline's LAST stage authors effect
 * definitions (`AgentBodyDesignPipeline`), `saveDesign` writes them into the `effects`
 * kind of the body's own package and names their ids on the blueprint's `inbornEffects`,
 * and `InbornEffects.applyInbornEffects` puts them on at spawn. What is pinned HERE is
 * the seam no single one of them owns: a blueprint in the exact shape the save writes,
 * read by a real world, produces a body that is actually running the effect — and the
 * round clock never eats it.
 *
 * The world is built from the SHIPPED registries with exactly two rows layered on in
 * memory (`RegistryStore` injection, no data file touched): the effect definition, and
 * `inbornEffects` on a blueprint this file spawns. So the only new facts are designed ones.
 *
 * @module test/contract/inbornEffectDesign
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { RegistryStore } from '../../src/services/RegistryStore.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import DataLoader from '../../src/utils/DataLoader.js';
import { REGISTRY_KINDS, REGISTRY_KIND_LIST } from '../../shared/RegistryKinds.js';

/** The `_`-prefixed file headers are metadata, not definitions (same basis as the loader). */
const stripMetadata = (registry) => Object.fromEntries(
    Object.entries(registry ?? {}).filter(([key]) => !key.startsWith('_'))
);

const BASE_REGISTRIES = Object.fromEntries(
    REGISTRY_KIND_LIST.map((kind) => [kind, stripMetadata(DataLoader.loadRegistry(kind))])
);

/** The body this file spawns, and the stat its inborn effect holds down. */
const BODY = 'smallBallDroid';
const TRAIT = 'Movement';
const STAT = 'move';
/** The namespaced id the save writes: `<package slug>_<authored id>`. */
const EFFECT_KEY = 'courier_slowFrame';

/**
 * An effect definition in the exact shape `saveDesign` writes into the package's `effects`
 * kind: `durationRounds: 0`, because an inborn effect lasts as long as the body does.
 */
const SLOW_FRAME = {
    name: 'Slow Frame',
    prose: { phrase: 'is moving through something heavy' },
    target: 'component',
    durationRounds: 0,
    stacking: 'refresh',
    revert: 'auto',
    operations: [{ op: 'statSet', params: { trait: TRAIT, stat: STAT, value: 3 } }],
    perRound: [],
    // The stamp the save puts and the model does not author: which body was born with this.
    appliesTo: BODY
};

/**
 * An effect that declares this body and promises a stat no part of it carries: the apply is
 * refused, and the body still arrives.
 */
const UNCARRIED = {
    ...SLOW_FRAME,
    name: 'Uncarried Promise',
    appliesTo: BODY,
    operations: [{ op: 'statSet', params: { trait: 'Movement', stat: 'flight', value: 9 } }]
};

/**
 * A real world over the shipped registries plus the two designed rows.
 * @param {Object} [options]
 * @param {string[]|null} [options.inbornEffects] - what the blueprint declares
 *   (default: the one effect this file authors)
 * @param {boolean} [options.withDefinition] - ship the effect definition at all
 * @returns {{ world: Object, spawn: () => string, nativeMove: number }}
 */
function buildDesignedWorld(options = {}) {
    const effects = { ...BASE_REGISTRIES[REGISTRY_KINDS.EFFECTS] };
    if (options.withEffect !== false) effects[EFFECT_KEY] = SLOW_FRAME;
    if (options.extra) Object.assign(effects, options.extra);

    const store = new RegistryStore({
        ...BASE_REGISTRIES,
        [REGISTRY_KINDS.EFFECTS]: effects,
    });
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world } = buildWorldState(tick, store);
    // Only this file's spawns speak here; the server's cast is not part of the claim.
    Object.values(world.stateEntityController.entities)
        .filter((entity) => entity.isNPC === true)
        .forEach((npc) => world.despawnEntity(npc.id));
    const roomId = world.roomsController.getUidByLogicalId('start_room');
    return {
        world,
        // What this part's stat is WITHOUT any inborn effect: read from a world where the
        // definition is absent, because a body in this world is born altered and a "before"
        // measured here would be the altered number.
        nativeMove: NATIVE_MOVE,
        spawn: () => world.stateEntityController.spawnEntity(BODY, roomId),
    };
}

/** The untouched value of the stat this file alters, measured once on a clean world. */
const NATIVE_MOVE = (() => {
    const store = new RegistryStore({
        ...BASE_REGISTRIES,
        [REGISTRY_KINDS.EFFECTS]: BASE_REGISTRIES[REGISTRY_KINDS.EFFECTS],
    });
    const { worldStateController: world } = buildWorldState(new UniversalTickSystem(MAX_TICKS_PER_SECOND), store);
    const entityId = world.stateEntityController.spawnEntity(BODY, world.roomsController.getUidByLogicalId('start_room'));
    const componentId = world.stateEntityController.getEntity(entityId).components
        .map((c) => c.id)
        .find((id) => Number.isFinite(world.getComponentStats(id)?.[TRAIT]?.[STAT]));
    return world.getComponentStats(componentId)[TRAIT][STAT];
})();

describe('a body designed with an inborn effect', () => {
    it('arrives with the effect already running, applied at spawn', () => {
        const { world, spawn, nativeMove } = buildDesignedWorld();
        const entityId = spawn();

        // The stat is held at the designed value on the part that carries it - so the
        // effect ran through the component choke point, not a side write.
        const componentId = world.stateEntityController.getEntity(entityId).components
            .map((c) => c.id)
            .find((id) => world.getComponentStats(id)?.[TRAIT]?.[STAT] !== undefined);
        expect(world.getComponentStats(componentId)[TRAIT][STAT]).toBe(3);
        expect(nativeMove).not.toBe(3);

        // And it is a live instance in the engine, recorded against the target the effect
        // was applied to - the BODY, which is what `InbornEffects` names. One instance
        // carrying several parts, not one per part.
        const running = world.listActiveEffects(entityId);
        expect(running.map((instance) => instance.effectId)).toEqual([EFFECT_KEY]);
        expect(world.listActiveEffects(componentId)).toEqual([]);
    });

    it('is not eaten by the round clock, because an inborn effect ends when the body does', () => {
        const { world, spawn } = buildDesignedWorld();
        const entityId = spawn();
        const componentId = world.stateEntityController.getEntity(entityId).components
            .map((c) => c.id)
            .find((id) => world.getComponentStats(id)?.[TRAIT]?.[STAT] !== undefined);

        // Many rounds pass. `durationRounds: 0` and the unpublished round at spawn mean
        // "until removed", so the body keeps what it was designed to do.
        for (let round = 1; round <= 20; round++) {
            world.effectEngine.setCurrentRound(round);
            world.effectEngine.expireEffects();
        }
        expect(world.getComponentStats(componentId)[TRAIT][STAT]).toBe(3);
        // A permanent instance: no expiry round, so `expireEffects` passes over it every
        // round it runs - the body ends, not the timer.
        const [instance] = world.listActiveEffects(entityId);
        expect(instance.effectId).toBe(EFFECT_KEY);
        expect(instance.expiresRound).toBeNull();
    });

    it('spawns anyway when its effect promises a stat no part of it carries', () => {
        // Spawn is the one moment the world cannot fail half-way: an over-promising effect
        // is a body without that effect and a warning naming it, never a missing character.
        const { world, spawn, nativeMove } = buildDesignedWorld({ extra: { [EFFECT_KEY]: UNCARRIED } });
        const entityId = spawn();
        const entity = world.stateEntityController.getEntity(entityId);
        expect(entity).toBeTruthy();
        expect(world.listActiveEffects(entityId)).toEqual([]);
        // Nothing half-applied: the part the refused effect targeted still holds its own value.
        expect(entity.components.length).toBeGreaterThan(0);
        const componentId = world.stateEntityController.getEntity(entityId).components
            .map((c) => c.id)
            .find((id) => world.getComponentStats(id)?.[TRAIT]?.[STAT] !== undefined);
        expect(world.getComponentStats(componentId)[TRAIT][STAT]).toBe(nativeMove);
    });

    it('is left completely alone when no effect declares its blueprint', () => {
        const { world, spawn, nativeMove } = buildDesignedWorld({ withEffect: false });
        const entityId = spawn();
        const componentId = world.stateEntityController.getEntity(entityId).components
            .map((c) => c.id)
            .find((id) => world.getComponentStats(id)?.[TRAIT]?.[STAT] !== undefined);
        expect(world.getComponentStats(componentId)[TRAIT][STAT]).toBe(nativeMove);
    });
});
