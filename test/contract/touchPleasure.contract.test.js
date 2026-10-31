/**
 * CONTRACT TEST — the "touch" action and the pleasure mechanic it drives.
 *
 * touch is a component-targeting action (like punch/cut): the LLM targets a
 * specific body-part component of a victim droid. Its consequence
 * (`stimulateSensitivePart`) validates that the part is a sensitive part (the
 * `sensitive` flag granted by the sensitiveNerve organ —
 * data/mods/core-internal-components/internalComponents.json) and that its type carries a
 * declared sensitivity value (data/mods/core-sensitive-parts/sensitiveParts.json), then
 * raises the TOUCHED droid's whole-entity Pleasure.pleasure by that value
 * (clamped into [0, max] by the facade). The toucher gains nothing (agreed
 * design: only the touched droid gains). The meter decays 1 per round —
 * pinned by the pleasureAttribute suite (floor 0, never a death).
 *
 * Full action round-trips: buildWorldState (tick NOT started) and
 * world.actionController.executeAction — the same entry the LLM agent uses.
 *
 * Pins:
 *   - touching a part raises the touched droid's pleasure by that part's
 *     sensitivity (clitoris 100 clamps 0 -> 100; nipple 40 stacks
 *     0 -> 40 -> 80), and the toucher's own meter is untouched;
 *   - touching a NON-sensitive part (head): the action executes, but the
 *     consequence reports the failure and no pleasure changes;
 *   - touching a droid without a pleasure meter (m1Droid): same — the
 *     consequence fails and nothing changes (no energy lost either);
 *   - touching out of range (distance > 50) fails at the range gate (an
 *     action-level failure, like the other component-targeting actions);
 *   - capability: touch declares no stat requirements, so the capability
 *     engine must report it as CAPABLE for every droid — canExecute covers
 *     all of the droid's body parts and cannotExecute stays empty (the UI
 *     must never show "0 capable / N incapable" for it).
 *
 * @module test/contract/touchPleasure
 */
import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { TRAIT_GROUPS, STAT_NAMES } from '../../shared/StatVocabulary.js';

function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    return buildWorldState(tick).worldStateController;
}

function pleasureOf(world, entityId) {
    return world.getEntityAttribute(entityId, TRAIT_GROUPS.PLEASURE, STAT_NAMES.PLEASURE);
}

function energyOf(world, entityId) {
    return world.getEntityAttribute(entityId, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.ENERGY);
}

/** Executes the touch action the way the LLM agent does (hand as source). */
function touch(world, attackerId, targetEntityId, targetComponentId) {
    const attacker = world.getEntity(attackerId);
    const hand =
        attacker.components.find((c) => c.type === 'maleHand' || c.type === 'femaleHand') ||
        attacker.components[0];
    return world.actionController.executeAction('touch', attackerId, {
        attackerComponentId: hand.id,
        targetEntityId,
        targetComponentId,
    });
}

function spawnPair(world, blueprintA, blueprintB, xA, yA, xB, yB) {
    const roomId = world.roomsController.getUidByLogicalId('start_room');
    const a = world.stateEntityController.spawnEntity(blueprintA, roomId);
    const b = world.stateEntityController.spawnEntity(blueprintB, roomId);
    world.stateEntityController.updateEntitySpatial(a, { x: xA, y: yA });
    world.stateEntityController.updateEntitySpatial(b, { x: xB, y: yB });
    return { a, b };
}

describe('touch — the pleasure mechanic (contract, full round-trip)', () => {
    it('touching a clitoris (sensitivity 100) clamps the touched droid to 100; the toucher gains nothing', () => {
        const world = buildWorld();
        const { a: attackerId, b: victimId } = spawnPair(world, 'femaleDroid', 'femaleDroid', 0, 0, 30, 0); // 30 < range 50

        const clitoris = world.getEntity(victimId).components.find((c) => c.type === 'femaleClitoris');
        expect(clitoris, 'the female droid must carry a clitoris component').toBeTruthy();

        const res = touch(world, attackerId, victimId, clitoris.id);
        expect(res.success, `touch must succeed within range: ${JSON.stringify(res)}`).toBe(true);

        const stim = res.results.find((r) => r.type === 'stimulateSensitivePart');
        expect(stim, 'the touch must run the stimulateSensitivePart consequence').toBeTruthy();
        expect(stim.success, 'the stimulation must succeed').toBe(true);
        expect(stim.data.sensitivity, 'clitoris sensitivity is 100').toBe(100);
        expect(stim.data.newPleasure).toBe(100);

        expect(pleasureOf(world, victimId), '0 -> 100 (clamped at max)').toBe(100);
        expect(pleasureOf(world, attackerId), 'the toucher gains nothing').toBe(0);
    });

    it('touching nipples (sensitivity 40) stacks 0 -> 40 -> 80 on the touched droid', () => {
        const world = buildWorld();
        const { a: attackerId, b: victimId } = spawnPair(world, 'maleDroid', 'maleDroid', 0, 0, 20, 0);

        const nipples = world.getEntity(victimId).components.filter((c) => c.type === 'maleNipple');
        expect(nipples.length, 'the male droid must carry two nipples').toBe(2);

        const first = touch(world, attackerId, victimId, nipples[0].id);
        expect(first.success).toBe(true);
        expect(pleasureOf(world, victimId), 'first nipple touch: 0 -> 40').toBe(40);

        const second = touch(world, attackerId, victimId, nipples[1].id);
        expect(second.success).toBe(true);
        expect(pleasureOf(world, victimId), 'second nipple touch: 40 -> 80').toBe(80);

        expect(pleasureOf(world, attackerId), 'the toucher gains nothing').toBe(0);
    });

    it('touching a non-sensitive part (head) fails and changes no pleasure', () => {
        const world = buildWorld();
        const { a: attackerId, b: victimId } = spawnPair(world, 'femaleDroid', 'femaleDroid', 0, 0, 25, 0);

        const head = world.getEntity(victimId).components.find((c) => c.type === 'femaleHead');
        expect(head, 'the female droid must carry a head component').toBeTruthy();

        const res = touch(world, attackerId, victimId, head.id);
        expect(res.success, 'the action itself executes; the consequence reports the failure').toBe(true);

        const stim = res.results.find((r) => r.type === 'stimulateSensitivePart');
        expect(stim, 'the stimulation consequence must have been attempted').toBeTruthy();
        expect(stim.success, 'a head is not a sensitive part — the stimulation must fail').toBe(false);
        expect(pleasureOf(world, victimId), 'no pleasure was gained').toBe(0);
    });

    it('touching a droid without a pleasure meter (m1Droid) fails and changes nothing', () => {
        const world = buildWorld();
        const { a: attackerId, b: m1Id } = spawnPair(world, 'maleDroid', 'm1Droid', 0, 0, 20, 0);

        const m1Comp = world.getEntity(m1Id).components[0];
        expect(m1Comp, 'the m1 droid must have components').toBeTruthy();

        const res = touch(world, attackerId, m1Id, m1Comp.id);
        expect(res.success, 'the action executes; the consequence reports the failure').toBe(true);

        const stim = res.results.find((r) => r.type === 'stimulateSensitivePart');
        expect(stim.success, 'the m1 droid has no Pleasure.pleasure meter — the stimulation must fail').toBe(false);
        expect(energyOf(world, m1Id), 'the m1 droid loses no energy from a failed touch').toBe(100);
    });

    it('touching out of range (distance > 50) fails (the range gate)', () => {
        const world = buildWorld();
        const { a: attackerId, b: victimId } = spawnPair(world, 'femaleDroid', 'femaleDroid', 0, 0, 80, 0); // 80 > range 50

        const clitoris = world.getEntity(victimId).components.find((c) => c.type === 'femaleClitoris');
        expect(clitoris).toBeTruthy();

        const res = touch(world, attackerId, victimId, clitoris.id);
        expect(res.success, 'out of range — the action must fail').toBe(false);
        expect(pleasureOf(world, victimId), 'no pleasure was gained').toBe(0);
    });

    it('reports touch as CAPABLE in the per-entity action list (no-requirement action: every body part can perform it)', () => {
        const world = buildWorld();
        const { a: maleId, b: m1Id } = spawnPair(world, 'maleDroid', 'm1Droid', 0, 0, 20, 0);

        const maleActions = world.getActionsForEntity(maleId);
        expect(maleActions.touch, 'the action list must include touch').toBeTruthy();

        const malePartIds = world.getEntity(maleId).components.map((c) => c.id).sort();
        const capableIds = maleActions.touch.canExecute.map((e) => e.componentId).sort();
        expect(capableIds, 'every body part of the droid is capable').toEqual(malePartIds);
        expect(maleActions.touch.cannotExecute, 'no incapable entry').toHaveLength(0);

        const m1Actions = world.getActionsForEntity(m1Id);
        const m1PartIds = world.getEntity(m1Id).components.map((c) => c.id).sort();
        expect(
            m1Actions.touch.canExecute.map((e) => e.componentId).sort(),
            'every body part of the m1 droid is capable too'
        ).toEqual(m1PartIds);
        expect(m1Actions.touch.cannotExecute, 'no incapable entry').toHaveLength(0);
    });
});
