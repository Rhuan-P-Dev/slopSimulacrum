/**
 * UNIT test for ConsequenceDispatcher's *generic action-attribution recording*.
 *
 * The dispatcher is the single choke point every successful action passes through.
 * It is where the reusable "which components & how many powered action X" answer
 * is written to the ActionAttributionStore. This test pins the invariant that
 * `execute()` and `executeMultiAttacker()` each record *exactly* the resolver's
 * attribution (allFulfillingIds / fulfillment / primary) to the store, with the
 * current world tick — independent of which consequence handlers exist.
 *
 * The same precedent as the sibling `dispatchConsequences` / `buildPerAttackerConsequences`
 * tests: drive the private seam directly with a stub `consequenceHandlers` facade,
 * no world build, no timers.
 *
 * @module test/unit/ConsequenceDispatcher.attribution
 */

import { describe, it, expect, vi } from 'vitest';
import ConsequenceDispatcher from '../../src/controllers/consequences/ConsequenceDispatcher.js';

/**
 * A ConsequenceDispatcher whose single `move` action carries one `entity`-targeted
 * consequence (the safest target — always resolves to the entity id, no facade
 * needed). Handlers are stubbed to always succeed.
 */
function makeDispatcher() {
    const dispatcher = new ConsequenceDispatcher(
        {
            actionRegistry: {
                move: {
                    consequences: [{ type: 'moveEntity', target: 'entity' }]
                },
                punch: {
                    consequences: [{ type: 'damageEntity', target: 'entity' }]
                }
            },
            consequenceHandlers: {
                // The stub records the call but returns a success result so the
                // dispatch loop completes without side effects.
                dispatch: vi.fn(() => ({ success: true }))
            }
        },
        null
    );
    // Give the dispatcher a tick source (so the record's `tick` is deterministic)
    // and a component-stats stub so `executeMultiAttacker`'s attacker loop can
    // read each attacker's strength and proceed to dispatch (it must not throw
    // on the recording path; only the recording is under test here).
    dispatcher.worldStateController = {
        tickSystem: { currentTick: 42 },
        componentController: {
            getComponentStats: vi.fn().mockReturnValue({ Physical: { strength: 20 } })
        }
    };
    return dispatcher;
}

describe('ConsequenceDispatcher — generic attribution recording', () => {
    it('execute() records the SELECTED fulfillers as used (eligible-but-unused are metadata, not claims)', () => {
        const dispatcher = makeDispatcher();
        const store = { record: vi.fn() };
        dispatcher.setActionAttributionStore(store);

        // Four legs all satisfy Movement.move, but the resolver SELECTED only
        // c-gate (the most capable). The record must claim that one leg —
        // never the four eligible candidates (the "used (4)" overclaim bug).
        dispatcher.execute(
            'move',
            'ent-1',
            { 'Movement.move': 20 }, // requirementValues
            { targetX: 1, targetY: 1 }, // params
            { 'Movement.move': 'c-gate' }, // fulfillingComponents (the selection)
            null, // synergyResult
            'c-gate', // primaryComponentId
            {
                allFulfillingIds: ['c-leg-1', 'c-leg-2', 'c-leg-3', 'c-leg-4'],
                fulfillment: {
                    'Movement.move': { best: 'c-gate', ids: ['c-leg-1', 'c-leg-2', 'c-leg-3', 'c-leg-4'] }
                }
            } // attribution
        );

        expect(store.record).toHaveBeenCalledTimes(1);
        expect(store.record).toHaveBeenCalledWith(
            'ent-1',
            'move',
            expect.objectContaining({
                primary: 'c-gate',
                // "only the ones used": exactly the selected fulfiller(s).
                ids: ['c-gate'],
                tick: 42,
                // The per-requirement eligibility breakdown is preserved as
                // metadata — eligible candidates remain discoverable, but they
                // are not claimed as used.
                fulfillment: expect.objectContaining({
                    'Movement.move': { best: 'c-gate', ids: ['c-leg-1', 'c-leg-2', 'c-leg-3', 'c-leg-4'] }
                })
            })
        );
    });

    it('execute() multi-requirement action: used = one selected component per requirement (deduped)', () => {
        const dispatcher = makeDispatcher();
        const store = { record: vi.fn() };
        dispatcher.setActionAttributionStore(store);

        // Two requirements, each fulfilled by its own selected component; the
        // same component selected for two requirements is claimed once.
        dispatcher.execute(
            'move',
            'ent-7',
            { 'Movement.move': 10, 'Physical.strength': 5 },
            {},
            { 'Movement.move': 'c-wheel', 'Physical.strength': 'c-arm' },
            null,
            'c-wheel',
            {
                allFulfillingIds: ['c-wheel', 'c-arm', 'c-other-arm'],
                fulfillment: {
                    'Movement.move': { best: 'c-wheel', ids: ['c-wheel'] },
                    'Physical.strength': { best: 'c-arm', ids: ['c-arm', 'c-other-arm'] }
                }
            }
        );

        expect(store.record).toHaveBeenCalledWith('ent-7', 'move', expect.objectContaining({
            ids: ['c-wheel', 'c-arm'], // the selection — NOT c-other-arm
            primary: 'c-wheel'
        }));
    });

    it('execute() records the caller’s EXPLICIT designation verbatim (2 named → 2 used, 4 named → 4 used)', () => {
        const dispatcher = makeDispatcher();
        const store = { record: vi.fn() };
        dispatcher.setActionAttributionStore(store);

        // The caller designated TWO of the droid's four legs for the move
        // (SOURCE-role componentIds). Both were used — both are recorded, and
        // the two eligible-but-unnamed legs are not.
        dispatcher.execute(
            'move',
            'ent-1',
            { 'Movement.move': 20 },
            { targetX: 1, targetY: 1 },
            { 'Movement.move': 'c-gate' }, // selection (engine picked the best)
            null,
            'c-gate',
            {
                explicitIds: ['c-leg-1', 'c-leg-2'],
                allFulfillingIds: ['c-leg-1', 'c-leg-2', 'c-leg-3', 'c-leg-4'],
                fulfillment: {
                    'Movement.move': { best: 'c-gate', ids: ['c-leg-1', 'c-leg-2', 'c-leg-3', 'c-leg-4'] }
                }
            }
        );

        expect(store.record).toHaveBeenCalledWith('ent-1', 'move', expect.objectContaining({
            ids: ['c-leg-1', 'c-leg-2'], // exactly the two named — count preserved
            primary: 'c-gate'
        }));

        // And all four named → all four used (the quadruped gait case).
        store.record.mockClear();
        dispatcher.execute(
            'move',
            'ent-1',
            { 'Movement.move': 20 },
            { targetX: 1, targetY: 1 },
            { 'Movement.move': 'c-gate' },
            null,
            'c-gate',
            {
                explicitIds: ['c-leg-1', 'c-leg-2', 'c-leg-3', 'c-leg-4'],
                allFulfillingIds: ['c-leg-1', 'c-leg-2', 'c-leg-3', 'c-leg-4'],
                fulfillment: {
                    'Movement.move': { best: 'c-gate', ids: ['c-leg-1', 'c-leg-2', 'c-leg-3', 'c-leg-4'] }
                }
            }
        );

        expect(store.record).toHaveBeenCalledWith('ent-1', 'move', expect.objectContaining({
            ids: ['c-leg-1', 'c-leg-2', 'c-leg-3', 'c-leg-4']
        }));
    });

    it('execute() explicit designation wins over the engine selection (named ≠ selected)', () => {
        const dispatcher = makeDispatcher();
        const store = { record: vi.fn() };
        dispatcher.setActionAttributionStore(store);

        // The caller named c-leg-2; the engine's per-requirement selection is
        // c-gate. "Used" follows the caller, not the selection.
        dispatcher.execute(
            'move',
            'ent-5',
            { 'Movement.move': 20 },
            {},
            { 'Movement.move': 'c-gate' },
            null,
            'c-gate',
            { explicitIds: ['c-leg-2'], fulfillment: null }
        );

        expect(store.record).toHaveBeenCalledWith('ent-5', 'move', expect.objectContaining({
            ids: ['c-leg-2']
        }));
    });

    it('execute() records an EMPTY used set (honest) when nothing was named and nothing was selected — never the eligible set', () => {
        const dispatcher = makeDispatcher();
        const store = { record: vi.fn() };
        dispatcher.setActionAttributionStore(store);

        // No explicit designation, no selection, no primary (only eligibility
        // data). The eligible set is metadata — it must never be claimed as
        // "used"; an empty used list is the honest answer.
        dispatcher.execute('move', 'ent-8', { 'Movement.move': 10 }, {}, {}, null, null, {
            allFulfillingIds: ['c-x', 'c-y'],
            fulfillment: { 'Movement.move': { best: 'c-x', ids: ['c-x', 'c-y'] } }
        });

        expect(store.record).toHaveBeenCalledWith('ent-8', 'move', expect.objectContaining({
            ids: []
        }));
    });

    it('execute() falls back to fulfillingComponents ids when allFulfillingIds is absent', () => {
        const dispatcher = makeDispatcher();
        const store = { record: vi.fn() };
        dispatcher.setActionAttributionStore(store);

        // No `attribution` arg — primary comes from the explicit primaryComponentId.
        dispatcher.execute('move', 'ent-2', { 'Physical.strength': 30 }, {}, { Physical: 'c-fist' }, null, 'c-fist');

        expect(store.record).toHaveBeenCalledTimes(1);
        expect(store.record).toHaveBeenCalledWith(
            'ent-2',
            'move',
            expect.objectContaining({
                primary: 'c-fist',
                ids: ['c-fist'],
                tick: 42
            })
        );
    });

    it('executeMultiAttacker() records the explicit attacker component ids (the users)', () => {
        const dispatcher = makeDispatcher();
        const store = { record: vi.fn() };
        dispatcher.setActionAttributionStore(store);

        dispatcher.executeMultiAttacker('punch', 'ent-3', ['comp-fist-a', 'comp-fist-b'], {}, null);

        expect(store.record).toHaveBeenCalledTimes(1);
        expect(store.record).toHaveBeenCalledWith('ent-3', 'punch', expect.objectContaining({
            primary: 'comp-fist-a',
            ids: expect.arrayContaining(['comp-fist-a', 'comp-fist-b']),
            tick: 42
        }));
    });

    it('does not record (and stays unchanged) when no store is wired', () => {
        const dispatcher = makeDispatcher();
        // No setter call → this.actionAttributionStore is null.
        dispatcher.execute('move', 'ent-4', {}, {}, { Physical: 'c-fist' }, null, 'c-fist');
        expect(dispatcher.actionAttributionStore).toBeNull();
        // execute() still completes (the recording is an added side effect, not a gate).
        // It does not throw for an unwired store.
        expect(() => dispatcher.execute('move', 'ent-4', {}, {}, { Physical: 'c-fist' }, null, 'c-fist')).not.toThrow();
    });

    it('marks the acting entity\'s room dirty in perception at the choke point (the action itself is observable)', () => {
        const dispatcher = makeDispatcher();
        const store = { record: vi.fn() };
        dispatcher.setActionAttributionStore(store);
        // Extend the stub facade with the two seams the recording path touches:
        // the entity's current location and the perception dirty-mark hook.
        dispatcher.worldStateController.stateEntityController = {
            getEntity: vi.fn((id) => (id === 'ent-5' ? { location: 'room-42' } : null))
        };
        dispatcher.worldStateController._markPerceptionDirty = vi.fn();

        dispatcher.execute('punch', 'ent-5', { 'Physical.strength': 10 }, {}, { Physical: 'c-fist' }, null, 'c-fist');

        expect(store.record).toHaveBeenCalledTimes(1);
        // The room the entity stands in is marked dirty so the next perception
        // flush surfaces "ent-5 performed punch (used …)" even if the punch's
        // consequences mark nothing else dirty.
        expect(dispatcher.worldStateController._markPerceptionDirty).toHaveBeenCalledTimes(1);
        expect(dispatcher.worldStateController._markPerceptionDirty).toHaveBeenCalledWith('room-42');
    });

    it('survives a facade without the perception seam (bare test builds)', () => {
        const dispatcher = makeDispatcher();
        const store = { record: vi.fn() };
        dispatcher.setActionAttributionStore(store);
        // No stateEntityController / _markPerceptionDirty on the stub facade —
        // the optional chaining must keep the execution path side-effect-free.
        expect(() =>
            dispatcher.execute('move', 'ent-6', { 'Movement.move': 5 }, {}, null, null, null)
        ).not.toThrow();
        expect(store.record).toHaveBeenCalledTimes(1);
    });
});

describe('ConsequenceDispatcher — action-target attribution (who was acted upon)', () => {
    it('execute() records the explicit target entity + hit component (punch on a named victim)', () => {
        const dispatcher = makeDispatcher();
        const store = { record: vi.fn() };
        dispatcher.setActionAttributionStore(store);

        dispatcher.execute(
            'punch',
            'ent-attacker',
            { 'Physical.strength': 40 },
            { targetEntityId: 'ent-victim', targetComponentId: 'comp-v1' },
            { 'Physical.strength': 'c-fist' },
            null,
            'c-fist',
            { explicitIds: ['c-fist'] }
        );

        expect(store.record).toHaveBeenCalledWith('ent-attacker', 'punch', expect.objectContaining({
            target: { entityId: 'ent-victim', componentId: 'comp-v1' }
        }));
    });

    it('execute() component-only call: the target entity is resolved from the component owner', () => {
        const dispatcher = makeDispatcher();
        const store = { record: vi.fn() };
        dispatcher.setActionAttributionStore(store);
        // Component-targeted calls may name ONLY the component: the dispatcher
        // must resolve the owning entity itself (WSC.getComponent attaches it).
        dispatcher.worldStateController.getComponent = vi.fn().mockReturnValue({
            id: 'comp-v1', type: 'centralBall', entityId: 'ent-owner'
        });

        dispatcher.execute(
            'punch',
            'ent-attacker',
            { 'Physical.strength': 40 },
            { targetComponentId: 'comp-v1' },
            { 'Physical.strength': 'c-fist' },
            null,
            'c-fist',
            null
        );

        expect(dispatcher.worldStateController.getComponent).toHaveBeenCalledWith('comp-v1');
        expect(store.record).toHaveBeenCalledWith('ent-attacker', 'punch', expect.objectContaining({
            target: { entityId: 'ent-owner', componentId: 'comp-v1' }
        }));
    });

    it('execute() unresolvable component: the entity degrades to null (never a wrong owner)', () => {
        const dispatcher = makeDispatcher();
        const store = { record: vi.fn() };
        dispatcher.setActionAttributionStore(store);
        dispatcher.worldStateController.getComponent = vi.fn().mockReturnValue(null);

        dispatcher.execute(
            'punch',
            'ent-attacker',
            { 'Physical.strength': 40 },
            { targetComponentId: 'comp-gone' },
            null,
            null,
            null,
            null
        );

        expect(store.record).toHaveBeenCalledWith('ent-attacker', 'punch', expect.objectContaining({
            target: { entityId: null, componentId: 'comp-gone' }
        }));
    });

    it('execute() spatial action (targetX/targetY): no target is recorded', () => {
        const dispatcher = makeDispatcher();
        const store = { record: vi.fn() };
        dispatcher.setActionAttributionStore(store);

        dispatcher.execute('move', 'ent-1', { 'Movement.move': 20 }, { targetX: 1, targetY: 2 }, null, null, null, null);

        expect(store.record).toHaveBeenCalledWith('ent-1', 'move', expect.objectContaining({ target: null }));
    });

    it('executeMultiAttacker() records the target alongside the full attacker set', () => {
        const dispatcher = makeDispatcher();
        const store = { record: vi.fn() };
        dispatcher.setActionAttributionStore(store);

        dispatcher.executeMultiAttacker('punch', 'ent-attacker', ['c-fist-L', 'c-fist-R'], { targetEntityId: 'ent-victim' });

        expect(store.record).toHaveBeenCalledWith('ent-attacker', 'punch', expect.objectContaining({
            ids: ['c-fist-L', 'c-fist-R'],
            target: { entityId: 'ent-victim', componentId: null }
        }));
    });
});
