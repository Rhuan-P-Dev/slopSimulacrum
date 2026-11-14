/**
 * CONTRACT TEST — consumable items and the `eat` action, against the real world.
 *
 * Built the way the coal-generator contract builds its world: `buildWorldState(tick)`
 * with the tick not started, real data files through the composition root, no mocks, no
 * network. The bite therefore runs the whole production path:
 *
 *   world.actionController.executeAction('eat', entityId, { itemId | itemType })
 *     → validation (targetingType, requirements, cooldown)
 *       → ConsequenceDispatcher → eatItem → EatConsequenceHandler
 *         → InventoryManager.removeItemFromEntity + setEntityAttributeDelta
 *
 * What this pins that a unit test cannot:
 *   - the DATA is the feature. `apple` / `goldenApple` survive boot (no quarantine)
 *     with the `consume` block intact, and every material their recipe names exists
 *     (`CR DATA-4`);
 *   - the meter the food charges exists on the blueprint the client actually gets
 *     (`DEFAULT_PLAYER_BLUEPRINT`), and the food the client actually spawns with is
 *     edible — a mismatch between those two files is the failure mode this feature
 *     could have shipped with (an apple that eats into a body with no energy meter);
 *   - the amount charged is the amount the item declares, and the ceiling is the
 *     attribute's own `max` in `core-entity-attributes`, never a number in code;
 *   - validation runs BEFORE any consequence, so an action that was never allowed
 *     cannot spend a meal (the ordering is the world's, not this feature's);
 *   - the SHAPE of the answer, where the server and the client meet: `success: true`
 *     on top of an action result means the action was allowed, while a refused meal is
 *     a failed `eatItem` entry inside `results`. `shared/ConsumableOutcome.js` is the
 *     reader the client's Eat button uses, and it is asserted against a real response
 *     here — a shape the client reads wrong is a toast that lies;
 *   - coal stays fuel: an item with no `consume` block is not food, whatever else the
 *     world does with it.
 *
 * The socket broadcast is not asserted here — that is the route's job
 * (`src/routes/actionRoutes.js`); the handler charges with `broadcast: false` and that
 * is pinned in test/unit/EatConsequenceHandler.test.js.
 *
 * @module test/contract/consumables
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { DEFAULT_PLAYER_BLUEPRINT } from '../../shared/Defaults.js';
import { readEatOutcome, EAT_CONSEQUENCE_TYPE } from '../../shared/ConsumableOutcome.js';
import DataLoader from '../../src/utils/DataLoader.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';

const APPLE_GAIN = 15;
const GOLDEN_GAIN = 60;

/**
 * Reads a shipped registry through the boot seam — the same bytes the world is built
 * from, including its `_comment` header (which is why the loops below skip
 * `_`-prefixed keys rather than trusting every entry to be a definition).
 * @param {string} kind
 * @returns {Object}
 */
const registry = (kind) => DataLoader.loadRegistry(kind) ?? {};

/** Builds a fresh world (tick not started) with the real data files. */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world } = buildWorldState(tick);
    return { world, tick };
}

/**
 * Incarnates the client exactly as the socket-connect path does (the same blueprint
 * `SocketLifecycleController._incarnatePlayer` uses).
 * @param {ReturnType<typeof buildWorld>["world"]} world
 */
function incarnateClient(world) {
    const startRoomId = world.roomsController.getUidByLogicalId('start_room');
    const entityId = world.stateEntityController.spawnEntity(DEFAULT_PLAYER_BLUEPRINT, startRoomId);
    return entityId;
}

/** Every item the entity carries, flattened across host components. */
function itemsOf(world, entityId) {
    return Object.values(world.getEntityItems(entityId)).flat();
}

/** Count of carried items of one type. */
function countOf(world, entityId, type) {
    return itemsOf(world, entityId).filter(i => i?.type === type).length;
}

/** The entity's whole-entity meter, or null. */
function statOf(world, entityId, traitId, statName) {
    return world.getEntityAttribute(entityId, traitId, statName);
}

/** Runs the eat action through the full validation path and returns the raw result. */
function eatRaw(world, entityId, params) {
    return world.actionController.executeAction('eat', entityId, params);
}

/**
 * Runs the eat action and returns what the world did with the bite, read through the
 * SAME pure reader the client's Eat button uses (`shared/ConsumableOutcome.js`). The
 * reading, not the top-level flag, is the truth about a meal — see the shape pin below.
 */
function eat(world, entityId, params) {
    return readEatOutcome(eatRaw(world, entityId, params));
}

describe('Consumables survive boot', () => {
    /** @type {{ apple: Object, goldenApple: Object }} */
    let items;
    /** @type {Object} */
    let materials;
    /** @type {Object} */
    let actions;

    beforeAll(() => {
        items = registry(REGISTRY_KINDS.INVENTORY_ITEMS);
        materials = registry(REGISTRY_KINDS.MATERIALS);
        actions = registry(REGISTRY_KINDS.ACTIONS);
    });

    it.each(['apple', 'goldenApple'])('%s declares a consume block on a whole-entity resource', (key) => {
        expect(items[key], `${key} is shipped`).toBeDefined();
        expect(items[key].consume).toMatchObject({ targetStat: 'Physical.energy' });
        expect(items[key].consume.energyGain).toBeGreaterThan(0);
        // The food is small enough to carry: a recipe with no form volume is a
        // definition the spawn path cannot host.
        expect(items[key].form?.volume).toBeGreaterThan(0);
    });

    it('the golden apple is worth more than the apple (the rarer food is rarer)', () => {
        expect(items['goldenApple'].consume.energyGain).toBeGreaterThan(items['apple'].consume.energyGain);
    });

    it('names materials that exist (CR DATA-4)', () => {
        for (const key of ['apple', 'goldenApple']) {
            for (const entry of items[key].materials || []) {
                expect(materials[entry.material], `${key} references material "${entry.material}"`).toBeDefined();
            }
        }
    });

    it('registers the eat action as a self-target, single-consequence action', () => {
        expect(actions['eat']).toBeDefined();
        expect(actions['eat'].targetingType).toBe('self_target');
        expect(actions['eat'].requirements ?? []).toEqual([]);
        // Exactly one consequence does the work; the log line is decoration around it.
        const workers = actions['eat'].consequences.filter(c => c.type === 'eatItem');
        expect(workers).toHaveLength(1);
        expect(workers[0].params).toMatchObject({ itemId: ':itemId', itemType: ':itemType' });
    });
});

describe('The client body can be fed', () => {
    it('the client blueprint seeds the meter the food charges, and spawns with food', () => {
        const { world } = buildWorld();
        const entityId = incarnateClient(world);

        // The meter: seeded, with its declared ceiling (the clamp the bite obeys).
        expect(statOf(world, entityId, 'Physical', 'energy')).toBe(100);
        expect(world.getEntityAttributeConfig(entityId, 'Physical', 'energy'))
            .toMatchObject({ value: 100, max: 100 });

        // The food, from data/mods/core-world/world.json initialSpawns.
        expect(countOf(world, entityId, 'apple'), 'spawns with 2 apples').toBe(2);
        expect(countOf(world, entityId, 'goldenApple'), 'spawns with 1 golden apple').toBe(1);
    });

    it('every consumable in the data charges a meter the client blueprint has', () => {
        // The cross-file contract: an item whose targetStat the client blueprint does
        // not seed would spawn as food that cannot be eaten.
        const { world } = buildWorld();
        const entityId = incarnateClient(world);
        const items = registry(REGISTRY_KINDS.INVENTORY_ITEMS);
        for (const [key, def] of Object.entries(items)) {
            if (key.startsWith('_') || !def?.consume) continue;
            const [traitId, statName] = def.consume.targetStat.split('.');
            expect(
                world.getEntityAttributeConfig(entityId, traitId, statName),
                `${key} targets ${def.consume.targetStat}, which the client blueprint does not seed`
            ).toBeTruthy();
        }
    });

    it('a validation-level refusal never reaches the bite', () => {
        // The order matters and is not this feature's choice: validation runs before
        // any consequence, so an action that was never allowed spends nothing. An actor
        // that does not exist is the cheapest way to prove the gate holds — the meal,
        // if it ran, would have nowhere to be eaten.
        const { world } = buildWorld();
        const raw = eatRaw(world, 'ent-no-such-actor', { itemType: 'apple' });
        expect(raw.success).toBe(false);
        expect(readEatOutcome(raw)).toMatchObject({ success: false, refused: true });
    });
});

describe('The shape of the answer', () => {
    it('a refused meal is a consequence-level NO, not a validation failure', () => {
        // THE cross-boundary pin. `executeAction` reports `success: true` once the
        // action was VALID; what happened rides in `results`, one entry per
        // consequence. So "already full" is a 200 with `success: true` on top and a
        // failed `eatItem` underneath. Anything reading only the top-level flag — the
        // client, a future caller — would report a meal that never happened. This is
        // where the server's shape and the client's reader (`shared/ConsumableOutcome`)
        // meet, which is why the assertion is here and not in a unit test.
        const { world } = buildWorld();
        const entityId = incarnateClient(world);
        expect(statOf(world, entityId, 'Physical', 'energy')).toBe(100);

        const raw = eatRaw(world, entityId, { itemType: 'apple' });
        const bite = (raw.results ?? []).find(r => r?.type === EAT_CONSEQUENCE_TYPE);

        expect(raw.success, 'the action itself was allowed').toBe(true);
        expect(bite, 'the bite answered').toBeTruthy();
        expect(bite.success, 'and said no').toBe(false);
        expect(bite.message).toMatch(/full Physical\.energy/);
        // The reader the client uses agrees with the world, not with the top-level flag.
        expect(readEatOutcome(raw)).toMatchObject({ success: false, refused: true });
        expect(countOf(world, entityId, 'apple'), 'nothing was spent').toBe(2);
    });
});

describe('Eating spends the item and charges the meter', () => {
    it('charges the declared amount onto Physical.energy and removes the item', () => {
        const { world } = buildWorld();
        const entityId = incarnateClient(world);
        world.setEntityAttributeDelta(entityId, 'Physical', 'energy', -30); // 100 -> 70
        const apple = itemsOf(world, entityId).find(i => i.type === 'apple');

        const result = eat(world, entityId, { itemId: apple.id });

        expect(result.success, result.message).toBe(true);
        expect(statOf(world, entityId, 'Physical', 'energy')).toBe(70 + APPLE_GAIN);
        expect(countOf(world, entityId, 'apple'), 'one apple spent').toBe(1);
    });

    it('eats by itemType when no instance id is given (the agent path)', () => {
        const { world } = buildWorld();
        const entityId = incarnateClient(world);
        world.setEntityAttributeDelta(entityId, 'Physical', 'energy', -50);

        const result = eat(world, entityId, { itemType: 'apple' });

        expect(result.success, result.message).toBe(true);
        expect(statOf(world, entityId, 'Physical', 'energy')).toBe(50 + APPLE_GAIN);
        expect(countOf(world, entityId, 'apple'), 'one instance spent, not both').toBe(1);
    });

    it('the golden apple charges the amount it declares', () => {
        const { world } = buildWorld();
        const entityId = incarnateClient(world);
        world.setEntityAttributeDelta(entityId, 'Physical', 'energy', -80); // 100 -> 20

        const result = eat(world, entityId, { itemType: 'goldenApple' });

        expect(result.success, result.message).toBe(true);
        expect(statOf(world, entityId, 'Physical', 'energy')).toBe(20 + GOLDEN_GAIN);
        expect(countOf(world, entityId, 'goldenApple')).toBe(0);
    });

    it('clamps at the attribute\'s declared maximum and reports what was actually gained', () => {
        const { world } = buildWorld();
        const entityId = incarnateClient(world);
        world.setEntityAttributeDelta(entityId, 'Physical', 'energy', -5); // 100 -> 95

        const result = eat(world, entityId, { itemType: 'goldenApple' });

        expect(result.success, result.message).toBe(true);
        expect(statOf(world, entityId, 'Physical', 'energy'), 'never above the declared max').toBe(100);
        expect(countOf(world, entityId, 'goldenApple'), 'the meal was still spent').toBe(0);
    });

    it('keeps draining between rounds: a meal is a refill, not immunity', () => {
        // The rule that makes food matter: the meter drains per turn, so what is eaten
        // is bounded by the drain (the death loop itself is energyFlow's contract).
        const { world } = buildWorld();
        const entityId = incarnateClient(world);
        const config = world.getEntityAttributeConfig(entityId, 'Physical', 'energy');
        expect(config.drainPerTurn).toBeGreaterThan(0);
        expect(APPLE_GAIN * 2).toBeLessThan(config.max);
    });
});

describe('Eating what is not food', () => {
    it('refuses an item that declares no consume block — coal is fuel, not food', () => {
        const { world } = buildWorld();
        const entityId = incarnateClient(world);
        world.setEntityAttributeDelta(entityId, 'Physical', 'energy', -40);

        const result = eat(world, entityId, { itemType: 'coal' });

        expect(result.success, 'coal has no consume block').toBe(false);
        expect(statOf(world, entityId, 'Physical', 'energy'), 'nothing charged').toBe(60);
        expect(countOf(world, entityId, 'coal'), 'the fuel is still aboard').toBe(10);
    });

    it('refuses at full energy and spends nothing', () => {
        const { world } = buildWorld();
        const entityId = incarnateClient(world);
        expect(statOf(world, entityId, 'Physical', 'energy')).toBe(100);

        const result = eat(world, entityId, { itemType: 'goldenApple' });

        expect(result.success).toBe(false);
        expect(statOf(world, entityId, 'Physical', 'energy')).toBe(100);
        expect(countOf(world, entityId, 'goldenApple'), 'a full body keeps the meal').toBe(1);
    });

    it('refuses to eat something the entity does not carry', () => {
        const { world } = buildWorld();
        const entityId = incarnateClient(world);
        world.setEntityAttributeDelta(entityId, 'Physical', 'energy', -40);

        const result = eat(world, entityId, { itemId: 'item-does-not-exist' });

        expect(result.success).toBe(false);
        expect(statOf(world, entityId, 'Physical', 'energy')).toBe(60);
    });

    it('a body with no energy meter is told so, and keeps the food', () => {
        // A real shipped shape, not a hypothetical: only m1Droid / maleDroid /
        // femaleDroid seed entity attributes at all, so every other blueprint
        // (smallBallDroid, merchantDroid, killerLlmDrone, tree…) has nothing to
        // charge. Such a body holding an apple must be refused, not told it ate — and
        // the apple must survive, because a refused meal costs nothing.
        const { world } = buildWorld();
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
        expect(statOf(world, entityId, 'Physical', 'energy'), 'this body has no meter').toBeNull();

        // The loadout in world.json is applied to every spawn, so this body already
        // holds the food its blueprint cannot use — the situation this refusal exists
        // for. Stow one more and watch that nothing is spent (counts are relative,
        // because how many the loadout managed to fit is not this test's subject).
        const stowedBefore = countOf(world, entityId, 'apple');
        const body = world.stateEntityController.getEntity(entityId).components[0];
        const add = world.addItemToEntity(entityId, 'apple', body.id);
        expect(add.success, `stowage failed: ${add.message}`).toBe(true);

        const result = eat(world, entityId, { itemType: 'apple' });

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/no Physical\.energy to charge/);
        expect(countOf(world, entityId, 'apple'), 'every apple is still aboard').toBe(stowedBefore + 1);
    });
});

describe('The eat the round has scheduled (the mode the client plays in)', () => {
    /*
     * Everything above is real-time: `actionController.executeAction` runs the bite now.
     * The browser's default is the opposite — `ActionManager` sends `queueForRound: true`
     * in Turn mode, and the route answers with an ACK:
     * `{ success: true, queued: true, queueId, queue }` (src/routes/actionRoutes.js). The
     * two answers are one frame apart on the wire and worlds apart in meaning, and the
     * message that got them confused is what brought this describe into existence: it
     * told the player "the world ran the eat action without eating anything" over a
     * request the queue had just ACCEPTED. Pinned here against the real queue — the ack
     * reads as scheduled, nothing is spent while it is only a plan, and the resolution
     * really does spend the apple the toast promised.
     */

    /** Ids of the items of one type the entity carries. */
    const carrying = (world, entityId, type) => itemsOf(world, entityId)
        .filter((item) => item?.type === type)
        .map((item) => item.id);

    /**
     * The world in Turn mode: the turn system initialised, the client entities carrying
     * the loadout their spawn gives them (2 apples, 1 golden apple), and the NPCs out of
     * the roster so the barrier closes when we signal — the same determinism trick
     * `test/contract/actionProse.contract.test.js` uses. The tick is stepped by hand: no
     * wall-clock timer, no flaky round boundary.
     * @returns {{ world: Object, clients: Array, step: (n: number) => void }}
     */
    function buildScheduledWorld() {
        const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
        const { worldStateController: world } = buildWorldState(tick);
        world.turnSystemController.initialize();
        const actor = incarnateClient(world); // the client body, with its spawn loadout
        Object.values(world.stateEntityController.entities ?? {})
            .filter((entity) => entity.isNPC === true)
            .forEach((npc) => world.despawnEntity(npc.id));
        const step = (targetTick) => {
            tick.currentTick = targetTick;
            world.turnSystemController.onTick();
        };
        step(0); // round 0 opens, with its roster
        return { world, actor, step };
    }

    /** Signal every planner in this round's roster — which is what closes the barrier. */
    const signalAll = (world) => {
        for (const actor of world.turnSystemController.getRoundState().actorOrder ?? []) {
            world.turnSystemController.signalPlanComplete(actor.entityId, 'player');
        }
    };

    it('answers an ACK that is neither a meal nor a refusal, and spends nothing', () => {
        const { world, actor } = buildScheduledWorld();
        expect(countOf(world, actor, 'apple'), 'the client body carries its two apples').toBe(2);
        const appleId = carrying(world, actor, 'apple')[0];

        const queued = world.turnSystemController.queueAction(actor, 'eat', { itemId: appleId }, 'player');
        expect(queued.success, queued.error).toBe(true);

        // The route's forwarding of that queue result — the JSON the browser receives.
        const ack = { success: true, queued: true, queueId: queued.queueId, queue: queued.queue };
        expect(readEatOutcome(ack)).toEqual({ success: false, queued: true, message: null, refused: false });

        // And the ack is HONEST: nothing has happened yet. The apple is still in the pack
        // and the meter has not moved — which is why the panel may not repaint a meal,
        // and may not claim the world failed to eat either.
        expect(carrying(world, actor, 'apple')).toContain(appleId);
        expect(statOf(world, actor, 'Physical', 'energy')).toBe(100);
    });

    it('the round resolves it: the apple is spent and the meter moved', () => {
        const { world, actor, step } = buildScheduledWorld();
        const appleId = carrying(world, actor, 'apple')[0];
        // Tired first. A spawn body is at full energy, where the rule refuses the meal —
        // and a refused resolution would look exactly like an unresolved one from here.
        world.setEntityAttributeDelta(actor, 'Physical', 'energy', -60);

        world.turnSystemController.queueAction(actor, 'eat', { itemId: appleId }, 'player');
        expect(statOf(world, actor, 'Physical', 'energy'), 'still 40 while queued').toBe(40);

        signalAll(world);
        for (let tickNumber = 1; tickNumber <= 4; tickNumber += 1) step(tickNumber);

        // "Scheduled" was a promise, and this is it kept: one apple gone, and the body
        // charged. The arithmetic is the world's own: 40 + 15 (the apple) - 1 (the round's
        // own drain on this meter) = 54. A resolution that never ran would leave 39, and a
        // refused one (a full meter) would too — which is why the meter is read here and
        // not just the item count.
        expect(carrying(world, actor, 'apple').length).toBe(1);
        expect(statOf(world, actor, 'Physical', 'energy')).toBe(54);
    });
});
