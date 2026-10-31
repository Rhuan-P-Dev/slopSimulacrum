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
 *   - the official content survives both steps.
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
