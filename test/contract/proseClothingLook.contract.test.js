/**
 * CONTRACT TEST — clothing in the round prose.
 *
 * A material's look is authored data, and an item now authors a look of its own:
 * the shipped t-shirt declares a `visual` block, because the matter a garment is
 * modelled from (`wood`, "brown, rough, grained") does not look the way the shirt
 * does. Two rules ride on that, and both are pinned here against a real driven
 * world (spawn → round → perception flush → prose), not against hand-written rows:
 *
 *   - a part WITH something on it does not reveal its own details: the garment's
 *     look is said and the flesh under it is not, while the parts the garment does
 *     not cover keep naming their matter exactly as before;
 *   - taking the garment off says what left the body, and the part is readable
 *     again afterwards;
 *   - the entity view carries the same clause as the room view (one builder, two
 *     readers — the same pin `proseMaterialLook` holds for material looks);
 *   - a caller with NO look resolvers still says the part is clothed (that fact is
 *     on the row) and invents no appearance whatsoever;
 *   - determinism: two identically built worlds speak an identical clause.
 *
 * The expected words are DERIVED from the shipped data, never typed here. An
 * authored word beside the numbers would be a second claim about the same matter,
 * and the first tune of a hue would break it silently (`DOC-1`,
 * `wiki/decisions/visual-stats.md`).
 *
 * @module test/contract/proseClothingLook
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import DataLoader from '../../src/utils/DataLoader.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';
import { buildRoomProse } from '../../src/utils/RoundProseBuilder.js';
import { describeVisual } from '../../src/utils/materialLook.js';

/** The look the shipped t-shirt recipe declares, read through the seam. */
const SHIRT_LOOK = describeVisual(
    DataLoader.loadRegistry(REGISTRY_KINDS.INVENTORY_ITEMS)?.tshirt?.visual
)?.phrase ?? '';
/** The look a bare human part reads as, from the shipped `flesh` material. */
const FLESH_LOOK = describeVisual(
    DataLoader.loadRegistry(REGISTRY_KINDS.MATERIALS)?.flesh?.visual
)?.phrase ?? '';
/**
 * The component type the shipped blueprint marks as hiding with its parent
 * (`["maleBreast", "left", { "hidesWithParent": true }]`), and its display name as
 * the registry gives it — derived from data, like every other word pinned here.
 */
const MARKED_TYPE = 'maleBreast';
const MARKED_NAME = DataLoader.loadRegistry(REGISTRY_KINDS.COMPONENTS)?.[MARKED_TYPE]?.name ?? '';

/**
 * The one wording the builder-under-test needs when driven directly: prose takes
 * its verbs from the action registry (`wiki/decisions/action-prose.md`), so a
 * caller that injects nothing gets "did <action>" — not the sentence pinned here.
 */
const verbOf = (action) => (action === 'droid punch' ? { verbPhrase: 'threw a punch' } : null);

/**
 * One human punching one droid, through a real round — the recipe of
 * `proseMaterialLook.contract.test.js`, so the two files pin two halves of the
 * same paragraph. Both spawns carry the world.json loadout, so BOTH of them are
 * wearing the shipped t-shirt (worn on the root component, `WearLogic`), which is
 * what makes this a clothing test rather than a hypothetical one. `advance` keeps
 * driving the same world from wherever the clock stands.
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

    const advance = (ticks) => {
        for (let i = 0; i < ticks; i += 1) {
            tick.currentTick += 1;
            world.turnSystemController.onTick();
        }
    };
    const step = (targetTick) => {
        tick.currentTick = targetTick;
        world.turnSystemController.onTick();
    };
    step(0);    // round 0 opens, and its roster is the two spawns
    world.turnSystemController.queueAction(attacker, 'droid punch', { targetEntityId: victim }, 'player');
    world.turnSystemController.signalPlanComplete(attacker, 'player');
    world.turnSystemController.signalPlanComplete(victim, 'player');
    advance(4);
    return { world, room, attacker, victim, advance };
}

/**
 * The action rows a driven round flushed, across every room. The body an actor was
 * read as lives ON these rows (`PerceptionController._actorBody`), which is what the
 * claims about coverage are actually about.
 * @param {Object} world
 * @returns {Array}
 */
function performedRows(world) {
    return Object.keys(world.getRooms())
        .flatMap((roomId) => world.getPerceptionDeltasForRoom(roomId, { limit: 50 }))
        .filter((entry) => entry?.actions?.performed?.length);
}

/**
 * The paragraph that matches, and the round that carries it. Which round holds it
 * is the turn system's business (rows flush at the round boundary), so the search
 * runs over recent rounds; what is pinned is WHAT the paragraph says.
 * @param {Object} world
 * @param {RegExp} pattern
 * @returns {{ round: number, text: string }|null}
 */
function findParagraph(world, pattern) {
    for (let round = 0; round <= 6; round += 1) {
        const prose = world.roundProseController.getRoundProse(round);
        for (const info of Object.values(prose?.rooms || {})) {
            if (pattern.test(info.text)) return { round, text: info.text };
        }
    }
    return null;
}

describe('round prose renders clothing: the garment is revealed, what it covers is not', () => {
    it('the shipped world really has the t-shirt on the actor this file reads', () => {
        // A fixture that silently stopped wearing anything would "pass" every
        // assertion below by never reaching the code they are about.
        const { world, attacker } = buildMatch();
        expect(SHIRT_LOOK, 'the t-shirt recipe declares a look').not.toBe('');
        const worn = world.getWornItems(attacker);
        expect(worn.map((row) => row.itemType)).toContain('tshirt');
        expect(worn[0].componentType, 'the fit puts it on one component, so it covers exactly that one')
            .toBe('maleCentralBody');
    });

    it('the covered part says what covers it, and not what it is made of', () => {
        const { world } = buildMatch();
        const found = findParagraph(world, /used .+ to throw a punch/);
        expect(found, 'a real round narrated the punch').toBeTruthy();
        expect(found.text).toContain(`Male Central Body wearing a T-Shirt (${SHIRT_LOOK})`);
        expect(found.text, 'a covered part does not also reveal the matter under it')
            .not.toContain(`Male Central Body (${FLESH_LOOK}`);
        // Everything the shirt does not cover keeps its own material clause: hiding
        // is per component (the wear system's coverage rule), never per body.
        expect(found.text).toContain(`Male Arm (left, ${FLESH_LOOK})`);
    });

    it('a part marked hidesWithParent is behind the cloth over its parent', () => {
        const { world } = buildMatch();
        const found = findParagraph(world, /used .+ to throw a punch/);
        expect(found, 'a real round narrated the punch').toBeTruthy();
        const marked = performedRows(world)[0]?.actions?.performed[0]?.body
            ?.find((part) => part.type === MARKED_TYPE);
        expect(marked, 'the flush wrote the coverage the blueprint marked')
            .toMatchObject({ covered: true });
        expect(found.text, 'the part under the shirt is not in the sentence')
            .not.toContain(MARKED_NAME);
        // Only the marked mount hides: the head hangs off the same parent and says so.
        expect(found.text).toContain(`Male Head (top, ${FLESH_LOOK})`);
    });

    it('the marked part comes back when the cloth comes off', () => {
        const { world, attacker, victim, advance } = buildMatch();
        const [shirt] = world.getWornItems(attacker);
        expect(shirt?.itemType).toBe('tshirt');

        world.unequipItem(attacker, shirt.itemId);
        world.turnSystemController.queueAction(attacker, 'droid punch', { targetEntityId: victim }, 'player');
        world.turnSystemController.signalPlanComplete(attacker, 'player');
        world.turnSystemController.signalPlanComplete(victim, 'player');
        advance(4);

        const found = findParagraph(world, /unequipped a T-Shirt/);
        expect(found, 'the round recorded the garment coming off').toBeTruthy();
        expect(found.text).toContain(`${MARKED_NAME} (left, ${FLESH_LOOK})`);
        expect(found.text).toContain(`${MARKED_NAME} (right, ${FLESH_LOOK})`);
    });

    it('the entity view carries the same clothing clause as the room view', () => {
        const { world, attacker } = buildMatch();
        const found = findParagraph(world, /used .+ to throw a punch/);
        expect(found, 'a real round narrated the punch').toBeTruthy();
        const entityProse = world.roundProseController.getEntityProse(attacker, found.round);
        expect(entityProse?.text ?? '', 'the entity paragraph says the same thing')
            .toContain(`Male Central Body wearing a T-Shirt (${SHIRT_LOOK})`);
    });

    it('taking it off is said, and the part reads as flesh again', () => {
        const { world, attacker, victim, advance } = buildMatch();
        const [shirt] = world.getWornItems(attacker);
        expect(shirt?.itemType).toBe('tshirt');

        world.unequipItem(attacker, shirt.itemId);
        // One more driven round carries the change into the ring (and gives the
        // actor a body clause to wear the new state in).
        world.turnSystemController.queueAction(attacker, 'droid punch', { targetEntityId: victim }, 'player');
        world.turnSystemController.signalPlanComplete(attacker, 'player');
        world.turnSystemController.signalPlanComplete(victim, 'player');
        advance(4);

        const found = findParagraph(world, /unequipped a T-Shirt/);
        expect(found, 'the round recorded the garment coming off').toBeTruthy();
        expect(found.text).toContain(`unequipped a T-Shirt (${SHIRT_LOOK})`);
        expect(found.text, 'with nothing on it, the part reveals its own matter again')
            .toContain(`Male Central Body (${FLESH_LOOK})`);
    });

    it('with no look resolvers the clothing is still named — and no appearance is invented', () => {
        const { world } = buildMatch();
        const rows = performedRows(world);
        expect(rows.length, 'the round recorded the action row').toBeGreaterThan(0);

        const lookless = buildRoomProse({ entries: rows, roomName: 'The Entrance Hall', room: null, verbOf });
        // The FACT that the part is clothed rides on the row, so it survives: a
        // reader with no data access still cannot be told a bare torso is bare skin.
        expect(lookless).toContain('Male Central Body wearing a T-Shirt');
        expect(lookless, 'no resolver, no look clause - never an invented one')
            .not.toContain(SHIRT_LOOK);
        expect(lookless, 'no look word from the vocabulary is invented')
            .not.toContain(FLESH_LOOK);
    });

    it('is a pure function of the data: two identically built worlds speak it identically', () => {
        const clause = (text) => text.match(/wearing a T-Shirt \([^)]*\)/)?.[0] ?? null;
        const first = findParagraph(buildMatch().world, /used .+ to throw a punch/);
        const second = findParagraph(buildMatch().world, /used .+ to throw a punch/);
        expect(first, 'a real round narrated the punch').toBeTruthy();
        expect(clause(first.text), 'the first world said the clothing').toBeTruthy();
        expect(clause(second.text)).toBe(clause(first.text));
    });
});
