/**
 * EffectsController — unit test: the definition validator.
 *
 * The controller is a pure data owner over the registry kind `effects`, so every
 * case is exercised by handing it a registry (or a fake store), never a world.
 * What is pinned here is the LAYER CONTRACT, not the shape of a JSON file:
 *
 *   - never throws, for any defect, at any level (the world-rules degradation
 *     contract, copied deliberately);
 *   - one bad entry never takes the others with it;
 *   - an unknown operation id is a DATA fault: the entry is disabled and the
 *     warning names the id (a code fault - an op that passed validation and has
 *     no adapter - is pinned in the engine's suite, where it throws);
 *   - a definition is narrowed ONCE: defaults are filled, so nothing downstream
 *     re-checks `target` or `stacking`;
 *   - definitions are frozen, so no caller can edit the live world definition;
 *   - the validated set follows the store version, so a mod apply at the round
 *     boundary re-validates without a restart.
 *
 * @module test/unit/EffectsController
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import Logger from '../../src/utils/Logger.js';
import EffectsController from '../../src/controllers/effects/EffectsController.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';
import {
    MAX_EFFECT_DEFINITIONS,
    MAX_EFFECT_DURATION_ROUNDS,
    MAX_EFFECT_STACKS,
} from '../../src/utils/Constants.js';

/**
 * A minimal stand-in for RegistryStore: exactly the two methods the controller is
 * allowed to call (`read`, `version`). `bump()` moves the version the way a mod
 * swap does, which is what the re-validation test needs.
 */
class FakeStore {
    constructor(registries) {
        this._registries = registries;
        this._version = 1;
    }
    read(kind) { return this._registries[kind]; }
    version() { return this._version; }
    set(registries) { this._registries = registries; this._version += 1; }
}

/** One well-formed entry every negative case starts from and mutates. */
const baseEffect = () => ({
    name: 'Test Effect',
    target: 'entity',
    durationRounds: 2,
    stacking: 'refresh',
    revert: 'auto',
    operations: [{ op: 'addCondition', params: { condition: 'burning' } }],
    perRound: [{ op: 'damageComponent', params: { channel: 'heat', value: 4 } }]
});

/** Build a controller over one raw registry object (data-seam mode). */
function controllerOver(registries) {
    return new EffectsController({ registries: registries === undefined ? null : new FakeStore(registries) });
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('EffectsController — reading the shipped definition set', () => {
    it('reads the shipped core-effects package through the data seam', () => {
        const controller = controllerOver(undefined);
        expect(controller.has('burning')).toBe(true);
        expect(controller.has('corroding')).toBe(true);
        expect(controller.has('dazed')).toBe(true);
    });

    it('disables nothing in the shipped file (every entry validates)', () => {
        const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        const controller = controllerOver(undefined);
        const warnings = warn.mock.calls.map((call) => String(call[0]));
        expect(warnings.filter((line) => line.includes('is disabled'))).toEqual([]);
        // The count agrees with the ids, and every shipped id survived validation.
        expect(controller.count()).toBe(3);
        for (const id of controller.definitionIds()) {
            expect(controller.getDefinition(id), id).not.toBe(null);
        }
    });

    it('fills the declared defaults so no reader re-checks them (T-2)', () => {
        const controller = controllerOver({
            [REGISTRY_KINDS.EFFECTS]: { bare: { operations: [{ op: 'grantFlag', params: { flag: 'flammable' } }] } }
        });
        const definition = controller.getDefinition('bare');
        expect(definition.target).toBe('entity');
        expect(definition.stacking).toBe('refresh');
        expect(definition.revert).toBe('auto');
        expect(definition.durationRounds).toBe(0);
        expect(definition.maxStacks).toBe(null);
        expect(definition.name).toBe('bare');
    });

    it('freezes the definition, so a caller cannot edit the live world definition', () => {
        const controller = controllerOver({ [REGISTRY_KINDS.EFFECTS]: { e: baseEffect() } });
        const definition = controller.getDefinition('e');
        expect(Object.isFrozen(definition)).toBe(true);
        expect(Object.isFrozen(definition.operations)).toBe(true);
        expect(Object.isFrozen(definition.operations[0].params)).toBe(true);
    });

    it('lists summaries for exactly the live effects', () => {
        const controller = controllerOver({
            [REGISTRY_KINDS.EFFECTS]: { good: baseEffect(), broken: { target: 'nowhere' } }
        });
        expect(controller.definitionIds()).toEqual(['good']);
        expect(controller.definitionSummaries()).toEqual([
            { id: 'good', name: 'Test Effect', phrase: null, durationRounds: 2, target: 'entity' }
        ]);
    });
});

describe('EffectsController — degradation: never throws, never all-or-nothing', () => {
    it('defines nothing for an absent registry, without throwing', () => {
        expect(() => controllerOver({ [REGISTRY_KINDS.EFFECTS]: null })).not.toThrow();
        expect(controllerOver({ [REGISTRY_KINDS.EFFECTS]: null }).count()).toBe(0);
    });

    it('defines nothing for a registry of the wrong type, without throwing', () => {
        expect(controllerOver({ [REGISTRY_KINDS.EFFECTS]: ['not', 'an', 'object'] }).count()).toBe(0);
    });

    it('does not treat metadata keys as definitions', () => {
        const controller = controllerOver({
            [REGISTRY_KINDS.EFFECTS]: { _comment: 'docs', version: 1, real: baseEffect() }
        });
        expect(controller.definitionIds()).toEqual(['real']);
    });

    it('disables one malformed entry and keeps the rest live', () => {
        const registry = { [REGISTRY_KINDS.EFFECTS]: { good: baseEffect(), broken: 'a string' } };
        const controller = controllerOver(registry);
        expect(controller.definitionIds()).toEqual(['good']);
        expect(controller.getDefinition('broken')).toBe(null);
    });

    it('disables an entry naming an unknown operation, and the warning names the id', () => {
        const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        const entry = baseEffect();
        entry.operations = [{ op: 'teleportToBed', params: {} }];
        const controller = controllerOver({ [REGISTRY_KINDS.EFFECTS]: { broken: entry } });
        expect(controller.count()).toBe(0);
        const warning = warn.mock.calls.map((call) => String(call[0])).join('\n');
        expect(warning).toContain('teleportToBed');
    });

    it('disables an entry missing a required param', () => {
        const entry = baseEffect();
        entry.operations = [{ op: 'statDelta', params: { trait: 'Physical' } }];
        expect(controllerOver({ [REGISTRY_KINDS.EFFECTS]: { e: entry } }).count()).toBe(0);
    });

    it('disables an entry carrying a param the operation does not have (a typo must not load)', () => {
        const entry = baseEffect();
        entry.operations = [{ op: 'statDelta', params: { traid: 'Physical', stat: 'strength', value: 1 } }];
        expect(controllerOver({ [REGISTRY_KINDS.EFFECTS]: { e: entry } }).count()).toBe(0);
    });

    it('disables an entry whose param is not a finite number', () => {
        const entry = baseEffect();
        entry.perRound = [{ op: 'damageComponent', params: { channel: 'heat', value: ':Physical.strength' } }];
        expect(controllerOver({ [REGISTRY_KINDS.EFFECTS]: { e: entry } }).count()).toBe(0);
    });

    it('rejects a placeholder-shaped duration the same way it rejects an operation param', () => {
        const entry = baseEffect();
        entry.durationRounds = '3';
        expect(controllerOver({ [REGISTRY_KINDS.EFFECTS]: { e: entry } }).count()).toBe(0);
    });
});

describe('EffectsController — the stated caps', () => {
    it('accepts a duration at the cap and refuses one over it', () => {
        const atCap = baseEffect();
        atCap.durationRounds = MAX_EFFECT_DURATION_ROUNDS;
        expect(controllerOver({ [REGISTRY_KINDS.EFFECTS]: { e: atCap } }).count()).toBe(1);

        const overCap = baseEffect();
        overCap.durationRounds = MAX_EFFECT_DURATION_ROUNDS + 1;
        expect(controllerOver({ [REGISTRY_KINDS.EFFECTS]: { e: overCap } }).count()).toBe(0);
    });

    it('refuses a negative duration (never means anything) and accepts zero (means "until removed")', () => {
        const negative = baseEffect();
        negative.durationRounds = -1;
        expect(controllerOver({ [REGISTRY_KINDS.EFFECTS]: { e: negative } }).count()).toBe(0);

        const zero = baseEffect();
        zero.durationRounds = 0;
        expect(controllerOver({ [REGISTRY_KINDS.EFFECTS]: { e: zero } }).count()).toBe(1);
    });

    it('requires maxStacks when stacking is capped, and bounds it', () => {
        const withoutMax = baseEffect();
        withoutMax.stacking = 'capped';
        expect(controllerOver({ [REGISTRY_KINDS.EFFECTS]: { e: withoutMax } }).count()).toBe(0);

        const withMax = baseEffect();
        withMax.stacking = 'capped';
        withMax.maxStacks = 3;
        expect(controllerOver({ [REGISTRY_KINDS.EFFECTS]: { e: withMax } }).getDefinition('e').maxStacks).toBe(3);

        const overMax = baseEffect();
        overMax.stacking = 'capped';
        overMax.maxStacks = MAX_EFFECT_STACKS + 1;
        expect(controllerOver({ [REGISTRY_KINDS.EFFECTS]: { e: overMax } }).count()).toBe(0);
    });

    it('refuses maxStacks when stacking is not capped (it would silently mean nothing)', () => {
        const entry = baseEffect();
        entry.maxStacks = 4;
        expect(controllerOver({ [REGISTRY_KINDS.EFFECTS]: { e: entry } }).count()).toBe(0);
    });

    it('reads at most MAX_EFFECT_DEFINITIONS entries', () => {
        const effects = {};
        for (let i = 0; i <= MAX_EFFECT_DEFINITIONS; i++) effects[`e${i}`] = baseEffect();
        const controller = controllerOver({ [REGISTRY_KINDS.EFFECTS]: effects });
        expect(controller.count()).toBe(MAX_EFFECT_DEFINITIONS);
    });
});

describe('EffectsController — the definition set follows the live store', () => {
    it('sees an effect added by a mod swap without a restart', () => {
        const store = new FakeStore({ [REGISTRY_KINDS.EFFECTS]: { first: baseEffect() } });
        const controller = new EffectsController({ registries: store });
        expect(controller.definitionIds()).toEqual(['first']);

        store.set({ [REGISTRY_KINDS.EFFECTS]: { first: baseEffect(), second: baseEffect() } });
        expect(controller.definitionIds()).toEqual(['first', 'second']);
    });

    it('drops an effect a mod swap removed, so an effect cannot outlive its definition', () => {
        const store = new FakeStore({ [REGISTRY_KINDS.EFFECTS]: { removable: baseEffect() } });
        const controller = new EffectsController({ registries: store });
        expect(controller.has('removable')).toBe(true);

        store.set({ [REGISTRY_KINDS.EFFECTS]: {} });
        expect(controller.has('removable')).toBe(false);
        expect(controller.getDefinition('removable')).toBe(null);
    });

    it('re-validates on a swap, so an entry broken by the new package is disabled then', () => {
        const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        const store = new FakeStore({ [REGISTRY_KINDS.EFFECTS]: { good: baseEffect() } });
        const controller = new EffectsController({ registries: store });
        store.set({ [REGISTRY_KINDS.EFFECTS]: { good: baseEffect(), broken: { operations: [{ op: 'noSuchOp' }] } } });
        expect(controller.definitionIds()).toEqual(['good']);
        expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain('noSuchOp');
    });
});
