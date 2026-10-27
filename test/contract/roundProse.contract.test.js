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
 * builds (determinism test).
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
});
