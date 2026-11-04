/**
 * roundProse contract tests — the "give me a round, give me prose" surface
 * (wiki/subMDs/systems/round_prose_system.md).
 *
 * Runs a full event-driven round on a real built world: perception flush (the
 * ring), barrier close (the round window), reader assembly, and the
 * express/fetch wire shape. The recipe mirrors turnBarrier.test.js: a fresh
 * buildWorldState(tick) with an un-started tick system, the tick advanced
 * EXPLICITLY before each onTick() (tests drive the tick clock — the turn
 * controller never advances it), a world pinned to a single planner (all NPCs
 * despawned, so round-start roster = [test droid]), and
 * `turns.signalPlanComplete(droid, 'player')` as the deterministic all-ready
 * close trigger. The droid gets a fixed name so prose is comparable across
 * builds (determinism test). Range tests (9-11) reuse the 502-round eviction
 * loop to put an evicted gap inside an otherwise-observed range, and drive
 * the new /perception/rounds/:from/:to wire shape. The last block reads ONE
 * ENTITY per round (/perception/round/:roundNumber/byEntity/:entityId): the
 * rows that name it, including a real cross-room move — which lands in two
 * rooms' rings, so it is the case a single-room read would silently halve.
 *
 * @module test/contract/roundProse
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { register as registerPerceptionRoutes } from '../../src/routes/perceptionRoutes.js';

/**
 * Fresh world: one test droid + an explicit crafter NPC (roster pin from
 * turnBarrier). All NPCs are despawned before use so the round-start roster
 * is exactly [test droid] — a single planner, close is deterministic via
 * signalPlanComplete.
 */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world, subControllers } = buildWorldState(tick);
    const startRoomId = world.roomsController.getUidByLogicalId('start_room');
    const entityId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId, {
        name: 'Test Droid'
    });
    world.stateEntityController.spawnEntity('crafterDrone', startRoomId, {
        isNPC: true,
        name: 'Crafter Drone',
        npcConfig: {
            displayName: 'Crafter Drone',
            personality: 'A tireless field-fabrication drone that forges knives.'
        }
    });
    Object.values(world.stateEntityController.entities)
        .filter((e) => e.isNPC === true)
        .forEach((npc) => world.despawnEntity(npc.id));
    return { world, tick, turns: subControllers.turnSystemController, entityId, startRoomId };
}

/**
 * Advances the tick and runs the tick duties (the test-mode recipe from
 * turnBarrier: `tick.currentTick = N; turns.onTick();`). The tick object is
 * an external clock — not held by the facade.
 */
function stepToTick(world, tick, targetTick) {
    tick.currentTick = targetTick;
    world.turnSystemController.onTick();
}

/** First move-capable component of the entity (a valid selfHeal target). */
function aMoveComponentId(world, entityId) {
    const entity = world.stateEntityController.getEntity(entityId);
    const moveComp = entity.components.find((c) => {
        const stats = world.getComponentStats(c.id);
        return typeof stats?.Movement?.move === 'number' && stats.Movement.move > 0;
    });
    return moveComp?.id ?? null;
}

/**
 * Lazy round 0 start (tick 0), a queued selfHeal (executes on resolution),
 * and the droid's plan-complete signal -> all-ready close at tick 0. Asserts
 * the close contract.
 */
function closeRound0(world, tick, entityId) {
    const turns = world.turnSystemController;
    stepToTick(world, tick, 0);
    const head = aMoveComponentId(world, entityId);
    turns.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
    const sig = turns.signalPlanComplete(entityId, 'player');
    expect(sig.success).toBe(true);
    expect(sig.closed).toBe(true);
    expect(turns.getRoundState().phase).toBe('resolution');
    expect(turns.getRoundState().currentTick).toBe(0);
    expect(turns.getRoundState().barrier.closedAtTick).toBe(0);
}

describe('Round-prose reader (wiki/subMDs/systems/round_prose_system.md)', () => {
    it('1. a live round reports live: true with endTick at the current tick; ticking advances the window, not the prose', () => {
        const { world, tick } = buildWorld();
        const reader = world.roundProseController;
        stepToTick(world, tick, 0); // lazy round 0 start (tick 0)
        const live = reader.getRoundProse(0);
        expect(live).toBeTruthy();
        expect(live.round).toBe(0);
        expect(live.live).toBe(true);
        expect(live.startTick).toBe(0);
        expect(live.endTick).toBe(0);
        expect(live.entryCount).toBeGreaterThan(0);
        expect(live.summary).toMatch(/^Round 0 \(ticks 0 to 0\) is still planning/);
        // A later tick while still planning advances the window but adds no
        // entry (nothing mutated).
        stepToTick(world, tick, 1);
        const live2 = reader.getRoundProse(0);
        expect(live2.live).toBe(true);
        expect(live2.startTick).toBe(0);
        expect(live2.endTick).toBe(1);
        expect(live2.entryCount).toBe(live.entryCount);
    });

    it('2. a closed round reads as a baseline paragraph: round 0 prose = the room baseline (1 entry)', () => {
        const { world, tick, entityId, startRoomId } = buildWorld();
        const reader = world.roundProseController;
        closeRound0(world, tick, entityId);
        const round0 = reader.getRoundProse(0);
        expect(round0).toBeTruthy();
        expect(round0.live).toBe(false);
        expect(round0.startTick).toBe(0);
        expect(round0.endTick).toBe(0);
        const room = round0.rooms[startRoomId];
        expect(room).toBeTruthy();
        expect(room.name).toBeTruthy();
        expect(room.entryCount).toBe(1); // single baseline entry (read happened after resolution)
        expect(round0.entryCount).toBe(Object.values(round0.rooms).reduce((sum, r) => sum + r.entryCount, 0));
        expect(room.text.length).toBeGreaterThan(0);
        expect(room.text.endsWith('.')).toBe(true);
        expect(room.text.toLowerCase().includes('initial observation')).toBe(true);
        expect(round0.summary).toBe(
            `Round 0 (ticks 0 to 0) recorded ${round0.entryCount} observable change${round0.entryCount === 1 ? '' : 's'} across ${Object.keys(round0.rooms).length} room${Object.keys(round0.rooms).length === 1 ? '' : 's'}.`
        );
    });

    it('3. re-reading a closed round is idempotent; round 1 carries only its own tick-scoped entries', () => {
        const { world, tick, entityId, startRoomId } = buildWorld();
        const reader = world.roundProseController;
        closeRound0(world, tick, entityId);
        const round0a = reader.getRoundProse(0);
        // Advance to round 1 (tick 1), second selfHeal, close all-ready.
        stepToTick(world, tick, 1);
        const head = aMoveComponentId(world, entityId);
        world.turnSystemController.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
        const sig = world.turnSystemController.signalPlanComplete(entityId, 'player');
        expect(sig.success).toBe(true);
        expect(sig.closed).toBe(true);
        expect(reader.getRoundProse(0).summary).toBe(round0a.summary);
        expect(reader.getRoundProse(0).rooms[startRoomId].text).toBe(round0a.rooms[startRoomId].text);
        const round1 = reader.getRoundProse(1);
        expect(round1).toBeTruthy();
        expect(round1.live).toBe(false);
        expect(round1.startTick).toBe(1);
        expect(round1.endTick).toBe(1);
        expect(round1.entryCount).toBeGreaterThan(0);
        // Round-0 entries (tick 0) must not leak into round 1 (tick 1).
        expect(round1.rooms[startRoomId].entryCount).toBe(1);
        expect(round1.rooms[startRoomId].text.toLowerCase().includes('stat change')).toBe(true);
    });

    it('4. two identically driven worlds produce byte-identical prose (determinism)', () => {
        const makeProse = () => {
            const { world, tick, entityId, startRoomId } = buildWorld();
            const reader = world.roundProseController;
            reader.getRoundProse(0); // live read, then close (same as a client would see)
            closeRound0(world, tick, entityId);
            return { prose: reader.getRoundProse(0), startRoomId };
        };
        const [a, b] = [makeProse(), makeProse()];
        expect(a.prose.summary).toBe(b.prose.summary);
        expect(a.prose.entryCount).toBe(b.prose.entryCount);
        expect(a.prose.startTick).toBe(b.prose.startTick);
        expect(a.prose.endTick).toBe(b.prose.endTick);
        expect(a.prose.rooms[a.startRoomId].text).toBe(b.prose.rooms[b.startRoomId].text);
        expect(a.prose.rooms[a.startRoomId].text.length).toBeGreaterThan(0);
    });

    it('5. unknown, out-of-range, or not-yet-started rounds resolve to null (reader)', () => {
        const { world, tick, entityId, startRoomId } = buildWorld();
        const reader = world.roundProseController;
        expect(reader.getRoundProse(0)).toBeNull(); // before the first tick: no round started
        closeRound0(world, tick, entityId);
        expect(reader.getRoundProse(999)).toBeNull();
        expect(reader.getRoundProse(-1)).toBeNull();
        expect(reader.getRoundProse(2)).toBeNull();
        expect(reader.getRoomProse(startRoomId, 999)).toBeNull();
        expect(reader.getRoomProse(startRoomId, 2)).toBeNull();
        expect(reader.getRoomProse('does-not-exist', 0)).toBeNull();
    });

    it('6. wire shape (express/fetch): 200 prose, 400 malformed, 404 unknown, 503 unwired, existing endpoints intact', async () => {
        const { world, tick, entityId, startRoomId } = buildWorld();
        closeRound0(world, tick, entityId);
        const router = express.Router();
        registerPerceptionRoutes(router, { worldStateController: world });
        const app = express().use(router);
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        const port = server.address().port;
        const url = (path) => `http://localhost:${port}${path}`;
        try {
            // Full-round prose.
            const full = await fetch(url('/perception/round/0'));
            expect(full.status).toBe(200);
            const fullBody = await full.json();
            expect(fullBody.success).toBe(true);
            expect(fullBody.round).toBe(0);
            expect(fullBody.live).toBe(false);
            expect(fullBody.startTick).toBe(0);
            expect(fullBody.endTick).toBe(0);
            expect(fullBody.entryCount).toBeGreaterThan(0);
            expect(fullBody.summary).toMatch(/^Round 0 \(ticks 0 to 0\) recorded/);
            const room = fullBody.rooms[startRoomId];
            expect(room).toBeTruthy();
            expect(room.text.length).toBeGreaterThan(0);
            expect(room.text.endsWith('.')).toBe(true);

            // By-room prose.
            const byRoom = await fetch(url('/perception/round/0/byRoom/start_room'));
            expect(byRoom.status).toBe(200);
            const byRoomBody = await byRoom.json();
            expect(byRoomBody.success).toBe(true);
            expect(byRoomBody.round).toBe(0);
            expect(byRoomBody.roomId).toBe('start_room');
            expect(byRoomBody.room).toBeTruthy();
            expect(byRoomBody.entryCount).toBeGreaterThan(0);
            expect(byRoomBody.text.endsWith('.')).toBe(true);

            // Malformed round -> 400.
            const malformed = await fetch(url('/perception/round/-3'));
            expect(malformed.status).toBe(400);
            expect((await malformed.json()).message).toMatch(/Invalid round number/);

            // Unknown round -> 404.
            const unknown = await fetch(url('/perception/round/999'));
            expect(unknown.status).toBe(404);
            expect((await unknown.json()).message).toMatch(/Round 999/);

            // Unknown room -> 404.
            const badRoom = await fetch(url('/perception/round/0/byRoom/does-not-exist'));
            expect(badRoom.status).toBe(404);
            expect((await badRoom.json()).message).toBe('Room "does-not-exist" not found in the world.');

            // Existing room endpoint untouched.
            const legacy = await fetch(url(`/perception/${startRoomId}`));
            expect(legacy.status).toBe(200);
            const legacyBody = await legacy.json();
            expect(legacyBody.success).toBe(true);
            expect(Array.isArray(legacyBody.deltas)).toBe(true);
        } finally {
            server.close();
        }
    });

    it('7. unwired reader -> 503', async () => {
        const { world } = buildWorld();
        world.roundProseController = null;
        const router = express.Router();
        registerPerceptionRoutes(router, { worldStateController: world });
        const app = express().use(router);
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const res = await fetch(`http://localhost:${server.address().port}/perception/round/0`);
            expect(res.status).toBe(503);
            expect((await res.json()).error).toBe('Round prose reader is not available.');
        } finally {
            server.close();
        }
    });

    it('8. rounds beyond the in-memory horizon resolve to null (eviction)', () => {
        const { world, tick, entityId } = buildWorld();
        const reader = world.roundProseController;
        const head = aMoveComponentId(world, entityId);
        for (let r = 0; r <= 501; r++) {
            stepToTick(world, tick, r);
            world.turnSystemController.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
            const sig = world.turnSystemController.signalPlanComplete(entityId, 'player');
            expect(sig.success).toBe(true);
        }
        expect(reader.getRoundProse(0)).toBeNull(); // evicted (502 rounds > 500 horizon)
        expect(reader.getRoundProse(1)).toBeNull(); // evicted
        const round2 = reader.getRoundProse(2);
        expect(round2).toBeTruthy();
        expect(round2.startTick).toBe(2);
        expect(round2.endTick).toBe(2);
        expect(round2.summary).toBe('Round 2 (ticks 2 to 2) passed with no observable changes.');
        const last = reader.getRoundProse(501);
        expect(last).toBeTruthy();
        expect(last.startTick).toBe(501);
        expect(last.endTick).toBe(501);
        expect(last.summary).toBe('Round 501 (ticks 501 to 501) recorded 1 observable change across 1 room.');
    });

    it('9. range reader: one row per requested round, observed:false for evicted gaps, single-round shape when observed', () => {
        const { world, tick, entityId } = buildWorld();
        const reader = world.roundProseController;
        const head = aMoveComponentId(world, entityId);
        // Close 502 rounds (0..501) so the in-memory horizon (500) evicts
        // rounds 0 and 1 while 2..501 stay reachable - the reader's exact
        // eviction horizon, same recipe as test 8.
        for (let r = 0; r <= 501; r++) {
            stepToTick(world, tick, r);
            world.turnSystemController.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
            const sig = world.turnSystemController.signalPlanComplete(entityId, 'player');
            expect(sig.success).toBe(true);
        }
        // Fully evicted range -> observed:false rows only, in request order.
        const evicted = reader.getRoundRangeProse(0, 1);
        expect(evicted).toBeTruthy();
        expect(evicted.from).toBe(0);
        expect(evicted.to).toBe(1);
        expect(evicted.rounds).toEqual([
            { round: 0, observed: false },
            { round: 1, observed: false }
        ]);
        // Mixed range: two evicted + two observed rows; observed rows carry
        // the exact single-round shape (rounds 2/3 kept no perception ring
        // entries, so their prose is the deterministic 'no observable changes'
        // line).
        const mixed = reader.getRoundRangeProse(0, 3);
        expect(mixed.rounds).toHaveLength(4);
        expect(mixed.rounds[0]).toEqual({ round: 0, observed: false });
        expect(mixed.rounds[1]).toEqual({ round: 1, observed: false });
        expect(mixed.rounds[2]).toEqual({
            round: 2,
            observed: true,
            live: false,
            startTick: 2,
            endTick: 2,
            summary: 'Round 2 (ticks 2 to 2) passed with no observable changes.',
            entryCount: 0,
            rooms: {}
        });
        expect(mixed.rounds[3]).toEqual({
            round: 3,
            observed: true,
            live: false,
            startTick: 3,
            endTick: 3,
            summary: 'Round 3 (ticks 3 to 3) passed with no observable changes.',
            entryCount: 0,
            rooms: {}
        });
    });

    it('10. range reader: live row stays live:true with endTick at read time; pre-start reads report the round unobserved', () => {
        const { world, tick } = buildWorld();
        const reader = world.roundProseController;
        // Before the first tick no window exists: the requested row is unobserved.
        expect(reader.getRoundRangeProse(0, 0).rounds).toEqual([{ round: 0, observed: false }]);
        // Lazy round-0 start: observed live row, unobserved row for round 1.
        stepToTick(world, tick, 0);
        const range = reader.getRoundRangeProse(0, 1);
        expect(range).toBeTruthy();
        expect(range.rounds).toHaveLength(2);
        const live = range.rounds[0];
        expect(live.round).toBe(0);
        expect(live.observed).toBe(true);
        expect(live.live).toBe(true);
        expect(live.startTick).toBe(0);
        expect(live.endTick).toBe(0);
        expect(live.entryCount).toBeGreaterThan(0);
        expect(live.summary).toMatch(/^Round 0 \(ticks 0 to 0\) is still planning/);
        expect(live.rooms).toBeTruthy();
        expect(range.rounds[1]).toEqual({ round: 1, observed: false });
        // A later tick while planning advances the live window
        // (endTick = current tick as of the read, same as the single-round API).
        stepToTick(world, tick, 1);
        expect(reader.getRoundRangeProse(0, 0).rounds[0].endTick).toBe(1);
    });

    it('11. range wire shape (express/fetch): 200 range with evicted gap, 400 on bad bounds/current round, 503 unwired, existing endpoints intact', async () => {
        const { world, tick, entityId } = buildWorld();
        const head = aMoveComponentId(world, entityId);
        // Evict rounds 0 and 1 (close 0..501, same recipe as test 9) so a
        // 200 range can show an evicted gap inside observed rounds.
        for (let r = 0; r <= 501; r++) {
            stepToTick(world, tick, r);
            world.turnSystemController.queueAction(entityId, 'selfHeal', { targetComponentId: head }, 'player');
            const sig = world.turnSystemController.signalPlanComplete(entityId, 'player');
            expect(sig.success).toBe(true);
        }
        const router = express.Router();
        registerPerceptionRoutes(router, { worldStateController: world });
        const app = express().use(router);
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        const port = server.address().port;
        const url = (path) => `http://localhost:${port}${path}`;
        try {
            // 200: 501 rows (rounds 1..501) - round 1 evicted (observed:false),
            // round 2 observed with its deterministic no-change prose, round 501
            // observed with its own entry (same shape as test 8's single read).
            const gap = await fetch(url('/perception/rounds/1/501'));
            expect(gap.status).toBe(200);
            const gapBody = await gap.json();
            expect(gapBody.success).toBe(true);
            expect(gapBody.from).toBe(1);
            expect(gapBody.to).toBe(501);
            expect(gapBody.rounds).toHaveLength(501);
            expect(gapBody.rounds[0]).toEqual({ round: 1, observed: false });
            expect(gapBody.rounds[1]).toEqual({
                round: 2,
                observed: true,
                live: false,
                startTick: 2,
                endTick: 2,
                summary: 'Round 2 (ticks 2 to 2) passed with no observable changes.',
                entryCount: 0,
                rooms: {}
            });
            expect(gapBody.rounds[500].round).toBe(501);
            expect(gapBody.rounds[500].observed).toBe(true);
            expect(gapBody.rounds[500].summary).toBe(
                'Round 501 (ticks 501 to 501) recorded 1 observable change across 1 room.'
            );
            // 400: out-of-order bounds.
            const badOrder = await fetch(url('/perception/rounds/500/1'));
            expect(badOrder.status).toBe(400);
            expect((await badOrder.json()).message).toBe('from (500) is greater than to (1).');
            // 400: to beyond the current round (501), message names it.
            const beyond = await fetch(url('/perception/rounds/500/502'));
            expect(beyond.status).toBe(400);
            expect((await beyond.json()).message).toBe('to (502) exceeds the current round (501).');
            // 400: malformed bounds.
            const malformed = await fetch(url('/perception/rounds/-3/500'));
            expect(malformed.status).toBe(400);
            expect((await malformed.json()).message).toBe('from and to must be non-negative integers.');
            // 200: single-row range.
            const single = await fetch(url('/perception/rounds/501/501'));
            expect(single.status).toBe(200);
            const singleBody = await single.json();
            expect(singleBody.rounds).toHaveLength(1);
            expect(singleBody.rounds[0].round).toBe(501);
            // Existing single-round endpoints stay intact.
            const full = await fetch(url('/perception/round/501'));
            expect(full.status).toBe(200);
            expect((await full.json()).round).toBe(501);
            const byRoom = await fetch(url('/perception/round/501/byRoom/start_room'));
            expect(byRoom.status).toBe(200);
            // 503: unwired reader.
            world.roundProseController = null;
            const unwired = await fetch(url('/perception/rounds/500/501'));
            expect(unwired.status).toBe(503);
            expect((await unwired.json()).error).toBe('Round prose reader is not available.');
        } finally {
            server.close();
        }
    });
});

// =========================================================================
// ONE ENTITY PER ROUND — RoundProseController.getEntityProse and
// GET /perception/round/:roundNumber/byEntity/:entityId on a real built world.
// The unit level (test/unit/RoundProseController.entity.test.js) pins the row
// selection with a stub; this level pins it against the rows the world actually
// writes, and against a real cross-room move: the round diff sees the droid
// LEAVE one room and APPEAR in the other, so its paragraph is assembled from
// two rings, in the world's room order (room ids are generated per build, so
// they cannot sort ties), and against what perception itself records: a room
// that has never been observed reports its contents as a BASELINE, which is the
// room's state description and therefore never one entity's paragraph.
// =========================================================================

/**
 * Round 0 closed (baseline only), then round 1: the droid heals itself, and —
 * when `move` is set — the world itself relocates it to the corridor
 * (`stateEntityController.moveEntity`, the call a door traversal makes) before
 * the round resolves. Tests drive the tick clock; nothing here fakes world
 * state.
 * @returns {{ world: Object, tick: Object, entityId: string, startRoomId: string,
 *   reader: Object, fromRoomId: string, toRoomId: string|null }}
 */
function runRound1({ move = false } = {}) {
    const ctx = buildWorld();
    const { world, tick, entityId } = ctx;
    closeRound0(world, tick, entityId);
    stepToTick(world, tick, 1);
    const fromRoomId = world.stateEntityController.getEntity(entityId).location;
    const toRoomId = move ? world.roomsController.getUidByLogicalId('right_room') : null;
    if (move) {
        world.stateEntityController.moveEntity(entityId, toRoomId, { spatial: { x: 3, y: 4 } });
    }
    const target = aMoveComponentId(world, entityId);
    world.turnSystemController.queueAction(entityId, 'selfHeal', { targetComponentId: target }, 'player');
    const sig = world.turnSystemController.signalPlanComplete(entityId, 'player');
    expect(sig.closed).toBe(true);
    return { ...ctx, reader: world.roundProseController, fromRoomId, toRoomId };
}

describe('Round-prose reader — one entity (byEntity)', () => {
    it('E1. round 0 is a baseline: the room has a paragraph, the entity has none', () => {
        const { world, tick, entityId, startRoomId } = buildWorld();
        const reader = world.roundProseController;
        closeRound0(world, tick, entityId);

        const room = reader.getRoomProse(startRoomId, 0);
        expect(room.entryCount).toBe(1); // the room's baseline entry
        expect(room.text.toLowerCase()).toContain('initial observation');

        const prose = reader.getEntityProse(entityId, 0);
        expect(prose).toMatchObject({
            round: 0,
            live: false,
            startTick: 0,
            endTick: 0,
            entityId,
            entity: 'Test Droid'
        });
        // A baseline describes the ROOM; it is never one entity's prose.
        expect(prose.entryCount).toBe(0);
        expect(prose.text).toBe('');
        expect(prose.room).toBe(room.room);
    });

    it('E2. an entity paragraph says what it did — and carries no room atmosphere', () => {
        const { reader, entityId } = runRound1();

        const prose = reader.getEntityProse(entityId, 1);

        expect(prose.round).toBe(1);
        expect(prose.live).toBe(false);
        expect(prose.startTick).toBe(1);
        expect(prose.endTick).toBe(1);
        expect(prose.entity).toBe('Test Droid');
        expect(prose.room).toBe('The Entrance Hall');
        expect(prose.entryCount).toBe(1);
        expect(prose.text).toContain('Test Droid healed itself');
        expect(prose.text.endsWith('.')).toBe(true);
        // Deterministic like the room prose: no raw ids in the text.
        expect(prose.text).not.toContain(entityId);
        // Atmosphere belongs to the room, never to an entity: light / fog /
        // temperature have no delta rows, so they cannot reach this paragraph.
        expect(prose.text).not.toMatch(/humidity|temperature|light|fog|air/i);
        // And no room framing ("In The Entrance Hall, …").
        expect(prose.text.startsWith('In ')).toBe(false);
    });

    it('E3. the entity read is not pinned to the room the entity stands in now', () => {
        const { reader, entityId, fromRoomId, toRoomId } = runRound1({ move: true });

        const prose = reader.getEntityProse(entityId, 1);

        // The droid now stands in the corridor...
        expect(prose.room).toBe('The Eastern Corridor');
        // ...and its paragraph still carries the DEPARTURE, which lives in the
        // ring of the room it left. A read scoped to the current room would have
        // found nothing of it.
        expect(prose.text).toContain('Test Droid left the room');
        expect(reader.getRoomProse(fromRoomId, 1).text).toContain('Test Droid left the room');
        // The corridor saw the droid only as part of its FIRST observation — a
        // baseline, which describes the ROOM, not an arrival. So that half is
        // not in the entity paragraph (pinned at unit level as well), and the
        // one entry that contributed is the room it left.
        expect(reader.getRoomProse(toRoomId, 1).text.toLowerCase()).toContain('initial observation');
        expect(prose.entryCount).toBe(1);
        expect(prose.text).not.toContain('appeared in the room');
    });

    it('E3b. movement inside a room is the entity\'s own sentence — and leaks no room uid', () => {
        const { world, tick, entityId } = buildWorld();
        closeRound0(world, tick, entityId);
        const reader = world.roundProseController;
        stepToTick(world, tick, 1);
        const here = world.stateEntityController.getEntity(entityId).location;
        world.stateEntityController.moveEntity(entityId, here, { spatial: { x: 12, y: 9 } });
        world.turnSystemController.queueAction(entityId, 'selfHeal', { targetComponentId: aMoveComponentId(world, entityId) }, 'player');
        expect(world.turnSystemController.signalPlanComplete(entityId, 'player').closed).toBe(true);

        const prose = reader.getEntityProse(entityId, 1);

        // The round's `moved` row is the entity's own line, coordinates included.
        expect(prose.text).toContain('Test Droid moved');
        expect(prose.text).toContain('(12.00, 9.00)');
        // Room rows reference rooms by uid; a uid is never prose (and room uids
        // are generated per build, so echoing one would break determinism too).
        expect(prose.text).not.toContain(here);
    });

    it('E4. an entity no row names, and an entity that is gone', () => {
        const { world, reader, entityId } = runRound1();

        // A valid id nothing named this round: a real answer, not an error.
        const nobody = reader.getEntityProse('ent-00000000-0000-0000-0000-000000000000', 1);
        expect(nobody.entryCount).toBe(0);
        expect(nobody.text).toBe('');
        expect(nobody.room).toBeNull();

        // Despawn it: the round it lived through is still readable, named by its
        // own rows, with no current room left to report.
        world.despawnEntity(entityId);
        const gone = reader.getEntityProse(entityId, 1);
        expect(gone.entity).toBe('Test Droid');
        expect(gone.room).toBeNull();
        expect(gone.entryCount).toBeGreaterThan(0);
        expect(gone.text).toContain('Test Droid');

        // Out of recent history the window is still the authority: null (route
        // 404), whether or not the entity survives.
        expect(reader.getEntityProse(entityId, 99)).toBeNull();
    });

    it('E5. two identically driven worlds produce byte-identical entity prose', () => {
        const first = runRound1({ move: true });
        const second = runRound1({ move: true });

        const a = first.reader.getEntityProse(first.entityId, 1);
        const b = second.reader.getEntityProse(second.entityId, 1);

        expect(a.text.length).toBeGreaterThan(0);
        expect(a.text).toBe(b.text);
        expect(a.entryCount).toBe(b.entryCount);
        expect(a.entity).toBe(b.entity);
    });

    it('E6. wire shape: 200 prose, 400 malformed round, 400 non-entity id, 404 unknown round, 503 unwired', async () => {
        const { world, entityId } = runRound1();
        const router = express.Router();
        registerPerceptionRoutes(router, { worldStateController: world });
        const server = await new Promise((resolve) => {
            const s = express().use(router).listen(0);
            resolve(s);
        });
        const port = server.address().port;
        const url = (path) => `http://localhost:${port}${path}`;
        try {
            const ok = await fetch(url(`/perception/round/1/byEntity/${entityId}`));
            expect(ok.status).toBe(200);
            const body = await ok.json();
            expect(body.success).toBe(true);
            expect(body.round).toBe(1);
            expect(body.live).toBe(false);
            expect(body.startTick).toBe(1);
            expect(body.endTick).toBe(1);
            expect(body.entityId).toBe(entityId);
            expect(body.entity).toBe('Test Droid');
            expect(body.room).toBe('The Entrance Hall');
            expect(body.entryCount).toBe(1);
            expect(body.text).toContain('Test Droid healed itself');
            expect(body.text).not.toContain(entityId);

            // Malformed round -> 400, before any world read.
            const badRound = await fetch(url(`/perception/round/-3/byEntity/${entityId}`));
            expect(badRound.status).toBe(400);
            expect((await badRound.json()).message).toMatch(/Invalid round number/);

            // A non-`ent-…` id -> 400 with the id echoed (same contract as the
            // other entity routes).
            const badId = await fetch(url('/perception/round/1/byEntity/not-an-entity-id'));
            expect(badId.status).toBe(400);
            expect((await badId.json()).message).toBe('Invalid entity ID "not-an-entity-id".');

            // Round out of recent history -> 404.
            const unknownRound = await fetch(url(`/perception/round/999/byEntity/${entityId}`));
            expect(unknownRound.status).toBe(404);
            expect((await unknownRound.json()).message).toMatch(/Round 999/);

            // An entity no row named is NOT a 404 — empty prose, zero rows.
            const nobody = await fetch(url('/perception/round/1/byEntity/ent-00000000-0000-0000-0000-000000000000'));
            expect(nobody.status).toBe(200);
            const nobodyBody = await nobody.json();
            expect(nobodyBody.entryCount).toBe(0);
            expect(nobodyBody.text).toBe('');

            // The existing endpoints are untouched by the new one.
            const full = await fetch(url('/perception/round/1'));
            expect(full.status).toBe(200);
            const byRoom = await fetch(url('/perception/round/1/byRoom/start_room'));
            expect(byRoom.status).toBe(200);
            const range = await fetch(url('/perception/rounds/0/1'));
            expect(range.status).toBe(200);

            // Unwired reader -> 503.
            world.roundProseController = null;
            const unwired = await fetch(url(`/perception/round/1/byEntity/${entityId}`));
            expect(unwired.status).toBe(503);
            expect((await unwired.json()).error).toBe('Round prose reader is not available.');
        } finally {
            server.close();
        }
    });
});
