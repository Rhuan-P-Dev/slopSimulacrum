/**
 * CardRelationshipStore — unit tests (the {{user}}-relationship sidecar seam,
 * CR B-3).
 *
 * The store is dumb byte I/O with an atomic write (tmp + rename, P-3); these
 * tests pin the name mappers, the list filters (the shared gallery
 * extension set, the sidecar suffix), the ENOENT degradation, the
 * read-degradation contract (corrupt or array → null, never throw), the
 * atomic write (an interrupted write leaves no half file behind) and the
 * idempotent delete. Temp dir per TST-8; no LLM in this module (TST-2 is
 * trivially satisfied).
 *
 * @module test/unit/CardRelationshipStore
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    SIDECAR_SUFFIX,
    SIDECAR_VERSION,
    sidecarNameFor,
    sidecarPathFor,
    listCardFileNames,
    listCardUserRelationshipFileNames,
    readCardUserRelationshipFile,
    writeCardUserRelationshipFile,
    deleteCardUserRelationshipFile
} from '../../src/utils/CardRelationshipStore.js';

let tmpDir;

beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'card-rel-store-'));
});

afterAll(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('sidecar name mapping (pure, no disk)', () => {
    it('maps a card file name to its sidecar name (stem + suffix)', () => {
        expect(sidecarNameFor('Connie Maheswaran-75538.png'))
            .toBe('Connie Maheswaran-75538.user-relationship.json');
        // extension-agnostic: any gallery extension (the shared
        // CARD_IMAGE_EXTS set) maps the same way
        expect(sidecarNameFor('card.webp')).toBe('card.user-relationship.json');
        expect(sidecarNameFor('card.jpeg')).toBe('card.user-relationship.json');
        expect(sidecarNameFor('card.gif')).toBe('card.user-relationship.json');
        expect(sidecarNameFor('card.bmp')).toBe('card.user-relationship.json');
    });

    it('uses only the basename (a nested path input maps its own file name)', () => {
        expect(sidecarNameFor('sub/card.png')).toBe('card.user-relationship.json');
    });

    it('builds the full sidecar path from the card dir and file name', () => {
        expect(sidecarPathFor('/cards', 'nova.png'))
            .toBe(path.join('/cards', 'nova.user-relationship.json'));
    });

    it('exports the version and suffix constants (P-1)', () => {
        expect(SIDECAR_VERSION).toBe(1);
        expect(SIDECAR_SUFFIX).toBe('.user-relationship.json');
    });
});

describe('list filters', () => {
    it('listCardFileNames keeps every gallery image extension (case-insensitive) and skips the rest', () => {
        for (const name of ['a.png', 'b.jpg', 'c.jpeg', 'd.webp', 'e.gif', 'f.bmp', 'G.PNG']) {
            fs.writeFileSync(path.join(tmpDir, name), 'x');
        }
        for (const name of ['readme.txt', 'a.user-relationship.json', 'noext']) {
            fs.writeFileSync(path.join(tmpDir, name), 'x');
        }
        expect(listCardFileNames(tmpDir).sort())
            .toEqual(['G.PNG', 'a.png', 'b.jpg', 'c.jpeg', 'd.webp', 'e.gif', 'f.bmp']);
    });

    it('listCardUserRelationshipFileNames keeps only sidecars (the suffix, case-sensitive)', () => {
        for (const name of ['a.user-relationship.json', 'b.user-relationship.json', 'c.png', 'd.user-relationship.json.tmp']) {
            fs.writeFileSync(path.join(tmpDir, name), 'x');
        }
        expect(listCardUserRelationshipFileNames(tmpDir).sort())
            .toEqual(['a.user-relationship.json', 'b.user-relationship.json']);
    });

    it('a missing directory yields an empty list (no cards yet), not a throw', () => {
        const missing = path.join(tmpDir, 'no-such-dir');
        expect(listCardFileNames(missing)).toEqual([]);
        expect(listCardUserRelationshipFileNames(missing)).toEqual([]);
    });
});

describe('read degradation (P-7: derived data degrades, never crashes)', () => {
    it('a missing sidecar yields null (the normal "no judgment yet" state)', () => {
        expect(readCardUserRelationshipFile(path.join(tmpDir, 'never-judged.user-relationship.json'))).toBeNull();
    });

    it('a corrupt sidecar (not JSON) yields null, not a throw', () => {
        const p = path.join(tmpDir, 'corrupt.user-relationship.json');
        fs.writeFileSync(p, 'not json at all {');
        expect(readCardUserRelationshipFile(p)).toBeNull();
    });

    it('a JSON array sidecar is not a record: null', () => {
        const p = path.join(tmpDir, 'array.user-relationship.json');
        fs.writeFileSync(p, '["devoted partner"]\n');
        expect(readCardUserRelationshipFile(p)).toBeNull();
    });

    it('a valid record reads back as an object', () => {
        const p = path.join(tmpDir, 'valid.user-relationship.json');
        const record = {
            version: SIDECAR_VERSION,
            cardId: 'valid',
            name: 'Valid',
            personaHash: '0'.repeat(64),
            judgedAt: '2026-01-01T00:00:00.000Z',
            relationship: { label: 'rival', summary: 'one sentence.' }
        };
        fs.writeFileSync(p, JSON.stringify(record, null, 2) + '\n');
        expect(readCardUserRelationshipFile(p)).toEqual(record);
    });
});

describe('atomic write (P-3)', () => {
    it('writes the record with a trailing newline and rewrites in place', () => {
        const p = path.join(tmpDir, 'roundtrip.user-relationship.json');
        writeCardUserRelationshipFile(p, { version: SIDECAR_VERSION, cardId: 'roundtrip' });
        const raw = fs.readFileSync(p, 'utf8');
        expect(raw.endsWith('\n')).toBe(true);
        expect(JSON.parse(raw).cardId).toBe('roundtrip');
        writeCardUserRelationshipFile(p, { version: SIDECAR_VERSION, cardId: 'roundtrip-v2' });
        expect(JSON.parse(fs.readFileSync(p, 'utf8')).cardId).toBe('roundtrip-v2');
        expect(fs.existsSync(`${p}.tmp`)).toBe(false);
    });

    it('an interrupted write (rename refused) leaves no tmp file and no half record', () => {
        // Deterministic rename failure: the target path is an existing
        // directory — rename(2) refuses a file-over-directory (EISDIR), so
        // the catch path runs exactly as it would on a real interruption.
        const dir = path.join(tmpDir, 'is-a-dir');
        fs.mkdirSync(dir);
        const target = path.join(tmpDir, 'refused');
        fs.mkdirSync(target);
        expect(() => writeCardUserRelationshipFile(target, { version: SIDECAR_VERSION })).toThrow();
        // the interrupted write left nothing behind
        expect(fs.existsSync(`${target}.tmp`)).toBe(false);
        // the target is still the directory it was (no half-written file)
        expect(fs.statSync(target).isDirectory()).toBe(true);
    });
});

describe('delete', () => {
    it('deletes an existing sidecar (returns true)', () => {
        const p = path.join(tmpDir, 'todelete.user-relationship.json');
        fs.writeFileSync(p, '{}\n');
        expect(deleteCardUserRelationshipFile(p)).toBe(true);
        expect(fs.existsSync(p)).toBe(false);
    });

    it('a missing sidecar is not an error (returns false)', () => {
        expect(deleteCardUserRelationshipFile(path.join(tmpDir, 'already-gone.user-relationship.json'))).toBe(false);
    });
});
