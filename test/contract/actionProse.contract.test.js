/**
 * CONTRACT TEST — action prose: the registry words the act, the row records the body.
 *
 * The decision under test is `wiki/decisions/action-prose.md`, and it has two
 * halves, both of which only mean anything against the live world:
 *
 *   - the WORDS of an action are the action registry's. The hand-written verb
 *     table prose used to carry is gone, so every shipped action has to declare
 *     `prose.verbPhrase` (and, where the verb governs its target directly,
 *     `prose.targetLink`) — otherwise the paragraph degrades to "did <action>".
 *     The registry's `description` stays out of prose: it is written for the
 *     actor ("Advance your droid… using your rolling wheels"), and a human has no
 *     rolling wheels.
 *   - the BODY an act is credited to is recorded on the act, at the round's
 *     perception flush: `actions.performed[].body`. Prose reads it off the row and
 *     reads no world, so a round re-rendered tomorrow says what it said the minute
 *     it closed. Each entry carries the part's OWN label (a nail is "tip", not
 *     "tip_f1_hand_left") and a `shallow` depth mark — and the deep parts stay on
 *     the row: the record is all 78 parts of a human, the sentence names the ten
 *     that hang off the root.
 *
 * Everything here is driven through a real round (real turn system, real
 * perception flush, real prose controller), never through a fixture that could
 * only prove the builder agrees with itself.
 *
 * @module test/contract/actionProse
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { buildRoomProse } from '../../src/utils/RoundProseBuilder.js';
import DataLoader from '../../src/utils/DataLoader.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';

/**
 * The wording prose would read from the registry, for the one case below that
 * drives the builder directly: prose owns no verbs (`wiki/decisions/action-prose.md`),
 * so a caller that injects nothing gets "did <action>" — and that is not what that
 * case is about. Every other case here reads the real registry through the
 * controller.
 */
const verbOf = (action) => ({ 'droid punch': { verbPhrase: 'threw a punch' } }[action] ?? null);

/** The ten parts of a maleDroid that hang off the body's own root. */
const SHALLOW_TYPES = [
    'maleCentralBody',
    'maleHead',
    'maleTorso',
    'maleBreast',
    'maleArm',
    'maleGenitals',
    'maleLeg'
];

/**
 * One human punching one droid, then touching it, through a real round. The turn
 * recipe mirrors proseMaterialLook.contract.test.js: the tick is an external clock
 * the test drives, NPCs are despawned so the roster is exactly the two spawns, and
 * BOTH planners signal, which is what closes the barrier all-ready. The onDamage
 * Bernoulli stream is pinned off so nothing random joins the paragraph.
 * @returns {{ world: Object, attacker: string, victim: string }}
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
    world.turnSystemController.queueAction(attacker, 'touch', { targetEntityId: victim }, 'player');
    world.turnSystemController.signalPlanComplete(attacker, 'player');
    world.turnSystemController.signalPlanComplete(victim, 'player');
    for (let tickNumber = 1; tickNumber <= 4; tickNumber += 1) step(tickNumber);
    return { world, attacker, victim };
}

/**
 * Every `actions.performed` row the world recorded, in any room, any round.
 * @param {Object} world
 * @returns {Array}
 */
function performedRows(world) {
    return Object.keys(world.getRooms())
        .flatMap((roomId) => world.getPerceptionDeltasForRoom(roomId, { limit: 50 }))
        .flatMap((entry) => (Array.isArray(entry?.actions?.performed) ? entry.actions.performed : []));
}

/**
 * The paragraph that narrates the punch, and the round it landed in (which round
 * carries it is the turn system's business; what is pinned is WHAT it says).
 * @param {Object} world
 * @returns {{ round: number, text: string }|null}
 */
function punchParagraph(world) {
    for (let round = 0; round <= 3; round += 1) {
        const prose = world.roundProseController.getRoundProse(round);
        for (const info of Object.values(prose?.rooms || {})) {
            if (/punch/i.test(info.text)) return { round, text: info.text };
        }
    }
    return null;
}

describe('the action registry is the only source of action wording', () => {
    it('every shipped action declares the words prose will say', () => {
        const { worldStateController: world } = buildWorldState(new UniversalTickSystem(MAX_TICKS_PER_SECOND));
        const registry = world.getActionRegistry() || {};
        const actions = Object.entries(registry).filter(([, def]) => def && typeof def === 'object');
        expect(actions.length, 'the live registry ships actions').toBeGreaterThan(0);

        let direct = 0;
        const instrumented = [];
        for (const [name, def] of actions) {
            const phrase = def.prose?.verbPhrase;
            expect(typeof phrase, `action "${name}" declares prose.verbPhrase`).toBe('string');
            expect(String(phrase).trim(), `action "${name}" prose.verbPhrase is not blank`).toBeTruthy();
            expect(phrase, `action "${name}" wording is ASCII (CR NAME-1)`).toMatch(/^[\x20-\x7E]+$/);
            if (def.prose.targetLink !== undefined) {
                expect(typeof def.prose.targetLink, `action "${name}" prose.targetLink is a string`).toBe('string');
                if (def.prose.targetLink === 'direct') direct += 1;
            }
            // The instrumental form (`wiki/decisions/action-prose.md`): the base verb
            // English cannot derive from its own past tense ("threw a punch" -> "throw
            // a punch", "fired the T1" -> "shoot"), so an act that wants the
            // "used <part> to <verb> <target>" sentence has to author it. Absent is a
            // real answer - that act keeps the "…, powered by <part>" clause - but a
            // declared-and-blank entry is not, exactly like verbPhrase.
            if (def.prose.instrumental !== undefined) {
                const ins = def.prose.instrumental;
                expect(ins, `action "${name}" prose.instrumental is an object`).toBeInstanceOf(Object);
                expect(typeof ins.verb, `action "${name}" prose.instrumental.verb is a string`).toBe('string');
                expect(String(ins.verb).trim(), `action "${name}" prose.instrumental.verb is not blank`).toBeTruthy();
                expect(ins.verb, `action "${name}" instrumental wording is ASCII (CR NAME-1)`).toMatch(/^[\x20-\x7E]+$/);
                if (ins.targetLink !== undefined) {
                    expect(typeof ins.targetLink, `action "${name}" prose.instrumental.targetLink is a string`).toBe('string');
                }
                instrumented.push(name);
            }
        }
        // At least one verb takes its target directly, or the whole `direct` rule
        // would be untested by the shipped data ("Adam touched Ball").
        expect(direct, 'a transitive action declares targetLink "direct"').toBeGreaterThan(0);
        // Which acts speak instrumentally is a decision, not a side effect of the
        // wording: every one of these acts on a target the sentence can name. A new
        // entry has to be named here too, so an act cannot start claiming an
        // instrument on its own.
        expect(instrumented.sort()).toEqual([
            'cut', 'droid punch', 'dropItem', 'grab', 'hand shotgun', 'pickUpItem',
            'placeMachine', 'retrieveMachine', 'shootT1', 'touch'
        ]);
    });

    it('a real round is narrated in those words — never in the fallback', () => {
        const found = punchParagraph(buildMatch().world);
        expect(found, 'a real round narrated the punch').toBeTruthy();
        // The instrumental shape, from the registry's own base verb: the part that did
        // it comes first, then what was done, then whom to. The look words live inside
        // the parenthesis after the part, so the two halves are pinned apart.
        expect(found.text).toContain('Adam used Male Arm');
        expect(found.text).toContain('to throw a punch against Ball');
        // "did <action>" is what prose says when the data has nothing; with a
        // complete registry it must not appear in a real paragraph at all.
        expect(found.text).not.toMatch(/\bdid [a-z]/);
    });
});

describe('the actor body is recorded on the act, and prose reads it off the row', () => {
    it('the row carries every part, its OWN label, and its depth', () => {
        const rows = performedRows(buildMatch().world);
        expect(rows.length, 'the round recorded the acts').toBeGreaterThan(0);
        const body = rows[0].body;
        expect(Array.isArray(body), 'the performed row carries a body').toBe(true);

        const leg = body.find((part) => part.type === 'maleLeg');
        const nail = body.find((part) => part.type === 'maleNail');
        expect(leg, 'the leg is on the row').toBeTruthy();
        expect(nail, 'the nail is on the row too — the record is not filtered').toBeTruthy();
        // The chain a component carries is its own label with its parent's appended;
        // the row keeps only its own, or the sentence says twice what the name says.
        expect(leg.identifier).toBe('frontal_left');
        expect(nail.identifier, 'the nail drops the ancestry the label already implies')
            .toBe('tip');
        expect(leg.shallow, 'a leg hangs off the root').toBe(true);
        expect(nail.shallow, 'a nail hangs off a finger').toBe(false);

        const shallow = body.filter((part) => part.shallow);
        expect(shallow.length, 'the sentence-level body is the ten parts hanging off the root')
            .toBe(10);
        for (const type of SHALLOW_TYPES) {
            expect(shallow.some((part) => part.type === type), `${type} is shallow`).toBe(true);
        }
        for (const type of ['maleHand', 'maleFinger', 'maleNail', 'maleTooth', 'maleHair']) {
            expect(shallow.some((part) => part.type === type), `${type} is not shallow`).toBe(false);
        }
        expect(body.length, 'the deep parts are marked, not dropped').toBeGreaterThan(70);
    });

    it('the room paragraph says the body as its own sentence, and names only the shallow parts', () => {
        const { world } = buildMatch();
        const found = punchParagraph(world);
        expect(found, 'a real round narrated the punch').toBeTruthy();

        expect(found.text).toContain('Adam, with ');
        expect(found.text).toContain('Male Arm (left, ');
        expect(found.text).toContain('Male Leg (frontal left, ');
        // Its own sentence, before the act: the narrative sentence that follows
        // still carries the "In <room>, …" prefix a dossier can never have.
        expect(found.text).toMatch(/Male Leg \(frontal right[^\n]*?\)\.\s(In [A-Z]|Adam\b)/);
        for (const deep of ['Male Nail', 'Male Tooth', 'Male Finger', 'Male Hand', 'Male Eye']) {
            expect(found.text, `the dossier reads out only the parts that hang off the root (${deep} stays off)`).not.toContain(deep);
        }
    });

    it('one body per actor, however many acts it performed', () => {
        const { world } = buildMatch();
        const found = punchParagraph(world);
        const rows = performedRows(world).filter((row) => row.action === 'droid punch' || row.action === 'touch');
        expect(rows.length, 'the actor performed more than one act').toBeGreaterThan(1);
        expect((found.text.match(/Adam, with/g) || []).length).toBe(1);
    });

    it('the entity view says the same dossier the room says', () => {
        const { world, attacker } = buildMatch();
        const found = punchParagraph(world);
        const entityProse = world.roundProseController.getEntityProse(attacker, found.round);
        expect(entityProse?.text ?? '').toContain('Adam, with ');
        expect(entityProse.text).toContain('Male Arm (left, ');
    });

    it('a row that carries no body renders none — a body is never reconstructed', () => {
        const { world } = buildMatch();
        const entries = Object.keys(world.getRooms())
            .flatMap((roomId) => world.getPerceptionDeltasForRoom(roomId, { limit: 50 }))
            .filter((entry) => entry?.actions?.performed?.length)
            .map((entry) => ({
                ...entry,
                actions: {
                    performed: entry.actions.performed.map((row) => {
                        // The field is absent, exactly as in a row this server wrote
                        // before the body was recorded.
                        const predating = { ...row };
                        delete predating.body;
                        return predating;
                    })
                }
            }));
        expect(entries.length, 'the round recorded the acts').toBeGreaterThan(0);

        const text = buildRoomProse({ entries, roomName: 'The Entrance Hall', room: null, verbOf });
        expect(text).toContain('threw a punch');
        expect(text, 'no body on the row, no body in the sentence — never a borrowed body')
            .not.toMatch(/, with /);
    });

    it('two identically built worlds speak the same dossier', () => {
        const first = punchParagraph(buildMatch().world);
        const second = punchParagraph(buildMatch().world);
        expect(first, 'a real round narrated the punch').toBeTruthy();
        const dossier = (text) => text.match(/Adam, with [^.]*\./)?.[0] ?? null;
        expect(dossier(first.text), 'the first world said the body').toBeTruthy();
        expect(dossier(second.text)).toBe(dossier(first.text));
    });
});

describe('the sentence names WHICH part of the target the act was aimed at', () => {
    /**
     * Adam touches one sensitive part of Eve, through a real round. The part is
     * DERIVED from the live sensitivity table (the touch mechanic raises pleasure on a
     * part listed there, and the owner must carry the meter), never typed here.
     * @returns {{ world: Object, part: Object }}
     */
    function buildTouchMatch() {
        const sensitive = DataLoader.loadRegistry(REGISTRY_KINDS.SENSITIVE_PARTS) || {};
        const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
        const { worldStateController: world } = buildWorldState(tick);
        const room = world.roomsController.getUidByLogicalId('start_room');
        const attacker = world.stateEntityController.spawnEntity('maleDroid', room, { name: 'Adam' });
        const victim = world.stateEntityController.spawnEntity('femaleDroid', room, { name: 'Eve' });
        world.stateEntityController.updateEntitySpatial(attacker, { x: 0, y: 0 });
        world.stateEntityController.updateEntitySpatial(victim, { x: 30, y: 0 });
        world.onDamageDropListener._randomFn = () => 1;
        Object.values(world.stateEntityController.entities)
            .filter((entity) => entity.isNPC === true)
            .forEach((npc) => world.despawnEntity(npc.id));
        const part = world.stateEntityController.entities[victim].components
            .find((comp) => sensitive[comp.type] !== undefined);
        tick.currentTick = 0;
        world.turnSystemController.onTick();
        world.turnSystemController.queueAction(attacker, 'touch',
            { targetEntityId: victim, targetComponentId: part.id }, 'player');
        world.turnSystemController.signalPlanComplete(attacker, 'player');
        world.turnSystemController.signalPlanComplete(victim, 'player');
        for (let tickNumber = 1; tickNumber <= 4; tickNumber += 1) {
            tick.currentTick = tickNumber;
            world.turnSystemController.onTick();
        }
        return { world, part };
    }

    it('the row keeps the part, its type, and its name', () => {
        // The TYPE is the half the writer had to add: the display name is prettified
        // ("Male Mouth") and the look lookup speaks recipe keys.
        const { world, part } = buildTouchMatch();
        const rows = performedRows(world).filter((row) => row.action === 'touch');
        expect(rows.length, 'the round recorded the touch').toBeGreaterThan(0);
        expect(rows[0].target?.componentType, 'the row names the part type').toBe(part.type);
        expect(rows[0].target?.componentName, 'and a display name for it').toBeTruthy();
        expect(rows[0].target?.name, 'and for the entity that owns it').toBe('Eve');
    });

    it('a real round says whose part it was, and never an id', () => {
        const { world, part } = buildTouchMatch();
        const recipes = DataLoader.loadRegistry(REGISTRY_KINDS.COMPONENTS) || {};
        const partName = recipes[part.type]?.name ?? part.type;
        let text = '';
        for (let round = 0; round <= 4; round += 1) {
            const prose = world.roundProseController.getRoundProse(round);
            for (const info of Object.values(prose?.rooms || {})) {
                if (info.text.includes("Eve's ")) text = info.text;
            }
        }
        expect(text, 'a real round named the part of Eve that was touched').toBeTruthy();
        expect(text).toContain(`Eve's ${partName}`);
        expect(text, 'a component instance id is not a part name').not.toMatch(/comp-[0-9a-f]{8}/i);
    });
});
