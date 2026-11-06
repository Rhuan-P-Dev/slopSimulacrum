/**
 * UNIT TEST — ModPackageWriter: the bytes of one data-only mod package.
 *
 * What is pinned here is the writer's own contract, not the world's: an id may become a
 * directory or it may not, the official prefix is refused, every declared kind gets a file
 * and a manifest entry, an overwrite backs up what it replaces, and a refusal leaves
 * nothing behind. What a definition means is NOT tested here — that is
 * `WorldProposalValidator` and the classifier behind it.
 *
 * Fixtures are real directories under `data/` (created here, removed afterwards), because
 * the writer goes through the data seam — there is no injected filesystem to fake,
 * deliberately (`CR B-3`). The writer never touches `data/mods/` in these tests: every
 * write lands in a per-process scratch directory.
 *
 * @module test/unit/ModPackageWriter
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import ModPackageWriter, {
    PACKAGE_WRITE_ERROR_CODES,
    DEFAULT_PACKAGE_VERSION,
    MAX_PACKAGE_BYTES
} from '../../src/services/ModPackageWriter.js';
import ModLoader from '../../src/services/ModLoader.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';

const FIXTURE_ROOT = path.resolve('data', `.mod-writer-${process.pid}`);
const RELATIVE_ROOT = path.relative(process.cwd(), FIXTURE_ROOT);

/** The writer under test, pointed at the scratch directory with a fixed clock (`D-1`). */
function makeWriter() {
    return new ModPackageWriter({ baseDir: RELATIVE_ROOT, backupStamp: () => 1700000000000 });
}

/** One kind of content that is a legal package: the manifest declares it, the file holds it. */
function componentsContent() {
    return { [REGISTRY_KINDS.COMPONENTS]: { salvagePlate: { name: 'Salvage Plate', form: { volume: 2 } } } };
}

/** Read a file the writer produced. */
function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8'));
}

let writer;

beforeAll(() => {
    writer = makeWriter();
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

afterAll(() => {
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

describe('ModPackageWriter.writePackage — the happy path', () => {
    it('writes a manifest and one file per declared kind, and the real loader reads them back', () => {
        const report = writer.writePackage({
            id: 'salvage-plate',
            description: 'A plate for hauling scrap.',
            content: componentsContent()
        });

        expect(report).toMatchObject({
            saved: true,
            packageId: 'salvage-plate',
            dir: `${RELATIVE_ROOT}/salvage-plate`,
            version: DEFAULT_PACKAGE_VERSION,
            content: [REGISTRY_KINDS.COMPONENTS],
            created: true,
            overwritten: [],
            backups: []
        });
        const dir = path.resolve(process.cwd(), RELATIVE_ROOT, 'salvage-plate');
        expect(fs.existsSync(path.join(dir, 'mod.json'))).toBe(true);
        expect(fs.existsSync(path.join(dir, `${REGISTRY_KINDS.COMPONENTS}.json`))).toBe(true);
        expect(readJson(`${RELATIVE_ROOT}/salvage-plate/mod.json`)).toEqual({
            id: 'salvage-plate',
            version: DEFAULT_PACKAGE_VERSION,
            content: [REGISTRY_KINDS.COMPONENTS],
            description: 'A plate for hauling scrap.'
        });

        // The real loader, not a stub: a package the writer produces must be discoverable
        // and must contribute its kind, or the write is a private file, not a mod.
        const scan = new ModLoader({ baseDir: RELATIVE_ROOT }).discover();
        expect(scan.invalid).toEqual([]);
        expect(scan.discovered.map((mod) => mod.manifest.id)).toContain('salvage-plate');
        const built = new ModLoader({ baseDir: RELATIVE_ROOT }).build(scan.discovered);
        expect(Object.keys(built.registries[REGISTRY_KINDS.COMPONENTS])).toEqual(['salvagePlate']);
    });

    it('reports an overwrite and backs up the file it replaces', () => {
        const first = writer.writePackage({ id: 'twice', description: 'first', content: componentsContent() });
        const second = writer.writePackage({ id: 'twice', description: 'second', content: componentsContent() });

        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.overwritten).toEqual([REGISTRY_KINDS.COMPONENTS]);
        expect(second.backups).toEqual([
            `${RELATIVE_ROOT}/twice/${REGISTRY_KINDS.COMPONENTS}.json.bak-1700000000000`
        ]);
        expect(fs.existsSync(path.resolve(process.cwd(), second.backups[0]))).toBe(true);
    });

    it('lists kinds in REGISTRY_KIND_LIST order, never in the order the caller wrote them', () => {
        const report = writer.writePackage({
            id: 'ordered',
            description: 'two kinds',
            content: {
                [REGISTRY_KINDS.INVENTORY_ITEMS]: { scrapBin: { name: 'Scrap Bin' } },
                [REGISTRY_KINDS.COMPONENTS]: { scrapWall: { name: 'Scrap Wall' } }
            }
        });
        expect(report.content).toEqual([REGISTRY_KINDS.COMPONENTS, REGISTRY_KINDS.INVENTORY_ITEMS]);
        expect(readJson(`${RELATIVE_ROOT}/ordered/mod.json`).content).toEqual([
            REGISTRY_KINDS.COMPONENTS,
            REGISTRY_KINDS.INVENTORY_ITEMS
        ]);
    });
});

describe('ModPackageWriter — what it refuses', () => {
    /** Assert a refusal, and that the package directory it would have written does not exist. */
    function expectRefusal(spec, code) {
        expect(() => writer.writePackage(spec)).toThrowError(
            expect.objectContaining({ code })
        );
        expect(fs.existsSync(path.resolve(process.cwd(), RELATIVE_ROOT, spec.id))).toBe(false);
    }

    it('refuses the reserved official prefix — shipped content is never written here', () => {
        expectRefusal({ id: 'core-components', content: componentsContent() }, PACKAGE_WRITE_ERROR_CODES.ID_RESERVED);
    });

    it('refuses an id that is not one path segment (traversal, slash, empty, uppercase)', () => {
        // An isolated base directory, and the assertion that it was never created: the id
        // check runs before `packageDir()`, so no path is ever BUILT from one of these —
        // including `..` and `.`, which would otherwise resolve to directories that
        // legitimately exist and prove nothing.
        const isolatedRoot = `${RELATIVE_ROOT}/never-created`;
        const isolated = new ModPackageWriter({ baseDir: isolatedRoot, backupStamp: () => 1 });
        for (const id of ['../evil', 'a/b', '', 'Core-Things', 'spaced id', 'nope\n', '..', '.', 'x'.repeat(65)]) {
            expect(() => isolated.writePackage({ id, content: componentsContent() })).toThrowError(
                expect.objectContaining({ code: PACKAGE_WRITE_ERROR_CODES.ID_INVALID })
            );
        }
        expect(fs.existsSync(path.resolve(process.cwd(), isolatedRoot))).toBe(false);
    });

    it('refuses a kind the world does not know, and a kind with no definitions', () => {
        expectRefusal(
            { id: 'unknown-kind', content: { notARegistry: { x: 1 } } },
            PACKAGE_WRITE_ERROR_CODES.KIND_UNKNOWN
        );
        expectRefusal({ id: 'empty-kind', content: { [REGISTRY_KINDS.COMPONENTS]: {} } }, PACKAGE_WRITE_ERROR_CODES.KIND_EMPTY);
        expectRefusal({ id: 'no-content', content: {} }, PACKAGE_WRITE_ERROR_CODES.CONTENT_INVALID);
    });

    it('refuses the unsafe keys, nested included — a package of data never reaches the prototype', () => {
        // `JSON.parse`, not an object literal: `{ __proto__: v }` in a literal SETS the
        // prototype, so a literal would test nothing. Parse is how a mod file puts an OWN
        // `__proto__` key on the table (`ModLoader`'s UNSAFE_KEYS note).
        const poisoned = JSON.parse(`{"${REGISTRY_KINDS.COMPONENTS}":{"__proto__":{"polluted":true}}}`);
        expectRefusal({ id: 'proto', content: poisoned }, PACKAGE_WRITE_ERROR_CODES.UNSAFE_KEY);
        expectRefusal(
            { id: 'proto-deep', content: { [REGISTRY_KINDS.COMPONENTS]: { plate: { nested: { constructor: {} } } } } },
            PACKAGE_WRITE_ERROR_CODES.UNSAFE_KEY
        );
        // And the proof the refusal mattered: nothing was written to merge into.
        expect(fs.existsSync(path.resolve(process.cwd(), RELATIVE_ROOT, 'proto-deep'))).toBe(false);
    });

    it('refuses a package over the size cap', () => {
        const huge = {};
        for (let i = 0; i < 400; i++) {
            huge[`pad${i}`] = { name: 'x'.repeat(2000) };
        }
        expect(() => writer.writePackage({ id: 'huge', content: { [REGISTRY_KINDS.COMPONENTS]: huge } }))
            .toThrowError(expect.objectContaining({ code: PACKAGE_WRITE_ERROR_CODES.TOO_LARGE }));
        expect(MAX_PACKAGE_BYTES).toBeGreaterThan(0);
    });
});

describe('ModPackageWriter.exists / readManifest', () => {
    it('answers for an installed package and for one that is not there', () => {
        writer.writePackage({ id: 'known', description: 'known', content: componentsContent() });
        expect(writer.exists('known')).toBe(true);
        expect(writer.readManifest('known')).toMatchObject({ id: 'known', content: [REGISTRY_KINDS.COMPONENTS] });
        expect(writer.exists('never-written')).toBe(false);
        expect(writer.readManifest('never-written')).toBeNull();
    });
});
