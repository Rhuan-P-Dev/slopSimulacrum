/**
 * CONTRACT TEST — appearance in the round prose.
 *
 * The prose is the first consumer of the `visual` blocks (the decision, with the
 * rejected alternatives, is `wiki/decisions/visual-stats.md`). The builder is a
 * pure reader and stays one: it is handed a `lookOf` lookup by
 * RoundProseController, and resolves the acting part's DOMINANT material through
 * the material owner. This file pins the four things that make that true:
 *
 *   - the live path: a real driven round says how the part that threw the punch
 *     looks — "powered by Male Arm (tan, satin)";
 *   - the entity view carries the same clause as the room view (both prose
 *     entries are wired, not just the room one);
 *   - the default is the old prose: WITHOUT a resolver the same rows render
 *     exactly "powered by Male Arm." — no parenthesis, no invented look, so the
 *     byte-pinned prose stays pinned;
 *   - determinism: the clause is a pure function of the data, so two worlds built
 *     the same way speak it identically.
 *
 * @module test/contract/proseMaterialLook
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { buildRoomProse } from '../../src/utils/RoundProseBuilder.js';

const FLESH_LOOK = 'tan, satin';

/**
 * The one wording the builder-under-test needs when it is driven directly: prose
 * takes its verbs from the action registry now (`wiki/decisions/action-prose.md`),
 * so a caller that injects nothing gets "did <action>" — which is not the sentence
 * this test is about. The registry itself is covered through the controller by the
 * other cases here and by test/contract/actionProse.contract.test.js.
 */
const verbOf = (action) => (action === 'droid punch' ? { verbPhrase: 'threw a punch' } : null);

/**
 * One human punching one droid, through a real round: the turn recipe mirrors
 * roundProse.contract.test.js (the tick is an external clock the test drives;
 * NPCs are despawned so the roster is exactly the two spawns; BOTH planners
 * signal, which is what closes the barrier all-ready). The onDamage Bernoulli
 * stream is pinned off so nothing random joins the paragraph.
 */
function buildMatch() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world } = buildWorldState(tick);
    const room = world.roomsController.getUidByLogicalId('start_room');
    const attacker = world.stateEntityController.spawnEntity('maleDroid', room, { name: 'Adam' });
    const victim = world.stateEntityController.spawnEntity('smallBallDroid', room, { name: 'Ball' });
    world.stateEntityController.updateEntitySpatial(attacker, { x: 0, y: 0 });
    world.stateEntityController.updateEntitySpatial(victim, { x: 30, y: 0 });
    world.onDamageDropListener._randomFn = () => 1;
    Object.values(world.stateEntityController.entities)
        .filter((entity) => entity.isNPC === true)
        .forEach((npc) => world.despawnEntity(npc.id));

    const step = (targetTick) => {
        tick.currentTick = targetTick;
        world.turnSystemController.onTick();
    };
    step(0);    // round 0 opens, and its roster is the two spawns
    world.turnSystemController.queueAction(attacker, 'droid punch', { targetEntityId: victim }, 'player');
    world.turnSystemController.signalPlanComplete(attacker, 'player');
    world.turnSystemController.signalPlanComplete(victim, 'player');
    for (let tickNumber = 1; tickNumber <= 4; tickNumber += 1) step(tickNumber);
    return { world, room, attacker, victim };
}

/**
 * The paragraph that narrates the punch, and the round it landed in. Which round
 * carries it is the turn system's business (rows flush at the round boundary), so
 * the search is over the recent rounds rather than a pinned round number; what is
 * pinned is WHAT the paragraph says.
 * @returns {{ round: number, text: string }|null}
 */
function punchParagraph(world) {
    for (let round = 0; round <= 3; round += 1) {
        const prose = world.roundProseController.getRoundProse(round);
        for (const info of Object.values(prose?.rooms || {})) {
            if (/threw a punch/.test(info.text)) return { round, text: info.text };
        }
    }
    return null;
}

describe('round prose speaks how the matter looks', () => {
    it('the room paragraph names the look of the part that threw the punch', () => {
        const { world } = buildMatch();
        const found = punchParagraph(world);
        expect(found, 'a real round narrated the punch').toBeTruthy();
        expect(found.text).toContain(`Male Arm (${FLESH_LOOK})`);
    });

    it('the entity view carries the same clause as the room view', () => {
        const { world, attacker } = buildMatch();
        const found = punchParagraph(world);
        expect(found, 'a real round narrated the punch').toBeTruthy();
        const entityProse = world.roundProseController.getEntityProse(attacker, found.round);
        expect(entityProse?.text ?? '', 'the entity paragraph says the same thing')
            .toContain(`Male Arm (${FLESH_LOOK})`);
    });

    it('without a resolver the same rows render the old sentence, exactly', () => {
        const { world } = buildMatch();
        const rooms = world.getRooms();
        const rows = Object.keys(rooms)
            .flatMap((roomId) => world.getPerceptionDeltasForRoom(roomId, { limit: 50 }))
            .filter((entry) => entry?.actions?.performed?.length);
        expect(rows.length, 'the round recorded the action row').toBeGreaterThan(0);

        const lookless = buildRoomProse({ entries: rows, roomName: 'The Entrance Hall', room: null, verbOf });
        expect(lookless).toContain('powered by Male Arm');
        expect(lookless, 'no resolver, no look clause - never an invented one').not.toContain(FLESH_LOOK);
        // A parenthesis on its own is not a look clause: the actor dossier says WHICH
        // part ("Male Head (top)") while saying nothing about how anything looks, so
        // no look word of the material vocabulary may appear anywhere in it.
        expect(lookless, 'no look word from the material vocabulary is invented')
            .not.toMatch(/, (satin|translucent|brushed|coarse|grained|near-black|tan)\b/);
    });

    it('the clause is a pure function of the data: two identically built worlds speak it identically', () => {
        const first = punchParagraph(buildMatch().world);
        const second = punchParagraph(buildMatch().world);
        expect(first, 'a real round narrated the punch').toBeTruthy();
        const clause = (text) => text.match(/powered by [^(]*\([^)]*\)/)?.[0] ?? null;
        expect(clause(first.text), 'the first world said the look').toBeTruthy();
        expect(clause(second.text)).toBe(clause(first.text));
    });
});
