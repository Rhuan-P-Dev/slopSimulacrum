/**
 * CONTRACT TEST — the effects layer is live in the composed world, and it is
 * deliberately NOT in the snapshot.
 *
 * Two claims, both of which a lint cannot see and a unit test over a hand-built
 * facade cannot make:
 *
 *   1. THE LAYER IS REACHABLE FROM THE REAL WORLD. `buildWorldState` wires an
 *      `effectEngine` onto the facade, the `effects` registry kind resolves through
 *      the mod packages, and applying a shipped effect moves a real component stat
 *      through the component choke point — the same write an NPC action makes, so a
 *      damage listener and a stat-change listener see it identically.
 *
 *   2. LIVE EFFECTS DO NOT SURVIVE SAVE/LOAD — decision D3, stated here rather than
 *      left in a module header. A restore landing mid-effect keeps the values the
 *      effect wrote and loses the bookkeeping, so the effect neither ticks nor
 *      expires. The snapshot schema is NOT bumped for it (`PERSISTENCE_SCHEMA_VERSION`
 *      is asserted unchanged), which is the part a reader is most likely to
 *      "helpfully" change and turn into a save-format break.
 *
 * The world is driven the way the other effect suites drive it — a non-started tick
 * system, a round published by hand — so nothing here waits on a timer (`CR TST-2`).
 *
 * @module test/contract/effectsLive
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';
import ConsequenceHandlers from '../../src/controllers/consequences/consequenceHandlers.js';
import { PERSISTENCE_SCHEMA_VERSION } from '../../src/controllers/logic/PersistenceLogic.js';

/** A composed world with one droid and no boot NPCs, so the effect has one target. */
function buildLiveWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world } = buildWorldState(tick);
    Object.values(world.stateEntityController.entities)
        .filter((entity) => entity.isNPC === true)
        .forEach((npc) => world.despawnEntity(npc.id));
    const roomId = world.roomsController.getUidByLogicalId('start_room');
    const entityId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
    return { world, entityId };
}

/**
 * The component of an entity that actually carries `Movement.move`. `move` is
 * granted by a function organ, so it lives on one part of the body rather than on
 * every one - which is exactly what the effect's entity target means: the parts the
 * body has, never an invented one.
 */
function moveBearingComponent(world, entityId) {
    const entity = world.stateEntityController.getEntity(entityId);
    return entity.components
        .map((component) => component.id)
        .find((componentId) => Number.isFinite(world.getComponentStats(componentId)?.Movement?.move));
}

describe('the effects layer in the composed world', () => {
    it('is wired on the facade and reads the shipped definitions', () => {
        const { world } = buildLiveWorld();
        expect(world.effectEngine).toBeTruthy();
        const shipped = world.listEffectDefinitions().map((entry) => entry.id);
        expect(shipped).toContain('burning');
        expect(world.getEffectDefinition('dazed').operations[0].op).toBe('statDelta');
    });

    it('refuses an unknown effect with a code rather than a stack', () => {
        const { world, entityId } = buildLiveWorld();
        const result = world.effectEngine.apply('noSuchEffect', { kind: 'entity', id: entityId });
        expect(result).toMatchObject({ ok: false, code: 'EFFECT_UNKNOWN' });
    });

    it('writes a real component stat through the component choke point', () => {
        const { world, entityId } = buildLiveWorld();
        const componentId = moveBearingComponent(world, entityId);
        expect(componentId, 'the test droid has a part that can move').toBeTruthy();
        const before = world.getComponentStats(componentId).Movement.move;
        world.effectEngine.setCurrentRound(1);
        const result = world.effectEngine.apply('dazed', { kind: 'entity', id: entityId });
        expect(result.ok).toBe(true);
        expect(world.getComponentStats(componentId).Movement.move).toBe(before - 4);
    });

    it('expires back to the value the body had, in the same engine the turn system drives', () => {
        const { world, entityId } = buildLiveWorld();
        const componentId = moveBearingComponent(world, entityId);
        const before = world.getComponentStats(componentId).Movement.move;
        world.effectEngine.setCurrentRound(1);
        world.effectEngine.apply('dazed', { kind: 'entity', id: entityId });
        expect(world.getComponentStats(componentId).Movement.move).toBe(before - 4);
        world.effectEngine.setCurrentRound(2);
        world.effectEngine.expireEffects();
        expect(world.getComponentStats(componentId).Movement.move).toBe(before);
    });
});

describe('live effects and the snapshot (decision D3, pinned)', () => {
    it('a restore keeps the values an effect wrote and forgets the effect itself', () => {
        const { world, entityId } = buildLiveWorld();
        const componentId = moveBearingComponent(world, entityId);
        const before = world.getComponentStats(componentId).Movement.move;
        world.effectEngine.setCurrentRound(1);
        world.effectEngine.apply('dazed', { kind: 'entity', id: entityId }, { rounds: 5 });
        const midEffectValue = world.getComponentStats(componentId).Movement.move;
        expect(midEffectValue).toBe(before - 4);

        const snapshot = world.serialize();
        const restored = buildWorldState(new UniversalTickSystem(MAX_TICKS_PER_SECOND));
        restored.worldStateController.restore(snapshot);

        // The value stays spent...
        const restoredEntity = Object.values(restored.worldStateController.stateEntityController.entities)
            .find((candidate) => candidate.id === entityId);
        const restoredComponentId = moveBearingComponent(restored.worldStateController, entityId);
        expect(restoredEntity).toBeTruthy();
        expect(restored.worldStateController.getComponentStats(restoredComponentId).Movement.move)
            .toBe(midEffectValue);
        // ...and the effect is gone: nothing will tick it, nothing will expire it.
        expect(restored.worldStateController.effectEngine.getActiveEffects()).toEqual({});
    });

    it('does not bump the snapshot schema for effects, so old saves still load', () => {
        const { world } = buildLiveWorld();
        const snapshot = world.serialize();
        expect(snapshot.schemaVersion).toBe(PERSISTENCE_SCHEMA_VERSION);
        expect(snapshot.state.effects).toBeUndefined();
    });
});

describe('an action inflicting an effect (the applyEffect consequence)', () => {
    /**
     * The handler map wired to the real world. What is under test is the bridge the
     * `applyEffect` consequence type adds - that a resolved target becomes a real effect
     * instance in the real engine. The dispatcher's own target resolution (`self` vs
     * `target`, placeholder substitution) is pre-existing and pinned in
     * ConsequenceDispatcher.dispatchConsequences.test.js, so it is not re-proven here.
     * @param {Object} world - the real facade
     * @returns {ConsequenceHandlers} the handler map
     */
    function handlersFor(world) {
        const handlers = new ConsequenceHandlers({});
        handlers.setWorldStateController(world);
        return handlers;
    }

    it('lands on the part that carries the stat, through the handler map', () => {
        const { world, entityId } = buildLiveWorld();
        const componentId = moveBearingComponent(world, entityId);
        const before = world.getComponentStats(componentId).Movement.move;

        const registered = world.registerEffectDefinition('sluggish', {
            target: 'component',
            durationRounds: 2,
            operations: [{ op: 'statSet', params: { trait: 'Movement', stat: 'move', value: 1 } }]
        });
        expect(registered.ok, JSON.stringify(registered.errors)).toBe(true);

        // The round is published BEFORE the application, the way the TurnSystem does it:
        // an instance applied while no round exists has no expiry round at all (it lasts
        // until removed), so aging it would test a different rule than the one here.
        world.effectEngine.setCurrentRound(1);
        const result = handlersFor(world).dispatch('applyEffect', componentId,
            { effectId: 'sluggish' }, { actorId: entityId, actionName: 'slash' });
        expect(result.success, result.message).toBe(true);
        expect(world.getComponentStats(componentId).Movement.move).toBe(1);

        // And it is a real instance in the real engine: the round retires it and the
        // contribution reverts, exactly as an operator-applied one would.
        world.effectEngine.setCurrentRound(2);
        world.effectEngine.expireEffects();
        expect(world.getComponentStats(componentId).Movement.move).toBe(1);
        world.effectEngine.setCurrentRound(3);
        world.effectEngine.expireEffects();
        expect(world.getComponentStats(componentId).Movement.move).toBe(before);
    });

    it('reports a refusal rather than pretending the hit landed', () => {
        const { world, entityId } = buildLiveWorld();
        const result = handlersFor(world).dispatch('applyEffect', entityId,
            { effectId: 'noSuchEffect' }, { actorId: entityId, actionName: 'slash' });
        expect(result.success).toBe(false);
        expect(result.message).toContain('noSuchEffect');
    });
});

describe('a runtime effect definition is session-only and never shadows a package', () => {
    it('refuses an invalid definition with the rules it broke, and keeps the world readable', () => {
        const { world } = buildLiveWorld();
        const bad = world.registerEffectDefinition('halfWritten', {
            target: 'component',
            operations: [{ op: 'statSet', params: { trait: 'Movement' } }]
        });
        expect(bad.ok).toBe(false);
        expect(bad.code).toBe('EFFECT_DEFINITION_INVALID');
        expect(bad.errors.length).toBeGreaterThan(0);
        expect(world.getEffectDefinition('halfWritten')).toBeNull();
    });

    it('drops the runtime entry once a package defines the same id, instead of outliving it', () => {
        const { world } = buildLiveWorld();
        // The store handle the real composition root wired into the controllers.
        const store = world.registryStore;
        expect(store, 'the world must expose the live registry store').toBeTruthy();
        expect(world.effectsController?._registries, 'the effects controller reads that same store')
            .toBe(store);

        const registered = world.registerEffectDefinition('drip', {
            target: 'component',
            durationRounds: 1,
            operations: [{ op: 'grantFlag', params: { flag: 'wet' } }]
        });
        expect(registered.ok, JSON.stringify(registered.errors)).toBe(true);
        expect(world.getEffectDefinition('drip')).toBeTruthy();
        expect(world.effectsController.runtimeDefinitionIds()).toEqual(['drip']);

        // A mod swap that ships the same id as content: the packaged definition wins and
        // the session entry is dropped. The reverse is the bug this pins - an overlay
        // entry nobody maintains, shadowing content forever because its source version
        // never moves again.
        const effects = store.read(REGISTRY_KINDS.EFFECTS);
        // The swap is the mod-apply path (`RegistryStore.replace`), not a private poke.
        store.replace({ [REGISTRY_KINDS.EFFECTS]: { ...effects, drip: { target: 'component', durationRounds: 9, operations: [] } } });

        expect(world.effectsController.runtimeDefinitionIds()).toEqual([]);
        expect(world.getEffectDefinition('drip').durationRounds).toBe(9);
    });
});

describe('the effects registry kind itself', () => {
    it('is present in the live definition store the world was built from', () => {
        const { world } = buildLiveWorld();
        const registry = world.registryStore.read(REGISTRY_KINDS.EFFECTS);
        expect(Object.keys(registry)).toContain('burning');
        // The definitions the facade reports are the ones the live store holds - one
        // source, not a boot-time copy of it.
        expect(world.listEffectDefinitions().map((entry) => entry.id).sort())
            .toEqual(Object.keys(registry)
                .filter((key) => !key.startsWith('_') && key !== 'version').sort());
    });
});
