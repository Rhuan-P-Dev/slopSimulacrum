/**
 * PngCharaReader — unit tests.
 *
 * The reader parses a PNG's `tEXt`/`iTXt` metadata side channel and decodes
 * the base64-encoded character payload. These tests cover: the real card file
 * in `data/cards/` (the happy path, nested `data` shape), the flat (no
 * `data` wrapper) shape, and every degradation path (missing file, non-PNG
 * bytes, a PNG with no character metadata, and a corrupted tail).
 *
 * @module test/unit/PngCharaReader
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readCharaCard } from '../../src/utils/PngCharaReader.js';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const FRISK_PNG = path.resolve('data/cards/Frisk-69286.png');

// =========================================================================
// Minimal PNG builders (enough framing for the reader; the reader does not
// verify CRCs or pixel data, so the IDAT bytes are a no-op placeholder).
// =========================================================================

/**
 * Emits the bytes for a single PNG chunk: 4-byte big-endian length + 4-byte
 * ASCII type + payload + 4-byte CRC (placeholder, not validated).
 * @param {string} type
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function pngChunk(type, payload) {
    return Buffer.concat([
        Buffer.from([0, 0, 0, payload.length]),
        Buffer.from(type, 'ascii'),
        payload,
        Buffer.from([0, 0, 0, 0])
    ]);
}

/**
 * Builds a valid-framed 1x1 PNG. If `tEXtKeyword`/`tEXtValue` are given, a
 * `tEXt` side channel is included (keyword \0 value); otherwise no metadata.
 * @param {string|null} tEXtKeyword
 * @param {string|null} tEXtValue
 * @returns {Buffer}
 */
function buildPng(tEXtKeyword, tEXtValue) {
    const ihdrData = Buffer.from([
        0x00, 0x00, 0x00, 0x01,
        0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00
    ]);
    const idatData = Buffer.from([0x78, 0x01]);
    const pieces = [
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ];
    pieces.push(pngChunk('IHDR', ihdrData));
    if (tEXtKeyword !== null && tEXtValue !== null) {
        const tEXtPayload = Buffer.concat([
            Buffer.from(tEXtKeyword, 'ascii'),
            Buffer.from([0x00]),
            Buffer.from(tEXtValue, 'utf8')
        ]);
        pieces.push(pngChunk('tEXt', tEXtPayload));
    }
    pieces.push(pngChunk('IDAT', idatData));
    pieces.push(pngChunk('IEND', Buffer.from([])));
    return Buffer.concat(pieces);
}

let tmpDir;
beforeAll(async () => {
    tmpDir = await mkdtemp(`${os.tmpdir()}/pngr-reader-`);
});
// Vitest cleans up via process exit; the dir lives under os.tmpdir for this
// run and is safe to leave.

function writeFile(name, bytes) {
    fs.writeFileSync(path.join(tmpDir, name), bytes);
    return path.join(tmpDir, name);
}

// =========================================================================
// Real card (happy path)
// =========================================================================

describe('readCharaCard', () => {
    it('extracts the embedded nested payload from the real Frisk PNG', () => {
        const res = readCharaCard(FRISK_PNG);
        expect(res.success).toBe(true);
        expect(res.card).toMatchObject({ name: 'Frisk' });
        expect(typeof res.card.description).toBe('string');
        expect(res.card.description.length).toBeGreaterThan(0);
        // The Frisk card ships `personality: ''` and puts the lore in
        // `description`; the reader must surface both for the controller's
        // fallback chain.
        expect(typeof res.card.personality).toBe('string');
        expect(res.card.personality).toBe('');
    });

    it('returns success:false for a file that does not exist', () => {
        const res = readCharaCard(path.join(tmpDir, 'does-not-exist.png'));
        expect(res.success).toBe(false);
        expect(res.card).toBeNull();
        expect(res.error).toBeDefined();
    });

    it('returns success:false for bytes that are not a PNG', () => {
        const res = readCharaCard(writeFile('junk.bin', 'hello, this is not a png'));
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/PNG/);
    });

    it('returns success:false for a well-framed PNG with no character metadata', () => {
        const res = readCharaCard(writeFile('plain.png', buildPng(null, null)));
        expect(res.success).toBe(false);
        expect(res.card).toBeNull();
    });

    it('returns success:false when metadata is present but not a decodable card', () => {
        const res = readCharaCard(writeFile('no-payload.png', buildPng('artist', 'Jane Doe')));
        expect(res.success).toBe(false);
        expect(res.card).toBeNull();
    });

    it('decodes a synthetic chara card (nested data shape)', () => {
        const payload = {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                name: 'Testa',
                personality: 'A quiet tinkerer who fixes broken things.',
                description: 'Name: Testa Age: 30'
            }
        };
        const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
        const res = readCharaCard(writeFile('nested.png', buildPng('chara', b64)));
        expect(res.success).toBe(true);
        expect(res.card.name).toBe('Testa');
        expect(res.card.personality).toBe('A quiet tinkerer who fixes broken things.');
    });

    it('decodes a synthetic flat card (no data wrapper)', () => {
        const payload = { name: 'Flat', personality: 'Flat personality text.' };
        const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
        const res = readCharaCard(writeFile('flat.png', buildPng('chara', b64)));
        expect(res.success).toBe(true);
        expect(res.card.name).toBe('Flat');
        expect(res.card.personality).toBe('Flat personality text.');
    });

    it('prefers the chara keyword when multiple tEXt chunks are present', () => {
        const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0x08, 0x02, 0, 0, 0]);
        const idat = Buffer.from([0x78, 0x01]);
        const b64Wrong = Buffer.from(JSON.stringify({ name: 'Wrong' }), 'utf8').toString('base64');
        const b64Right = Buffer.from(JSON.stringify({ name: 'Right' }), 'utf8').toString('base64');
        const wrongPayload = Buffer.concat([Buffer.from('other'), Buffer.from([0]), Buffer.from(b64Wrong, 'utf8')]);
        const rightPayload = Buffer.concat([Buffer.from('chara'), Buffer.from([0]), Buffer.from(b64Right, 'utf8')]);
        const all = Buffer.concat([
            header,
            pngChunk('IHDR', ihdr),
            pngChunk('tEXt', wrongPayload),
            pngChunk('tEXt', rightPayload),
            pngChunk('IDAT', idat),
            pngChunk('IEND', Buffer.from([]))
        ]);
        const res = readCharaCard(writeFile('prefers-multi.png', all));
        expect(res.success).toBe(true);
        expect(res.card.name).toBe('Right');
    });

    it('handles a truncated chunk tail without throwing', () => {
        const full = buildPng('chara', Buffer.from(JSON.stringify({ name: 'Trunc' }), 'utf8').toString('base64'));
        const buf = Buffer.alloc(full.length);
        full.copy(buf);
        const truncated = buf.slice(0, 30); // cut mid-chunk
        const res = readCharaCard(writeFile('truncated-cut.png', truncated));
        // Either it decodes a card or it fails cleanly; it must never throw.
        expect(res.success === false).toBe(res.card === null);
    });
});
