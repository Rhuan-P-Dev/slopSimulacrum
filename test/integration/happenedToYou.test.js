/**
 * "HAPPENED TO YOU" end to end — integration test.
 *
 * The question this answers is the one the state text used to leave unasked:
 * when something acts on an agent, does its own context say so — and say WHO
 * did it TO WHOM? A punch that lands was reported as "1 action performed
 * (droid punch by ent-9c1f…) in The Entrance Hall": a reader-independent
 * summary with no target and an id where a name belongs, so the victim's brain
 * contained no fact about being hit, and the attacker's memory no fact about
 * what it hit.
 *
 * This drives the REAL path (real world, real action pipeline, real perception
 * flush, real context composer — no stubs, no LLM) in both directions:
 *
 *   inbound  — an action aimed at the agent reaches its context as
 *              `- Rover used "droid punch" on you (hit: Droid Head, 2x droidHand)`;
 *   outbound — a turn-queued, component-targeted action reaches the ACTOR's
 *              memory as `- ✓ droid punch on Victim: executed` (the queue
 *              carries a `targetComponentId` only, so the owner lookup is the
 *              case that used to record `targetEntityId: null`).
 *
 * The system under test is generic: neither half names a specific action, and
 * the rows are produced by the consequence dispatcher's shared attribution
 * store for ANY action. The assertions pin the two sentences, the live name
 * resolution (never an id in front of the model), and that the shared delta
 * summary stays reader-independent — the new section is an addition to that
 * stream, not a rewrite of it.
 *
 * A third surface is pinned here because it is the one that used to silently
 * win: the dev inspector (`describeAgentView`, the Agent View panel) consumed
 * the agent's perception window while composing its byte-identical view, so the
 * operator watched an agent being destroyed while its own context read
 * "(none)". A peek is now a peek: same window, cursor untouched.
 *
 * Roster note: every NPC is despawned after boot. Cards in data/cards/ are
 * gitignored local content, and an NPC left alive joins the round roster —
 * this test would then depend on which images happen to be on this machine.
 *
 * @module test/integration/happenedToYou
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import LLMAgentController from '../../src/controllers/networking/LLMAgentController.js';

/**
 * A fresh world with no NPCs and two named droids standing in the same room
 * (spawned at the same spot, so a melee action is in range without any move).
 * @param {string} attackerName
 * @param {string} victimName
 */
function buildArena(attackerName, victimName) {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world, subControllers } = buildWorldState(tick);
    Object.values(world.stateEntityController.entities)
        .filter((e) => e.isNPC === true)
        .forEach((npc) => world.despawnEntity(npc.id));

    const roomId = world.roomsController.getUidByLogicalId('start_room');
    const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId, { name: attackerName });
    const victimId = world.stateEntityController.spawnEntity('smallBallDroid', roomId, { name: victimName });
    return { world, tick, subControllers, turns: subControllers.turnSystemController, roomId, attackerId, victimId };
}

/**
 * The Agent View inspector, wired to the real world with a stub provider (it
 * must never be the LLM that is tested here — the inspector only composes).
 * @param {Object} world
 * @param {Object} subControllers
 */
function buildInspector(world, subControllers) {
    return new LLMAgentController({
        llmController: {
            runLlmTurn: () => Promise.reject(new Error('the inspector never calls the provider')),
            createLlmConversation: () => 'unused'
        },
        worldStateController: world,
        llmContextController: subControllers.llmContextController,
        roomChatController: subControllers.roomChatController,
        turnSystemController: subControllers.turnSystemController,
        instinctController: subControllers.instincts
    });
}

/**
 * Open round 0 the way the tick does (the round-start snapshot fixes the
 * planner roster to the entities present now — the two droids below).
 * @param {Object} tick
 * @param {Object} turns
 */
function openRound(tick, turns) {
    tick.currentTick = 0;
    turns.onTick();
}

/** The named entity's fists (the components that power 'droid punch'). */
function fistsOf(world, entityId) {
    return world.getEntity(entityId).components.filter((c) => c.type === 'droidHand').map((c) => c.id);
}

/** The named entity's head component id (what a punch is aimed at). */
function headOf(world, entityId) {
    return world.getEntity(entityId).components.find((c) => c.type === 'droidHead').id;
}

/**
 * The section body of one context section (between its header and the next).
 * @param {string} text
 * @param {string} header
 */
function section(text, header) {
    const start = text.indexOf(header) + header.length;
    const next = text.indexOf('===', start);
    return text.slice(start, next === -1 ? text.length : next);
}

describe('HAPPENED TO YOU — an action aimed at the agent reaches its own context', () => {
    it('renders the blow as a sentence naming actor, action, the part hit and the components used', () => {
        const { world, roomId, attackerId, victimId } = buildArena('Rover', 'Victim');
        // Both look once first: that read is the observation, so the baseline
        // is acknowledged and the punch is what the next window reports.
        world.getAgentRoomPerception(victimId, roomId, { limit: 10 });

        const exec = world.actionController.executeAction('droid punch', attackerId, {
            componentIds: fistsOf(world, attackerId),
            targetComponentId: headOf(world, victimId)
        });
        expect(exec.success, `the punch must land: ${exec?.error ?? ''}`).toBe(true);

        const { text, data } = world.llmContextController.buildContext(victimId);
        const inbound = section(text, '=== HAPPENED TO YOU ===');
        expect(inbound).toContain('- Rover used "droid punch" on you (hit: Droid Head, 2x droidHand)');
        // The actor's own action is not "something that happened to you" — and
        // this row is the victim's, so the section cannot be echoing itself.
        expect(data.happenedToYou).toEqual([expect.objectContaining({
            actorId: attackerId, actorName: 'Rover', action: 'droid punch', hitComponentName: 'Droid Head'
        })]);
    });

    it('keeps the shared delta summary reader-independent (the new section adds, never rewrites)', () => {
        const { world, roomId, attackerId, victimId } = buildArena('Rover', 'Victim');
        world.getAgentRoomPerception(victimId, roomId, { limit: 10 });
        world.actionController.executeAction('droid punch', attackerId, {
            componentIds: fistsOf(world, attackerId),
            targetComponentId: headOf(world, victimId)
        });

        const { text, data } = world.llmContextController.buildContext(victimId);
        const summary = data.deltas.map((d) => d.summary).join('\n');
        // One summary serves every reader of the room, so it cannot say "you" —
        // which is exactly why the agent-relative section exists.
        expect(summary).toContain('action performed');
        expect(summary).not.toMatch(/\byou\b/i);
        // The victim still reads the change window (state, then change).
        expect(text).toContain('since you last looked:');
        expect(text.indexOf('=== HAPPENED TO YOU ===')).toBeLessThan(text.indexOf('=== YOUR WORLD'));
    });

    it('reports an inbound row only for the agent it was aimed at', () => {
        const { world, roomId, attackerId, victimId } = buildArena('Rover', 'Victim');
        world.getAgentRoomPerception(victimId, roomId, { limit: 10 });
        world.getAgentRoomPerception(attackerId, roomId, { limit: 10 });
        world.actionController.executeAction('droid punch', attackerId, {
            componentIds: fistsOf(world, attackerId),
            targetComponentId: headOf(world, victimId)
        });

        // The attacker aimed it — its own memory says "on Victim", and it is
        // not a victim of its own punch.
        const attackerCtx = world.llmContextController.buildContext(attackerId);
        expect(section(attackerCtx.text, '=== HAPPENED TO YOU ===')).toContain('(none)');
        const victimCtx = world.llmContextController.buildContext(victimId);
        expect(section(victimCtx.text, '=== HAPPENED TO YOU ===')).toContain('Rover used "droid punch" on you');
    });
});

describe('looking is not observing — the inspector peek must not consume the agent window', () => {
    // The 2026-11-02 bug: describeAgentView / GET /llm/context composed the
    // context with the SAME consuming read the brain uses, so every look at the
    // panel advanced the agent's perception cursor. The operator watched an
    // agent being destroyed while its context read "since you last looked:
    // (none)" and "HAPPENED TO YOU (none)": the panel had seen the blows, and
    // the agent never would.
    it('the facade peek returns the same window twice; only the brain read consumes it', () => {
        const { world, roomId, attackerId, victimId } = buildArena('Rover', 'Victim');
        world.getAgentRoomPerception(victimId, roomId, { limit: 10 }); // baseline acknowledged
        world.actionController.executeAction('droid punch', attackerId, {
            componentIds: fistsOf(world, attackerId),
            targetComponentId: headOf(world, victimId)
        });

        const peekedTwice = [
            world.peekAgentRoomPerception(victimId, roomId, { limit: 10 }),
            world.peekAgentRoomPerception(victimId, roomId, { limit: 10 })
        ];
        expect(peekedTwice[0]).toHaveLength(1);
        expect(peekedTwice[1], 'a peek never acknowledges: the window is stable').toHaveLength(1);

        // The brain read still finds it, and only IT consumes it.
        expect(world.getAgentRoomPerception(victimId, roomId, { limit: 10 })).toHaveLength(1);
        expect(world.getAgentRoomPerception(victimId, roomId, { limit: 10 }), 'the second brain read is a new window').toHaveLength(0);
    });

    it('opening Agent View shows the blow AND leaves it for the next agent round', () => {
        const { world, subControllers, attackerId, victimId } = buildArena('Rover', 'Victim');
        const inspector = buildInspector(world, subControllers);
        world.llmContextController.buildContext(victimId); // the agent's own round 1
        world.actionController.executeAction('droid punch', attackerId, {
            componentIds: fistsOf(world, attackerId),
            targetComponentId: headOf(world, victimId)
        });

        // 1. The panel shows what happened (peek, same window the brain gets).
        const view = inspector.describeAgentView(victimId);
        expect(section(view.context.text, '=== HAPPENED TO YOU ===')).toContain('- Rover used "droid punch" on you');
        const peekedAgain = inspector.describeAgentView(victimId);
        expect(section(peekedAgain.context.text, '=== HAPPENED TO YOU ==='), 'two opens, same window').toContain('- Rover used "droid punch" on you');

        // 2. THE REGRESSION: the agent's own next round must still perceive it.
        //    Before the fix this read came back empty — the panel had consumed
        //    the window the agent was about to read.
        const brain = world.llmContextController.buildContext(victimId);
        expect(section(brain.text, '=== HAPPENED TO YOU ===')).toContain('- Rover used "droid punch" on you');
        expect(section(brain.text, 'since you last looked:')).toContain('action performed');
    });
});

describe('YOUR LAST ACTIONS & RESULTS — the actor learns what it hit', () => {
    it('a turn-queued, component-targeted action records the owner of the part it aimed at', () => {
        const { world, tick, turns, attackerId, victimId } = buildArena('Rover', 'Victim');
        openRound(tick, turns);
        // The queue carries ONLY a targetComponentId — the form the context
        // tells the model to aim with ("target comp: comp-…"). The owner is
        // what the actor's memory has to name.
        const queued = turns.queueAction(attackerId, 'droid punch', {
            targetComponentId: headOf(world, victimId)
        }, 'player');
        expect(queued.success, `queue rejected: ${queued.error ?? queued.code ?? ''}`).toBe(true);

        // Both droids are planners in this round's roster (present at round
        // start); the round resolves when the last of them stops planning.
        turns.signalPlanComplete(victimId, 'player');
        const closed = turns.signalPlanComplete(attackerId, 'player');
        expect(closed.closed, 'the round must resolve on the last signal').toBe(true);

        const { text } = world.llmContextController.buildContext(attackerId);
        const own = section(text, '=== YOUR LAST ACTIONS & RESULTS ===');
        // (the detail text is TurnSystem's own — "punch hit" is reserved for the
        //  legacy "punch" action name; the point here is the target it names.)
        expect(own).toContain('- ✓ droid punch on Victim: executed');
    });
});
