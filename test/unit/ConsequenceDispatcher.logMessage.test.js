/**
 * UNIT test for ConsequenceDispatcher log-message resolution (top-level `message`/`level`).
 *
 * data/actions.json declares free-text log messages at the consequence level — a
 * top-level `message`/`level` on the `log` consequence, with NO `params` object.
 * The template is the SHARED generic shape used by every damage action:
 *     ":entityName (:entityId) performed :actionName dealing :damageValue
 *      :damageChannel damage"
 * so the line reads e.g. "Droid (ent-…) performed droid punch dealing 25 impact
 * damage" — naming the actor, the action, and the concrete damage, identically
 * for punch / cut / shoot / shotgun (no per-action wording).
 *
 * The fix (dispatcher._resolveLogMessage) routes the top-level template through
 * the same PlaceholderResolver used for the damage `value`, with a context that
 * carries the acting entity (:entityName / :entityId), the action name
 * (:actionName) and the resolved damage (:damageValue / :damageChannel).
 *
 * This file pins the fix at every entry point that runs a top-level log message:
 *   - the shared dispatch loop _dispatchConsequences (the code both execute() and
 *     executeMultiAttacker() share);
 *   - the single-attacker execute() path (the log line the user reported);
 *   - the multi-attacker executeMultiAttacker() path (per-attacker strength);
 *   - the failure path executeFailure().
 *
 * The stub consequenceHandlers.facade records the `params` object handed to the
 * `log` handler; assertions are on `params.message` (and `.level`) — exactly what
 * the LogConsequenceHandler / event sink consume.
 *
 * @module test/unit/ConsequenceDispatcher.logMessage
 */

import { describe, it, expect } from 'vitest';
import ConsequenceDispatcher from '../../src/controllers/consequences/ConsequenceDispatcher.js';
import DataLoader from '../../src/utils/DataLoader.js';

// The punch template as now stored in data/actions.json, plus the shape it must
// resolve to (actor ID + concrete strength number).
const PUNCH_TEMPLATE =
    ':entityName (:entityId) performed :actionName dealing :damageValue :damageChannel damage';
const PUNCH_RESOLVED = 'Droid (ent-abc123) performed droid punch dealing 25 impact damage';

/**
 * The punch action shape exactly as in data/actions.json (two-attacker eligible:
 * a strength requirement + a per-attacker damage + a top-level log message).
 */
function makePunchAction() {
    return {
        consequences: [
            {
                type: 'damageComponent',
                target: 'target',
                params: {
                    channel: 'impact',
                    value: ':Physical.strength',
                    requirementValues: { 'Physical.strength': 20 }
                }
            },
            {
                type: 'log',
                target: 'self',
                level: 'info',
                message: PUNCH_TEMPLATE
            }
        ],
        failureConsequences: [
            {
                type: 'log',
                target: 'entity',
                level: 'warn',
                message: 'Punch failed for [:entityId] - strength too low'
            }
        ]
    };
}

/**
 * Wires a minimal ConsequenceDispatcher with a stub consequenceHandlers.facade.
 * `handlers` maps consequence type -> stub fn (targetId, params, handlerContext).
 * Every `log` dispatch is recorded in `logCalls` for assertions.
 *
 * @param {Object<string, fn>} handlers
 * @param {Object} [extra] - optional { actionRegistry }
 * @returns {{ dispatcher: ConsequenceDispatcher, logCalls: Object[] }}
 */
function makeDispatcher(handlers, extra = {}) {
    const logCalls = [];
    const actionController = {
        actionRegistry: { ...(extra.actionRegistry || {}) },
        consequenceHandlers: {
            dispatch(type, targetId, params, handlerContext) {
                // Record whatever the log handler actually receives — this is the
                // contract under test (message/level resolved, not raw).
                if (type === 'log') logCalls.push(params);
                const handler = handlers[type];
                if (!handler) return { success: false, error: 'no-handler' };
                return handler(targetId, params, handlerContext);
            }
        }
    };
    const dispatcher = new ConsequenceDispatcher(actionController, null);
    return { dispatcher, logCalls };
}

describe('ConsequenceDispatcher log-message resolution (top-level message/level)', () => {
    // A fixed options object that exercises the shared loop the way execute()
    // would for a single-attacker punch.
    const sharedLoopOptions = (action) => ({
        action,
        actionName: 'droid punch',
        entityId: 'ent-abc123',
        requirementValues: { 'Physical.strength': 25 },
        targetParams: { targetEntityId: 'ent-target' },
        initialContextParams: { targetEntityId: 'ent-target', entityId: 'ent-abc123' },
        fulfillingComponents: { 'Physical.strength': 'comp-hand' },
        synergyResult: null,
        propagateParams: false,
        includeResolvedSourceId: false
    });

    describe('_dispatchConsequences — the shared loop (single-attacker execute() path)', () => {
        it('resolves the generic placeholders (entity / action / damage) in the top-level log message', () => {
            const action = makePunchAction();
            const { dispatcher, logCalls } = makeDispatcher({
                damageComponent: () => ({ success: true }),
                log: () => ({ success: true })
            });

            dispatcher._dispatchConsequences(action.consequences, sharedLoopOptions(action));

            expect(logCalls.length, 'the top-level log consequence must dispatch').toBe(1);
            expect(
                logCalls[0].message,
                'message must carry the entity, the action name, and the concrete damage'
            ).toBe(PUNCH_RESOLVED);
            expect(logCalls[0].level).toBe('info');
        });

        it('resolves :entityId while leaving unknown placeholders untouched (no crash, no regression)', () => {
            const action = {
                consequences: [
                    {
                        type: 'log',
                        target: 'entity',
                        level: 'warn',
                        message: 'entity [:entityId] dealt :Physical.missing_stat damage!'
                    }
                ]
            };
            const { dispatcher, logCalls } = makeDispatcher({ log: () => ({ success: true }) });

            dispatcher._dispatchConsequences(
                action.consequences,
                {
                    action,
                    actionName: 'custom',
                    entityId: 'ent-x',
                    requirementValues: {},
                    targetParams: {},
                    initialContextParams: { entityId: 'ent-x' },
                    fulfillingComponents: { 'Physical.existence': 'comp-a' },
                    synergyResult: null,
                    propagateParams: false,
                    includeResolvedSourceId: false
                }
            );

            // :entityId resolves; :Physical.missing_stat is absent from the context so
            // it stays as a literal token — same as pre-fix behavior, no throw.
            expect(logCalls.length).toBe(1);
            expect(logCalls[0].message).toBe(
                'entity [ent-x] dealt :Physical.missing_stat damage!'
            );
        });
    });

    describe('execute() — single-attacker path (the reported log line)', () => {
        it('resolves the punch log message end-to-end', () => {
            const action = makePunchAction();
            const { dispatcher, logCalls } = makeDispatcher(
                { damageComponent: () => ({ success: true }), log: () => ({ success: true }) },
                { actionRegistry: { 'droid punch': action } }
            );

            dispatcher.execute(
                'droid punch',
                'ent-abc123',
                { 'Physical.strength': 25 },
                { targetEntityId: 'ent-target' },
                { 'Physical.strength': 'comp-hand' },
                null,
                'comp-hand'
            );

            expect(logCalls.length, 'exactly one log consequence for a single attack').toBe(1);
            expect(logCalls[0].message, 'single-attacker execute() must show id + damage').toBe(
                PUNCH_RESOLVED
            );
        });
    });

    describe('executeMultiAttacker() — multi-attacker path', () => {
        it('resolves the punch log message per attacker (entity id + that attacker\'s strength)', () => {
            const action = makePunchAction();
            const { dispatcher, logCalls } = makeDispatcher(
                { damageComponent: () => ({ success: true }), log: () => ({ success: true }) },
                { actionRegistry: { 'droid punch': action } }
            );

            // The only facade surface executeMultiAttacker() needs for comp- attackers:
            // per-attacker component stats.
            dispatcher.worldStateController = {
                componentController: {
                    getComponentStats: () => ({ Physical: { strength: 37 } })
                },
                getEquippedItem: () => null
            };

            dispatcher.executeMultiAttacker(
                'droid punch',
                'ent-abc123',
                ['comp-hand-1', 'comp-hand-2'],
                { targetEntityId: 'ent-target' }
            );

            // Two fists -> the top-level log runs once per attacker.
            expect(logCalls.length, 'one log consequence per attacker').toBe(2);
            expect(logCalls[0].message, 'per-attacker: entity + action + that fist\'s strength').toBe(
                'Droid (ent-abc123) performed droid punch dealing 37 impact damage'
            );
            expect(logCalls[1].message).toBe(
                'Droid (ent-abc123) performed droid punch dealing 37 impact damage'
            );
        });

        it('resolves a NON-strength per-attacker stat in the log (two-handed shotgun: fine_controls, not strength)', () => {
            // Regression (was a High bug): the multi-attacker path used to log 0 damage
            // for a non-strength stat because the message resolved against the
            // strength-only requirementValues. It now resolves against the full
            // per-attacker stat context (perAttackerStatContext) fed via messageStatContext.
            const shotgunAction = {
                consequences: [
                    {
                        type: 'damageRandomComponents',
                        target: 'target',
                        params: { channel: 'impact', value: ':Manipulation.fine_controls*2', count: '3' }
                    },
                    {
                        type: 'log',
                        target: 'self',
                        level: 'info',
                        message: PUNCH_TEMPLATE
                    }
                ]
            };
            const { dispatcher, logCalls } = makeDispatcher(
                { damageRandomComponents: () => ({ success: true }), log: () => ({ success: true }) },
                { actionRegistry: { 'hand shotgun': shotgunAction } }
            );
            dispatcher.worldStateController = {
                componentController: {
                    getComponentStats: () => ({ Physical: { strength: 41 }, Manipulation: { fine_controls: 5 } })
                },
                getEquippedItem: () => null
            };

            dispatcher.executeMultiAttacker(
                'hand shotgun',
                'ent-sg',
                ['comp-h1', 'comp-h2'],
                { targetComponentId: 'comp-t' }
            );

            // Two hands -> two logs; each resolves fine_controls (5*2=10 per pellet x 3 = 30),
            // NOT the strength-only fallback (which produced 0 before the fix).
            expect(logCalls.length, 'one log per attacker').toBe(2);
            expect(logCalls[0].message, 'per-pellet value x count from attacker fine_controls, not strength').toBe(
                'Droid (ent-sg) performed hand shotgun dealing 30 impact damage'
            );
            expect(logCalls[1].message).toBe(
                'Droid (ent-sg) performed hand shotgun dealing 30 impact damage'
            );
        });
    });

    describe('executeFailure() — failure path', () => {
        it('resolves :entityId in the failure log message', () => {
            const action = makePunchAction();
            const { dispatcher, logCalls } = makeDispatcher(
                { log: () => ({ success: true }) },
                { actionRegistry: { 'droid punch': action } }
            );

            dispatcher.executeFailure('droid punch', 'ent-abc123');

            expect(logCalls.length, 'one failure log consequence').toBe(1);
            expect(
                logCalls[0].message,
                'failure log must name the acting entity, not leak ":entityId"'
            ).toBe('Punch failed for [ent-abc123] - strength too low');
            expect(logCalls[0].level).toBe('warn');
        });
    });

    describe('_resolveLogMessage — generic placeholders (entityName / actionName / damage)', () => {
        it('names a NAMED entity and the action, with the resolved damage (stat)', () => {
            const { dispatcher } = makeDispatcher({ log: () => ({ success: true }) });
            dispatcher.worldStateController = { getEntity: () => ({ name: 'Rusty' }) };
            const action = makePunchAction();
            const msg = dispatcher._resolveLogMessage(
                PUNCH_TEMPLATE,
                { 'Physical.strength': 25 },
                {},
                'ent-named',
                'droid punch',
                dispatcher._getEntityName('ent-named'),
                action
            );
            expect(msg).toBe('Rusty (ent-named) performed droid punch dealing 25 impact damage');
        });

        it('falls back to "Droid" when the entity has no name', () => {
            const { dispatcher } = makeDispatcher({ log: () => ({ success: true }) });
            dispatcher.worldStateController = { getEntity: () => ({ name: undefined }) };
            const action = makePunchAction();
            const msg = dispatcher._resolveLogMessage(
                PUNCH_TEMPLATE,
                { 'Physical.strength': 25 },
                {},
                'ent-bare',
                'droid punch',
                dispatcher._getEntityName('ent-bare'),
                action
            );
            expect(msg).toBe('Droid (ent-bare) performed droid punch dealing 25 impact damage');
        });

        it('shootT1: damageValue is the consumed item volume (declared value is 0)', () => {
            const { dispatcher } = makeDispatcher({ log: () => ({ success: true }) });
            const shootAction = {
                consequences: [
                    { type: 'consumeItemAndDamage', target: 'target', params: { channel: 'impact', value: 0 }, damageSource: 'equippedItem.firstChild.volume' },
                    { type: 'log', target: 'self', level: 'info', message: PUNCH_TEMPLATE }
                ]
            };
            // itemVolume is published into actionParams by ConsumeItemHandler.
            const msg = dispatcher._resolveLogMessage(
                PUNCH_TEMPLATE,
                {},
                { itemVolume: 240 },
                'ent-shoot',
                'shootT1',
                'Droid',
                shootAction
            );
            expect(msg).toBe('Droid (ent-shoot) performed shootT1 dealing 240 impact damage');
        });

        it('hand shotgun: damageValue is per-pellet value × count (total)', () => {
            const { dispatcher } = makeDispatcher({ log: () => ({ success: true }) });
            const shotgunAction = {
                consequences: [
                    { type: 'damageRandomComponents', target: 'target', params: { channel: 'impact', value: ':Manipulation.fine_controls*2', count: '3' } },
                    { type: 'log', target: 'self', level: 'info', message: PUNCH_TEMPLATE }
                ]
            };
            const msg = dispatcher._resolveLogMessage(
                PUNCH_TEMPLATE,
                { 'Manipulation.fine_controls': 5 },
                {},
                'ent-gun',
                'hand shotgun',
                'Droid',
                shotgunAction
            );
            // 5 fine_controls * 2 = 10 per pellet, x 3 pellets = 30 total.
            expect(msg).toBe('Droid (ent-gun) performed hand shotgun dealing 30 impact damage');
        });

        it('non-damage action: no damage placeholders to resolve, message unaffected, no crash', () => {
            const { dispatcher } = makeDispatcher({ log: () => ({ success: true }) });
            const moveAction = { consequences: [{ type: 'deltaSpatial', target: 'entity' }] };
            const msg = dispatcher._resolveLogMessage(
                ':entityName performed :actionName',
                {},
                {},
                'ent-move',
                'move',
                'Droid',
                moveAction
            );
            expect(msg).toBe('Droid performed move');
        });
    });
});

describe('data-lint: shared damage template requires channel-based damage', () => {
    const actions = DataLoader.loadJsonSafe('data/actions.json', {});

    it('every action whose log uses the damage template declares a channel damage consequence', () => {
        const damageTypes = ['damageComponent', 'consumeItemAndDamage', 'damageRandomComponents'];
        const violations = [];
        for (const [name, action] of Object.entries(actions)) {
            const logMessages = [];
            for (const bucket of ['consequences', 'failureConsequences']) {
                for (const c of (action[bucket] || [])) {
                    if (c && c.type === 'log' && typeof c.message === 'string') logMessages.push(c.message);
                }
            }
            const usesDamageTemplate = logMessages.some(
                (m) => m.includes(':damageValue') || m.includes(':damageChannel')
            );
            if (!usesDamageTemplate) continue;
            const hasChannelDamage = (action.consequences || []).some(
                (c) => c && damageTypes.includes(c.type) && typeof (c.params?.channel) === 'string'
            );
            if (!hasChannelDamage) violations.push(name);
        }
        expect(violations, 'an action using the damage template must declare channel-based damage (damageComponent / consumeItemAndDamage / damageRandomComponents with a `channel` param), else :damageValue/:damageChannel leak raw').toEqual([]);
    });
});
