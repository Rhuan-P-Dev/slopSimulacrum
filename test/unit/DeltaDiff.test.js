/**
 * DeltaDiff — unit tests for the *move attribution* enrichment of the
 * `entities.moved` row: which *action* repositioned the entity (from the entity's
 * `lastMoveAction`, set by the spatial consequence handler) and which *components*
 * granted the Movement trait (locomotion).
 *
 * These are pure-function tests: we feed `diffRoomSnapshots` two snapshots where
 * exactly one entity repositioned within the same room (so it surfaces as a
 * `moved` entry with a coordinate delta), and we assert the attribution fields.
 *
 * @module test/unit/DeltaDiff
 */

import { describe, it, expect, vi } from 'vitest';
import { diffRoomSnapshots, buildBaselineEntry, hasDeltaChanges } from '../../src/utils/DeltaDiff.js';

/**
 * A component that grants the Movement trait (a locomotion component).
 */
const movementComp = {
    id: 'c-body',
    name: 'Body',
    type: 'centralBall',
    stats: { Movement: { move: 20 } }
};

/**
 * A non-kinetic component (grants only the Sensory trait) — must *not* appear
 * in the locomotion list.
 */
const nonKineticComp = {
    id: 'c-senses',
    name: 'Senses',
    type: 'senses',
    stats: { Sensory: { scan: 10 } }
};

/**
 * A minimal room snapshot. Only the fields `diffRoomSnapshots` reads are
 * present; the rest default to empty maps, so a pure entity move produces
 * only a single `entities.moved` entry (no items/internal/equipped/dropped).
 */
function makeSnapshot(tick, entity) {
    return {
        roomId: 'room1',
        tick,
        entities: { e1: entity }
    };
}

/**
 * Builds an entity snapshot for a given position + optional attribution.
 */
function makeEntity({ x, y, name = 'Bolt', components = { 'c-body': movementComp, 'c-senses': nonKineticComp }, lastMoveAction = null } = {}) {
    return {
        id: 'e1',
        name,
        location: 'room1',
        spatial: { x, y },
        components,
        lastMoveAction
    };
}

/**
 * Runs the diff and returns the moved entry (if any) whose id is 'e1'.
 */
function movedRow(prev, next) {
    const delta = diffRoomSnapshots(prev, next, next.tick, next.roomId);
    return (delta?.entities?.moved ?? []).find((m) => m?.id === 'e1') ?? null;
}

describe('DeltaDiff — moved-entity attribution (action + locomotion)', () => {
    it('a within-room move produces a "moved" entry with the coordinate delta', () => {
        const prev = makeSnapshot(10, makeEntity({ x: 0, y: 0 }));
        const next = makeSnapshot(12, makeEntity({ x: 10, y: 5 }));
        const row = movedRow(prev, next);
        expect(row).not.toBeNull();
        expect(row.name).toBe('Bolt');
        // Same-room move: fromRoom === toRoom === the room.
        expect(row.fromRoom).toBe('room1');
        expect(row.toRoom).toBe('room1');
        expect(row.fromXY).toEqual({ x: 0, y: 0 });
        expect(row.toXY).toEqual({ x: 10, y: 5 });
    });

    it('credits the action that repositioned the entity (lastMoveAction)', () => {
        const prev = makeSnapshot(10, makeEntity({ x: 0, y: 0 }));
        const next = makeSnapshot(
            12,
            makeEntity({ x: 10, y: 5, lastMoveAction: { action: 'move', tick: 12 } })
        );
        const row = movedRow(prev, next);
        expect(row.action).toBe('move');
    });

    it('leaves action null when the reposition was not action-driven', () => {
        // No lastMoveAction → the move was a direct (non-action) spatial change.
        const prev = makeSnapshot(10, makeEntity({ x: 0, y: 0 }));
        const next = makeSnapshot(12, makeEntity({ x: 10, y: 5 }));
        const row = movedRow(prev, next);
        expect(row).not.toBeNull();
        expect(row.action).toBeNull();
    });

    it('names every locomotion component that carries the move (type + id)', () => {
        // The 'senses' component grants only Sensory — it must be *excluded*.
        // Every Movement-granting component is returned as an array; with a
        // single leg the array has one entry.
        const prev = makeSnapshot(10, makeEntity({ x: 0, y: 0 }));
        const next = makeSnapshot(12, makeEntity({ x: 10, y: 5 }));
        const row = movedRow(prev, next);
        expect(row.locomotion).toEqual([{ type: 'centralBall', id: 'c-body' }]);
    });

    it('includes the recorded mover even when other components also grant movement', () => {
        // Every Movement-granting component is listed. The component the resolver
        // picked to gate the move (recorded in lastMoveAction.componentId) is one
        // of them; it appears in the list alongside the others.
        const prev = makeSnapshot(10, makeEntity({ x: 0, y: 0 }));
        const next = makeSnapshot(
            12,
            makeEntity({
                x: 10,
                y: 5,
                lastMoveAction: { action: 'move', tick: 12, componentId: 'c-body' },
                components: {
                    // The recorded gate (centralBall, move 20).
                    'c-body': movementComp,
                    // Another component that ALSO grants movement — it's listed too.
                    'c-fast': { id: 'c-fast', name: 'Fast Tread', type: 'treadCore', stats: { Movement: { move: 60 } } }
                }
            })
        );
        const row = movedRow(prev, next);
        expect(row).not.toBeNull();
        // Both c-body and c-fast grant Movement.move → both appear, in snapshot order.
        const ids = (row.locomotion ?? []).map((c) => c.id);
        expect(ids).toContain('c-body'); // the recorded gate
        expect(ids).toContain('c-fast');
        expect(ids).toEqual(['c-body', 'c-fast']);
    });

    it('lists all locomotion components that grant the movement trait, in snapshot order', () => {
        const components = {
            'c-leg1': { id: 'c-leg1', name: 'Leg A', type: 'centralBall', stats: { Movement: { move: 10 } } },
            'c-leg2': { id: 'c-leg2', name: 'Leg B', type: 'treadCore', stats: { Movement: { move: 10 } } },
            'c-senses': nonKineticComp
        };
        const prev = makeSnapshot(10, { ...makeEntity({ x: 0, y: 0 }), name: 'Rover', components });
        const next = makeSnapshot(12, { ...makeEntity({ x: 5, y: 5 }), name: 'Rover', components });
        const row = movedRow(prev, next);
        expect(row).not.toBeNull();
        expect(row.name).toBe('Rover');
        // Both legs grant Movement.move (tied at 10) — BOTH are listed, in snapshot
        // order, not just the "best".
        expect(row.locomotion).toEqual([
            { type: 'centralBall', id: 'c-leg1' },
            { type: 'treadCore', id: 'c-leg2' }
        ]);
        // The purely Sensory component is *not* counted as locomotion.
        expect((row.locomotion ?? []).map((c) => c.id)).not.toContain('c-senses');
    });

    it('lists all locomotion components on ties (m1: 4 equal legs -> all 4)', () => {
        // Mirrors the real m1 droid: four m1Leg components, each installing a
        // moveCore (all grant Movement.move: 20). The log lists *every* leg that
        // grants movement, so all four appear (snapshot order) — the resolver's
        // single "gate" leg is just one of them.
        const m1Leg = (prefix) => ({
            id: `c-leg-${prefix}`,
            name: 'm1Leg',
            type: 'm1Leg',
            stats: { Movement: { move: 20 } }
        });
        const components = {
            'c-leg-fL': m1Leg('fL'),
            'c-leg-fR': m1Leg('fR'),
            'c-leg-bL': m1Leg('bL'),
            'c-leg-bR': m1Leg('bR')
        };
        const prev = makeSnapshot(10, { ...makeEntity({ x: 0, y: 0 }), components });
        const next = makeSnapshot(12, { ...makeEntity({ x: 10, y: 5 }), components });
        const row = movedRow(prev, next);
        expect(row).not.toBeNull();
        expect(row.locomotion).toEqual([
            { type: 'm1Leg', id: 'c-leg-fL' },
            { type: 'm1Leg', id: 'c-leg-fR' },
            { type: 'm1Leg', id: 'c-leg-bL' },
            { type: 'm1Leg', id: 'c-leg-bR' }
        ]);
    });

    it('omits locomotion when no component grants the Movement trait', () => {
        const components = {
            'c-senses': nonKineticComp
        };
        const prev = makeSnapshot(10, { ...makeEntity({ x: 0, y: 0 }), components });
        const next = makeSnapshot(12, { ...makeEntity({ x: 10, y: 5 }), components });
        const row = movedRow(prev, next);
        expect(row).not.toBeNull();
        // null (no locomotion component), not undefined and not the non-kinetic
        // component.
        expect(row.locomotion).toBeNull();
    });

    // ── Generic recorded-attribution tests (the ActionAttributionStore seam) ──
    // These pass a *resolver* (entityId, actionName) => record to diffRoomSnapshots.
    // The resolver is the perception's view of the shared store. The moved row's
    // `locomotion` is derived from it (the authoritative "which & how many powered
    // action X" set) and falls back to the Movement.move heuristic only when the
    // recorded set is absent/empty.

    function movedRowWithResolver(prev, next, resolver) {
        const delta = diffRoomSnapshots(prev, next, next.tick, next.roomId, resolver);
        return (delta?.entities?.moved ?? []).find((m) => m?.id === 'e1') ?? null;
    }

    it('uses the recorded attribution for the move action (overrides the heuristic)', () => {
        // c-body grants Movement (the heuristic would credit it), but the
        // *recorded* attribution credits a different, purely actuator component —
        // the store set must win.
        const powerComp = { id: 'c-power', name: 'Actuator', type: 'actuatorCore', stats: { Sensory: { scan: 5 } } };
        const resolver = (entityId, actionName) =>
            (entityId === 'e1' && actionName === 'move') ? { ids: ['c-power'], tick: 12 } : null;
        const prev = makeSnapshot(10, makeEntity({ x: 0, y: 0 }));
        const next = makeSnapshot(
            12,
            makeEntity({ x: 10, y: 5, components: { 'c-body': movementComp, 'c-power': powerComp, 'c-senses': nonKineticComp }, lastMoveAction: { action: 'move', tick: 12 } })
        );
        const row = movedRowWithResolver(prev, next, resolver);
        expect(row).not.toBeNull();
        expect(row.action).toBe('move');
        // The authoritative recorded set is shown (the actuator), NOT the heuristic
        // locomotion list (c-body) — the store is the single source of truth.
        expect(row.locomotion).toEqual([{ type: 'actuatorCore', id: 'c-power' }]);
    });

    // ── The user's bug: 4-leg droid moves -> perception must show ALL the legs
    // that power the move (every leg that satisfies the requirement), NOT just one
    // best mover.
    it('shows ALL the legs that power the move when the resolver records the full all-satisfy set (4-leg move -> 4)', () => {
        // Real m1 droid: four legs all grant Movement.move. The store records the
        // full set of components that powered the move (`ids` = all 4 legs); the
        // engine has no per-leg gait tracking, so the "used to execute the move"
        // set is all movement legs, and the count reflects every one.
        const m1Leg = (id) => ({ id, name: 'm1Leg', type: 'm1Leg', stats: { Movement: { move: 20 } } });
        const components = {
            'c-leg-fL': m1Leg('c-leg-fL'),
            'c-leg-fR': m1Leg('c-leg-fR'),
            'c-leg-bL': m1Leg('c-leg-bL'),
            'c-leg-bR': m1Leg('c-leg-bR')
        };
        const resolver = (entityId, actionName) =>
            (entityId === 'e1' && actionName === 'move')
                ? {
                    // every leg that powered the move (all 4 satisfy the requirement)
                    ids: ['c-leg-fL', 'c-leg-fR', 'c-leg-bL', 'c-leg-bR'],
                    // fulfillment is also recorded; best marks the single strongest
                    // mover, but the perception credits ALL legs, not just it.
                    fulfillment: {
                        'Movement.move': {
                            best: 'c-leg-fL',
                            ids: ['c-leg-fL', 'c-leg-fR', 'c-leg-bL', 'c-leg-bR']
                        }
                    },
                    tick: 12
                }
                : null;
        const prev = makeSnapshot(10, makeEntity({ x: 0, y: 0, components }));
        const next = makeSnapshot(
            12,
            makeEntity({ x: 10, y: 5, components, lastMoveAction: { action: 'move', tick: 12, componentId: 'c-leg-fL' } })
        );
        const row = movedRowWithResolver(prev, next, resolver);
        expect(row).not.toBeNull();
        expect(row.action).toBe('move');
        expect(row.attributionSource).toBe('store');
        // All four legs powered the move, so all four are listed (count = 4).
        expect(row.locomotion).toEqual([
            { type: 'm1Leg', id: 'c-leg-fL' },
            { type: 'm1Leg', id: 'c-leg-fR' },
            { type: 'm1Leg', id: 'c-leg-bL' },
            { type: 'm1Leg', id: 'c-leg-bR' }
        ]);
        const ids = (row.locomotion ?? []).map((c) => c.id);
        expect(ids).toEqual(['c-leg-fL', 'c-leg-fR', 'c-leg-bL', 'c-leg-bR']);
    });

    it('falls back to the Movement.move heuristic when the recorded attribution carries no ids', () => {
        // Recorded attribution exists but has no component ids → empty set →
        // fall back to the pure heuristic (c-body grants Movement).
        const resolver = (entityId, actionName) =>
            (entityId === 'e1' && actionName === 'move') ? { ids: [], tick: 12 } : null;
        const prev = makeSnapshot(10, makeEntity({ x: 0, y: 0 }));
        const next = makeSnapshot(
            12,
            makeEntity({ x: 10, y: 5, lastMoveAction: { action: 'move', tick: 12 } })
        );
        const row = movedRowWithResolver(prev, next, resolver);
        expect(row).not.toBeNull();
        expect(row.locomotion).toEqual([{ type: 'centralBall', id: 'c-body' }]);
    });

    it('does not consult the resolver when the reposition was not action-driven', () => {
        // No lastMoveAction → action is null → the resolver must not be called;
        // locomotion is pure heuristic.
        const resolver = vi.fn().mockReturnValue(null);
        const prev = makeSnapshot(10, makeEntity({ x: 0, y: 0 }));
        const next = makeSnapshot(12, makeEntity({ x: 10, y: 5 })); // no lastMoveAction
        const row = movedRowWithResolver(prev, next, resolver);
        expect(row).not.toBeNull();
        expect(row.action).toBeNull();
        expect(row.locomotion).toEqual([{ type: 'centralBall', id: 'c-body' }]);
        expect(resolver).not.toHaveBeenCalled();
    });

    it('lists a recorded component even when it is absent from the snapshot (type falls back to id)', () => {
        // The recorded id may refer to a component not present in this room
        // snapshot (e.g. an already-despawned part that powered the move). It is
        // still listed, with the id used as the display type.
        const resolver = (entityId, actionName) =>
            (entityId === 'e1' && actionName === 'move') ? { ids: ['c-ghost'] } : null;
        const prev = makeSnapshot(10, makeEntity({ x: 0, y: 0 }));
        const next = makeSnapshot(
            12,
            makeEntity({ x: 10, y: 5, lastMoveAction: { action: 'move', tick: 12 } }) // no c-ghost in components
        );
        const row = movedRowWithResolver(prev, next, resolver);
        expect(row).not.toBeNull();
        expect(row.locomotion).toEqual([{ type: 'c-ghost', id: 'c-ghost' }]);
    });
});

describe('DeltaDiff — performed-action category shape (stable entry schema)', () => {
    it('a diff entry carries an empty actions.performed category and counts.actions = 0 by default', () => {
        const prev = makeSnapshot(10, makeEntity({ x: 0, y: 0 }));
        const next = makeSnapshot(12, makeEntity({ x: 10, y: 5 }));
        const delta = diffRoomSnapshots(prev, next, next.tick, next.roomId);
        // The controller fills `performed` later (it owns the attribution store);
        // the pure diff only establishes the stable, always-present shape.
        expect(delta.actions).toEqual({ performed: [] });
        expect(delta.counts.actions).toBe(0);
        // actions is deliberately not folded into counts.total (the controller
        // updates counts.actions after it fills the rows).
        expect(delta.counts.total).toBe(1); // the one moved row
    });

    it('a baseline entry carries the same empty actions category (stable schema across kinds)', () => {
        const snapshot = makeSnapshot(1, makeEntity({ x: 0, y: 0 }));
        const baseline = buildBaselineEntry(snapshot, 1, 'room1');
        expect(baseline.actions).toEqual({ performed: [] });
        expect(baseline.counts.actions).toBe(0);
    });

    it('hasDeltaChanges: a non-empty performed list is a change even when counts.total is 0', () => {
        const prev = makeSnapshot(10, makeEntity({ x: 0, y: 0 }));
        const next = makeSnapshot(12, makeEntity({ x: 0, y: 0 })); // nothing moved/changed
        const delta = diffRoomSnapshots(prev, next, next.tick, next.roomId);
        expect(delta.counts.total).toBe(0);
        expect(hasDeltaChanges(delta)).toBe(false);

        // The controller now credits a performed action (e.g. a punch with no
        // observable state change yet) → the flush must surface it.
        delta.actions.performed.push({ entity: 'e1', name: 'Bolt', action: 'punch', used: [], source: 'store' });
        expect(hasDeltaChanges(delta)).toBe(true);
    });

    it('hasDeltaChanges: an empty performed list with nothing else stays empty', () => {
        const prev = makeSnapshot(10, makeEntity({ x: 0, y: 0 }));
        const next = makeSnapshot(12, makeEntity({ x: 0, y: 0 }));
        const delta = diffRoomSnapshots(prev, next, next.tick, next.roomId);
        delta.actions.performed = []; // the shape is present, but nothing performed
        expect(hasDeltaChanges(delta)).toBe(false);
    });
});

describe('DeltaDiff — movement at the perceptual (display) resolution', () => {
    it('sub-grid drift (identical "00.00" display) is NOT a moved row — the phantom-move bug', () => {
        // The reported case: an entity dashed at its own position, its stored
        // coordinate oscillated by ~1e-14 around the target, and perception
        // claimed "(35.85, -17.73) → (35.85, -17.73)" as a move every round.
        // Both values display identically → no observer could see a move.
        const prev = makeSnapshot(10, makeEntity({ x: 35.85, y: -17.73 }));
        const next = makeSnapshot(12, makeEntity({ x: 35.85000000000001, y: -17.73 }));
        expect(movedRow(prev, next)).toBeNull();
    });

    it('a sub-grid drift on the y axis alone is not a moved row either', () => {
        const prev = makeSnapshot(10, makeEntity({ x: 35.85, y: -17.73 }));
        const next = makeSnapshot(12, makeEntity({ x: 35.85, y: -17.73000000000001 }));
        expect(movedRow(prev, next)).toBeNull();
    });

    it('drift that crosses a display step IS a moved row (a real, visible move)', () => {
        const prev = makeSnapshot(10, makeEntity({ x: 35.85, y: -17.73 }));
        const next = makeSnapshot(12, makeEntity({ x: 35.86, y: -17.73 }));
        const row = movedRow(prev, next);
        expect(row).not.toBeNull();
        expect(row.fromXY).toEqual({ x: 35.85, y: -17.73 });
        expect(row.toXY).toEqual({ x: 35.86, y: -17.73 });
    });

    it('missing coordinates on both sides is not a moved row (both display "?")', () => {
        const bare = (tick) => ({
            roomId: 'room1',
            tick,
            entities: { e1: { id: 'e1', name: 'Bolt', location: 'room1', spatial: null, components: {} } }
        });
        const delta = diffRoomSnapshots(bare(10), bare(12), 12, 'room1');
        expect(delta.entities.moved).toEqual([]);
    });
});

/**
 * DeltaDiff — chat (the lines said in the room).
 *
 * Chat is the *event* category that parallels performed actions: the snapshot
 * carries the room's whole ring and the diff reports only the lines that
 * arrived since the last observation. A baseline is a state description and
 * carries no transcript rows (the key exists for schema stability). All rows
 * are defensive copies (the snapshots are shared with the broadcast/agent
 * surfaces, so a mutation of one must never corrupt the other's diff).
 */
const chatLine = (id, { speakerName, speakerEntityId, text, tick = null, ts = null } = {}) => ({
    id,
    speakerName: speakerName ?? 'Player',
    speakerEntityId: speakerEntityId ?? null,
    text: text ?? '',
    tick,
    ts
});

/**
 * A snapshot with an unchanged entity (no moved row) + a chat ring. The
 * snapshot contract is an id-keyed map (Object<string, SnapshotChatMessage>),
 * so the list form is converted here.
 */
function makeChatSnapshot(tick, chatList) {
    const chat = {};
    for (const m of chatList) chat[m.id] = m;
    return {
        roomId: 'room1',
        tick,
        entities: {
            e1: { id: 'e1', name: 'Bolt', location: 'room1', spatial: { x: 0, y: 0 }, components: {}, lastMoveAction: null }
        },
        chat
    };
}

describe('DeltaDiff — chat (the lines said in the room)', () => {
    it('a line that arrived since the last observation is reported in chat.added, with speaker attribution', () => {
        const prev = makeChatSnapshot(10, [
            chatLine('m1', { speakerName: 'Bolt', speakerEntityId: 'ent-npc-0001', text: 'hello', tick: 10, ts: 100 })
        ]);
        const next = makeChatSnapshot(12, [
            chatLine('m1', { speakerName: 'Bolt', speakerEntityId: 'ent-npc-0001', text: 'hello', tick: 10, ts: 100 }),
            chatLine('m2', { speakerName: 'Player', speakerEntityId: null, text: 'hi there', tick: 12, ts: 200 })
        ]);
        const delta = diffRoomSnapshots(prev, next, next.tick, next.roomId);
        expect(delta.chat).toBeDefined();
        expect(delta.chat.added).toHaveLength(1);
        expect(delta.chat.added[0]).toEqual({
            id: 'm2',
            speakerName: 'Player',
            speakerEntityId: null,
            text: 'hi there',
            tick: 12,
            ts: 200
        });
        expect(delta.counts.chat).toBe(1);
        expect(delta.counts.total).toBe(1);
        expect(hasDeltaChanges(delta)).toBe(true);
    });

    it('a room whose only change is chat still surfaces as a change (chat-only flush, counts.chat drives hasDeltaChanges)', () => {
        const prev = makeChatSnapshot(10, []);
        const next = makeChatSnapshot(12, [
            chatLine('m1', { speakerName: 'Bolt', speakerEntityId: 'ent-npc-0001', text: 'who went there', tick: 12, ts: 200 })
        ]);
        const delta = diffRoomSnapshots(prev, next, next.tick, next.roomId);
        expect(delta.counts.total).toBe(1);
        expect(delta.counts.entities).toBe(0);
        expect(delta.counts.items).toBe(0);
        expect(delta.counts.dropped).toBe(0);
        expect(delta.counts.chat).toBe(1);
        expect(hasDeltaChanges(delta)).toBe(true);
    });

    it('no new lines => empty chat diff and no change (chat-only no-op)', () => {
        const snap = makeChatSnapshot(12, [
            chatLine('m1', { text: 'a', tick: 10, ts: 100 }),
            chatLine('m2', { text: 'b', tick: 10, ts: 101 })
        ]);
        const delta = diffRoomSnapshots(snap, { ...snap, tick: 15 }, 15, snap.roomId);
        expect(delta.chat).toBeDefined();
        expect(delta.chat.added).toHaveLength(0);
        expect(delta.counts.chat).toBe(0);
        expect(delta.counts.total).toBe(0);
        expect(hasDeltaChanges(delta)).toBe(false);
    });

    it('a line evicted from the ring is not re-reported (only lines that arrived since the last observation)', () => {
        // Ring capacity is small: prev {m1, m2, m3}, next {m2, m3, m4} → m1 was
        // evicted (already reported), so only m4 is new.
        const prev = makeChatSnapshot(10, [
            chatLine('m1', { text: 'first', tick: 10, ts: 100 }),
            chatLine('m2', { text: 'second', tick: 10, ts: 101 }),
            chatLine('m3', { text: 'third', tick: 10, ts: 102 })
        ]);
        const next = makeChatSnapshot(12, [
            chatLine('m2', { text: 'second', tick: 10, ts: 101 }),
            chatLine('m3', { text: 'third', tick: 10, ts: 102 }),
            chatLine('m4', { text: 'fourth', tick: 12, ts: 120 })
        ]);
        const delta = diffRoomSnapshots(prev, next, next.tick, next.roomId);
        expect(delta.chat.added).toHaveLength(1);
        expect(delta.chat.added[0].id).toBe('m4');
    });

    it('new lines are ordered deterministically by (tick, ts, id) — even when the tick is static (a chat-only room)', () => {
        const prev = makeChatSnapshot(12, []);
        const next = makeChatSnapshot(12, [
            chatLine('z', { text: 'z', tick: 12, ts: 300 }),
            chatLine('a', { text: 'a', tick: 12, ts: 100 }),
            chatLine('m', { text: 'm', tick: 12, ts: 200 })
        ]);
        const delta = diffRoomSnapshots(prev, next, next.tick, next.roomId);
        expect(delta.chat.added.map((m) => m.id)).toEqual(['a', 'm', 'z']);
    });

    it('chat rows are defensive copies — mutating the snapshot does not corrupt the delta', () => {
        const prev = makeChatSnapshot(10, [chatLine('m1', { text: 'before', tick: 10, ts: 100 })]);
        const next = makeChatSnapshot(12, [
            chatLine('m1', { text: 'before', tick: 10, ts: 100 }),
            chatLine('m2', { speakerName: 'Bolt', speakerEntityId: 'ent-npc-0001', text: 'after', tick: 12, ts: 200 })
        ]);
        const delta = diffRoomSnapshots(prev, next, next.tick, next.roomId);
        expect(delta.chat.added).toHaveLength(1);
        expect(delta.chat.added[0].id).toBe('m2');
        // Mutate the *snapshot* — the delta must be untouched (the ring is a
        // live shared structure, so the diff must never alias it).
        next.chat.m2 = { id: 'm2', speakerName: 'hacked', speakerEntityId: 'bad-id', text: 'tampered', tick: null, ts: null };
        expect(delta.chat.added[0].speakerName).toBe('Bolt');
        expect(delta.chat.added[0].speakerEntityId).toBe('ent-npc-0001');
        expect(delta.chat.added[0].text).toBe('after');
    });

    it('a baseline is a state description: no transcript rows (chat key empty, for schema stability)', () => {
        const snapshot = {
            roomId: 'room1',
            tick: 0,
            entities: {
                e1: { id: 'e1', name: 'Bolt', location: 'room1', spatial: { x: 0, y: 0 }, components: {}, lastMoveAction: null }
            },
            chat: [chatLine('m1', { text: 'pre-existing line', tick: 0, ts: 0 }), chatLine('m2', { text: 'another', tick: 0, ts: 0 })]
        };
        const baseline = buildBaselineEntry(snapshot, 0, 'room1');
        expect(baseline.counts.chat).toBe(0);
        expect(baseline.chat).toBeDefined();
        expect(baseline.chat.added).toEqual([]);
    });
});

describe('diffRoomSnapshots machines (who placed what where)', () => {
    // The place choke point tags the spawned entity record (isMachine/
    // machineType/placedBy), so the diff derives the machine category from
    // the record itself — no side state. A machine is an entity, so it also
    // appears in the entity rows (with the tag) — but `counts.machines` is
    // deliberately NOT folded into `counts.total` (it would double-count).

    function machineEntity({ x = 30, y = 30, name = 'Knife Generator', type = 'knifeGenerator', placedBy = { id: 'p1', name: 'Ada' } } = {}) {
        return {
            id: 'e1',
            name,
            location: 'room1',
            spatial: { x, y },
            components: {},
            items: {},
            internal: {},
            equipped: {},
            lastMoveAction: null,
            machine: { type, placedBy }
        };
    }

    function machineRoom(tick, entities) {
        return { roomId: 'room1', tick, entities };
    }

    it('a machine-tagged entity appearing surfaces in machines.placed with who/where', () => {
        const prev = machineRoom(1, {});
        const next = machineRoom(2, { e1: machineEntity({ x: 30, y: 30 }) });
        const delta = diffRoomSnapshots(prev, next, 2, 'room1');
        expect(delta.machines.placed).toEqual([
            { id: 'e1', name: 'Knife Generator', type: 'knifeGenerator', x: 30, y: 30, placedBy: { id: 'p1', name: 'Ada' } }
        ]);
        expect(delta.machines.retrieved).toEqual([]);
        expect(delta.counts.machines).toBe(1);
        // The machine is an entity: the raw entity row carries the tag too.
        expect(delta.entities.appeared).toHaveLength(1);
        expect(delta.entities.appeared[0].machine).toEqual({ type: 'knifeGenerator', placedBy: { id: 'p1', name: 'Ada' } });
        // But total counts the entity once (machines is not folded in).
        expect(delta.counts.total).toBe(1);
    });

    it('a machine-tagged entity despawning surfaces in machines.retrieved with last-seen who/where', () => {
        const prev = machineRoom(1, { e1: machineEntity({ x: 30, y: 30 }) });
        const next = machineRoom(2, {});
        const delta = diffRoomSnapshots(prev, next, 2, 'room1');
        expect(delta.machines.retrieved).toEqual([
            { id: 'e1', name: 'Knife Generator', type: 'knifeGenerator', x: 30, y: 30, placedBy: { id: 'p1', name: 'Ada' } }
        ]);
        expect(delta.machines.placed).toEqual([]);
        expect(delta.counts.machines).toBe(1);
        // The despawned row keeps the tag (the diff's source for the row).
        expect(delta.entities.despawned[0].machine).toEqual({ type: 'knifeGenerator', placedBy: { id: 'p1', name: 'Ada' } });
    });

    it('an unchanged machine (and a plain non-machine entity) produce no machine rows', () => {
        const m = machineEntity();
        const plain = { id: 'e2', name: 'Bolt', location: 'room1', spatial: { x: 1, y: 2 }, components: {}, lastMoveAction: null };
        const prev = machineRoom(1, { e1: m, e2: plain });
        const next = machineRoom(2, { e1: m, e2: plain });
        const delta = diffRoomSnapshots(prev, next, 2, 'room1');
        expect(delta.machines).toEqual({ placed: [], retrieved: [] });
        expect(delta.counts.machines).toBe(0);
        // The plain entity's rows carry machine: null (schema stability).
        const plainDelta = diffRoomSnapshots(machineRoom(1, {}), machineRoom(2, { e2: plain }), 2, 'room1');
        expect(plainDelta.entities.appeared[0].machine).toBeNull();
    });

    it('a baseline reports machines present at first observation (a fact, not an event window); a machine-less baseline stays empty', () => {
        const baseline = buildBaselineEntry(machineRoom(1, { e1: machineEntity({ x: 5.5, y: 7.25 }) }), 1, 'room1');
        expect(baseline.machines.placed).toEqual([
            { id: 'e1', name: 'Knife Generator', type: 'knifeGenerator', x: 5.5, y: 7.25, placedBy: { id: 'p1', name: 'Ada' } }
        ]);
        expect(baseline.machines.retrieved).toEqual([]);
        expect(baseline.counts.machines).toBe(1);
        // The appeared row carries the tag too (schema parity with the delta).
        expect(baseline.entities.appeared[0].machine).toEqual({ type: 'knifeGenerator', placedBy: { id: 'p1', name: 'Ada' } });

        const plainSnap = machineRoom(1, { e1: { id: 'e1', name: 'Bolt', location: 'room1', spatial: { x: 1, y: 2 }, components: {}, lastMoveAction: null } });
        const plainBaseline = buildBaselineEntry(plainSnap, 1, 'room1');
        expect(plainBaseline.machines).toEqual({ placed: [], retrieved: [] });
        expect(plainBaseline.counts.machines).toBe(0);
        expect(plainBaseline.entities.appeared[0].machine).toBeNull();
    });
});

