/**
 * A damage value that never became a number cannot wound anything — CONTRACT test.
 *
 * The reported symptom: a hand-authored fire-punch mod rendered one of the droid's body
 * parts as `null` in the panel. The mod's damage value was the
 * string `":Physical.strength/2"`. The placeholder grammar accepted only an INTEGER
 * multiplier (`*N`), and an expression it does not recognise does not fail — it falls
 * through to a template substitution, so the param resolved to the STRING `"1/2"`. The
 * damage handler multiplied that string by the material's damage-against and wrote `NaN`
 * into `Physical.existence`, and a NaN is permanent: `NaN + x` is NaN forever, the part
 * never satisfies `existence > 0` again (so it stays a valid target but is never
 * destroyable), and the damage listener never fires because `NaN < 0` is false — which is
 * why the part went `null` with no broken-part event anywhere in the record.
 *
 * Three things are pinned end to end, through the real composition pipeline and the real
 * dispatch (CR DATA-6), with a punch-shaped probe action aimed at another droid's head:
 *   1. an UNRESOLVED placeholder in a damage value is refused and moves nothing;
 *   2. so is a literal that is not an expression at all (`"50/2"`);
 *   3. and the expression the language now accepts — `:Trait.stat/2` — deals exactly
 *      half of what the bare stat deals. Division is sayable; a non-number is not.
 *
 * @module test/contract/damageValuePoison
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

/** The probe verbs: one action per damage-value shape under test. */
const PROBES = {
    poison_probe: ':Physical.armor',      // a stat no component has — resolves to nothing
    literal_probe: '50/2',                // text that only looks like an expression
    full_probe: ':Physical.strength',     // the whole stat (the shipped punch's value)
    half_probe: ':Physical.strength/2',   // the expression the grammar used to reject
};

/**
 * A world with the probe verbs injected into the action registry (the shape a mod
 * authors, written straight into actions.json, but not shipped: a new verb in the
 * official world would change its balance for no reason).
 * @returns {{ world: object, attackerId: string, victimId: string, handId: string, headId: string }}
 */
function bootWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world } = buildWorldState(tick);
    // Pin the onDamage Bernoulli stream: this suite asserts exact stat writes and would
    // otherwise inherit a probabilistic drop from the shipped onDamage rule.
    world.onDamageDropListener._randomFn = () => 1;

    for (const [name, value] of Object.entries(PROBES)) {
        world.actionController.actionRegistry[name] = {
            description: `probe punch ${name}`,
            targetingType: 'component',
            range: 100,
            // A requirement is what puts a fulfilling component into the resolution
            // context, i.e. what `:Physical.strength` is read from. Kept permissive
            // (minValue 1) so the probe does not ride the shipped balance.
            requirements: [{ trait: 'Physical', stat: 'strength', minValue: 1 }],
            consequences: [{
                type: 'damageComponent',
                target: 'target',
                params: { channel: 'impact', value },
            }],
        };
    }

    const roomId = world.roomsController.getUidByLogicalId('start_room');
    const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
    const victimId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
    world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
    world.stateEntityController.updateEntitySpatial(victimId, { x: 50, y: 0 }); // within range 100
    const hand = world.getEntity(attackerId).components.find((c) => c.type === 'droidHand');
    const head = world.getEntity(victimId).components.find((c) => c.type === 'droidHead');
    return { world, attackerId, victimId, headId: head.id, handId: hand.id };
}

/**
 * Throws one probe punch.
 * @param {object} world the built world
 * @param {{ attackerId: string, victimId: string, handId: string, headId: string }} rig participants
 * @param {string} actionName which probe verb to use
 * @returns {object} the damageComponent step of the action result
 */
function punch(world, rig, actionName) {
    const result = world.actionController.executeAction(actionName, rig.attackerId, {
        targetEntityId: rig.victimId,
        targetComponentId: rig.headId,
        componentIds: [{ componentId: rig.handId, role: 'source' }],
    });
    return result.results?.find((r) => r.type === 'damageComponent');
}

describe('a damage value that is not a finite number is refused, not written', () => {
    it('an unresolved placeholder does not poison the component it aimed at', () => {
        const { world, ...rig } = bootWorld();
        const existence = () => world.getComponentStats(rig.headId)?.Physical?.existence;
        const before = existence();
        expect(typeof before).toBe('number');

        const damage = punch(world, rig, 'poison_probe');

        // (1) refused, with a message that names the value rather than a silent success.
        expect(damage, 'the damage consequence step must exist').toBeTruthy();
        expect(damage.success, 'a damage value that is not a number must not report success').toBe(false);
        expect(String(damage.message || damage.error)).toMatch(/resolved number/i);

        // (2) nothing moved, and nothing became NaN — the part is still a number.
        expect(existence(), 'the refused hit must leave the stat exactly where it was').toBe(before);
        expect(Number.isFinite(existence())).toBe(true);

        // (3) the part is still alive, still a target, still destroyable: a real damage
        //     value lands on the ORIGINAL value, not on a NaN.
        const later = punch(world, rig, 'full_probe');
        expect(later.success, `a real damage value must still land: ${JSON.stringify(later)}`).toBe(true);
        expect(Number.isFinite(existence())).toBe(true);
        expect(existence()).toBeLessThan(before);
    });

    it('a literal that only looks like an expression is refused the same way', () => {
        // `"50/2"` in a data file is a string, not an expression — no placeholder to
        // resolve. The resolver leaves it text; the damage handler refuses text.
        const { world, ...rig } = bootWorld();
        const before = world.getComponentStats(rig.headId).Physical.existence;

        const damage = punch(world, rig, 'literal_probe');

        expect(damage.success).toBe(false);
        expect(String(damage.message || damage.error)).toMatch(/resolved number/i);
        expect(world.getComponentStats(rig.headId).Physical.existence).toBe(before);
    });

    it('the whole stat and half of it differ by exactly half (the expression means what it says)', () => {
        // Two identical worlds, identical droids, one verb differing only by `/2`. The
        // channel math is linear in the raw value, so the loss must be too.
        const full = measureLoss('full_probe');
        const half = measureLoss('half_probe');

        expect(full.damage.success, 'the whole-stat hit must land').toBe(true);
        expect(half.damage.success, 'the halved hit must land').toBe(true);
        expect(full.strength, 'a probe hand must actually carry strength').toBeGreaterThan(0);
        expect(half.damage.data.existenceLoss).toBeGreaterThan(0);
        expect(half.damage.data.existenceLoss).toBeCloseTo(full.damage.data.existenceLoss / 2, 10);
        expect(half.delta).toBeCloseTo(full.delta / 2, 10);
    });
});

/**
 * Runs one probe punch in a fresh world and reports what it cost the victim's head.
 * @param {string} actionName which probe verb to throw
 * @returns {{ strength: number, damage: object, delta: number }} strength and the loss
 */
function measureLoss(actionName) {
    const { world, ...rig } = bootWorld();
    const strength = world.getComponentStats(rig.handId)?.Physical?.strength;
    const before = world.getComponentStats(rig.headId).Physical.existence;
    const damage = punch(world, rig, actionName);
    return { strength, damage, delta: before - world.getComponentStats(rig.headId).Physical.existence };
}
