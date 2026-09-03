/**
 * Targetability PARITY CONTRACT (subtask 4c).
 *
 * WHY this contract exists: two INDEPENDENT consumers each answer the question
 * "is this entity a viable target?" — the deterministic brain
 * (NpcAIController._isViableTarget, used by chase_attack) and the LLM context
 * (LlmContextController._isViableTarget, used to build the NEARBY ENTITIES
 * section). If they ever DISAGREE, the world desyncs: the brain can chase a
 * target the LLM never told the LLM agent about (phantom goal → stuck loop),
 * or the LLM can hand the model a target the brain refuses to pursue. Both now
 * delegate to the SAME shared core predicate (npcAiUtils.hasUsableComponent);
 * this test pins that the two full implementations (each with its own data-
 * source adapter) still yield IDENTICAL verdicts across the whole component
 * matrix, so a future edit to either reader — or to the shared predicate — that
 * breaks parity is caught here, not in production.
 *
 * The matrix is driven through BOTH _isViableTarget implementations DIRECTLY
 * (each controller is freshly constructed with a facade / worldState bound to
 * the row's entity + component-stats map). For every row we assert the two
 * verdicts are equal (the core contract) AND that they match the expected
 * value (pinning the absolute semantics, not just relative agreement).
 *
 * The two readers differ only in their data-source adapter: the brain's
 * _readExistence adds a flat-key fallback for test fixtures (no flat-key stats
 * exist in this matrix, so it degrades to the authoritative nested read and
 * agrees with the LLM's inline getComponentStats() reader).
 */

import { describe, it, expect } from 'vitest';
import NpcAIController from '../../src/controllers/ai/NpcAIController.js';
import LlmContextController from '../../src/controllers/networking/LlmContextController.js';

/**
 * Build an entity + the authoritative nested component-stats map from a list
 * of { id, existence } rows.
 *
 * - A row with a finite numeric `existence` gets a nested stat entry:
 *   `{ Physical: { existence } }` (TRAIT_GROUPS.PHYSICAL / STAT_NAMES.EXISTENCE).
 * - A row with `existence: null` has NO authoritative stat — getComponentStats
 *   returns null for it (the "existence unknown" case).
 *
 * Component instances carry NO flat-key stats, so the brain's flat-key fallback
 * also yields "unknown" for stat-less components — the two readers agree.
 *
 * @param {Array<{id: string, existence: (number|null)}>} rows
 * @returns {{ entity: Object, componentStatsMap: Object<string, Object> }}
 */
function buildWorld(rows) {
    const componentInstances = rows.map(r => ({
        id: r.id,
        type: 'Metal',
        state: { durability: 100 },
    }));

    const componentStatsMap = {};
    for (const r of rows) {
        if (typeof r.existence === 'number' && Number.isFinite(r.existence)) {
            componentStatsMap[r.id] = { Physical: { existence: r.existence } };
        }
    }

    const entity = {
        id: 'ent-parity-target',
        name: 'Parity Droid',
        location: 'room-main',
        spatial: { x: 0, y: 0 },
        components: componentInstances,
    };
    return { entity, componentStatsMap };
}

/**
 * Drive one matrix row through BOTH _isViableTarget implementations and return
 * their verdicts. Each controller is freshly constructed with a facade /
 * worldState bound to this row's entity + component-stats map, so the shared
 * predicate is exercised with each consumer's own data-source adapter.
 *
 * @param {Array<{id: string, existence: (number|null)}>} rows
 * @returns {{ ai: boolean, llm: boolean }}
 */
function driveRow(rows) {
    const { entity, componentStatsMap } = buildWorld(rows);

    // The deterministic brain: facade exposes getEntity (the live read) plus the
    // authoritative nested store. _isViableTarget resolves the live entity via
    // getEntity and reads existence through _readExistence (nested, then
    // flat-key fallback — which is absent here).
    const aiFacade = {
        getEntities: () => ({ [entity.id]: entity }),
        getEntity: (id) => (id === entity.id ? entity : null),
        getComponentStats: (compId) => componentStatsMap[compId] ?? null,
        getComponent: () => null,
    };
    // The NpcAIController constructor takes { worldStateController, turnSystem-
    // Controller }; the worldStateController doubles as the read facade. The
    // turn system is irrelevant to viability (only _isViableTarget is exercised
    // here, which reads the facade directly).
    const ai = new NpcAIController({ worldStateController: aiFacade, turnSystemController: null });

    // The LLM context: worldState exposes getAll (the snapshot source) plus the
    // authoritative nested store. _isViableTarget reads existence inline via
    // getComponentStats (no flat-key fallback).
    const llmWorldState = {
        getAll: () => ({ entities: { [entity.id]: entity } }),
        getComponentStats: (compId) => componentStatsMap[compId] ?? null,
    };
    // The LlmContextController takes { actionRegistry } and injects the world
    // state facade post-construction.
    const llm = new LlmContextController({ actionRegistry: {} });
    llm.setWorldStateController(llmWorldState);

    return {
        ai: ai._isViableTarget(entity),
        llm: llm._isViableTarget(entity),
    };
}

/**
 * Assert the two verdicts agree (the core contract) AND both equal the expected
 * value (pinning the absolute semantics).
 *
 * @param {string} rowName — for readable failure messages
 * @param {{ ai: boolean, llm: boolean }} verdicts
 * @param {boolean} expected — the absolute expected viability
 */
function assertParity(rowName, verdicts, expected) {
    const { ai, llm } = verdicts;
    // The core contract: the brain and the LLM context must NEVER disagree.
    expect(ai, `PARITY — ${rowName}: brain=${ai} but llm=${llm}`).toBe(llm);
    // And both must match the pinned expected semantics.
    expect(ai, `${rowName}: expected viable=${expected}, got brain=${ai} llm=${llm}`).toBe(expected);
}

describe('Targetability parity contract (deterministic brain ≡ LLM context)', () => {

    it('the full component matrix: identical verdicts (and matching the expected semantics) on every row', () => {
        const rows = [
            {
                name: 'living entity (all components existence > 0)',
                rows: [
                    { id: 'c-core', existence: 1.0 },
                    { id: 'c-arm', existence: 0.42 },
                ],
                expected: true,
            },
            {
                name: 'component-less ghost (no components)',
                rows: [],
                expected: false,
            },
            {
                name: 'mid-cascade wreck (all components existence 0, not yet removed)',
                rows: [
                    { id: 'c-core', existence: 0 },
                    { id: 'c-arm', existence: 0 },
                ],
                expected: false,
            },
            {
                name: 'existence-unknown component (no authoritative stat)',
                rows: [
                    { id: 'c-core', existence: null },
                ],
                expected: true,
            },
            {
                name: 'single usable among broken (one > 0, one 0)',
                rows: [
                    { id: 'c-core', existence: 0.5 },
                    { id: 'c-arm', existence: 0 },
                ],
                expected: true,
            },
        ];

        for (const row of rows) {
            assertParity(row.name, driveRow(row.rows), row.expected);
        }
    });

    it('mixed unknown + gone components: the unknown component is usable → viable (parity held)', () => {
        const name = 'one existence-unknown + one existence-0';
        const rows = [
            { id: 'c-unknown', existence: null },
            { id: 'c-gone', existence: 0 },
        ];
        assertParity(name, driveRow(rows), true);
    });

    it('all components existence-unknown (no authoritative stats at all) → viable (parity held)', () => {
        const name = 'all existence unknown';
        const rows = [
            { id: 'c-a', existence: null },
            { id: 'c-b', existence: null },
        ];
        assertParity(name, driveRow(rows), true);
    });

    it('all components existence-0 AND one unknown → viable (parity held)', () => {
        const name = 'gone + unknown mixed (unknown wins)';
        const rows = [
            { id: 'c-gone', existence: 0 },
            { id: 'c-unknown', existence: null },
        ];
        assertParity(name, driveRow(rows), true);
    });

});
