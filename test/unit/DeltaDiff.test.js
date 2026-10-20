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

