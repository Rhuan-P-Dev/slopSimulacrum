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
import { WorldOperatorService } from '../../src/services/WorldOperatorService.js';
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

    // The verb carries the effect instead of naming one. The claim worth a contract test
    // is the one a unit suite over a hand-built facade cannot make: the definition is
    // applied by the REAL engine, ages and reverts like a registered effect, and leaves
    // the `effects` registry exactly as it found it - a verb hitting something is not a
    // mod author writing a global type.
    it('carries an effect authored for the verb, and writes no registry row to do it', () => {
        const { world, entityId } = buildLiveWorld();
        const componentId = moveBearingComponent(world, entityId);
        const before = world.getComponentStats(componentId).Movement.move;
        const shippedCount = world.listEffectDefinitions().length;

        world.effectEngine.setCurrentRound(1);
        const result = handlersFor(world).dispatch('applyEffect', componentId, {
            effect: {
                name: 'Frostbite',
                target: 'component',
                durationRounds: 2,
                operations: [{ op: 'statDelta',
                    params: { trait: 'Movement', stat: 'move', value: -3 } }],
            },
        }, { actorId: entityId, actionName: 'frost bolt' });

        expect(result.success, result.message).toBe(true);
        expect(world.getComponentStats(componentId).Movement.move).toBe(before - 3);
        // A synthetic id naming the verb, because there is no registry key to name it by.
        expect(world.listActiveEffects(componentId)[0].effectId).toBe('inline:frost bolt');
        // And nothing was registered: the session's definitions are still the shipped set.
        expect(world.listEffectDefinitions()).toHaveLength(shippedCount);
        expect(world.getEffectDefinition('inline:frost bolt')).toBeNull();

        // It ages like any other instance: expiry writes back its own contribution.
        world.effectEngine.setCurrentRound(3);
        world.effectEngine.expireEffects();
        expect(world.getComponentStats(componentId).Movement.move).toBe(before);
    });

    it('refuses to carry an effect and name one in the same consequence', () => {
        const { world, entityId } = buildLiveWorld();
        const result = handlersFor(world).dispatch('applyEffect', entityId, {
            effectId: 'burning',
            effect: { name: 'Frostbite', operations: [{ op: 'grantFlag', params: { flag: 'wet' } }] },
        }, { actorId: entityId, actionName: 'slash' });
        expect(result.success).toBe(false);
        expect(result.message).toContain('burning');
        expect(world.effectEngine.getActiveEffects()).toEqual({});
    });

    it('refuses a carried effect that breaks the registry law, naming the rule', () => {
        const { world, entityId } = buildLiveWorld();
        const result = handlersFor(world).dispatch('applyEffect', entityId, {
            effect: { name: 'Halfwritten', operations: [{ op: 'meltMatter' }] },
        }, { actorId: entityId, actionName: 'slash' });
        expect(result.success).toBe(false);
        expect(result.message).toContain('meltMatter');
        expect(world.effectEngine.getActiveEffects()).toEqual({});
    });

    it('refuses a carried effect whose parameter is still a placeholder', () => {
        const { world, entityId } = buildLiveWorld();
        const result = handlersFor(world).dispatch('applyEffect', entityId, {
            effect: { name: 'Misnamed', target: 'component',
                operations: [{ op: 'addCondition', params: { condition: ':Physical.strength' } }] },
        }, { actorId: entityId, actionName: 'slash' });
        expect(result.success).toBe(false);
        expect(result.message).toContain(':Physical.strength');
        // The garbage name never reaches the body: a condition is a name, not a template.
        const entity = world.stateEntityController.getEntity(entityId);
        for (const component of entity.components) {
            expect(world.getComponentConditions(component.id)).not.toContain(':Physical.strength');
        }
    });

    it('refuses a parameter still wearing any shape the grammar knows', () => {
        // The guard is BUILT from the resolver's own fragments (`PLACEHOLDER_TOKEN`,
        // `PLACEHOLDER_ARITHMETIC`), so it cannot lag the language. A hand-copied version of
        // it did: it knew `*N` but not `/N` nor decimals, so an unresolved `:NoSuch.stat/2`
        // walked past the guard into an operation, where a string is a NAME - the effect
        // applied cleanly and did nothing. A stat name is the parameter with no whitelist
        // behind it, so only the guard can refuse these.
        const shapes = [
            ':Physical.strength',
            ':NoSuch.stat/2',
            ':Physical.strength/0',
            ':Physical.strength*0.5',
            ':fuel'
        ];
        for (const shape of shapes) {
            const { world, entityId } = buildLiveWorld();
            const result = handlersFor(world).dispatch('applyEffect', entityId, {
                effect: { name: 'Misnamed', target: 'component',
                    operations: [{ op: 'statDelta', params: { trait: 'Physical', stat: shape, value: -1 } }] },
            }, { actorId: entityId, actionName: 'slash' });
            expect(result.success, `${shape} must not reach an operation as a name`).toBe(false);
            expect(result.message, `${shape} must be named in the refusal`).toContain(shape);
            expect(world.effectEngine.getActiveEffects(), `${shape} must not land`).toEqual({});
        }
    });

    it('refuses a rounds override the engine cannot honour', () => {
        // Absent rounds means the effect's own declared duration. Present-but-unusable is a
        // typo in the action, and the engine's rule for a number it cannot use is "no
        // override" - so an unchecked 1e9 is an instance that outlives its world and an
        // unresolved "50/2" is a silent fallback. Refused by value, and nothing lands.
        for (const rounds of ['3', '50/2', 2.5, -1, 1e9, Number.NaN]) {
            const { world, entityId } = buildLiveWorld();
            const result = handlersFor(world).dispatch('applyEffect', entityId, {
                effect: { name: 'Cold', target: 'component', durationRounds: 2,
                    operations: [{ op: 'addCondition', params: { condition: 'chilled' } }] },
                rounds,
            }, { actorId: entityId, actionName: 'slash' });
            expect(result.success, `${rounds} must not silently change the duration`).toBe(false);
            expect(result.message).toContain('rounds');
            expect(world.effectEngine.getActiveEffects(), `${rounds} must not land an instance`).toEqual({});
        }

        // Positive control, so the loop above cannot pass by refusing everything: a usable
        // override still means what it says.
        const { world, entityId } = buildLiveWorld();
        const ok = handlersFor(world).dispatch('applyEffect', entityId, {
            effect: { name: 'Cold', target: 'component', durationRounds: 9,
                operations: [{ op: 'addCondition', params: { condition: 'chilled' } }] },
            rounds: 2,
        }, { actorId: entityId, actionName: 'slash' });
        expect(ok.success, JSON.stringify(ok)).toBe(true);
    });

    it('runs a carried effect through the whole verb path, from executeAction to the engine', () => {
        // The claim only the composed world can make: the same consequence written in an
        // actions.json is read by the REAL dispatcher - target resolution, and the
        // placeholder pass that walks straight through the nested `effect` object - and
        // lands in the REAL engine, without a row of the `effects` registry being touched.
        const { world, entityId } = buildLiveWorld();
        const componentId = moveBearingComponent(world, entityId);
        const before = world.getComponentStats(componentId).Movement.move;
        const shippedIds = world.listEffectDefinitions().map((entry) => entry.id);
        // A verb written by the test rather than shipped: this is the shape a mod authors,
        // and shipping one would change the balance of the world for no reason.
        world.actionController.actionRegistry.testChill = {
            description: 'Exhale cold air on a part: it works worse for two rounds.',
            targetingType: 'component',
            range: 50,
            requirements: [],
            consequences: [{
                type: 'applyEffect',
                target: 'target',
                params: {
                    effect: {
                        name: 'Frostbite',
                        target: 'component',
                        durationRounds: 2,
                        operations: [{ op: 'addCondition', params: { condition: 'frostbitten' } }],
                        perRound: [{ op: 'statDelta',
                            params: { trait: 'Movement', stat: 'move', value: -1 } }],
                    },
                },
            }],
        };
        try {
            world.effectEngine.setCurrentRound(1);
            const result = world.executeAction('testChill', entityId, { targetComponentId: componentId });
            expect(result.success, JSON.stringify(result)).toBe(true);

            expect(world.getComponentConditions(componentId)).toContain('frostbitten');
            const [instance] = world.listActiveEffects(componentId);
            expect(instance.effectId).toBe('inline:testChill');
            expect(instance.expiresRound).toBe(3);
            // A verb hitting something never authors a global type on the way past.
            expect(world.listEffectDefinitions().map((entry) => entry.id)).toEqual(shippedIds);

            // The stream ticks from the definition the action carried, and expiry takes the
            // mark back - the same lifecycle a registry effect has.
            world.effectEngine.setCurrentRound(2);
            world.effectEngine.onRoundStart(2);
            expect(world.getComponentStats(componentId).Movement.move).toBe(before - 1);
            world.effectEngine.setCurrentRound(3);
            world.effectEngine.expireEffects();
            expect(world.getComponentConditions(componentId)).not.toContain('frostbitten');
        } finally {
            delete world.actionController.actionRegistry.testChill;
        }
    });

    it('refuses a carried effect claiming a body it cannot be born on', () => {
        const { world, entityId } = buildLiveWorld();
        const result = handlersFor(world).dispatch('applyEffect', entityId, {
            effect: { name: 'InbornWannabe', appliesTo: 'smallBallDroid',
                operations: [{ op: 'grantFlag', params: { flag: 'wet' } }] },
        }, { actorId: entityId, actionName: 'slash' });
        expect(result.success).toBe(false);
        expect(result.message).toContain('appliesTo');
        expect(world.effectEngine.getActiveEffects()).toEqual({});
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

describe('define the type in the world, then apply it to an entity', () => {
    /** The operator surface over the real world and the real definition owner. */
    const operatorFor = (world) => new WorldOperatorService({
        worldStateController: world,
        registryStore: world.registryStore,
    });

    it('applies a type the world did not have until step 1 defined it and was executed', () => {
        // The sequence the System prompt now spells out, pinned as behaviour: the definition
        // step runs, and only then can the application be proposed and run. A prompt that
        // promised an order the tools refuse is worse than no prompt at all.
        const { world, entityId } = buildLiveWorld();
        const service = operatorFor(world);

        const defined = service.validateAction('register_effect', {
            effectId: 'heavyLead',
            definition: { target: 'component', durationRounds: 0, operations: [{ op: 'statDelta', params: { trait: 'Movement', stat: 'move', value: -5 } }] },
        });
        expect(defined.ok, JSON.stringify(defined.errors)).toBe(true);
        expect(service.executeActions([defined.intent]).results[0].status).toBe('ok');
        expect(world.getEffectDefinition('heavyLead')).toBeTruthy();

        const applied = service.validateAction('apply_effect', { effectId: 'heavyLead', entityId });
        expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
        expect(service.executeActions([applied.intent]).results[0].status).toBe('ok');

        // The type exists, and something of this body is now carrying it.
        const running = world.effectEngine.getActiveEffects();
        expect(Object.keys(running).some((id) => running[id].effectId === 'heavyLead')).toBe(true);
    });

    it('refuses to apply a type the world has never defined, by name, listing what does', () => {
        const { world, entityId } = buildLiveWorld();
        const service = operatorFor(world);
        const result = service.validateAction('apply_effect', { effectId: 'inventedHere', entityId });
        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('inventedHere');
        // The ids that DO exist are in the same answer, so the next call is a fix and not a guess.
        expect(result.errors.join(' ')).toContain('burning');
    });
});

describe('the operator reads a part back through the body it hangs on', () => {
    it('lists and removes a component-targeted application by the entity, through the real facade', () => {
        // `apply_effect { componentId }` lands an instance whose target is the PART.
        // The read-back and the removal name the ENTITY - through the composed facade
        // and the real engine, this is the seam where "nothing is running" used to be
        // the honest answer about an effect the same console had just applied.
        const { world, entityId } = buildLiveWorld();
        const service = new WorldOperatorService({
            worldStateController: world,
            registryStore: world.registryStore,
        });
        const defined = service.validateAction('register_effect', {
            effectId: 'heavyLead',
            definition: { target: 'component', durationRounds: 0, operations: [{ op: 'statDelta', params: { trait: 'Movement', stat: 'move', value: -5 } }] },
        });
        expect(defined.ok, JSON.stringify(defined.errors)).toBe(true);
        expect(service.executeActions([defined.intent]).results[0].status).toBe('ok');

        const componentId = moveBearingComponent(world, entityId);
        const before = world.getComponentStats(componentId).Movement.move;
        const applied = service.validateAction('apply_effect', { effectId: 'heavyLead', entityId, componentId });
        expect(applied.ok, JSON.stringify(applied.errors)).toBe(true);
        expect(service.executeActions([applied.intent]).results[0].status).toBe('ok');
        expect(world.getComponentStats(componentId).Movement.move).toBe(before - 5);

        const listed = service.executeActions([service.validateAction('list_effects', { entityId }).intent]).results[0];
        expect(listed.status).toBe('ok');
        const onThePart = listed.result.filter((instance) => instance.targetId === componentId);
        expect(onThePart.map((instance) => instance.effectId)).toEqual(['heavyLead']);

        const removed = service.executeActions([service.validateAction('remove_effect', { entityId }).intent]).results[0];
        expect(removed.status).toBe('ok');
        expect(removed.result).toBe(1);
        expect(world.getComponentStats(componentId).Movement.move).toBe(before);
        // The body is clean by the same verb: entity scope is the entity's whole body.
        expect(world.listActiveEffects(entityId, { includeComponentInstances: true })).toEqual([]);
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
