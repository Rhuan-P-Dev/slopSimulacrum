/**
 * Killer LLM Drone — spawn-gate, loadout, and objective-persistence unit tests
 * (design spec §9.1, plans/killer_llm_drone_design.md).
 *
 * Construction/mock seam (mirrors test/unit/WorldStateController.npcValidation.test.js):
 *   - A single top-level vi.mock of '../../src/utils/DataLoader.js' serves a fixture
 *     data/npcs.json (entries mirroring the production field shape) and a minimal
 *     data/rooms.json; all other paths delegate to the real DataLoader.
 *   - The full controller is built via buildWorldState(tickSystem) — which already
 *     runs initializeWorld() → _spawnNpcs() — so the gate is evaluated at build time
 *     against the process.env state set by each test before the build.
 *   - The gate variable (KILLER_LLM_DRONE_ENABLED) is set per test; the ambient
 *     value (if any) is snapshotted and restored so a gate-ON verification run
 *     cannot leak into tests that expect the unset/off state.
 *
 * Covers (spec §9.1 rows 1-6):
 *   - gate matrix: unset / "false" / "true" / case-whitespace " TRUE " / other values
 *     ("1", "yes", "") → the drone spawns only for "true"; a skip log names the
 *     gate variable when gated out;
 *   - ungated NPC entries are unaffected by the gate (both directions);
 *   - a malformed (non-string) envGate means "no gate" — the entry spawns normally;
 *   - loadout: t1 and knife in inventory AND equipped on holding-capable
 *     components (passing the production canHoldItem check — never a bare
 *     droidArm; the knife lands on a hand, which is the only fine-controls
 *     component);
 *   - the t1 loadout is pre-loaded: its 10 declared knife contents nest inside
 *     the t1 instance (hostComponentId = the t1's item id) and surface via the
 *     public getContainerItems() facade;
 *   - an entry with initialItems but no contents spawns with every item host
 *     on a real component and zero nested children;
 *   - the objective is persisted into the drone's npcConfig, and the objective key
 *     is ABSENT from NPC configs of entries without one.
 *
 * @module test/unit/KillerLlmDroneSpawn
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import Logger from '../../src/utils/Logger.js';

// =========================================================================
// Fixture data (mirrors the production data/npcs.json field shape)
// =========================================================================

/** The env var the drone entry's envGate names (production: data/npcs.json). */
const GATE_VAR = 'KILLER_LLM_DRONE_ENABLED';

/**
 * The env-gated LLM drone entry — field-for-field the same shape as the
 * production killerLlmDrone entry (spec §3.2): NO ai block (routes to the LLM
 * agent), a non-empty objective, action-only caps, and an equip-flagged
 * loadout (the t1 pre-loaded with its full 10-knife magazine via contents).
 */
const KILLER_ENTRY = {
    displayName: 'Killer LLM Drone',
    room: 'start_room',
    personality: 'A cold, relentless hunter. It does not hesitate, does not warn, and does not stop.',
    objective: 'Attack all other entities: each round, strike the nearest entity you can reach; when nothing is in range, move toward the nearest one. Never help, never idle while a target is reachable.',
    maxWorldActionsPerRound: 2,
    maxChatMessagesPerRound: 0,
    envGate: GATE_VAR,
    initialItems: [
        { item: 't1', count: 1, equip: true, contents: [{ item: 'knife', count: 10 }] },
        { item: 'knife', count: 1, equip: true }
    ]
    // NO ai block: hasDeterministicBrain() is false → the LLM agent owns it.
};

/**
 * An ungated, deterministic-brain NPC entry (mirrors the production
 * smallBallDroid "Rogue Droid" entry) — the control entry proving the gate is
 * per-entry and that existing entries spawn exactly as before.
 */
const UNGATED_ENTRY = {
    displayName: 'Rogue Droid',
    room: 'start_room',
    personality: 'A rogue combat droid that hunts anything that moves in its room.',
    ai: { behavior: 'chase_attack' }
};

/**
 * A fixture entry whose envGate is present but malformed (non-string) — per the
 * gate contract, a missing/malformed envGate means "no gate" (spawn normally).
 */
const MALFORMED_GATE_ENTRY = {
    displayName: 'NoGateDroid',
    room: 'start_room',
    personality: 'A droid whose gate declaration is malformed.',
    envGate: 42
};

/**
 * A small, ungated fixture entry with initialItems but NO contents
 * declaration — the no-nesting control: every item host must resolve to a
 * real component and no item may be nested inside another.
 */
const NO_CONTENTS_ENTRY = {
    displayName: 'Plain Droid',
    room: 'start_room',
    personality: 'A droid that merely carries knives.',
    ai: { behavior: 'chase_attack' },
    initialItems: [
        { item: 'knife', count: 2 }
    ]
};

/** @type {Object|null} — set per-test; null = empty registry */
let fixtureNpcs = null;

/**
 * Sets the fixture npcs.json registry for the next buildWorldState call.
 * @param {Object} entries - Keyed map { [blueprint]: entry } (blueprint keys must
 *   exist in data/blueprints.json so spawnEntity can resolve them).
 */
function setFixture(entries) {
    fixtureNpcs = entries;
}

function resetFixture() {
    fixtureNpcs = null;
}

// =========================================================================
// Top-level DataLoader mock (hoisted by vitest)
// =========================================================================

vi.mock('../../src/utils/DataLoader.js', async () => {
    const actual = await vi.importActual('../../src/utils/DataLoader.js');
    const realDefault = actual.default || {};

    return {
        default: {
            loadJsonSafe(path, defaultValue) {
                if (path === 'data/npcs.json') {
                    return fixtureNpcs !== null ? fixtureNpcs : defaultValue;
                }
                if (path === 'data/rooms.json') {
                    // Minimal room definition that passes RoomsController validation
                    return {
                        start_room: {
                            name: 'Start Room',
                            description: 'A test room.',
                            x: 0,
                            y: 0,
                            width: 100,
                            height: 100,
                            connections: {}
                        }
                    };
                }
                // Delegate all other paths to the real DataLoader
                if (realDefault.loadJsonSafe) {
                    return realDefault.loadJsonSafe(path, defaultValue);
                }
                return defaultValue;
            }
        }
    };
});

// =========================================================================
// Helpers
// =========================================================================

// The gate is read at bootstrap (spawn time), not a runtime toggle — so each
// test sets the variable BEFORE building the world, and the snapshot/restore
// keeps tests independent of the ambient environment (including a gate-ON
// verification run of the whole suite).
const ambientGate = process.env[GATE_VAR];

/**
 * Sets the gate variable for the next world build.
 * @param {string|undefined} value - undefined = unset; any other string = set.
 */
function setGate(value) {
    if (value === undefined) {
        delete process.env[GATE_VAR];
    } else {
        process.env[GATE_VAR] = value;
    }
}

function restoreGate() {
    delete process.env[GATE_VAR];
    if (ambientGate !== undefined) {
        process.env[GATE_VAR] = ambientGate;
    }
}

/** Builds a fresh world with the fixture registry + current env (spec §5.1). */
function buildWorld(tickSystem) {
    const { worldStateController } = buildWorldState(tickSystem);
    return worldStateController;
}

/** Finds an NPC entity by its display name. */
function findNpcEntity(entities, name) {
    return Object.values(entities).find((e) => e.name === name);
}

/** Finds the drone entity (by blueprint) in the entity map. */
function findDroneEntity(entities) {
    return Object.values(entities).find((e) => e.blueprint === 'killerLlmDrone');
}

/** Resolves an entity component record (from the entity's components array) by id. */
function findComponent(entity, componentId) {
    return (entity.components || []).find((c) => c.id === componentId) || null;
}

/**
 * Collects the skip-log messages _spawnNpcs() emitted for gated-out entries.
 * The production log line: `npcs.json: "<displayName>" is gated by <var> (not "true") — skipped.`
 * @param {Array} infoCalls - Recorded Logger.info calls.
 * @returns {string[]}
 */
function skipLogs(infoCalls) {
    return infoCalls
        .map((c) => (c && typeof c[0] === 'string' ? c[0] : ''))
        .filter((msg) => msg.includes('is gated by') && msg.includes('skipped'));
}

// =========================================================================
// Tests
// =========================================================================

describe('WorldStateController._spawnNpcs — killer LLM drone (env-gated, LLM-routed)', () => {
    let infoSpy;
    let tickSystem;

    beforeEach(() => {
        infoSpy = vi.spyOn(Logger, 'info').mockImplementation(() => {});
        tickSystem = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
        resetFixture();
        delete process.env[GATE_VAR];
    });

    afterEach(() => {
        infoSpy.mockRestore();
        if (tickSystem) {
            try { tickSystem.stop(); } catch (_) { /* not started in all paths */ }
        }
        resetFixture();
        restoreGate();
    });

    // ---------------------------------------------------------------------
    // Gate matrix (spec §9.1 rows 1-3)
    // ---------------------------------------------------------------------

    it('with the env var UNSET (default), the drone is gated out and a skip log names the gate variable', () => {
        setGate(undefined);
        setFixture({ killerLlmDrone: KILLER_ENTRY, smallBallDroid: UNGATED_ENTRY });

        const wsc = buildWorld(tickSystem);
        const entities = wsc.getAll().entities;

        expect(findDroneEntity(entities)).toBeUndefined();
        const skipped = skipLogs(infoSpy.mock.calls).find((msg) => msg.includes('Killer LLM Drone'));
        expect(skipped).toBeDefined();
        expect(skipped).toContain(`is gated by ${GATE_VAR}`);
    });

    it('with the env var "false", the drone is not spawned and the skip log is emitted', () => {
        setGate('false');
        setFixture({ killerLlmDrone: KILLER_ENTRY, smallBallDroid: UNGATED_ENTRY });

        const wsc = buildWorld(tickSystem);

        expect(findDroneEntity(wsc.getAll().entities)).toBeUndefined();
        expect(skipLogs(infoSpy.mock.calls).some((msg) => msg.includes('Killer LLM Drone'))).toBe(true);
    });

    it('with the env var "true", the drone spawns as an NPC with no deterministic brain, at the room center', () => {
        setGate('true');
        setFixture({ killerLlmDrone: KILLER_ENTRY, smallBallDroid: UNGATED_ENTRY });

        const wsc = buildWorld(tickSystem);
        const drone = findDroneEntity(wsc.getAll().entities);

        expect(drone).toBeDefined();
        expect(drone.isNPC).toBe(true);
        expect(drone.name).toBe('Killer LLM Drone');
        // No ai block in the data → the persisted npcConfig.ai is null → the
        // routing predicate sends this entity to the LLM agent, not the
        // deterministic brain.
        expect(drone.npcConfig.ai ?? null).toBeNull();
        // Position: the fixture room is 100x100 → center (50, 50) (spec §7.2).
        expect(drone.spatial).toEqual({ x: 50, y: 50 });
        // Gate on → no skip log for the drone.
        expect(skipLogs(infoSpy.mock.calls).some((msg) => msg.includes('Killer LLM Drone'))).toBe(false);
    });

    it('the gate value is case-insensitive and trimmed: " TRUE " spawns the drone', () => {
        setGate(' TRUE ');
        setFixture({ killerLlmDrone: KILLER_ENTRY, smallBallDroid: UNGATED_ENTRY });

        const wsc = buildWorld(tickSystem);

        expect(findDroneEntity(wsc.getAll().entities)).toBeDefined();
        expect(skipLogs(infoSpy.mock.calls)).toHaveLength(0);
    });

    it('gate values other than "true" ("1", "yes", "") keep the drone gated out', () => {
        for (const value of ['1', 'yes', '']) {
            infoSpy.mockClear();
            setGate(value);
            setFixture({ killerLlmDrone: KILLER_ENTRY, smallBallDroid: UNGATED_ENTRY });

            const wsc = buildWorld(tickSystem);

            expect(findDroneEntity(wsc.getAll().entities), `gate "${value}" must not spawn the drone`).toBeUndefined();
            expect(skipLogs(infoSpy.mock.calls).some((msg) => msg.includes('Killer LLM Drone')),
                `gate "${value}" must emit the skip log`).toBe(true);
        }
    });

    // ---------------------------------------------------------------------
    // Per-entry gating: other NPC entries are unaffected (spec §9.1 rows 1/4)
    // ---------------------------------------------------------------------

    it('ungated NPC entries still spawn when the drone is gated out (existing entries are unaffected)', () => {
        setGate(undefined);
        setFixture({ killerLlmDrone: KILLER_ENTRY, smallBallDroid: UNGATED_ENTRY });

        const wsc = buildWorld(tickSystem);
        const entities = wsc.getAll().entities;

        const rogue = findNpcEntity(entities, 'Rogue Droid');
        expect(rogue).toBeDefined();
        expect(rogue.isNPC).toBe(true);
        // The existing entry keeps its exact persisted shape, including the
        // deterministic brain block (unchanged by the drone feature).
        expect(rogue.npcConfig.ai).toEqual({ behavior: 'chase_attack' });
        expect(findDroneEntity(entities)).toBeUndefined();
    });

    it('the gate is per-entry: the ungated NPC still spawns when the drone gate is on', () => {
        setGate('true');
        setFixture({ killerLlmDrone: KILLER_ENTRY, smallBallDroid: UNGATED_ENTRY });

        const wsc = buildWorld(tickSystem);
        const entities = wsc.getAll().entities;

        expect(findDroneEntity(entities)).toBeDefined();
        const rogue = findNpcEntity(entities, 'Rogue Droid');
        expect(rogue).toBeDefined();
        expect(rogue.npcConfig.ai).toEqual({ behavior: 'chase_attack' });
    });

    it('a malformed (non-string) envGate means "no gate": the entry spawns normally without a skip log', () => {
        setGate(undefined);
        setFixture({ smallBallDroid: MALFORMED_GATE_ENTRY, killerLlmDrone: KILLER_ENTRY });

        const wsc = buildWorld(tickSystem);
        const entities = wsc.getAll().entities;

        expect(findNpcEntity(entities, 'NoGateDroid')).toBeDefined();
        expect(findDroneEntity(entities)).toBeUndefined(); // drone stays gated (its gate is valid)
        expect(skipLogs(infoSpy.mock.calls).some((msg) => msg.includes('NoGateDroid'))).toBe(false);
    });

    // ---------------------------------------------------------------------
    // Loadout: initialItems with the equip flag (spec §3.3, §9.1 row 5)
    // ---------------------------------------------------------------------

    it('the drone spawns with t1 and knife in inventory, both equipped on holding-capable components (not a bare arm)', () => {
        setGate('true');
        setFixture({ killerLlmDrone: KILLER_ENTRY, smallBallDroid: UNGATED_ENTRY });

        const wsc = buildWorld(tickSystem);
        const drone = findDroneEntity(wsc.getAll().entities);
        expect(drone).toBeDefined();

        // Both loadout items are in the entity's inventory.
        const itemTypes = (drone.items || []).map((item) => item.type);
        expect(itemTypes).toContain('t1');
        expect(itemTypes).toContain('knife');

        // Both are EQUIPPED (not just held) — one equipped entry per item.
        const equipped = wsc.getEquippedItems(drone.id);
        const equippedTypes = equipped.map((e) => e.itemType).sort();
        expect(equippedTypes).toEqual(['knife', 't1']);

        // The "correct host component" guarantee: every equipped item sits on a
        // real component of the drone that passes the production holding-cost
        // check for that item type (the same canHoldItem gate equip() uses —
        // evaluated on the component's effective, material-derived stats), and
        // never on a bare arm. (In practice the t1 lands on the iron centralBall
        // — its derived strength/existence meet the t1 cost — while the knife
        // needs Manipulation.fine_controls, which only a hand provides.)
        const canHold = (itemType, componentId) =>
            wsc.holdingCostController.canHoldItem(itemType, wsc.getComponentStats(componentId)).success;
        for (const eq of equipped) {
            const host = findComponent(drone, eq.componentId);
            expect(host, `equipped ${eq.itemType} must sit on a real component of the drone`).not.toBeNull();
            expect(host.type, `${eq.itemType} must not be equipped on a bare arm`).not.toBe('droidArm');
            expect(canHold(eq.itemType, host.id),
                `${eq.itemType} must be equipped on a component that meets its holding cost (host: ${host.type})`).toBe(true);
        }

        // The knife specifically can only be held by a manipulator: its host
        // must actually carry Manipulation.fine_controls (no arm does).
        const knifeEq = equipped.find((e) => e.itemType === 'knife');
        const knifeHost = findComponent(drone, knifeEq.componentId);
        expect(wsc.getComponentStats(knifeHost.id).Manipulation?.fine_controls,
            'the knife must be held by a component with fine_controls').toBeGreaterThanOrEqual(10);

        // The held copy of each TOP-LEVEL item rides the same host component
        // the equip used (spec §3.3: add then equip on the same host) — never
        // a bare arm. An item whose hostComponentId is an item id is a NESTED
        // child (its host is the container item, not a component) — those are
        // asserted positively below, not in this component-host loop.
        const itemIds = new Set((drone.items || []).map((i) => i.id));
        for (const item of drone.items) {
            if (itemIds.has(item.hostComponentId)) continue;
            const host = findComponent(drone, item.hostComponentId);
            expect(host, `item ${item.type} must be held on a real component`).not.toBeNull();
            expect(host.type).not.toBe('droidArm');
        }

        // The t1 loadout instance is pre-loaded: all 10 declared knife
        // contents sit INSIDE the t1 — each nested knife's hostComponentId is
        // the t1 instance's item id (never a component id), and the public
        // getContainerItems() facade reports exactly those 10 knife children.
        const t1Item = (drone.items || []).find((i) => i.type === 't1');
        expect(t1Item, 'the drone must hold a t1 instance').toBeDefined();
        const knivesInT1 = (drone.items || []).filter(
            (i) => i.type === 'knife' && i.hostComponentId === t1Item.id
        );
        expect(knivesInT1, 'the 10 declared t1 contents must be nested knives').toHaveLength(10);
        const t1Children = wsc.getContainerItems(drone.id, t1Item.id);
        expect(t1Children, 'the t1 must report 10 children via the public facade').toHaveLength(10);
        expect(t1Children.every((i) => i.type === 'knife')).toBe(true);
    });

    // ---------------------------------------------------------------------
    // Objective persistence (spec §3.2, §6.2)
    // ---------------------------------------------------------------------

    it('persists the objective into the drone\'s npcConfig and leaves the key ABSENT on NPCs without one', () => {
        setGate('true');
        setFixture({ killerLlmDrone: KILLER_ENTRY, smallBallDroid: UNGATED_ENTRY });

        const wsc = buildWorld(tickSystem);
        const entities = wsc.getAll().entities;
        const drone = findDroneEntity(entities);
        const rogue = findNpcEntity(entities, 'Rogue Droid');
        expect(drone).toBeDefined();
        expect(rogue).toBeDefined();

        // The drone's objective is persisted verbatim into the stored npcConfig
        // (the value the LLM agent later renders as the "Objective:" prompt line).
        expect(drone.npcConfig.objective).toBe(KILLER_ENTRY.objective);
        // The rest of the persisted config keeps the production shape.
        expect(drone.npcConfig.personality).toBe(KILLER_ENTRY.personality);
        expect(drone.npcConfig.maxWorldActionsPerRound).toBe(2);
        expect(drone.npcConfig.maxChatMessagesPerRound).toBe(0);

        // Entries without an objective keep the EXACT pre-feature npcConfig
        // shape: the objective key itself is absent (not an empty string).
        expect(rogue.npcConfig).not.toHaveProperty('objective');
    });

    // ---------------------------------------------------------------------
    // Contents: initialItems without a contents declaration (no-nesting path)
    // ---------------------------------------------------------------------

    it('an NPC entry with initialItems but no contents spawns with every item host on a real component and zero nested children', () => {
        setGate(undefined);
        setFixture({ smallBallDroid: NO_CONTENTS_ENTRY });

        const wsc = buildWorld(tickSystem);
        const plain = findNpcEntity(wsc.getAll().entities, 'Plain Droid');
        expect(plain).toBeDefined();
        expect(plain.items).toHaveLength(2);

        const itemIds = new Set(plain.items.map((i) => i.id));
        for (const item of plain.items) {
            // No contents declared: every item's host must be a real
            // component (never an item id — nothing may be nested).
            expect(itemIds.has(item.hostComponentId),
                `item ${item.type} must not be nested inside another item`).toBe(false);
            const host = findComponent(plain, item.hostComponentId);
            expect(host, `item ${item.type} must be held on a real component`).not.toBeNull();
        }
        // And the public facade reports zero children for every item.
        for (const item of plain.items) {
            expect(wsc.getContainerItems(plain.id, item.id),
                `item ${item.type} must have zero nested children`).toHaveLength(0);
        }
    });
});
