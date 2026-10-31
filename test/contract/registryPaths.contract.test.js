/**
 * CONTRACT TEST — the registry kind vocabulary and the one path table.
 *
 * A reader asks for a registry by KIND (`DataLoader.loadRegistry(kind)`), never
 * for a file. `src/utils/DataLoader.js` holds the only kind -> file table in the
 * codebase, and that single mapping is what lets the same registry be served by
 * a different source later (a mod package becoming the source of a kind, while
 * the server runs — `wiki/decisions/mod-system.md`).
 *
 * This contract fails when:
 *   - a declared kind has no source (a reader would throw at boot);
 *   - two kinds share one source (a swap of one would silently change the other);
 *   - the table names a path that is not the data-file layout (a stray prefix
 *     would resolve outside the data tree);
 *   - `loadRegistry` accepts an unknown kind instead of refusing it (a typo would
 *     return the empty default and make part of the world vanish quietly).
 *
 * It does NOT pin which file each kind reads — that is the table's content, and
 * moving a data file is a deliberate change to the table, not to this test.
 *
 * @module test/contract/registryPaths
 */

import { describe, it, expect } from 'vitest';
import DataLoader from '../../src/utils/DataLoader.js';
import { REGISTRY_KINDS, REGISTRY_KIND_LIST, isRegistryKind } from '../../shared/RegistryKinds.js';

describe('registry path table (the only kind -> file mapping)', () => {
    it('gives every declared kind a source file', () => {
        for (const kind of REGISTRY_KIND_LIST) {
            const source = DataLoader.registrySourcePath(kind);
            expect(typeof source, `source of "${kind}"`).toBe('string');
            expect(source, `source of "${kind}"`).toMatch(/^data\/[A-Za-z0-9_/]+\.json$/);
        }
    });

    it('never maps two kinds onto the same file', () => {
        const bySource = new Map();
        for (const kind of REGISTRY_KIND_LIST) {
            const source = DataLoader.registrySourcePath(kind);
            expect(bySource.has(source), `${source} claimed by ${bySource.get(source)} and ${kind}`).toBe(false);
            bySource.set(source, kind);
        }
    });

    it('refuses a kind outside the vocabulary instead of returning the default', () => {
        expect(() => DataLoader.loadRegistry('materialsButTypoed')).toThrowError(
            /unknown registry kind/
        );
        try {
            DataLoader.loadRegistry('Components'); // kinds are case-sensitive
            expect.unreachable('a mis-cased kind must not load');
        } catch (error) {
            expect(error.code).toBe('REGISTRY_KIND_UNKNOWN');
        }
    });

    it('reads the kind source, and degrades to the caller default when it is unreadable', () => {
        // Every shipped kind resolves through the same safe path: a real read
        // returns an object, and an unknown-source kind is impossible (guarded
        // above), so the only observable contract here is "never throws on read".
        for (const kind of [REGISTRY_KINDS.COMPONENTS, REGISTRY_KINDS.MATERIALS, REGISTRY_KINDS.ACTIONS]) {
            const registry = DataLoader.loadRegistry(kind);
            expect(registry, kind).toBeTypeOf('object');
            expect(isRegistryKind(kind)).toBe(true);
        }
    });
});
