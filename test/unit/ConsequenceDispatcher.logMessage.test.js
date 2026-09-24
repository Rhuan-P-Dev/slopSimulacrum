/**
 * UNIT test for ConsequenceDispatcher log-message resolution (top-level `message`/`level`).
 *
 * data/actions.json declares free-text log messages at the consequence level — a
 * top-level `message`/`level` on the `log` consequence, with NO `params` object.
 * The template is the SHARED generic shape used by every damage action:
 *
 *     ":entityName (:entityId):attackerCompPhrase performed :actionName
 *      dealing :damageValue :damageChannel damage to :targetName
 *      (:targetId):targetCompPhrase"
 *
 * so one template names EVERY part of the event, identically for punch / cut /
 * shoot / shotgun (no per-action wording):
 *   - the acting entity            (:entityName / :entityId)
 *   - the component it used        (:attackerCompPhrase → "'s <name>", e.g. "'s Droid Hand")
 *   - the action                   (:actionName)
 *   - the concrete damage          (:damageValue / :damageChannel)
 *   - the entity that was hit      (:targetName / :targetId)
 *   - the component that was hit   (:targetCompPhrase → "'s <name>", e.g. "'s Droid Arm")
 *
 * e.g. "Rusty (ent-…)'s Droid Hand performed droid punch dealing 25 impact damage
 * to Vex (ent-…)'s Droid Arm".
 *
 * The fix (dispatcher._resolveLogMessage) routes the top-level template through the
 * same PlaceholderResolver used for the damage `value`, with a context that carries
 * the actor, the attacker's component, the action name, the resolved damage, and the
 * victim entity + component. Component display names are resolved from
 * data/components.json (body parts) and data/inventoryItems.json (equipped weapons);
 * the possessive phrases degrade to '' when a component cannot be resolved, so the
 * sentence stays grammatical.
 *
 * This file pins the fix at every entry point that runs a top-level log message:
 *   - the shared dispatch loop _dispatchConsequences (the code both execute() and
 *     executeMultiAttacker() share);
 *   - the single-attacker execute() path (the log line the user reported);
 *   - the multi-attacker executeMultiAttacker() path (per-attacker component + stat);
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

// The shared damage template as now stored in data/actions.json (one for every
// damage action): it names the actor, the attacker's component, the action, the
// concrete damage, the victim entity, and the victim's component.
const PUNCH_TEMPLATE =
    ':entityName (:entityId):attackerCompPhrase performed :actionName dealing :damageValue ' +
    ':damageChannel damage to :targetName (:targetId):targetCompPhrase';

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

/**
 * Builds a fake WorldStateController with just the surface the log-message fix
 * uses: getEntity (entity display names), getComponent (body-part types) and
 * getEquippedItem (equipped weapon itemType). `componentStats` backs the
 * multi-attacker per-attacker stat path.
 *
 * `components` is a map compId -> { id, type } (type is a data/components.json key).
 * `equipped` is a map entityId -> { eqId -> { eqId, itemType } } (itemType is a
 * data/inventoryItems.json key).
 */
function makeWorld({ entities = {}, components = {}, equipped = {}, componentStats } = {}) {
    return {
        getEntity: (id) => (id in entities ? entities[id] : undefined),
        getComponent: (id) => (id in components ? components[id] : null),
        getEquippedItem: (eid, eqid) => {
            const map = equipped[eid] || {};
            return eqid in map ? map[eqid] : null;
        },
        ...(componentStats ? { componentController: { getComponentStats: () => componentStats } } : {})
    };
}

// A punch world: attacker "Rusty" (a Droid Hand does the punching) hits "Vex" on
// a Droid Arm. Named entities exercise the entity-name path; the body-part types
// resolve to their data/components.json names ("Droid Hand", "Droid Arm").
const PUNCH_WORLD = () => makeWorld({
    entities: { 'ent-abc123': { name: 'Rusty' }, 'ent-target': { name: 'Vex' } },
    components: {
        'comp-hand': { id: 'comp-hand', type: 'droidHand' },
        'comp-arm': { id: 'comp-arm', type: 'droidArm' }
    },
    equipped: {}
});

describe('ConsequenceDispatcher log-message resolution (top-level message/level)', () => {
    describe('_dispatchConsequences — the shared loop (single-attacker execute() path)', () => {
        it('names the actor + attacker component, the action, the damage, and the victim + victim component', () => {
            const action = makePunchAction();
            const { dispatcher, logCalls } = makeDispatcher({
                damageComponent: () => ({ success: true }),
                log: () => ({ success: true })
            });
            dispatcher.worldStateController = PUNCH_WORLD();

            dispatcher._dispatchConsequences(action.consequences, {
                action,
                actionName: 'droid punch',
                entityId: 'ent-abc123',
                requirementValues: { 'Physical.strength': 25 },
                targetParams: { targetEntityId: 'ent-target', targetComponentId: 'comp-arm' },
                initialContextParams: { targetEntityId: 'ent-target', targetComponentId: 'comp-arm', entityId: 'ent-abc123' },
                fulfillingComponents: { 'Physical.strength': 'comp-hand' },
                primaryComponentId: 'comp-hand',
                synergyResult: null,
                propagateParams: false,
                includeResolvedSourceId: false
            });

            expect(logCalls.length, 'the top-level log consequence must dispatch').toBe(1);
            expect(
                logCalls[0].message,
                'message must name attacker+component, action, damage, and victim+component'
            ).toBe(
                "Rusty (ent-abc123)'s Droid Hand performed droid punch dealing 25 impact damage " +
                "to Vex (ent-target)'s Droid Arm"
            );
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
        it('resolves the punch log message end-to-end (attacker hand → victim arm)', () => {
            const action = makePunchAction();
            const { dispatcher, logCalls } = makeDispatcher(
                { damageComponent: () => ({ success: true }), log: () => ({ success: true }) },
                { actionRegistry: { 'droid punch': action } }
            );
            dispatcher.worldStateController = PUNCH_WORLD();

            dispatcher.execute(
                'droid punch',
                'ent-abc123',
                { 'Physical.strength': 25 },
                { targetEntityId: 'ent-target', targetComponentId: 'comp-arm' },
                { 'Physical.strength': 'comp-hand' },
                null,
                'comp-hand'
            );

            expect(logCalls.length, 'exactly one log consequence for a single attack').toBe(1);
            expect(
                logCalls[0].message,
                'single-attacker execute() names attacker+component, damage, victim+component'
            ).toBe(
                "Rusty (ent-abc123)'s Droid Hand performed droid punch dealing 25 impact damage " +
                "to Vex (ent-target)'s Droid Arm"
            );
        });

        it('degrades gracefully when the world is unavailable (no components, bare entities)', () => {
            const action = makePunchAction();
            const { dispatcher, logCalls } = makeDispatcher(
                { damageComponent: () => ({ success: true }), log: () => ({ success: true }) },
                { actionRegistry: { 'droid punch': action } }
            );
            // No worldStateController injected: entities fall back to "Droid" and the
            // possessive component phrases are omitted (no dangling apostrophe).
            dispatcher.worldStateController = null;

            dispatcher.execute(
                'droid punch',
                'ent-abc123',
                { 'Physical.strength': 25 },
                { targetEntityId: 'ent-target' },
                { 'Physical.strength': 'comp-hand' },
                null,
                'comp-hand'
            );

            expect(logCalls.length).toBe(1);
            expect(logCalls[0].message, 'no world -> bare entities, no possessive phrases').toBe(
                'Droid (ent-abc123) performed droid punch dealing 25 impact damage to Droid (ent-target)'
            );
        });
    });

    describe('executeMultiAttacker() — multi-attacker path', () => {
        it('names each attacker\'s component and the victim (two-handed punch: two Droid Hands)', () => {
            const action = makePunchAction();
            const { dispatcher, logCalls } = makeDispatcher(
                { damageComponent: () => ({ success: true }), log: () => ({ success: true }) },
                { actionRegistry: { 'droid punch': action } }
            );
            dispatcher.worldStateController = makeWorld({
                entities: { 'ent-abc123': { name: 'Rusty' }, 'ent-target': { name: 'Vex' } },
                components: {
                    'comp-hand-1': { id: 'comp-hand-1', type: 'droidHand' },
                    'comp-hand-2': { id: 'comp-hand-2', type: 'droidHand' },
                    'comp-arm': { id: 'comp-arm', type: 'droidArm' }
                },
                componentStats: { Physical: { strength: 37 } }
            });

            dispatcher.executeMultiAttacker(
                'droid punch',
                'ent-abc123',
                ['comp-hand-1', 'comp-hand-2'],
                { targetEntityId: 'ent-target', targetComponentId: 'comp-arm' }
            );

            // Two fists -> the top-level log runs once per attacker; each names that
            // attacker's Droid Hand, the per-attacker strength, and the victim + component.
            expect(logCalls.length, 'one log consequence per attacker').toBe(2);
            const expected =
                "Rusty (ent-abc123)'s Droid Hand performed droid punch dealing 37 impact damage " +
                "to Vex (ent-target)'s Droid Arm";
            expect(logCalls[0].message, 'per-attacker: attacker component + that fist\'s strength').toBe(expected);
            expect(logCalls[1].message).toBe(expected);
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
            dispatcher.worldStateController = makeWorld({
                entities: { 'ent-sg': { name: 'Rusty' }, 'ent-target': { name: 'Vex' } },
                components: {
                    'comp-h1': { id: 'comp-h1', type: 'droidHand' },
                    'comp-h2': { id: 'comp-h2', type: 'droidHand' },
                    'comp-t': { id: 'comp-t', type: 'droidArm' }
                },
                componentStats: { Physical: { strength: 41 }, Manipulation: { fine_controls: 5 } }
            });

            dispatcher.executeMultiAttacker(
                'hand shotgun',
                'ent-sg',
                ['comp-h1', 'comp-h2'],
                { targetEntityId: 'ent-target', targetComponentId: 'comp-t' }
            );

            // Two hands -> two logs; each names the hand, resolves fine_controls
            // (5*2=10 per pellet x 3 = 30, NOT the strength-only fallback -> 0), and
            // names the victim + the component that was hit.
            expect(logCalls.length, 'one log per attacker').toBe(2);
            const expected =
                "Rusty (ent-sg)'s Droid Hand performed hand shotgun dealing 30 impact damage " +
                "to Vex (ent-target)'s Droid Arm";
            expect(logCalls[0].message, 'per-pellet value x count from attacker fine_controls, not strength').toBe(expected);
            expect(logCalls[1].message).toBe(expected);
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

    describe('_resolveLogMessage — generic placeholders (entity / component / action / damage / target)', () => {
        it('names a NAMED entity and the attacker body-part component (punch)', () => {
            const { dispatcher } = makeDispatcher({ log: () => ({ success: true }) });
            dispatcher.worldStateController = makeWorld({
                entities: { 'ent-named': { name: 'Rusty' }, 'ent-target': { name: 'Vex' } },
                components: { 'comp-hand': { id: 'comp-hand', type: 'droidHand' }, 'comp-arm': { id: 'comp-arm', type: 'droidArm' } }
            });
            const action = makePunchAction();
            const msg = dispatcher._resolveLogMessage(
                PUNCH_TEMPLATE,
                { 'Physical.strength': 25 },
                { targetEntityId: 'ent-target', targetComponentId: 'comp-arm' },
                'ent-named',
                'droid punch',
                dispatcher._getEntityName('ent-named'),
                action,
                undefined,
                'comp-hand'
            );
            expect(msg).toBe(
                "Rusty (ent-named)'s Droid Hand performed droid punch dealing 25 impact damage " +
                "to Vex (ent-target)'s Droid Arm"
            );
        });

        it('names an EQUIPPED WEAPON as the attacker component (shootT1: the T1)', () => {
            const { dispatcher } = makeDispatcher({ log: () => ({ success: true }) });
            dispatcher.worldStateController = makeWorld({
                entities: { 'ent-shoot': { name: 'Rusty' }, 'ent-target': { name: 'Vex' } },
                components: { 'comp-arm': { id: 'comp-arm', type: 'droidArm' } },
                equipped: { 'ent-shoot': { 'eq-t1': { eqId: 'eq-t1', itemType: 't1' } } }
            });
            const shootAction = {
                consequences: [
                    { type: 'consumeItemAndDamage', target: 'target', params: { channel: 'impact', value: 0 }, damageSource: 'equippedItem.firstChild.volume' },
                    { type: 'log', target: 'self', level: 'info', message: PUNCH_TEMPLATE }
                ]
            };
            // itemVolume is published into actionParams by ConsumeItemHandler; the
            // attacker component is the equipped T1 weapon (an eq- ID).
            const msg = dispatcher._resolveLogMessage(
                PUNCH_TEMPLATE,
                {},
                { itemVolume: 240, targetEntityId: 'ent-target', targetComponentId: 'comp-arm' },
                'ent-shoot',
                'shootT1',
                'Rusty',
                shootAction,
                {},
                'eq-t1'
            );
            expect(msg).toBe(
                "Rusty (ent-shoot)'s T1 performed shootT1 dealing 240 impact damage " +
                "to Vex (ent-target)'s Droid Arm"
            );
        });

        it('hand shotgun: damageValue is per-pellet value × count (total), attacker + victim named', () => {
            const { dispatcher } = makeDispatcher({ log: () => ({ success: true }) });
            dispatcher.worldStateController = makeWorld({
                entities: { 'ent-gun': { name: 'Rusty' }, 'ent-target': { name: 'Vex' } },
                components: { 'comp-h': { id: 'comp-h', type: 'droidHand' }, 'comp-t': { id: 'comp-t', type: 'centralBall' } }
            });
            const shotgunAction = {
                consequences: [
                    { type: 'damageRandomComponents', target: 'target', params: { channel: 'impact', value: ':Manipulation.fine_controls*2', count: '3' } },
                    { type: 'log', target: 'self', level: 'info', message: PUNCH_TEMPLATE }
                ]
            };
            const msg = dispatcher._resolveLogMessage(
                PUNCH_TEMPLATE,
                { 'Manipulation.fine_controls': 5 },
                { targetEntityId: 'ent-target', targetComponentId: 'comp-t' },
                'ent-gun',
                'hand shotgun',
                'Rusty',
                shotgunAction,
                { 'Manipulation.fine_controls': 5 },
                'comp-h'
            );
            // 5 fine_controls * 2 = 10 per pellet, x 3 pellets = 30 total. The victim
            // component type centralBall resolves to its data/components.json name.
            expect(msg).toBe(
                "Rusty (ent-gun)'s Droid Hand performed hand shotgun dealing 30 impact damage " +
                "to Vex (ent-target)'s Central Ball"
            );
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

        it('omits the possessive phrase (but not the sentence) when a component cannot be resolved', () => {
            const { dispatcher } = makeDispatcher({ log: () => ({ success: true }) });
            // World has the entities but getComponent resolves to a type with no recipe
            // name AND no prettify-friendly form is available -> here we simulate the
            // "no component found" case: getComponent returns null for the attacker.
            dispatcher.worldStateController = makeWorld({
                entities: { 'ent-a': { name: 'Rusty' }, 'ent-target': { name: 'Vex' } },
                components: {},
                equipped: {}
            });
            const action = makePunchAction();
            const msg = dispatcher._resolveLogMessage(
                PUNCH_TEMPLATE,
                { 'Physical.strength': 25 },
                { targetEntityId: 'ent-target' },
                'ent-a',
                'droid punch',
                'Rusty',
                action,
                undefined,
                'comp-missing'
            );
            // No attacker component resolvable, no target component given -> both
            // possessive phrases drop out, but both entities are still named.
            expect(msg).toBe('Rusty (ent-a) performed droid punch dealing 25 impact damage to Vex (ent-target)');
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
