/**
 * UNIT TEST — WorldAuthoringController: the System behind the System tab.
 *
 * The provider is a scripted fake implementing the seam (`TST-3`), the world definition is
 * a `RegistryStore` of a few entries, and the writer is a spy — because the property that
 * matters most here is WHEN a write happens: never during a conversation, only on the
 * operator's `writeProposal`.
 *
 * Pinned:
 *   - the tool loop answers every tool call and stops at the model's prose answer;
 *   - `propose_mod` runs the real validator, so a rule refusal goes back to the model as
 *     data (the turn continues) and NOT as a stored proposal;
 *   - the world structure kinds are refused;
 *   - the replayed history is wishes and replies only (`RP-3`) — tool traffic is answered
 *     to the caller, never replayed; and the cap drops the oldest with a log;
 *   - a session is minted at the edge and bounded in memory (`A-7`);
 *   - `writeProposal` re-validates and hands the writer the proposal, and the answers for
 *     "no such session" / "no proposal" are typed, not 500s (`E-1`).
 *
 * @module test/unit/WorldAuthoringController
 */

import { describe, it, expect, vi } from 'vitest';
import WorldAuthoringController, {
    PROMPT_KIND,
    PROMPT_VERSION,
    MAX_TOOL_ITERATIONS,
    MAX_SESSIONS,
    MAX_HISTORY_MESSAGES,
    MAX_ACTIONS_PER_SESSION,
    SessionNotFoundError,
    ProposalNotSetError,
    ActionsNotSetError
} from '../../src/controllers/networking/WorldAuthoringController.js';
import RegistryStore from '../../src/services/RegistryStore.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';

/** A world small enough to read here, valid enough for the composition classifier. */
function makeStore(overrides = {}) {
    return new RegistryStore({
        [REGISTRY_KINDS.MATERIALS]: { steel: { name: 'Steel', density: 7.8, properties: {} } },
        [REGISTRY_KINDS.COMPONENTS]: { hull: { name: 'Hull', form: { volume: 4 }, materials: [{ material: 'steel', fraction: 1 }] } },
        [REGISTRY_KINDS.INVENTORY_ITEMS]: {},
        [REGISTRY_KINDS.ACTIONS]: { move: { description: 'Advance.' } },
        [REGISTRY_KINDS.ROOMS]: { workshop: { name: 'Workshop' } },
        ...overrides
    });
}

/**
 * A seam fake answering from a script: each entry is one `chatFull` result. Tool calls are
 * built in the shape `LLMController.chatFull` normalizes to (`function.arguments` is a
 * string, `T-1`).
 * @param {Array<Object>} script
 */
function makeSeam(script) {
    const calls = [];
    return {
        calls,
        chatFull: vi.fn(async (messages, options) => {
            // A snapshot, not a reference: the controller appends the tool answers to the
            // very array it was handed, so a stored reference would show what the LAST call
            // sent rather than what this one saw.
            calls.push({ messages: structuredClone(messages), options });
            const next = script.shift();
            return next ?? { content: 'script exhausted', finishReason: 'stop', message: { role: 'assistant' }, toolCalls: [] };
        })
    };
}

/**
 * The `tool` message the controller answered for `id` on the given provider call.
 * @param {Array<Object>} calls - the seam's recorded calls
 * @param {number} callIndex - which provider call's request to look at
 * @param {string} id - the tool_call id
 * @returns {Object} the parsed tool result
 */
function toolAnswerSent(calls, callIndex, id) {
    const message = calls[callIndex].messages.find((m) => m.role === 'tool' && m.tool_call_id === id);
    return JSON.parse(message.content);
}

/** One `tool_calls` answer. */
function toolAnswer(name, args, id = 'call-1') {
    return {
        content: null,
        finishReason: 'tool_calls',
        message: { role: 'assistant', content: null, tool_calls: [{ id }] },
        toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
    };
}

/** A prose answer. */
function proseAnswer(content) {
    return { content, finishReason: 'stop', message: { role: 'assistant', content }, toolCalls: [] };
}

/** A writer spy that records what it was asked to write. */
function makeWriterSpy() {
    return {
        writePackage: vi.fn((spec) => ({
            saved: true,
            packageId: spec.id,
            dir: `data/mods/${spec.id}`,
            files: [`data/mods/${spec.id}/mod.json`],
            content: Object.keys(spec.content),
            created: true,
            overwritten: [],
            backups: []
        }))
    };
}

/** A legal proposal, as the model would send it through `propose_mod`. */
function legalProposal() {
    return {
        packageId: 'salvage-plate',
        description: 'A plate a droid can haul.',
        rationale: 'Because the operator asked for salvage.',
        content: { [REGISTRY_KINDS.COMPONENTS]: { salvagePlate: { name: 'Salvage Plate', form: { volume: 2 }, materials: [{ material: 'steel', fraction: 1 }] } } }
    };
}

describe('WorldAuthoringController.handleChat — the loop', () => {
    it('answers every tool call, then ends on the prose answer, replaying tool results in order', async () => {
        const seam = makeSeam([
            toolAnswer('list_registries', {}),
            toolAnswer('read_registry', { kind: REGISTRY_KINDS.MATERIALS }, 'call-2'),
            proseAnswer('Steel exists; I would build on it.')
        ]);
        const controller = new WorldAuthoringController({
            llmController: seam,
            registryStore: makeStore(),
            writer: makeWriterSpy()
        });

        const turn = await controller.handleChat({ message: 'is there steel?' });

        expect(turn.reply).toBe('Steel exists; I would build on it.');
        expect(seam.calls).toHaveLength(3);
        // The second call carries the tool answer for the first call's id, in the protocol
        // shape `LLMController._validateMessages` requires (assistant tool_calls, then tool).
        const second = seam.calls[1].messages;
        expect(second.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call-1' }] });
        expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-1' });
        expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-1' });
        const materialAnswer = toolAnswerSent(seam.calls, 2, 'call-2');
        expect(materialAnswer).toMatchObject({ kind: REGISTRY_KINDS.MATERIALS, total: 1, keys: ['steel'] });
        // A listing carries one real definition: the shape, without spending a call on it.
        expect(materialAnswer.sample).toMatchObject({ key: 'steel', definition: { name: 'Steel' } });
        // Every provider call carries the versioned prompt and the tool set (`RP-1`, `RP-2`).
        // Reads for definitions (list/read/find), the authoring lever (propose_mod), and the
        // live levers (inspect the running world, then propose a plan to Execute).
        expect(seam.calls[0].options.system).toContain(`${PROMPT_KIND} v${PROMPT_VERSION}`);
        expect(seam.calls[0].options.tools.map((t) => t.function.name)).toEqual([
            'list_registries', 'read_registry', 'find_definitions', 'propose_mod',
            'list_entities', 'inspect_entity', 'list_rooms', 'propose_action'
        ]);
        expect(turn.toolLog.map((entry) => entry.name)).toEqual(['list_registries', 'read_registry']);
        expect(turn.meta.iterations).toBe(3);
        expect(turn.meta.stoppedAtToolCap).toBe(false);
        // Nothing was written: a conversation writes nothing (`the whole point`).
        expect(turn.proposal).toBeNull();
    });

    it('stops at the iteration cap and says so instead of inventing an answer', async () => {
        const looping = Array.from({ length: MAX_TOOL_ITERATIONS + 2 }, (_, i) => toolAnswer('list_registries', {}, `c${i}`));
        const seam = makeSeam(looping);
        const controller = new WorldAuthoringController({
            llmController: seam,
            registryStore: makeStore(),
            writer: makeWriterSpy()
        });

        const turn = await controller.handleChat({ message: 'read forever' });

        expect(turn.reply).toBeNull();
        expect(turn.toolLog).toHaveLength(MAX_TOOL_ITERATIONS);
        // The client distinguishes "ran out of budget" from "had nothing to say".
        expect(turn.meta.stoppedAtToolCap).toBe(true);
        // Every tool answer carries the remaining budget, because the model spends it.
        expect(JSON.parse(seam.calls[1].messages.at(-1).content).callsRemaining)
            .toBe(MAX_TOOL_ITERATIONS - 1);
    });

    it('treats an unknown tool and a broken arguments string as answers, not crashes', async () => {
        const seam = makeSeam([
            {
                content: null,
                finishReason: 'tool_calls',
                message: { role: 'assistant' },
                toolCalls: [
                    { id: 'a', type: 'function', function: { name: 'drop_everything', arguments: '{}' } },
                    { id: 'b', type: 'function', function: { name: 'read_registry', arguments: '{not json' } }
                ]
            },
            proseAnswer('I cannot do that.')
        ]);
        const controller = new WorldAuthoringController({
            llmController: seam,
            registryStore: makeStore(),
            writer: makeWriterSpy()
        });

        const turn = await controller.handleChat({ message: 'do things' });

        expect(turn.reply).toBe('I cannot do that.');
        expect(turn.toolLog[0]).toMatchObject({ name: 'drop_everything', ok: false, detail: 'unknown tool' });
        expect(turn.toolLog[1].ok).toBe(false);
        expect(toolAnswerSent(seam.calls, 1, 'a').error).toContain('Unknown tool');
        // The broken `arguments` string comes back as the parse error, as data — the turn
        // does not die on it (the wording is V8's, so the assertion is on its shape).
        expect(toolAnswerSent(seam.calls, 1, 'b').error).toMatch(/JSON at position/);
    });
});

describe('WorldAuthoringController — proposing', () => {
    it('accepts a legal proposal, freezes it, and names what it adds and what it shadows', async () => {
        const seam = makeSeam([toolAnswer('propose_mod', legalProposal()), proseAnswer('Proposed one component.')]);
        const controller = new WorldAuthoringController({
            llmController: seam,
            registryStore: makeStore(),
            writer: makeWriterSpy()
        });

        const turn = await controller.handleChat({ message: 'add a salvage plate' });

        expect(turn.proposal).toMatchObject({
            kind: 'mod-proposal',
            packageId: 'system-salvage-plate',
            added: [{ kind: REGISTRY_KINDS.COMPONENTS, key: 'salvagePlate' }],
            overrides: []
        });
        expect(Object.isFrozen(turn.proposal)).toBe(true);
        // The model is told the truth: nothing is written by proposing.
        const toolResult = toolAnswerSent(seam.calls, 1, 'call-1');
        expect(toolResult.ok).toBe(true);
        expect(toolResult.note).toMatch(/Nothing is written/);
    });

    it('reports an override of shipped content instead of hiding it', async () => {
        const proposal = legalProposal();
        proposal.content[REGISTRY_KINDS.COMPONENTS].hull = { name: 'Hull', form: { volume: 9 }, materials: [{ material: 'steel', fraction: 1 }] };
        const seam = makeSeam([toolAnswer('propose_mod', proposal), proseAnswer('I redefined hull.')]);
        const controller = new WorldAuthoringController({ llmController: seam, registryStore: makeStore(), writer: makeWriterSpy() });

        const turn = await controller.handleChat({ message: 'make hull bigger' });

        expect(turn.proposal.overrides).toEqual([{ kind: REGISTRY_KINDS.COMPONENTS, key: 'hull' }]);
        expect(turn.proposal.added).toEqual([{ kind: REGISTRY_KINDS.COMPONENTS, key: 'salvagePlate' }]);
    });

    it('refuses the world structure kinds, and lets the model try again in the same turn', async () => {
        // (two tool calls in one answer are both answered before the next provider call,
        // and answered in the order they came — the protocol order the seam validates)
        const mapProposal = {
            packageId: 'new-map',
            description: 'A new room.',
            content: { [REGISTRY_KINDS.ROOMS]: { lab: { name: 'Lab' } } }
        };
        const seam = makeSeam([
            toolAnswer('propose_mod', mapProposal, 'a'),
            toolAnswer('propose_mod', legalProposal(), 'b'),
            proseAnswer('I cannot redraw the map; I proposed a component instead.')
        ]);
        const controller = new WorldAuthoringController({ llmController: seam, registryStore: makeStore(), writer: makeWriterSpy() });

        const turn = await controller.handleChat({ message: 'redraw the map, or do what you can' });

        expect(turn.toolLog[0]).toMatchObject({ name: 'propose_mod', ok: false });
        expect(turn.toolLog[0].detail).toContain('world structure');
        expect(turn.toolLog[1].ok).toBe(true);
        expect(turn.proposal).toMatchObject({ packageId: 'system-salvage-plate' });
    });

    it('sends the world\'s own composition rule back to the model so it can fix the reference', async () => {
        const bad = legalProposal();
        bad.content[REGISTRY_KINDS.COMPONENTS].salvagePlate.materials = [{ material: 'unobtainium', fraction: 1 }];
        const seam = makeSeam([toolAnswer('propose_mod', bad), proseAnswer('That material does not exist.')]);
        const controller = new WorldAuthoringController({ llmController: seam, registryStore: makeStore(), writer: makeWriterSpy() });

        const turn = await controller.handleChat({ message: 'a plate of unobtainium' });

        expect(turn.proposal).toBeNull();
        expect(turn.toolLog[0].ok).toBe(false);
        expect(turn.toolLog[0].detail).toMatch(/Unknown material "unobtainium"/);
    });
});

describe('WorldAuthoringController — history and sessions', () => {
    it('replays only wishes and replies: tool traffic never enters the history', async () => {
        const seam = makeSeam([toolAnswer('list_registries', {}), proseAnswer('Read them.')]);
        const controller = new WorldAuthoringController({ llmController: seam, registryStore: makeStore(), writer: makeWriterSpy() });

        const first = await controller.handleChat({ message: 'look around' });
        const second = await controller.handleChat({ sessionId: first.sessionId, message: 'and now?' });

        const replayed = seam.calls.at(-1).messages;
        expect(replayed.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        expect(second.sessionId).toBe(first.sessionId);
    });

    it('keeps a proposal in the history as one line, so a refinement knows it exists', async () => {
        const seam = makeSeam([toolAnswer('propose_mod', legalProposal()), proseAnswer('Proposed.'), proseAnswer('Still there.')]);
        const controller = new WorldAuthoringController({ llmController: seam, registryStore: makeStore(), writer: makeWriterSpy() });

        const turn = await controller.handleChat({ message: 'add a plate' });
        await controller.handleChat({ sessionId: turn.sessionId, message: 'anything else?' });

        const replayed = seam.calls.at(-1).messages.map((m) => m.content).join('\n');
        expect(replayed).toContain('[proposal on the table: system-salvage-plate');
    });

    it('trims the oldest messages past the cap and says it dropped them', async () => {
        const seam = makeSeam(Array.from({ length: MAX_HISTORY_MESSAGES + 4 }, () => proseAnswer('ok')));
        const controller = new WorldAuthoringController({ llmController: seam, registryStore: makeStore(), writer: makeWriterSpy() });
        let sessionId = null;
        for (let i = 0; i <= MAX_HISTORY_MESSAGES / 2; i++) {
            const turn = await controller.handleChat({ sessionId, message: `wish ${i}` });
            sessionId = turn.sessionId;
        }
        const history = controller.getHistory(sessionId);
        expect(history.messages.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
    });

    it('evicts the oldest session past the bound, and mints a fresh id for an unknown one', async () => {
        const seam = makeSeam([]);
        const controller = new WorldAuthoringController({ llmController: seam, registryStore: makeStore(), writer: makeWriterSpy() });
        const ids = [];
        for (let i = 0; i < MAX_SESSIONS + 3; i++) {
            const turn = await controller.handleChat({ sessionId: null, message: 'hi' });
            ids.push(turn.sessionId);
        }
        expect(controller.sessionCount()).toBe(MAX_SESSIONS);
        expect(ids).toHaveLength(MAX_SESSIONS + 3);
        // The evicted ids are gone from the server, and a new turn on one of them starts a
        // fresh session rather than failing — a reloaded tab cannot know whether it survived.
        expect(() => controller.getHistory(ids[0])).toThrow(SessionNotFoundError);
        const revived = await controller.handleChat({ sessionId: ids[0], message: 'hello again' });
        expect(revived.sessionId).toBe(ids[0]);
    });
});

describe('WorldAuthoringController.writeProposal', () => {
    it('writes the session proposal, once validated, and never writes during the conversation', async () => {
        const seam = makeSeam([toolAnswer('propose_mod', legalProposal()), proseAnswer('Proposed.')]);
        const writer = makeWriterSpy();
        const controller = new WorldAuthoringController({ llmController: seam, registryStore: makeStore(), writer });

        const turn = await controller.handleChat({ message: 'add a salvage plate' });
        expect(writer.writePackage).not.toHaveBeenCalled();

        const report = await controller.writeProposal(turn.sessionId);
        expect(writer.writePackage).toHaveBeenCalledTimes(1);
        expect(writer.writePackage.mock.calls[0][0]).toMatchObject({
            id: 'system-salvage-plate',
            description: 'A plate a droid can haul.',
            content: { [REGISTRY_KINDS.COMPONENTS]: { salvagePlate: expect.any(Object) } }
        });
        expect(report.packageId).toBe('system-salvage-plate');
        expect(report.overrides).toEqual([]);
    });

    it('answers a typed error when the session is unknown or has nothing to write', async () => {
        const controller = new WorldAuthoringController({
            llmController: makeSeam([]),
            registryStore: makeStore(),
            writer: makeWriterSpy()
        });
        await expect(controller.writeProposal('nope')).rejects.toBeInstanceOf(SessionNotFoundError);

        const turn = await controller.handleChat({ message: 'hello' });
        await expect(controller.writeProposal(turn.sessionId)).rejects.toBeInstanceOf(ProposalNotSetError);
    });

    it('re-validates at write time: a proposal that the moved world no longer accepts is refused', async () => {
        const seam = makeSeam([toolAnswer('propose_mod', legalProposal()), proseAnswer('Proposed.')]);
        const store = makeStore();
        const writer = makeWriterSpy();
        const controller = new WorldAuthoringController({ llmController: seam, registryStore: store, writer });
        const turn = await controller.handleChat({ message: 'add a salvage plate' });

        // The world moved: an apply landed a package that made the proposal's reference bad.
        // Written directly on the store's live content — that is what a swap does to it.
        const materials = store.read(REGISTRY_KINDS.MATERIALS);
        delete materials.steel;
        materials.iron = { name: 'Iron', density: 7.2, properties: {} };

        await expect(controller.writeProposal(turn.sessionId)).rejects.toThrowError(
            expect.objectContaining({ code: 'PROPOSAL_INVALID' })
        );
        expect(writer.writePackage).not.toHaveBeenCalled();
    });
});

// =========================================================================
// (b3) the live action plan (the operator's Execute/Clear table)
// =========================================================================

// The plan is a per-session queue of server-validated live actions. The LLM
// proposes; the operator service re-validates (both at proposal time and at
// execution); the world changes only through the two explicit setters,
// `setComponentStat` and `setEntityAttributeDelta`.

describe('WorldAuthoringController — the live action plan', () => {
    const noopWriter = makeWriterSpy();

    /** A fake live world: accepts any well-formed action. */
    function acceptingOperator() {
        return {
            validateAction: vi.fn((operation, rawParams) => ({
                ok: true,
                intent: {
                    operation,
                    params: rawParams ?? {},
                    summary: `live ${operation}`
                }
            })),
            executeActions: vi.fn(() => ({ executed: 0, results: [] })),
            listEntities: vi.fn(() => ({ live: true, entities: [] })),
            inspectEntity: vi.fn(() => ({ live: true, components: [] })),
            listRooms: vi.fn(() => ({ live: true, rooms: [] }))
        };
    }

    it('propose_action puts the validated action on the table; the plan persists across later turns and into getPlanStatus', async () => {
        const controller = new WorldAuthoringController({
            llmController: makeSeam([
                toolAnswer('propose_action', { operation: 'set_entity_stat', params: { entityId: 'ent-1', traitId: 'Pleasure', statName: 'pleasure', value: 15 } }, 'a'),
                proseAnswer('It is on the table.'),
                proseAnswer('Still there.')
            ]),
            registryStore: makeStore(),
            writer: noopWriter,
            operatorService: acceptingOperator()
        });

        const first = await controller.handleChat({ message: 'raise its pleasure' });
        const second = await controller.handleChat({ sessionId: first.sessionId, message: 'what now' });

        expect(first.actions).toHaveLength(1);
        expect(first.actions[0]).toMatchObject({
            operation: 'set_entity_stat',
            params: { entityId: 'ent-1', traitId: 'Pleasure', statName: 'pleasure', value: 15 }
        });
        expect(first.actions[0].id).toBeDefined();
        expect(first.toolLog[0]).toMatchObject({ name: 'propose_action', ok: true });

        // The table outlives the turn that proposed it, carrying the same action.
        expect(second.actions).toHaveLength(1);
        expect(second.actions[0].id).toBe(first.actions[0].id);

        const status = controller.getPlanStatus(first.sessionId);
        expect(status).toMatchObject({
            sessionId: first.sessionId,
            actions: [{ operation: 'set_entity_stat' }]
        });
    });

    it('a rejected propose_action leaves the plan untouched but answers the model with the rule list', async () => {
        const operatorService = {
            validateAction: vi.fn((operation, rawParams) => {
                const _op = rawParams?.statName ?? '';
                const isGhost = operation === 'set_entity_stat';
                return isGhost
                    ? { ok: false, errors: ['No entity attribute "Movement.move" for this entity. Known: none. For component stats, use set_component_stat with a component id.'] }
                    : { ok: true, intent: { operation, params: rawParams ?? {}, summary: `live ${operation}` } };
            }),
            executeActions: vi.fn(() => ({ executed: 0, results: [] })),
            listEntities: vi.fn(() => ({ live: true, entities: [] })),
            inspectEntity: vi.fn(() => ({ live: true, components: [] })),
            listRooms: vi.fn(() => ({ live: true, rooms: [] }))
        };
        const controller = new WorldAuthoringController({
            llmController: makeSeam([
                toolAnswer('propose_action', { operation: 'set_entity_stat', params: { traitId: 'Movement', statName: 'move', value: 200 } }, 'a'),
                toolAnswer('propose_action', { operation: 'move', params: { entityId: 'ent-1' }, target: 'b' }, 'b'),
                proseAnswer('First refused, so I parked it under the move action instead.')
            ]),
            registryStore: makeStore(),
            writer: noopWriter,
            operatorService
        });

        const turn = await controller.handleChat({ message: 'raise its pleasure by 200, or just move it' });

        expect(turn.actions).toHaveLength(1);
        expect(turn.actions[0].operation).toBe('move');
        expect(turn.actions[0].params).toEqual({ entityId: 'ent-1' });
        expect(turn.toolLog[0]).toMatchObject({ name: 'propose_action', ok: false });
        expect(turn.toolLog[0].detail).toMatch(/No entity attribute "Movement.move"/);
        expect(turn.toolLog[1]).toMatchObject({ name: 'propose_action', ok: true });
    });

    it('refuses to grow the plan past MAX_ACTIONS_PER_SESSION and says so to the model', async () => {
        const proposes = Array.from({ length: MAX_ACTIONS_PER_SESSION + 8 }, (_, i) =>
            toolAnswer('propose_action', { operation: 'move', params: {} }, `c${i}`)
        );
        const controller = new WorldAuthoringController({
            llmController: makeSeam([...proposes, proseAnswer('Table full.')]),
            registryStore: makeStore(),
            writer: noopWriter,
            operatorService: acceptingOperator()
        });

        let sessionId = null;
        const turns = [];
        for (let i = 0; i < 7; i++) {
            const turn = await controller.handleChat({ sessionId, message: `wish ${i}` });
            sessionId = turn.sessionId;
            turns.push(turn);
        }

        // Turn six landed four more (the cap filled); the last turn is prose only.
        expect(turns.at(-1).reply).toBe('Table full.');
        expect(turns.at(-1).actions).toHaveLength(MAX_ACTIONS_PER_SESSION);

        const overCapTurn = turns[5];
        expect(overCapTurn.toolLog.filter((t) => t.ok)).toHaveLength(4);
        expect(overCapTurn.toolLog.at(-1).ok).toBe(false);
        expect(overCapTurn.toolLog.at(-1).detail).toMatch(new RegExp(`cap ${MAX_ACTIONS_PER_SESSION}`));
    });

    it('executeActions runs the table through the operator (frozen report), clears it, and records it in history', async () => {
        const operatorService = {
            validateAction: vi.fn((operation, rawParams) => ({ ok: true, intent: { operation, params: rawParams ?? {}, summary: `live ${operation}` } })),
            executeActions: vi.fn(() => ({
                executed: 2,
                results: [
                    { operation: 'set_component_stat', summary: 'set Physical.existence -> 0.75', status: 'ok', result: true },
                    { operation: 'set_entity_stat', summary: 'set Pleasure.pleasure -> 15', status: 'error', error: 'No entity attribute "Pleasure.pleasure" for this entity. Known: none. For component stats, use set_component_stat with a component id.' }
                ]
            })),
            listEntities: vi.fn(() => ({ live: true, entities: [] })),
            inspectEntity: vi.fn(() => ({ live: true, components: [] })),
            listRooms: vi.fn(() => ({ live: true, rooms: [] }))
        };
        const controller = new WorldAuthoringController({
            llmController: makeSeam([
                toolAnswer('propose_action', { operation: 'set_component_stat', params: { entityId: 'ent-1', componentId: 'comp-1' } }, 'a'),
                toolAnswer('propose_action', { operation: 'set_entity_stat', params: { entityId: 'ent-1' }, target: 'b' }, 'b'),
                proseAnswer('Both on the table.'),
                proseAnswer('done')
            ]),
            registryStore: makeStore(),
            writer: noopWriter,
            operatorService
        });

        const turn = await controller.handleChat({ message: 'set existence, then pleasure' });
        expect(operatorService.executeActions).not.toHaveBeenCalled();
        expect(turn.actions).toHaveLength(2);

        const report = controller.executeActions(turn.sessionId);
        expect(report).toEqual({
            executed: 2,
            results: [
                expect.objectContaining({ operation: 'set_component_stat', status: 'ok', result: true }),
                expect.objectContaining({ operation: 'set_entity_stat', status: 'error', error: expect.stringContaining('No entity attribute') })
            ]
        });
        expect(Object.isFrozen(report.results)).toBe(true);
        expect(operatorService.executeActions).toHaveBeenCalledTimes(1);

        // The operator got the session's server-side actions (normalized params), in order.
        const sent = operatorService.executeActions.mock.calls[0][0];
        expect(sent).toHaveLength(2);
        expect(sent[0]).toMatchObject({ operation: 'set_component_stat', params: { entityId: 'ent-1', componentId: 'comp-1' } });
        expect(sent[1]).toMatchObject({ operation: 'set_entity_stat', params: { entityId: 'ent-1' } });

        // The table was cleared; the conversation now remembers what landed.
        expect(controller.getPlanStatus(turn.sessionId).actions).toHaveLength(0);
        const messages = controller.getHistory(turn.sessionId).messages.map((m) => m.content ?? '');
        expect(messages.join(' ')).toContain('[');
        expect(messages.join(' ')).toContain('[executed 2 action(s): ok (set Physical.existence -> 0.75); error (set Pleasure.pleasure -> 15)]');
    });

    it('executeActions on an empty table or unknown session throws typed errors, not 500s', async () => {
        const controller = new WorldAuthoringController({
            llmController: makeSeam([toolAnswer('list_entities', {}), proseAnswer('no plan.')]),
            registryStore: makeStore(),
            writer: noopWriter,
            operatorService: acceptingOperator()
        });
        const turn = await controller.handleChat({ message: 'look around' });

        expect(() => controller.executeActions(turn.sessionId)).toThrow(ActionsNotSetError);
        expect(() => controller.executeActions('missing')).toThrow(SessionNotFoundError);
    });

    it('clearPlan erases the table (cleared true), then is a harmless no-op (cleared false)', async () => {
        const controller = new WorldAuthoringController({
            llmController: makeSeam([
                toolAnswer('propose_action', { operation: 'move', params: {} }, 'a'),
                proseAnswer('On the table.'),
                proseAnswer('')
            ]),
            registryStore: makeStore(),
            writer: noopWriter,
            operatorService: acceptingOperator()
        });
        const turn = await controller.handleChat({ message: 'move it' });

        const cleared = controller.clearPlan(turn.sessionId);
        expect(cleared).toMatchObject({ sessionId: turn.sessionId, cleared: true });

        const again = controller.clearPlan(turn.sessionId);
        expect(again.cleared).toBe(false);
        expect(again.sessionId).toBe(turn.sessionId);
    });

    it('rejects an operatorService that lacks validateAction at construction', () => {
        expect(() => new WorldAuthoringController({
            llmController: makeSeam([proseAnswer('ok')]),
            registryStore: makeStore(),
            writer: noopWriter,
            operatorService: {}
        })).toThrow(TypeError);
    });

    it('throws a named error on a live tool path when the operator service is not wired', async () => {
        const controller = new WorldAuthoringController({
            llmController: makeSeam([toolAnswer('list_entities', {}), proseAnswer('no live world.')]),
            registryStore: makeStore(),
            writer: noopWriter
        });
        const turn = await controller.handleChat({ message: 'look around' });

        expect(turn.toolLog[0]).toMatchObject({ name: 'list_entities', ok: false });
        expect(turn.toolLog[0].detail).toContain('not wired');
        // And the table is empty; execute fails with the typed refusal, not a 500.
        expect(() => controller.executeActions(turn.sessionId)).toThrow(ActionsNotSetError);
    });
});
