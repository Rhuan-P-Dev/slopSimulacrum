/**
 * INTEGRATION TEST — a queued mod change reaches the running world at the round boundary.
 *
 * This is the runtime half of the mod system, and the half a unit test cannot make
 * credible: `ModService` could compute the right candidate and still be wired to nothing.
 * Here a real world is built (the official packages plus one fixture package), a package is
 * disabled while the world runs, and the turn machine is advanced. The claims:
 *
 *   - the fixture package contributes at boot;
 *   - `disable` changes the wish and NOT the world (`pending`, definition untouched);
 *   - the FIRST round start swaps the definition — the content is gone from the store every
 *     controller reads, and the store version moved;
 *   - the official content survives both steps; and
 *   - the map grows with the definition that describes it: a room authored in a package is
 *     a room of the RUNNING world after the swap, and a room already there is never moved,
 *     resized or removed by one (`wiki/decisions/world-structure-authoring.md`).
 *
 * The package directory is the real `data/mods` tree, copied into a temp dir, with the
 * fixture package added to the copy: a fixture package alone would not be a world at all
 * (no rooms, no entities). The enable / load-order state is in memory, because this test
 * must not write `data/mods/loadorder.json` — the file the next boot reads.
 *
 * @module test/integration/modApplyAtRoundBoundary
 */

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import ModLoader, { MOD_BASE_DIR, MANIFEST_FILE } from '../../src/services/ModLoader.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';

const MOD_ID = 'itest-boundary';
const PART = 'itestBoundaryPart';
const COMPONENT_KIND = REGISTRY_KINDS.COMPONENTS;

/** The package that authors a room, and the room it authors. */
const ROOM_MOD_ID = 'itest-annex';
const ANNEX = 'itest_annex';

/** A room the map can be built from, hung off the official `start_room`. */
const annexRoom = () => ({
    name: 'Integration Annex',
    connections: { back_to_start: { target: 'start_room' } },
    x: 900,
    y: 400,
    width: 220,
    height: 160,
    atmosphere: { lightLevel: 'dim', airQuality: 'stale' }
});

/** A well-formed component: the shape the official catalog ships. */
const part = () => ({
    name: 'Boundary test part',
    slotType: 'core',
    tags: ['itest'],
    maxCondition: 100,
    weight: 1,
    cost: 1,
    volume: 1,
    materialRef: 'steel',
    craftable: true,
    requiresProficiency: false
});

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-mod-boundary-'));
fs.cpSync(MOD_BASE_DIR, tmpBase, { recursive: true });

/** Add one package directory to the copied tree. */
function writePackage(id, files) {
    const dir = path.join(tmpBase, id);
    fs.mkdirSync(dir, { recursive: true });
    const kinds = Object.keys(files);
    fs.writeFileSync(
        path.join(dir, MANIFEST_FILE),
        JSON.stringify({ id, version: '1.0.0', content: kinds }),
        'utf8'
    );
    for (const [kind, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, `${kind}.json`), JSON.stringify(content), 'utf8');
    }
}

writePackage(MOD_ID, { [COMPONENT_KIND]: { [PART]: part() } });
// Installed at boot, so the map has the annex from the start — the test that grows the map
// writes a SECOND room package after the world is already running.
writePackage(ROOM_MOD_ID, { [REGISTRY_KINDS.ROOMS]: { [ANNEX]: annexRoom() } });

afterAll(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
});

/** In-memory state store, so no test writes the boot-time file. */
const memState = () => {
    const holder = { state: {} };
    return {
        load: () => ({ ...holder.state }),
        save: (next) => { holder.state = JSON.parse(JSON.stringify(next)); }
    };
};

/** A real world whose definition comes from the official packages plus one fixture. */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const built = buildWorldState(tick, null, {
        modLoader: new ModLoader({ baseDir: tmpBase }),
        modStateStore: memState()
    });
    return {
        wsc: built.worldStateController,
        store: built.registryStore,
        modService: built.modService,
        tick,
        turns: built.subControllers.turnSystemController
    };
}

/** Open a round: this is what fires the turn-start hook, and so what drains the queue. */
function openRound(tick, turns) {
    tick.currentTick = tick.currentTick + 1;
    turns.onTick();
    return turns.getRoundState();
}

describe('the round boundary applies a queued mod change', () => {
    it('honors the package at boot', () => {
        const { store } = buildWorld();
        expect(store.read(COMPONENT_KIND)[PART]).toBeDefined();
    });

    it('leaves the running world alone until a round opens, then swaps it', () => {
        const { store, modService, tick, turns } = buildWorld();
        const versionAtBoot = store.version();
        const officialCount = Object.keys(store.read(COMPONENT_KIND)).length;

        const result = modService.disable(MOD_ID);
        expect(result).toMatchObject({ enabled: false, pending: true });
        // Still running it: no mid-round swap, whatever the caller asked a moment ago.
        expect(store.read(COMPONENT_KIND)[PART]).toBeDefined();
        expect(store.version()).toBe(versionAtBoot);

        openRound(tick, turns);

        expect(store.read(COMPONENT_KIND)[PART]).toBeUndefined();
        expect(store.version()).toBe(versionAtBoot + 1);
        expect(modService.pending).toBe(false);
        expect(modService.lastApply.swappedKinds).toContain(COMPONENT_KIND);
        // The official catalog survived the swap: this replaced one kind with the
        // official-plus-fixture-minus-disabled definition, not the fixture alone.
        expect(Object.keys(store.read(COMPONENT_KIND)).length).toBe(officialCount - 1);
    });

    it('keeps the world unchanged when nothing is queued', () => {
        const { store, modService, tick, turns } = buildWorld();
        const versionAtBoot = store.version();
        const catalog = JSON.stringify(store.read(COMPONENT_KIND));

        openRound(tick, turns);
        openRound(tick, turns);

        expect(store.version()).toBe(versionAtBoot);
        expect(JSON.stringify(store.read(COMPONENT_KIND))).toBe(catalog);
        expect(modService.lastApply).toBeNull();
    });
});

describe('the official dependency graph', () => {
    /** The code that a call threw, or null. */
    const codeOf = (fn) => {
        try {
            fn();
        } catch (error) {
            return error.code;
        }
        return null;
    };

    it('refuses to pull a load-bearing package out from under the world', () => {
        const { store, modService } = buildWorld();
        const versionAtBoot = store.version();

        let thrown = null;
        try {
            modService.disable('core-materials');
        } catch (error) {
            thrown = error;
        }

        expect(thrown?.code).toBe('MOD_REQUIREMENT_HELD');
        // The refusal names what blocks it, in the same breath as what to do about it.
        expect(thrown.message).toContain('core-components');
        expect(thrown.message).toContain('core-material-damage-types');
        expect(thrown.message).toContain('disable those first');
        // And it is the whole effect: no write, no queue, no swap.
        expect(modService.list().pending).toBe(false);
        expect(store.version()).toBe(versionAtBoot);
        expect(store.read(REGISTRY_KINDS.MATERIALS).wood).toBeDefined();
    });

    it('lets the operator reach a world without them, in dependency order', () => {
        const { store, modService } = buildWorld();

        // Unofficial overlays hold the official packages they require, and that IS what
        // `requires` is for, and a refusal from one is the rule working, not a defect in it.
        // This test unwinds the OFFICIAL graph, so every overlay installed on this machine
        // is set aside first (this test's own fixture package among them).
        for (const overlay of modService.rescan().mods.filter((mod) => !mod.official)) {
            expect(codeOf(() => modService.disable(overlay.id)), overlay.id).toBeNull();
        }

        // items are held by crafting, by machines and by the outfits that name a garment
        // (`core-outfits` requires `core-inventory-items`); crafting is held by machines.
        // So the chain has to be unwound from the top, and each refusal says so.
        expect(codeOf(() => modService.disable('core-inventory-items'))).toBe('MOD_REQUIREMENT_HELD');
        expect(codeOf(() => modService.disable('core-machines'))).toBeNull();
        expect(codeOf(() => modService.disable('core-crafting'))).toBeNull();
        expect(codeOf(() => modService.disable('core-outfits'))).toBeNull();
        // With the last holder gone, the item package is reachable - and the world it
        // leaves behind is one where no body is dressed by outfit, so the spawn
        // loadouts' default garment is back on duty (`OutfitLogic.clothedByOutfit`).
        expect(codeOf(() => modService.disable('core-inventory-items'))).toBeNull();

        // materials are still held by the definitions that name a material.
        expect(codeOf(() => modService.disable('core-materials'))).toBe('MOD_REQUIREMENT_HELD');
        modService.disable('core-components');
        modService.disable('core-material-damage-types');
        modService.disable('core-material-drop-rates');
        expect(codeOf(() => modService.disable('core-materials'))).toBeNull();

        // The candidate this leaves is one the world's own rules can classify, and the plan
        // reports the removals rather than crashing on them.
        const plan = modService.plan();
        const removed = plan.kinds.find((kind) => kind.kind === REGISTRY_KINDS.MATERIALS);
        expect(removed && removed.removedCount).toBeGreaterThan(0);
        expect(store.read(REGISTRY_KINDS.MATERIALS).wood).toBeDefined();  // still pending, not applied
    });
});

describe('the map grows with the definition', () => {
    it('builds an authored room at boot, connected to the official map', () => {
        const { wsc } = buildWorld();

        const annexUid = wsc.getRoomUidByLogicalId(ANNEX);
        expect(annexUid).toBeTruthy();
        const rooms = wsc.getRooms();
        expect(rooms[annexUid].name).toBe('Integration Annex');
        expect(rooms[annexUid].connections.back_to_start.target)
            .toBe(wsc.getRoomUidByLogicalId('start_room'));
        expect(wsc.getRoomLogicalId(annexUid)).toBe(ANNEX);
    });

    it('takes on a room written after boot, at the swap, and reports what the map did', () => {
        const { wsc, modService } = buildWorld();
        const before = wsc.getRooms();
        const beforeUids = Object.keys(before);

        // A package appears on disk while the world runs — the operator's Write click, or a
        // hand-authored directory. Nothing has been applied yet.
        writePackage('itest-late-annex', {
            [REGISTRY_KINDS.ROOMS]: { itest_late: { ...annexRoom(), name: 'Late Annex', x: 1200, y: 0 } }
        });
        const answer = modService.requestApply();

        expect(answer.applied).toBe(true);
        const lateUid = wsc.getRoomUidByLogicalId('itest_late');
        expect(lateUid).toBeTruthy();
        expect(wsc.getRooms()[lateUid].name).toBe('Late Annex');
        expect(Object.keys(wsc.getRooms())).toHaveLength(beforeUids.length + 1);
        expect(answer.report.map.added).toEqual([{ logicalId: 'itest_late', roomId: lateUid }]);
    });

    it('never removes, moves or renames an installed room — not even when its package goes away', () => {
        const { wsc, store, modService, tick, turns } = buildWorld();
        const annexUid = wsc.getRoomUidByLogicalId(ANNEX);
        const atBoot = wsc.getRooms()[annexUid];

        expect(modService.disable(ROOM_MOD_ID)).toMatchObject({ enabled: false, pending: true });
        openRound(tick, turns);

        // The definition no longer describes the room — and the running map keeps it. The
        // uid is where entities stand and what this round already named; a swap that edited
        // or deleted it would be a corruption, not an update. The room is gone at the next
        // boot, which is what "additive only" costs, said out loud.
        expect(store.read(REGISTRY_KINDS.ROOMS)[ANNEX]).toBeUndefined();
        const stillThere = wsc.getRooms()[annexUid];
        expect(stillThere).toEqual(atBoot);
    });
});

/**
 * Props are population (`wiki/decisions/world-structure-authoring.md`).
 *
 * The half of the goal the room tests do not cover: a `worldObjects` entry authored into a
 * package has to arrive in a world created AFTER the apply, without a process restart. That is
 * only credible end-to-end — the apply has to land in the same store the world-create pass
 * reads, and the pass has to build a real prop. It also pins the one shape the shipped prop file
 * relies on and no rule test named: a `room` field that is ABSENT means `start_room`.
 */
describe('a prop authored into a package arrives when a world is created', () => {
    it('is not there when the apply lands, and is there after a world create', () => {
        const { wsc, modService } = buildWorld();
        const annexUid = wsc.getRoomUidByLogicalId(ANNEX);
        const startUid = wsc.getRoomUidByLogicalId('start_room');
        const named = () => Object.values(wsc.getAll().entities).filter((e) => e.name === 'Integration Bench');
        const propMod = 'itest-props';

        expect(named(), 'no such prop before the package exists').toHaveLength(0);

        writePackage(propMod, {
            [REGISTRY_KINDS.WORLD_OBJECTS]: {
                itest_bench: { name: 'Integration Bench', blueprint: 'tree', room: ANNEX, position: { x: 10, y: -5 } },
                // No `room` at all: the shape the official worldObjects.json uses, read as
                // `start_room` by the spawn pass.
                itest_loose_bench: { name: 'Integration Bench', blueprint: 'tree' }
            }
        });
        const answer = modService.requestApply();
        expect(answer.applied).toBe(true);

        // Applied is not arrived. Props are population: a running world takes them at the next
        // world create, exactly like an NPC. Nothing in the apply puts a prop on the map.
        expect(named(), 'an apply alone does not spawn population').toHaveLength(0);

        // The real world-create path, with an empty card selection (MODS.md: "props, nobody in
        // the room") so this asserts the prop pass and nothing else.
        wsc.recreateWorld({ cardIds: [] });

        const props = named();
        expect(props).toHaveLength(2);
        expect(props.every((p) => p.isStatic), 'a prop is a static entity, the same kind boot spawns').toBe(true);
        const placed = props.find((p) => p.location === annexUid);
        const defaulted = props.find((p) => p.location === startUid);
        expect(placed, 'the prop with a room stands in that room').toBeTruthy();
        expect(placed.spatial).toEqual({ x: 10, y: -5 });
        expect(defaulted, 'the prop with no room stands in start_room').toBeTruthy();
    });
});

/**
 * The HTTP half of the gate.
 *
 * `POST /mods/apply` calls `ModService.requestApply()`, which asks an injected
 * `roundGate` before swapping anything. A unit test can prove the service honors
 * the answer; only the composition root can prove the answer it gets is the turn
 * system's. Before the first round, `isRoundActive()` must be false even though
 * the round *display* defaults to "planning" - otherwise an apply would defer
 * forever in a process that has never started a round.
 */
describe('the composition root gates an apply on the round', () => {
    it('wires the turn system as the apply gate', () => {
        const { modService, turns } = buildWorld();

        expect(typeof modService.roundGate).toBe('function');
        expect(turns.isRoundActive()).toBe(false);
        expect(modService.roundGate()).toBe(turns.isRoundActive());
    });

    it('applies on request while no round is open, in the same store the world reads', () => {
        const { store, modService, turns } = buildWorld();
        const versionAtBoot = store.version();

        const answer = modService.requestApply();
        expect(answer).toMatchObject({ applied: true, pending: false, appliesAt: 'immediate' });
        expect(store.version()).toBe(versionAtBoot + 1);
        expect(turns.isRoundActive()).toBe(false);
    });
});
