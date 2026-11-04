/**
 * Integration (composition root): delivery of events and room chat is scoped by
 * ROUND, end to end through the real facade, the real stores and a REAL resolved
 * round — wiki/decisions/round-scoped-context.md.
 *
 * What only an integration test can prove: the store got the facade (so it can
 * stamp a round at all), the facade exposes the round reads the context calls,
 * and the stamp comes from the turn system that actually resolved the round —
 * not from a number a caller passed.
 *
 * The round is driven the way the contract tests drive it (`queueAction` +
 * `signalPlanComplete` closes the barrier, the tick after resolution opens the
 * next one), so nothing here invents a round number.
 *
 * @module test/integration/currentRoundEvents
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

/**
 * A built world plus the handles this file needs. One droid is spawned so a
 * round has a planner to signal; the round closes deterministically on
 * all-ready.
 */
function buildRoundWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world, subControllers } = buildWorldState(tick);
    const roomId = world.roomsController.getUidByLogicalId('start_room');
    const entityId = world.stateEntityController.spawnEntity('smallBallDroid', roomId, { name: 'Test Droid' });
    const turns = world.turnSystemController;
    tick.currentTick = 0;
    turns.onTick(); // lazy round 0 opens
    /** The move-capable component a selfHeal needs (the cheapest real action). */
    const moveComponentId = world.stateEntityController.getEntity(entityId).components
        .find((c) => world.getComponentStats(c.id)?.Movement?.move > 0)?.id;
    return {
        world,
        subControllers,
        turns,
        tick,
        roomId,
        entityId,
        moveComponentId,
        /** Resolve the round that is open, then open the next one. */
        resolveRound() {
            turns.queueAction(entityId, 'selfHeal', { targetComponentId: moveComponentId }, 'player');
            turns.signalPlanComplete(entityId, 'player');
            const resolved = turns.getResolvedRound();
            tick.currentTick += 1;
            turns.onTick();
            return resolved;
        }
    };
}

/** One warn-level event written through the store that owns the ring. */
function writeEvent(harness, message) {
    harness.subControllers.worldEventLogController.record({
        action: 'test', message, level: 'warn', targetId: null
    });
}

/** The messages of ONE round, as written by the real store through the facade. */
function messagesOf(world, round) {
    return world.getWorldEventsForRound({ round, limit: 200 }).map((e) => e.message);
}

/** One room line, written through the store that owns the transcript. */
function say(harness, text, speakerName = 'Player') {
    return harness.subControllers.roomChatController.sendMessage({ roomId: harness.roomId, speakerName, text });
}

describe('delivery is scoped by round, through the real wiring', () => {
    it('the facade answers the round reads the context asks, and no consuming one', () => {
        const { world } = buildRoundWorld();

        expect(typeof world.getWorldEventsForRound).toBe('function');
        expect(typeof world.getRoomChatMessagesForRound).toBe('function');
        // The agent-relative pair this change removed: keeping it would leave a
        // second, reader-relative notion of "what is new" in the same facade.
        expect(world.getRecentEventsForAgent).toBeUndefined();
        expect(world.getRoomChatMessagesForAgent).toBeUndefined();
        // The stateless tail stays: "the latest" is a fact about the store, and
        // GET /world-events and GET /rooms/:id/chat answer exactly that.
        expect(typeof world.getRecentEvents).toBe('function');
        expect(typeof world.getRoomChatMessages).toBe('function');
    });

    it('the round in force owns what is written in it, and "no round" (-1) owns nothing', () => {
        const harness = buildRoundWorld();
        const { world, turns } = harness;

        expect(turns.getResolvedRound(), 'nothing has resolved yet').toBe(-1);
        writeEvent(harness, 'written in the first round');

        const row = world.getRecentEvents(50).find((e) => e.message === 'written in the first round');
        expect(row, 'the event is stored').toBeTruthy();
        // Round 0 is open, so round 0 said it. A round number is never withheld
        // while a round is being lived — it is withheld only when nobody can say
        // what round it was (no turn system wired).
        expect(row.round).toBe(0);
        expect(messagesOf(world, 0)).toContain('written in the first round');
        expect(world.getWorldEventsForRound({ round: -1 }), '-1 is not a round').toEqual([]);
        expect(messagesOf(world, 1)).not.toContain('written in the first round');
    });

    it('a round that resolved owns its events, and the next round owns its own', () => {
        const harness = buildRoundWorld();
        const { world, turns } = harness;

        writeEvent(harness, 'in round zero');
        harness.resolveRound();
        expect(turns.getResolvedRound()).toBe(0);
        writeEvent(harness, 'in round one');

        // Each round holds its own and only its own. The world writes its own
        // events at a round boundary ("Round 0 started", an execution line), so
        // these assertions are about the two lines this test wrote.
        expect(messagesOf(world, 0)).toContain('in round zero');
        expect(messagesOf(world, 0)).not.toContain('in round one');
        expect(messagesOf(world, 1)).toContain('in round one');
        expect(messagesOf(world, 1)).not.toContain('in round zero');
        // Nothing consumed: asking twice is answering twice.
        expect(messagesOf(world, 1)).toContain('in round one');
        // The tail still answers "the latest", for the readers that ask that.
        const tail = world.getRecentEvents(50).map((e) => e.message);
        expect(tail.indexOf('in round zero')).toBeLessThan(tail.indexOf('in round one'));
    });

    it('a room line is filed in the round it was said in, and read back from there', () => {
        const harness = buildRoundWorld();
        const { world, roomId } = harness;

        say(harness, 'said in zero');
        harness.resolveRound();
        say(harness, 'said in one');

        expect(world.getRoomChatMessagesForRound(roomId, { round: 0 }).map((m) => m.text)).toEqual(['said in zero']);
        expect(world.getRoomChatMessagesForRound(roomId, { round: 1 }).map((m) => m.text)).toEqual(['said in one']);
        expect(world.getRoomChatMessagesForRound(roomId, { round: 2 })).toEqual([]);
        // Per room: another room's transcript of the same round stays there.
        const otherRoom = Object.keys(world.getRooms()).find((uid) => uid !== roomId);
        expect(world.getRoomChatMessagesForRound(otherRoom, { round: 0 })).toEqual([]);
    });

    it('a round close flushes the room changes into an entry owned by the round that resolved', () => {
        // The hook is wired at the composition root, not here: this asserts the
        // wiring exists and the boundary stamp is the resolved round. Without it
        // a window straddles two rounds and one agent sentence mixes them.
        const harness = buildRoundWorld();
        const { world, roomId } = harness;
        world.getPerceptionDeltasForRoom(roomId, { limit: 10 }); // first observation

        harness.resolveRound(); // the selfHeal heals existence: a real state change

        const changed = world.getPerceptionDeltasForRoom(roomId, { limit: 10 })
            .filter((e) => e.kind !== 'baseline');
        const ofRoundZero = changed.filter((e) => e.roundNumber === 0);
        expect(ofRoundZero.length, 'the boundary flushed the room into the round that closed')
            .toBeGreaterThan(0);
        // Anything else belongs to the round that opened afterwards and sits
        // above them in flush order: the boundary is a cut, not a smear.
        const later = changed.filter((e) => e.roundNumber !== 0);
        expect(later.every((e) => e.sequence > ofRoundZero.at(-1).sequence)).toBe(true);
    });

    it('the stores behind the facade answer a round and carry no reader state', () => {
        const { subControllers } = buildRoundWorld();
        const chat = subControllers.roomChatController;
        const events = subControllers.worldEventLogController;

        expect(typeof chat.getMessagesForRound).toBe('function');
        expect(typeof events.getEventsForRound).toBe('function');
        // No per-agent window left behind in either store: delivery is a fact
        // about the round, so nobody can be first to look.
        expect(chat.cursors).toBeUndefined();
        expect(events.cursors).toBeUndefined();
        expect(chat.messagesByAgent).toBeUndefined();
    });
});
