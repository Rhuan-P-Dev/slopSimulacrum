/**
 * INTEGRATION CONTRACT — LLMAgentController × TurnSystemController (audit
 * follow-up: the non-regression lock for audit bugs 2/3/4).
 *
 * Unlike test/unit/LLMAgentController.test.js (everything hand-mocked), this
 * contract wires the REAL world via the composition root (buildWorldState —
 * the same path src/server.js uses) and plugs a REAL LLMAgentController into
 * the real TurnSystemController via setNpcAgent(), with the ONLY external
 * seam stubbed: globalThis.fetch for LLMController.chatFull (same pattern as
 * test/unit/LLMController.chatFull.test.js). The turn machine is driven
 * deterministically (set tick N, onTick() — spec §5.12).
 *
 * Scenarios:
 *   (a) full round with the NPC (LLM Killer) acting: agent tick 20 → LLM proposes
 *       selfHeal → queued during planning → executed via the REAL pipeline at
 *       tick 300 (durability delta asserted) + event-log line;
 *   (b) RESTORE mid-planning → resolution: a pending NPC queue must survive a
 *       world.serialize()/world2.restore() round-trip and still execute at
 *       tick 300 (audit bug 2 — restore() used to zero _actorOrder, and
 *       _resolveRound filtered an empty order, dropping the queue);
 *   (c) an entity joining the round AFTER _roundStart cached the initiative
 *       order: its queue is NOT discarded — resolution reconciles it into the
 *       order with initiative computed on the fly (audit bug 3);
 *   (d) a LATE LLM response landing in the resolution phase: the NPC stays
 *       SILENT — no immediate pipeline execution in a turn world (audit bug
 *       4 / spec §5.8; the pre-fix fallback executed facade.executeAction
 *       directly, bypassing the turn system).
 *
 * @module test/contract/LLMAgent.integration
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import LLMController from '../../src/controllers/networking/LLMController.js';
import LLMAgentController from '../../src/controllers/networking/LLMAgentController.js';

// =========================================================================
// Helpers
// =========================================================================

/** Builds a Response-like object from a JSON payload (fetch stub). */
function jsonResponse(data, { status = 200, statusText = 'OK' } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        json: async () => data,
        text: async () => JSON.stringify(data)
    };
}

/** OpenAI tool-call response for one execute_action + optional speak. */
function toolCallResponse(actionName, extraArgs = {}, speakText = null) {
    const calls = [{
        id: 'call_npc_1',
        type: 'function',
        function: {
            name: 'execute_action',
            arguments: JSON.stringify({ actionName, ...extraArgs })
        }
    }];
    if (speakText !== null) {
        calls.push({
            id: 'call_npc_speak',
            type: 'function',
            function: {
                name: 'speak_in_room',
                arguments: JSON.stringify({ message: speakText })
            }
        });
    }
    return {
        choices: [{
            finish_reason: 'tool_calls',
            message: { role: 'assistant', content: null, tool_calls: calls }
        }]
    };
}

/**
 * Builds the REAL world + a REAL agent wired exactly like src/server.js:
 *   LLMAgentController(real LLMController, real facade, real context, real
 *   room chat, real turn system) → turnSystem.setNpcAgent(runRound).
 * Returns everything the scenarios need.
 */
function buildWorldWithAgent() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world, subControllers } = buildWorldState(tick);

    const llmController = new LLMController();
    const agent = new LLMAgentController({
        llmController,
        worldStateController: world,
        llmContextController: subControllers.llmContextController,
        roomChatController: subControllers.roomChatController,
        turnSystemController: subControllers.turnSystemController
    });

    const agentPromises = [];
    subControllers.turnSystemController.setNpcAgent((npcEntityId, round) => {
        const p = agent.runRound(npcEntityId, round);
        agentPromises.push(p);
        return p;
    });

    const bolt = Object.values(world.stateEntityController.entities).find(e => e.isNPC === true);
    expect(bolt, 'expected the world to have spawned the NPC (data/npcs.json)').toBeTruthy();
    const boltCore = bolt.components.find(c => c.type === 'killerCore');

    return { world, tick, turns: subControllers.turnSystemController, agent, agentPromises, bolt, boltCore };
}

/** The spec's deterministic step primitive: set tick N, onTick(). */
function stepTo(tick, turns, targetTick) {
    tick.currentTick = targetTick;
    turns.onTick();
    return turns.getRoundState();
}

afterEach(() => {
    vi.unstubAllGlobals();
});

// =========================================================================
// Scenarios
// =========================================================================

describe('LLMAgentController × TurnSystemController integration (audit non-regression)', () => {
    it('(a) full round: LLM Killer acts — LLM proposes selfHeal at tick 20, queued in planning, executed via the REAL pipeline at tick 300', async () => {
        const { world, tick, turns, agentPromises, bolt, boltCore } = buildWorldWithAgent();

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            jsonResponse(toolCallResponse('selfHeal', { targetComponentId: boltCore.id }))
        ));

        stepTo(tick, turns, 0);   // round 0 start (order cached)
        stepTo(tick, turns, 20);  // NPC agent fires for LLM Killer
        expect(agentPromises).toHaveLength(1);
        const result = await agentPromises[0]; // let the LLM call land (still planning)

        expect(result.error).toBeNull();
        expect(result.actions).toHaveLength(1);
        expect(result.actions[0]).toMatchObject({ actionName: 'selfHeal', queued: true, success: true });
        expect(result.actions[0].queueId).toMatch(/^q-/);
        // LLM Killer has maxChatMessagesPerRound: 0 → chat is rejected by design.
        expect(result.chat).toMatchObject({ sent: false });

        // Resolution: the REAL pipeline ran the queued selfHeal (+10 durability).
        const before = world.getComponentStats(boltCore.id).Physical.durability;
        const state = stepTo(tick, turns, 300);
        expect(state.phase).toBe('resolution');
        const after = world.getComponentStats(boltCore.id).Physical.durability;
        expect(after).toBe(before + 10);
        expect(Object.keys(state.queues)).toHaveLength(0);

        const events = world.getRecentEvents(12).filter(e => e.action === 'turn');
        expect(events.find(e => e.message.includes('executed selfHeal'))).toBeTruthy();
    });

    it('(b) restore() mid-planning preserves the pending NPC queue — resolution still executes it (audit bug 2)', async () => {
        const { world, tick, turns, agentPromises, bolt, boltCore } = buildWorldWithAgent();

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            jsonResponse(toolCallResponse('selfHeal', { targetComponentId: boltCore.id }))
        ));

        stepTo(tick, turns, 0);
        stepTo(tick, turns, 100);           // mid-planning of round 0
        // Queue directly as the NPC (equivalent of the agent's dispatch — the
        // bug is on the turn-system persistence path, not the LLM path).
        const q = turns.queueAction(bolt.id, 'selfHeal', { targetComponentId: boltCore.id }, 'npc');
        expect(q.success).toBe(true);
        expect(agentPromises).toHaveLength(0); // no LLM involved in this scenario

        // Serialize mid-round with the pending queue, restore onto a FRESH world.
        const snapshot = world.serialize();
        expect(Object.keys(snapshot.state.turns.queues)).toContain(bolt.id);

        const tick2 = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
        const { worldStateController: world2, subControllers: subs2 } = buildWorldState(tick2);
        const restored = world2.restore(snapshot);
        expect(restored.success).toBe(true);

        // Place the restored world in the same planning position (round 0, L=100).
        tick2.currentTick = 100;
        subs2.turnSystemController.onTick(); // must NOT re-fire _roundStart (round unchanged)

        // The pre-fix bug: _actorOrder was [] after restore() and _roundStart
        // never ran again → _resolveRound filtered an empty array and silently
        // dropped the queue. Now: durability rises + an execution event line.
        const before = world2.getComponentStats(boltCore.id).Physical.durability;
        const state = stepTo(tick2, subs2.turnSystemController, 300);
        expect(state.phase).toBe('resolution');
        const after = world2.getComponentStats(boltCore.id).Physical.durability;
        expect(after, 'restored queue must execute at resolution').toBe(before + 10);
        expect(Object.keys(state.queues)).toHaveLength(0);

        const events = world2.getRecentEvents(12).filter(e => e.action === 'turn');
        expect(events.find(e => e.message.includes('executed selfHeal'))).toBeTruthy();
    });

    it('(c) an entity joining the round after the order was cached still resolves its queue (audit bug 3)', () => {
        const { world, tick, turns } = buildWorldWithAgent();
        stepTo(tick, turns, 0); // round start — order cached WITHOUT the newcomer

        // A player droid joins mid-planning (spawnEntity, like a new client).
        const startRoomId = world.roomsController.getUidByLogicalId('start_room');
        const latecomerId = world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
        expect(latecomerId).toBeTruthy();
        const latecomer = world.stateEntityController.getEntity(latecomerId);
        const head = latecomer.components.find(c => c.type === 'droidHead').id;

        // Its queue is ACCEPTED (the entity exists; pre-fix it was silently
        // ignored at resolution because it was absent from _actorOrder).
        const q = turns.queueAction(latecomerId, 'selfHeal', { targetComponentId: head }, 'player');
        expect(q.success).toBe(true);
        expect(Object.keys(turns.getRoundState().queues)).toContain(latecomerId);

        const before = world.getComponentStats(head).Physical.durability;
        const state = stepTo(tick, turns, 300);
        expect(state.phase).toBe('resolution');
        const after = world.getComponentStats(head).Physical.durability;
        expect(after, 'latecomer queue must be reconciled into the order and execute').toBe(before + 10);

        const events = world.getRecentEvents(12).filter(e => e.action === 'turn');
        const execLine = events.find(e => e.message.includes('executed selfHeal'));
        expect(execLine).toBeTruthy();
    });

    it('(d) a LATE LLM response landing in the resolution phase makes the NPC silent — no immediate execution (audit bug 4 / spec §5.8)', async () => {
        const { world, tick, turns, agentPromises, bolt, boltCore } = buildWorldWithAgent();

        // Deferred fetch: the LLM call is pending at tick 20 and only resolves
        // AFTER tick 300 (resolution has already run) — a late response.
        // The agent's single retry (fired by the dispatch failure) must not
        // consume the same pending promise — the 2nd fetch call returns a
        // prose-only response (the model gives up and stays silent).
        let resolveFetch;
        const pending = new Promise(resolve => { resolveFetch = resolve; });
        let fetchCall = 0;
        vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
            fetchCall += 1;
            if (fetchCall === 1) return pending;
            return jsonResponse({
                choices: [{
                    finish_reason: 'stop',
                    message: { role: 'assistant', content: 'I will wait for the next round.' }
                }]
            });
        }));

        stepTo(tick, turns, 0);
        stepTo(tick, turns, 20); // agent fires, LLM call in flight
        expect(agentPromises).toHaveLength(1);

        // Resolution runs with an empty queue (nothing has landed yet).
        const before = world.getComponentStats(boltCore.id).Physical.durability;
        const state = stepTo(tick, turns, 300);
        expect(state.phase).toBe('resolution');

        // NOW the LLM lands with a selfHeal proposal.
        resolveFetch(jsonResponse(toolCallResponse('selfHeal', { targetComponentId: boltCore.id })));
        const result = await agentPromises[0];

        expect(result.error).toBeNull();
        expect(result.iterations).toBe(2); // the failure burned the single retry
        expect(result.actions).toHaveLength(1);
        expect(result.actions[0].queued).toBe(false);
        expect(result.actions[0].success).toBe(false);
        expect(result.actions[0].detail).toBe('planning window closed');

        // The pre-fix bug: the fallback executed facade.executeAction directly —
        // the world must be UNCHANGED (the turn system owns execution timing).
        const after = world.getComponentStats(boltCore.id).Physical.durability;
        expect(after, 'no immediate execution in a turn world').toBe(before);
        expect(Object.keys(world.turnSystemController.getRoundState().queues)).toHaveLength(0);
    });
});
