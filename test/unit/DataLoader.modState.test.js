/**
 * UNIT TEST — the mod state file: its shape, its defaults, and its round trip.
 *
 * `data/mods/loadorder.json` is user-editable tuning data, which sets the two contracts
 * tested here: reading it never throws (a hand-edited file must not keep the server from
 * starting), and writing it is stable (sorted by id, so a diff of the file says what
 * changed and nothing else).
 *
 * The path is fixed by the seam on purpose, so this test writes the file the next boot
 * reads. It therefore preserves whatever was there first — the state of a real install is
 * not a test fixture — and restores it afterwards.
 *
 * @module test/unit/DataLoader.modState
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import DataLoader, { MOD_STATE_PATH } from '../../src/utils/DataLoader.js';

/** What was in the file before this file ran, if anything (restored afterwards). */
let prior = null;
let hadPrior = false;

const writeRaw = (value) => {
    fs.writeFileSync(MOD_STATE_PATH, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
};

beforeAll(() => {
    hadPrior = fs.existsSync(MOD_STATE_PATH);
    if (hadPrior) prior = fs.readFileSync(MOD_STATE_PATH, 'utf8');
});

afterAll(() => {
    if (hadPrior) fs.writeFileSync(MOD_STATE_PATH, prior, 'utf8');
    else if (fs.existsSync(MOD_STATE_PATH)) fs.unlinkSync(MOD_STATE_PATH);
});

describe('reading', () => {
    it('treats an absent file as everything enabled at the default order', () => {
        if (fs.existsSync(MOD_STATE_PATH)) fs.unlinkSync(MOD_STATE_PATH);
        expect(DataLoader.loadModState()).toEqual({});
    });

    it('reads the documented shape: an array of { id, enabled, loadOrder }', () => {
        writeRaw({ mods: [{ id: 'core-traits', enabled: false, loadOrder: 50 }, { id: 'extra', enabled: true }] });
        expect(DataLoader.loadModState()).toEqual({
            'core-traits': { enabled: false, loadOrder: 50 },
            extra: { enabled: true }
        });
    });

    it('keeps an entry that only names an id, which is how "use the defaults" is written', () => {
        writeRaw({ mods: [{ id: 'core-traits' }] });
        expect(DataLoader.loadModState()).toEqual({ 'core-traits': {} });
    });

    it('ignores a field of the wrong type instead of taking the server down', () => {
        writeRaw({ mods: [{ id: 'a', enabled: 'no', loadOrder: 'first' }, { id: 'b', enabled: false }] });
        const state = DataLoader.loadModState();
        // `a` keeps no usable override, so it loads enabled at the default order; `b` is honored.
        expect(state.a).toEqual({});
        expect(state.b).toEqual({ enabled: false });
    });

    it('skips an entry without a usable id', () => {
        writeRaw({ mods: [{ enabled: false }, { id: '', enabled: false }, { id: 'kept', enabled: false }] });
        expect(Object.keys(DataLoader.loadModState())).toEqual(['kept']);
    });

    it('falls back to defaults when the file is not the documented shape at all', () => {
        writeRaw([]);
        expect(DataLoader.loadModState()).toEqual({});
        writeRaw({ mods: 'not-an-array' });
        expect(DataLoader.loadModState()).toEqual({});
        writeRaw('{ this is not json');
        expect(DataLoader.loadModState()).toEqual({});
    });
});

describe('writing', () => {
    it('round-trips, sorted by id, in the documented file shape', () => {
        DataLoader.saveModState({ zeta: { enabled: false }, alpha: { loadOrder: 2000 }, mid: {} });
        const raw = JSON.parse(fs.readFileSync(MOD_STATE_PATH, 'utf8'));
        expect(raw.mods.map((entry) => entry.id)).toEqual(['alpha', 'mid', 'zeta']);
        expect(DataLoader.loadModState()).toEqual({
            alpha: { loadOrder: 2000 },
            mid: {},
            zeta: { enabled: false }
        });
    });

    it('writes no field the reader would not use', () => {
        DataLoader.saveModState({ only: { enabled: undefined, loadOrder: 'soon', extra: 'ignored' } });
        const raw = JSON.parse(fs.readFileSync(MOD_STATE_PATH, 'utf8'));
        expect(raw.mods).toEqual([{ id: 'only' }]);
    });

    it('leaves no sibling .tmp behind (the write is rename-based)', () => {
        DataLoader.saveModState({ one: { enabled: false } });
        expect(fs.existsSync(`${MOD_STATE_PATH}.tmp`), 'temp file left in the mod directory').toBe(false);
    });
});
