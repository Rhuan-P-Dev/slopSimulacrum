/**
 * UNIT test for ConsequenceDispatcher._dispatchConsequences — the propagateKeys whitelist.
 *
 * BUG-134 audit, finding M1. On the multi-attacker path, executeMultiAttacker() invokes the
 * shared dispatch loop with propagateParams: false and propagateKeys: [PUBLISHED_CHANNEL_LOSS_KEY].
 * That is the ONE deliberate exception to the path's no-propagation rule: after each consequence
 * runs, the dispatcher copies exactly that reserved published-loss key (and nothing else) from the
 * just-run handler's context into the same attacker's shared context, so the attacker's OWN later
 * drop consequence can consume its own applied loss — while every other handler-modified param keeps
 * the no-propagation semantics and never crosses consequence boundaries.
 *
 * Today the invariant is pinned only end-to-end by the two-fist contract test. A regression that
 * propagated extra keys (or that broke the per-attacker isolation) could pass that contract silently.
 * Per project rule §5.1 this unit test drives the shared dispatch loop directly (the pure private
 * method — the same precedent as the sibling buildPerAttackerConsequences test) with stub handlers,
 * so the whitelist is pinned in isolation: deterministic, no world build, no timers.
 *
 * The dispatcher calls ConsequenceHandlers.dispatch(type, targetId, params, handlerContext) for each
 * consequence and then reads handlerContext.actionParams for the propagateKeys copy-back. The stub
 * handler mutates handlerContext.actionParams (the same object the loop reads back), exactly as the
 * real DamageConsequenceHandler publishes its loss and the real MaterialChunkDropHandler reads it.
 *
 * @module test/unit/ConsequenceDispatcher.dispatchConsequences
 */

import { describe, it, expect } from 'vitest';
import ConsequenceDispatcher from '../../src/controllers/consequences/ConsequenceDispatcher.js';
import { PUBLISHED_CHANNEL_LOSS_KEY } from '../../src/utils/Constants.js';

// A deliberately NON-reserved param key the publisher mutates. On the multi-attacker path it must
// never be carried into the next consequence (propagateParams is false there).
const NON_RESERVED_KEY = 'leakGuard';

/**
 * Creates a minimal ConsequenceDispatcher wired with a stub consequenceHandlers facade.
 * The stub routes each consequence type to a per-type handler function; a type with no
 * registered handler yields the 'no-handler' sentinel the dispatcher already treats.
 *
 * @param {Object<string, function>} handlers - Map of consequence type to stub handler.
 */
function makeDispatcher(handlers) {
    const actionController = {
        actionRegistry: {},
        consequenceHandlers: {
            dispatch(type, targetId, params, handlerContext) {
                const handler = handlers[type];
                if (!handler) return { error: 'no-handler' };
                return handler(targetId, params, handlerContext);
            }
        }
    };
    return new ConsequenceDispatcher(actionController, null);
}

/**
 * Runs the shared dispatch loop over a two-consequence pipeline (a publisher followed by a
 * recorder) on the multi-attacker path's EXACT options (propagateParams: false,
 * propagateKeys: [reserved]), and returns what the recorder observed plus the raw results.
 *
 * @param {(contextParams: Object) => void} publishStep - Publisher body; mutates its own context.
 * @returns {{ seen: Object, results: Array }} recorder observations and per-consequence results.
 */
function runPublishThenRecord(publishStep) {
    const seen = {
        recorderRan: false,
        reserved: undefined,
        nonReserved: undefined
    };

    const handlers = {
        // Consequence 1 — publisher: runs the test's publishStep against its own handler context,
        // mirroring DamageConsequenceHandler writing its loss into the dispatch context.
        damageComponent: (_targetId, _params, handlerContext) => {
            publishStep(handlerContext.actionParams);
            return { success: true, outcome: 'published' };
        },
        // Consequence 2 — recorder: captures what ITS OWN context contains.
        dropMaterialChunk: (_targetId, _params, handlerContext) => {
            seen.recorderRan = true;
            seen.reserved = handlerContext.actionParams[PUBLISHED_CHANNEL_LOSS_KEY];
            seen.nonReserved = handlerContext.actionParams[NON_RESERVED_KEY];
            return { success: true, outcome: 'recorded' };
        }
    };

    const dispatcher = makeDispatcher(handlers);

    const consequences = [
        { type: 'damageComponent', target: 'target', params: {} },
        { type: 'dropMaterialChunk', target: 'target', params: {} }
    ];

    // Exact multi-attacker options (spec D11 revised): full propagation OFF, only the
    // reserved published-loss key whitelisted for per-attacker copy-back.
    const { results } = dispatcher._dispatchConsequences(consequences, {
        action: { consequences },
        actionName: 'twoFistPunch',
        entityId: 'ent-attacker',
        requirementValues: { 'Physical.strength': 42 },
        targetParams: { targetComponentId: 'comp-damaged', attackerComponentId: 'comp-fist-1' },
        initialContextParams: { targetComponentId: 'comp-damaged', attackerComponentId: 'comp-fist-1' },
        fulfillingComponents: { 'Physical.strength': 'comp-fist-1' },
        synergyResult: null,
        propagateParams: false,
        propagateKeys: [PUBLISHED_CHANNEL_LOSS_KEY],
        includeResolvedSourceId: false
    });

    return { seen, results };
}

/** Publisher (a)/(b): set BOTH the reserved key and a non-reserved key on its own context. */
function publishBoth(contextParams) {
    contextParams[PUBLISHED_CHANNEL_LOSS_KEY] = { targetId: 'comp-damaged', appliedLoss: 0.5 };
    contextParams[NON_RESERVED_KEY] = 'leaked';
}

/** Publisher (c): deliberately publishes nothing — the reserved key is never set. */
function publishNothing(_contextParams) { /* no-op */ }

describe('ConsequenceDispatcher._dispatchConsequences (propagateKeys whitelist, multi-attacker path)', () => {
    // (a) The reserved published-loss key reaches the SECOND consequence's own context.
    it('propagates the reserved PUBLISHED_CHANNEL_LOSS_KEY to the next consequence', () => {
        const { seen } = runPublishThenRecord(publishBoth);
        expect(seen.recorderRan, 'the second consequence must have run').toBe(true);
        expect(seen.reserved, 'reserved key must reach the second consequence').toEqual(
            { targetId: 'comp-damaged', appliedLoss: 0.5 }
        );
    });

    // (b) A non-reserved handler-modified key does NOT cross into the next consequence.
    it('does NOT propagate a non-reserved handler-modified key to the next consequence', () => {
        const { seen } = runPublishThenRecord(publishBoth);
        expect(seen.recorderRan, 'the second consequence must have run').toBe(true);
        // The reserved key IS present (proves the recorder saw the shared context)...
        expect(seen.reserved, 'reserved key still crosses (isolation is selective, not total)').toBeDefined();
        // ...while the non-reserved key the same handler mutated must NOT.
        expect(seen.nonReserved, 'non-reserved key must NOT reach the second consequence').toBeUndefined();
    });

    // (c) When a handler publishes nothing (reserved key absent), nothing is propagated and
    //     no error is thrown — the loop simply copies an undefined value forward.
    it('propagates nothing and throws no error when the handler publishes nothing', () => {
        const { seen, results } = runPublishThenRecord(publishNothing);
        expect(seen.recorderRan, 'the second consequence must have run').toBe(true);
        expect(seen.reserved, 'absent reserved key must not appear in the second consequence').toBeUndefined();
        expect(results[0].success, 'publisher consequence should succeed').toBe(true);
        expect(results[1].success, 'recorder consequence should succeed (no error thrown)').toBe(true);
        expect(results.some(r => r.error), 'no consequence should surface an error').toBe(false);
    });
});
