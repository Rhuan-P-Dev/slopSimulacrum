/**
 * UNIT TEST — the effect verbs on the live operator surface.
 *
 * `apply_effect`, `list_effects`, `remove_effect` and `register_effect`
 * (wiki/decisions/effects-system.md) are how a human or the System LLM puts an effect on
 * a body that is already walking around. What is pinned is the contract every other
 * operation on this service has and this one especially needs:
 *
 *   - a proposal is refused with a rule list BEFORE it reaches the world (`T-1`), so a
 *     typo'd effect id is named next to the ids that exist rather than silently doing
 *     nothing at execute;
 *   - execute re-runs the checks and throws, leaving the world untouched;
 *   - the operation goes through a facade public method, never into a sub-controller
 *     (`CR AP-5`);
 *   - `register_effect` is memory-only and says so, the way `create_room` does — writing
 *     durably is the separate explicit path.
 *
 * The world is a fake implementing exactly the facade reads these four use (`TST-3`).
 *
 * @module test/unit/WorldOperatorEffects
 */

import { describe, it, expect } from 'vitest';
import WorldOperatorService from '../../src/services/WorldOperatorService.js';

/**
 * A live world with one entity, one component, one effect definition and recorded calls.
 * @param {Object} [overrides]
 * @returns {Object} the fake facade
 */
function makeWorld(overrides = {}) {
    /** @type {Array<[string, ...Array<unknown>]>} the facade calls the service made */
    const calls = [];
    return {
        calls,
        getEntity: (id) => (id === 'ent-droid'
            // A component list, because `_requireComponent` reads the containment off the
            // entity itself — a fake without one would refuse a well-formed component
            // target for the wrong reason.
            ? { id: 'ent-droid', components: [{ id: 'comp-torso' }, { id: 'comp-arm' }] }
            : null),
        getEffectDefinition: (id) => (id === 'burning' ? { id: 'burning', target: 'component' } : null),
        listEffectDefinitions: () => [{ id: 'burning' }, { id: 'corroding' }],
        listActiveEffects: (id) => {
            calls.push(['listActiveEffects', id]);
            return [{ instanceId: 'eff-1', effectId: 'burning', remainingRounds: 2 }];
        },
        applyEffect: (effectId, target, options) => {
            calls.push(['applyEffect', effectId, target, options]);
            return overrides.applyResult ?? { ok: true, instanceIds: ['eff-1'] };
        },
        removeEffects: (selector, options) => {
            calls.push(['removeEffects', selector, options]);
            return 1;
        },
        registerEffectDefinition: (id, definition) => {
            calls.push(['registerEffectDefinition', id, definition]);
            return overrides.registerResult ?? { ok: true, appliesVia: 'POST /mods/apply (after authoring an "effects" package)' };
        }
    };
}

const service = (world = makeWorld()) => new WorldOperatorService({ worldStateController: world, registryStore: { has: () => false, read: () => ({}) } });

describe('apply_effect', () => {
    it('is offered, and a well-formed one reaches the facade with the target kind resolved', () => {
        const world = makeWorld();
        const svc = service(world);
        const result = svc.validateAction('apply_effect', { effectId: 'burning', entityId: 'ent-droid', rounds: 3 });
        expect(result.ok).toBe(true);
        expect(result.intent.summary).toContain('burning');

        svc.executeActions([result.intent]);
        const applied = world.calls.find(([name]) => name === 'applyEffect');
        expect(applied).toBeDefined();
        expect(applied[1]).toBe('burning');
        expect(applied[2]).toEqual({ kind: 'entity', id: 'ent-droid' });
        expect(applied[3].rounds).toBe(3);
    });

    it('resolves a componentId to a component target, so the effect lands on one part', () => {
        const world = makeWorld();
        const svc = service(world);
        const intent = svc.validateAction('apply_effect', {
            effectId: 'burning', entityId: 'ent-droid', componentId: 'comp-arm', rounds: 1
        });
        expect(intent.ok).toBe(true);
        svc.executeActions([intent.intent]);
        const applied = world.calls.find(([name]) => name === 'applyEffect');
        expect(applied[2]).toEqual({ kind: 'component', id: 'comp-arm' });
    });

    it('refuses an unknown effect id by name, next to the ids that exist, before it lands', () => {
        const world = makeWorld();
        const svc = service(world);
        const result = svc.validateAction('apply_effect', { effectId: 'cryo-burn', entityId: 'ent-droid' });
        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('cryo-burn');
        expect(result.errors.join(' ')).toContain('corroding');
        expect(world.calls.filter(([name]) => name === 'applyEffect')).toHaveLength(0);
    });

    it('refuses a negative or fractional round override', () => {
        const svc = service();
        for (const rounds of [-1, 1.5, Number.NaN]) {
            const result = svc.validateAction('apply_effect', { effectId: 'burning', entityId: 'ent-droid', rounds });
            expect(result.ok, `rounds=${rounds}`).toBe(false);
        }
    });

    it('reports a refused application as a failed action, not as a silent success', () => {
        const world = makeWorld({ applyResult: { ok: false, code: 'NO_TARGET_CARRIER', error: 'nothing here carries [heat, wetness]' } });
        const svc = service(world);
        const intent = svc.validateAction('apply_effect', { effectId: 'burning', entityId: 'ent-droid' });
        expect(intent.ok).toBe(true);
        const [applied] = svc.executeActions([intent.intent]).results;
        expect(applied.status).toBe('error');
        expect(applied.error).toContain('NO_TARGET_CARRIER');
    });
});

describe('list_effects and remove_effect', () => {
    it('lists what is running on an entity through the facade', () => {
        const world = makeWorld();
        const svc = service(world);
        const intent = svc.validateAction('list_effects', { entityId: 'ent-droid' });
        expect(intent.ok).toBe(true);
        const [listed] = svc.executeActions([intent.intent]).results;
        expect(listed.status).toBe('ok');
        expect(listed.result).toEqual([{ instanceId: 'eff-1', effectId: 'burning', remainingRounds: 2 }]);
    });

    it('refuses an empty remove selector, because it would strip every live effect in the world', () => {
        const world = makeWorld();
        const svc = service(world);
        const result = svc.validateAction('remove_effect', {});
        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('every live effect');
        expect(world.calls.filter(([name]) => name === 'removeEffects')).toHaveLength(0);
    });

    it('removes by instance id through the facade', () => {
        const world = makeWorld();
        const svc = service(world);
        const intent = svc.validateAction('remove_effect', { instanceId: 'eff-1' });
        expect(intent.ok).toBe(true);
        svc.executeActions([intent.intent]);
        const removed = world.calls.find(([name]) => name === 'removeEffects');
        expect(removed[1]).toEqual({ instanceId: 'eff-1' });
    });
});

describe('register_effect', () => {
    it('is memory only and says so in the summary, naming the durable path', () => {
        const svc = service();
        const intent = svc.validateAction('register_effect', {
            effectId: 'sapped',
            definition: { target: 'entity', durationRounds: 10, operations: [{ opId: 'attr', kind: 'attribute', traitId: 'Volatile', statName: 'luck', op: 'mul', value: 0.5 }] }
        });
        expect(intent.ok).toBe(true);
        expect(intent.intent.summary).toContain('memory only');
        expect(intent.intent.summary).toContain('effects');
    });

    it('refuses to shadow a definition that already exists', () => {
        const world = makeWorld();
        const svc = service(world);
        const result = svc.validateAction('register_effect', { effectId: 'burning', definition: { target: 'entity' } });
        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('already defined');
        expect(world.calls.filter(([name]) => name === 'registerEffectDefinition')).toHaveLength(0);
    });

    it('surfaces the validation rules the definition broke instead of half-storing it', () => {
        const world = makeWorld({ registerResult: { ok: false, code: 'EFFECT_DEFINITION_INVALID', errors: ['operations[0]: unknown operation kind "wild"'], appliesVia: 'POST /mods/apply' } });
        const svc = service(world);
        const intent = svc.validateAction('register_effect', { effectId: 'sapped', definition: { target: 'entity', operations: [{ kind: 'wild' }] } });
        const [written] = svc.executeActions([intent.intent]).results;
        expect(written.status).toBe('error');
        expect(written.error).toContain('unknown operation kind');
    });
});
