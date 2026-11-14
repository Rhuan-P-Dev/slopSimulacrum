/**
 * EffectEngine — unit test: the lifecycle of a live effect.
 *
 * The engine is exercised through its public surface over a hand-built facade, so
 * nothing here depends on the turn machine, the socket layer or a provider
 * (`CR TST-2`). What is pinned is the behaviour the layer promises, not its
 * internals:
 *
 *   - a revert undoes the effect's OWN contribution, so two live effects on one stat
 *     commute (the law durableEffects.contract.test.js pins end-to-end);
 *   - `perRound` runs in the round AFTER the one that applied it, exactly once per
 *     round, and is NEVER reverted (a sequence of events is not rewound);
 *   - each stacking mode does what its name says (and only modes a caller can
 *     actually reach are implemented - see the note on EFFECT_STACKING);
 *   - a condition or flag the target already had survives the effect that merely
 *     matched its name;
 *   - the caps refuse with a code, they never drop an effect quietly (`CR A-7`);
 *   - a target that left the world loses its records and is not written to.
 *
 * @module test/unit/EffectEngine
 */

import { describe, it, expect } from 'vitest';
import EffectEngine from '../../src/controllers/effects/EffectEngine.js';
import EffectsController from '../../src/controllers/effects/EffectsController.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';
import { MAX_ACTIVE_EFFECTS_PER_TARGET } from '../../src/utils/Constants.js';

/**
 * A hand-built world: components with stats, conditions and granted flags, plus the
 * two entity lookups the engine uses. Every write is recorded so a test can assert
 * on what the engine actually did to the world.
 */
function buildWorld({ entities, stats }) {
    const componentStats = {};
    for (const [componentId, value] of Object.entries(stats)) {
        componentStats[componentId] = structuredClone(value);
    }
    const conditions = {};
    const flags = {};
    const writes = [];
    const entityOf = new Map();
    for (const [entityId, entity] of Object.entries(entities)) {
        // The world's real shape: components are records with an `id`, not bare ids.
        entity.components = entity.components.map((component) =>
            (typeof component === 'string' ? { id: component, type: `type-${component}` } : component));
        for (const component of entity.components) entityOf.set(component.id, entityId);
    }

    const componentController = {
        getComponentStats: (componentId) => componentStats[componentId],
        updateComponentStatDelta: (componentId, trait, stat, delta, skipDamageEvent = false) => {
            const slot = componentStats[componentId]?.[trait];
            if (!slot) return false;
            slot[stat] = slot[stat] + delta;
            writes.push({ kind: 'delta', componentId, trait, stat, delta, skipDamageEvent });
            return true;
        },
        updateComponentStat: (componentId, trait, stat, value, skipDamageEvent = false) => {
            const slot = componentStats[componentId]?.[trait];
            if (!slot) return false;
            slot[stat] = value;
            writes.push({ kind: 'set', componentId, trait, stat, value, skipDamageEvent });
            return true;
        },
        getComponentConditions: (componentId) => [...(conditions[componentId] ?? [])],
        addCondition: (componentId, condition) => {
            const current = conditions[componentId] ?? [];
            conditions[componentId] = current.includes(condition) ? current : [...current, condition];
            return true;
        },
        removeCondition: (componentId, condition) => {
            conditions[componentId] = (conditions[componentId] ?? []).filter((c) => c !== condition);
            return true;
        },
        getComponentFlags: (componentId) => [...(flags[componentId] ?? [])],
        addGrantedFlag: (componentId, flag) => {
            const current = flags[componentId] ?? [];
            flags[componentId] = current.includes(flag) ? current : [...current, flag];
            return true;
        },
        removeGrantedFlag: (componentId, flag) => {
            flags[componentId] = (flags[componentId] ?? []).filter((f) => f !== flag);
            return true;
        },
    };

    const stateEntityController = {
        getEntity: (entityId) => (entities[entityId] ? { id: entityId, ...entities[entityId] } : null),
        findEntityByComponent: (componentId) => {
            const entityId = entityOf.get(componentId);
            return entityId ? { id: entityId, ...entities[entityId] } : null;
        },
    };

    const facade = { componentController, stateEntityController, getComponent: null };
    return {
        facade,
        writes,
        valueOf: (componentId, trait, stat) => componentStats[componentId]?.[trait]?.[stat],
        conditionsOf: (componentId) => conditions[componentId] ?? [],
        flagsOf: (componentId) => flags[componentId] ?? [],
        despawn(entityId) { delete entities[entityId]; },
    };
}

/** An engine over the given effect definitions and world. */
function buildEngine(definitions, { entities = { e1: { components: ['c1', 'c2'] } }, stats = {}, maxPerTarget } = {}) {
    const world = buildWorld({ entities, stats });
    const store = { read: (kind) => (kind === REGISTRY_KINDS.EFFECTS ? definitions : {}), version: () => 1 };
    const engine = new EffectEngine({
        effectsController: new EffectsController({ registries: store }),
        maxPerTarget,
    });
    engine.setWorldStateController(world.facade);
    return { engine, world };
}

const statEffect = (extra = {}) => ({
    target: 'entity',
    durationRounds: 2,
    stacking: 'refresh',
    revert: 'auto',
    operations: [{ op: 'statDelta', params: { trait: 'Movement', stat: 'move', value: -5 } }],
    ...extra,
});

describe('EffectEngine — apply and revert', () => {
    it('applies a stat delta to every component of the entity carrying that stat', () => {
        const { engine, world } = buildEngine({ e: statEffect() }, {
            stats: { c1: { Movement: { move: 20 } }, c2: { Movement: { move: 30 } } }
        });
        engine.setCurrentRound(1);
        const result = engine.apply('e', { kind: 'entity', id: 'e1' });
        expect(result.ok).toBe(true);
        expect(world.valueOf('c1', 'Movement', 'move')).toBe(15);
        expect(world.valueOf('c2', 'Movement', 'move')).toBe(25);
    });

    it('skips a component that does not carry the named stat, and never invents one', () => {
        const { engine, world } = buildEngine({ e: statEffect() }, {
            stats: { c1: { Movement: { move: 20 } }, c2: { Physical: { mass: 5 } } }
        });
        engine.setCurrentRound(1);
        engine.apply('e', { kind: 'entity', id: 'e1' });
        expect(world.valueOf('c1', 'Movement', 'move')).toBe(15);
        expect(world.writes.filter((write) => write.componentId === 'c2')).toEqual([]);
    });

    it('sets expiresRound from the round of application, and reverts at that round', () => {
        const { engine, world } = buildEngine({ e: statEffect({ durationRounds: 3 }) }, {
            stats: { c1: { Movement: { move: 20 } }, c2: { Movement: { move: 20 } } }
        });
        engine.setCurrentRound(7);
        const [instanceId] = engine.apply('e', { kind: 'entity', id: 'e1' }).instanceIds;
        expect(engine.getActiveEffects()[instanceId].expiresRound).toBe(10);

        engine.setCurrentRound(10);
        engine.expireEffects();
        expect(world.valueOf('c1', 'Movement', 'move')).toBe(20);
        expect(engine.getActiveEffects()).toEqual({});
    });

    it('never routes a revert through the damage pipeline (undoing is not weakening)', () => {
        const { engine, world } = buildEngine({ e: statEffect() }, {
            stats: { c1: { Movement: { move: 20 } }, c2: { Movement: { move: 20 } } }
        });
        engine.setCurrentRound(1);
        engine.apply('e', { kind: 'entity', id: 'e1' });
        engine.setCurrentRound(3);
        engine.expireEffects();
        const restores = world.writes.filter((write) => write.kind === 'delta' && write.delta === 5);
        expect(restores.length).toBe(2);
        expect(restores.every((write) => write.skipDamageEvent === true)).toBe(true);
    });

    it('leaves the other live effect intact when one of two on the same stat expires', () => {
        const { engine, world } = buildEngine({
            short: statEffect({ durationRounds: 1 }),
            long: { ...statEffect(), operations: [{ op: 'statDelta', params: { trait: 'Movement', stat: 'move', value: -7 } }], durationRounds: 5 }
        }, { stats: { c1: { Movement: { move: 100 } }, c2: { Physical: { mass: 1 } } } });

        engine.setCurrentRound(1);
        engine.apply('short', { kind: 'entity', id: 'e1' });
        engine.apply('long', { kind: 'entity', id: 'e1' });
        expect(world.valueOf('c1', 'Movement', 'move')).toBe(88);

        engine.setCurrentRound(2);
        engine.expireEffects();
        // Only the -5 is undone. Restoring an absolute baseline would have written 95
        // back over the -7 that is still live.
        expect(world.valueOf('c1', 'Movement', 'move')).toBe(93);
    });

    it('treats an application with no round active as living until removed', () => {
        const { engine } = buildEngine({ e: statEffect() }, { stats: { c1: { Movement: { move: 20 } } } });
        const [instanceId] = engine.apply('e', { kind: 'entity', id: 'e1' }).instanceIds;
        expect(engine.getActiveEffects()[instanceId].expiresRound).toBe(null);
    });
});

describe('EffectEngine — the per-round stream', () => {
    const ticking = {
        tick: {
            target: 'entity',
            durationRounds: 2,
            operations: [{ op: 'grantFlag', params: { flag: 'flammable' } }],
            perRound: [{ op: 'statDelta', params: { trait: 'Physical', stat: 'strength', value: -1 } }]
        }
    };

    it('does not tick in the round that applied it', () => {
        const { engine, world } = buildEngine(ticking, {
            stats: { c1: { Physical: { strength: 10 } }, c2: { Physical: { strength: 10 } } }
        });
        engine.setCurrentRound(7);
        engine.apply('tick', { kind: 'entity', id: 'e1' });
        engine.onRoundStart(7);
        expect(world.valueOf('c1', 'Physical', 'strength')).toBe(10);
    });

    it('ticks once on each later round, and stops after the expiry round', () => {
        const { engine, world } = buildEngine(ticking, {
            stats: { c1: { Physical: { strength: 10 } }, c2: { Physical: { strength: 10 } } }
        });
        engine.setCurrentRound(7);
        engine.apply('tick', { kind: 'entity', id: 'e1' });
        engine.setCurrentRound(8);
        engine.onRoundStart(8);
        expect(world.valueOf('c1', 'Physical', 'strength')).toBe(9);
        engine.setCurrentRound(9);
        engine.onRoundStart(9);
        expect(world.valueOf('c1', 'Physical', 'strength')).toBe(8);
        engine.setCurrentRound(10);
        engine.expireEffects();
        engine.setCurrentRound(11);
        engine.onRoundStart(11);
        expect(world.valueOf('c1', 'Physical', 'strength')).toBe(8);
    });

    it('never rewinds a per-round stream when the effect expires', () => {
        const { engine, world } = buildEngine(ticking, {
            stats: { c1: { Physical: { strength: 10 } }, c2: { Physical: { strength: 10 } } }
        });
        engine.setCurrentRound(7);
        engine.apply('tick', { kind: 'entity', id: 'e1' });
        engine.setCurrentRound(8);
        engine.onRoundStart(8);
        engine.setCurrentRound(9);
        engine.expireEffects();
        // The grant is taken back; the two rounds of strength loss stay spent.
        expect(world.flagsOf('c1')).toEqual([]);
        expect(world.valueOf('c1', 'Physical', 'strength')).toBe(9);
    });
});

describe('EffectEngine — stacking', () => {
    it('refresh keeps the effect flat and pushes the expiry out', () => {
        const { engine, world } = buildEngine({ e: statEffect({ durationRounds: 2 }) }, {
            stats: { c1: { Movement: { move: 100 } } }
        });
        engine.setCurrentRound(1);
        engine.apply('e', { kind: 'entity', id: 'e1' });
        engine.apply('e', { kind: 'entity', id: 'e1' });
        expect(world.valueOf('c1', 'Movement', 'move')).toBe(95);
        expect(Object.keys(engine.getActiveEffects())).toHaveLength(1);
    });

    it('independent keeps both instances, and both contributions land', () => {
        const { engine, world } = buildEngine({ e: statEffect({ stacking: 'independent' }) }, {
            stats: { c1: { Movement: { move: 100 } } }
        });
        engine.setCurrentRound(1);
        engine.apply('e', { kind: 'entity', id: 'e1' });
        engine.apply('e', { kind: 'entity', id: 'e1' });
        expect(world.valueOf('c1', 'Movement', 'move')).toBe(90);
        expect(Object.keys(engine.getActiveEffects())).toHaveLength(2);
    });

    it('capped replaces the oldest once the declared cap is reached', () => {
        const { engine, world } = buildEngine({ e: statEffect({ stacking: 'capped', maxStacks: 2 }) }, {
            stats: { c1: { Movement: { move: 100 } } }
        });
        engine.setCurrentRound(1);
        engine.apply('e', { kind: 'entity', id: 'e1' });
        engine.setCurrentRound(2);
        engine.apply('e', { kind: 'entity', id: 'e1' });
        engine.setCurrentRound(3);
        engine.apply('e', { kind: 'entity', id: 'e1' });
        expect(Object.keys(engine.getActiveEffects())).toHaveLength(2);
        // Two live at -5 each; the first was reverted when the cap was hit.
        expect(world.valueOf('c1', 'Movement', 'move')).toBe(90);
    });

});

describe('EffectEngine — conditions, flags and what a revert may not take back', () => {
    const conditionEffect = {
        target: 'entity',
        durationRounds: 1,
        operations: [{ op: 'addCondition', params: { condition: 'burning' } }]
    };

    it('adds the condition to every component and takes it back at expiry', () => {
        const { engine, world } = buildEngine({ c: conditionEffect }, { stats: { c1: {}, c2: {} } });
        engine.setCurrentRound(1);
        engine.apply('c', { kind: 'entity', id: 'e1' });
        expect(world.conditionsOf('c1')).toEqual(['burning']);
        expect(world.conditionsOf('c2')).toEqual(['burning']);
        engine.setCurrentRound(2);
        engine.expireEffects();
        expect(world.conditionsOf('c1')).toEqual([]);
    });

    it('leaves a condition the component already had, when the matching effect expires', () => {
        const { engine, world } = buildEngine({ c: conditionEffect }, { stats: { c1: {}, c2: {} } });
        world.facade.componentController.addCondition('c1', 'burning');
        engine.setCurrentRound(1);
        engine.apply('c', { kind: 'entity', id: 'e1' });
        engine.setCurrentRound(2);
        engine.expireEffects();
        // The world put it there, not the effect: the effect may not revoke it.
        expect(world.conditionsOf('c1')).toEqual(['burning']);
        expect(world.conditionsOf('c2')).toEqual([]);
    });

    it('takes back a granted flag and only a granted one', () => {
        const { engine, world } = buildEngine({
            f: { target: 'entity', durationRounds: 1, operations: [{ op: 'grantFlag', params: { flag: 'flammable' } }] }
        }, { stats: { c1: {}, c2: {} } });
        world.facade.componentController.addGrantedFlag('c2', 'flammable');
        engine.setCurrentRound(1);
        engine.apply('f', { kind: 'entity', id: 'e1' });
        engine.setCurrentRound(2);
        engine.expireEffects();
        expect(world.flagsOf('c1')).toEqual([]);
        expect(world.flagsOf('c2')).toEqual(['flammable']);
    });
});

describe('EffectEngine — refusals are typed, never silent', () => {
    it('refuses an effect that is not defined, with a code', () => {
        const { engine } = buildEngine({ e: statEffect() }, { stats: { c1: { Movement: { move: 1 } } } });
        const result = engine.apply('nope', { kind: 'entity', id: 'e1' });
        expect(result).toMatchObject({ ok: false, code: 'EFFECT_UNKNOWN' });
    });

    it('refuses a target that is not in the world', () => {
        const { engine } = buildEngine({ e: statEffect() }, { stats: { c1: { Movement: { move: 1 } } } });
        const result = engine.apply('e', { kind: 'entity', id: 'ghost' });
        expect(result).toMatchObject({ ok: false, code: 'EFFECT_TARGET_MISSING' });
    });

    it('refuses when the per-target bound is reached, instead of dropping the effect', () => {
        const { engine } = buildEngine({ e: statEffect({ stacking: 'independent' }) }, {
            stats: { c1: { Movement: { move: 10 } } },
            maxPerTarget: MAX_ACTIVE_EFFECTS_PER_TARGET
        });
        engine.setCurrentRound(1);
        for (let i = 0; i < MAX_ACTIVE_EFFECTS_PER_TARGET; i++) {
            engine.apply('e', { kind: 'entity', id: 'e1' }, { rounds: 0, source: 'test' });
        }
        const result = engine.apply('e', { kind: 'entity', id: 'e1' }, { rounds: 0, source: 'test' });
        expect(result).toMatchObject({ ok: false, code: 'EFFECT_LIMIT_REACHED' });
    });

    it('says so when nothing about the target could be acted on', () => {
        const { engine } = buildEngine({ e: statEffect() }, { stats: { c1: { Physical: { mass: 1 } } } });
        engine.setCurrentRound(1);
        const result = engine.apply('e', { kind: 'entity', id: 'e1' });
        expect(result.ok).toBe(false);
    });
});

describe('EffectEngine — records never outlive the thing they describe', () => {
    it('drops the instances of a despawned target without writing to it', () => {
        const { engine, world } = buildEngine({ e: statEffect({ stacking: 'independent' }) }, {
            stats: { c1: { Movement: { move: 20 } } }
        });
        engine.setCurrentRound(1);
        engine.apply('e', { kind: 'entity', id: 'e1' });
        world.despawn('e1');
        world.writes.length = 0;

        engine.setCurrentRound(2);
        engine.forgetGoneTargets();
        expect(engine.getActiveEffects()).toEqual({});
        expect(world.writes).toEqual([]);
    });

    it('remove() reverts the instance it drops', () => {
        const { engine, world } = buildEngine({ e: statEffect() }, { stats: { c1: { Movement: { move: 20 } } } });
        engine.setCurrentRound(1);
        const [instanceId] = engine.apply('e', { kind: 'entity', id: 'e1' }).instanceIds;
        expect(world.valueOf('c1', 'Movement', 'move')).toBe(15);
        expect(engine.remove({ instanceId })).toBe(1);
        expect(world.valueOf('c1', 'Movement', 'move')).toBe(20);
    });

    it('lists the live instances of a target with their remaining rounds', () => {
        const { engine } = buildEngine({ e: statEffect({ durationRounds: 4 }) }, { stats: { c1: { Movement: { move: 20 } } } });
        engine.setCurrentRound(3);
        engine.apply('e', { kind: 'entity', id: 'e1' });
        expect(engine.listActive({ id: 'e1' })).toEqual([{
            instanceId: expect.any(String),
            effectId: 'e',
            targetId: 'e1',
            targetKind: 'entity',
            appliedRound: 3,
            expiresRound: 7,
            remainingRounds: 4,
        }]);
    });
});

describe('EffectEngine — the entity-scope view the operator verbs read', () => {
    // `apply_effect { componentId }` lands an instance on one PART, and its targetId is
    // the component. The operator's read-back and removal name the ENTITY - the body and
    // everything carried under it - so entity scope matches the instance's OWN record of
    // who wore the target, kept at apply time (`ownerEntityId`). The default stays exact:
    // the LLM context renders part instances under the part and body instances under the
    // body, each exactly once, and widening the default would print them twice.
    it('lists an entity-scope view that includes what runs on the entity\'s parts', () => {
        const { engine } = buildEngine({ e: statEffect() }, { stats: { c1: { Movement: { move: 20 } } } });
        engine.setCurrentRound(1);
        engine.apply('e', { kind: 'component', id: 'c1' });
        // Exact scope (the context's view): the part shows the instance, the body does not.
        expect(engine.listActive({ id: 'c1' }).map((i) => i.effectId)).toEqual(['e']);
        expect(engine.listActive({ id: 'e1' })).toEqual([]);
        // Entity scope (the operator's view): the body AND everything running on its parts.
        const wide = engine.listActive({ id: 'e1' }, { includeComponentInstances: true });
        expect(wide.map((i) => i.effectId)).toEqual(['e']);
        expect(wide.map((i) => i.targetId)).toEqual(['c1']);
    });

    it('removes and reverts, by entity scope, the instances running on the entity\'s parts', () => {
        const { engine, world } = buildEngine({ e: statEffect() }, { stats: { c1: { Movement: { move: 20 } } } });
        engine.setCurrentRound(1);
        engine.apply('e', { kind: 'component', id: 'c1' });
        expect(world.valueOf('c1', 'Movement', 'move')).toBe(15);
        // Exact removal names the body and touches no part - the old behavior, pinned.
        expect(engine.remove({ targetId: 'e1' })).toBe(0);
        expect(world.valueOf('c1', 'Movement', 'move')).toBe(15);
        // Entity scope takes the part's instance off the body, reverted like any other.
        expect(engine.remove({ targetId: 'e1' }, { includeComponentInstances: true })).toBe(1);
        expect(world.valueOf('c1', 'Movement', 'move')).toBe(20);
    });

    it('keeps an entity-scoped effectId selector narrow to that entity, not worldwide', () => {
        const { engine } = buildEngine({ e: statEffect() }, { entities: { e1: { components: ['c1'] }, e2: { components: ['c2'] } }, stats: { c1: { Movement: { move: 20 } }, c2: { Movement: { move: 20 } } } });
        engine.setCurrentRound(1);
        engine.apply('e', { kind: 'component', id: 'c1' });
        engine.apply('e', { kind: 'component', id: 'c2' });
        expect(engine.remove({ targetId: 'e1', effectId: 'e' }, { includeComponentInstances: true })).toBe(1);
        // The other body's part keeps its instance: entity scope is scoped to the entity.
        expect(engine.listActive({ id: 'c2' })).toHaveLength(1);
    });
});
