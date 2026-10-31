/**
 * ModService — what is installed, and what applying it would change.
 *
 * This is the package manager's side of the mod system: it reads the package
 * directory through `ModLoader` and compares the result against the definition the
 * world is actually running (`RegistryStore`). It never mutates the world — not
 * `rescan()`, not `plan()`. The apply point is a separate change (the round
 * boundary in `TurnSystemController`), and keeping this module free of it is what
 * lets an operator ask "what would happen?" as many times as they like, from an
 * HTTP request, with no consequence (`wiki/decisions/mod-system.md`, decision 6).
 *
 * WHY IT CACHES THE DISCOVERY. `list()` answers from the last scan; `rescan()`
 * looks at the disk again. Without that split the two endpoints would be the same
 * call under different names, and the one thing an operator needs — "I copied a
 * directory in, now tell me what you see" — would have no verb. A directory scan
 * is cheap, so nothing is saved by caching; the split is about naming the intent.
 *
 * WHAT A PLAN IS NOT. It is not a transaction and not a promise: between a
 * `plan()` and an apply, the disk can change. The apply rebuilds its own candidate
 * and validates it again. The plan's `fromVersion` is the store version it was
 * computed against, so a caller can tell whether the world moved underneath it.
 *
 * PAYLOAD SIZE. A registry can hold hundreds of definitions, so a plan caps the
 * key names it lists per kind (`MAX_KEYS_PER_KIND`) and says so with
 * `truncated`. Counts are always exact; only the name lists are capped — a client
 * that needs the full list asks the registry it concerns (`CR SEC-2`).
 *
 * @module ModService
 */

import ModLoader from './ModLoader.js';
import DataLoader from '../utils/DataLoader.js';
import { REGISTRY_KIND_LIST, isRegistryKind } from '../../shared/RegistryKinds.js';

/** How many key names per kind a plan lists before saying `truncated`. */
export const MAX_KEYS_PER_KIND = 50;

/**
 * Structural equality for JSON-shaped values. `JSON.stringify` is not enough: the
 * key order of a merged definition follows the order the patches arrived in, which
 * is not the order the file was written in, and a plan that reported every merged
 * definition as "changed" would be noise nobody reads.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
    }
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

/**
 * Compare one kind's candidate against the live content.
 * @param {Object} live - What the world runs now.
 * @param {Object} candidate - What an apply would install.
 * @returns {{ added: string[], removed: string[], changed: string[], unchanged: number,
 *   truncated: boolean }}
 */
export function diffRegistry(live, candidate) {
    const liveKeys = Object.keys(live ?? {});
    const candidateKeys = Object.keys(candidate ?? {});
    const added = candidateKeys.filter((key) => !Object.hasOwn(live ?? {}, key));
    const removed = liveKeys.filter((key) => !Object.hasOwn(candidate ?? {}, key));
    const changed = candidateKeys.filter((key) => Object.hasOwn(live ?? {}, key)
        && !deepEqual(live[key], candidate[key]));
    const unchanged = candidateKeys.length - added.length - changed.length;
    const cap = (list) => list.length > MAX_KEYS_PER_KIND;
    return {
        added: added.slice(0, MAX_KEYS_PER_KIND),
        removed: removed.slice(0, MAX_KEYS_PER_KIND),
        changed: changed.slice(0, MAX_KEYS_PER_KIND),
        addedCount: added.length,
        removedCount: removed.length,
        changedCount: changed.length,
        unchanged,
        truncated: cap(added) || cap(removed) || cap(changed)
    };
}

export class ModService {
    /**
     * @param {Object} options
     * @param {import('./RegistryStore.js').RegistryStore} options.registryStore
     *   The live definition the plan is computed against. Required: a mod service
     *   that cannot see the world could only report what is on disk, which is the
     *   loader's job.
     * @param {ModLoader} [options.loader] - Package reader. A fresh loader by
     *   default, over the default package directory.
     */
    constructor({ registryStore, loader = new ModLoader() } = {}) {
        if (!registryStore || typeof registryStore.read !== 'function') {
            throw new TypeError('ModService: registryStore is required');
        }
        this.registryStore = registryStore;
        this.loader = loader;
        /** @type {Array<Object>|null} discovery result, null until the first scan */
        this.discovered = null;
        /** @type {Array<Object>} */
        this.invalid = [];
    }

    /**
     * Look at the package directory again. Installs nothing, changes nothing.
     * @returns {{ scanned: true, mods: Array<Object>, invalid: Array<Object> }}
     */
    rescan() {
        const result = this.loader.discover();
        this.discovered = result.discovered;
        this.invalid = result.invalid;
        return { scanned: true, mods: this.view(), invalid: this.invalid };
    }

    /**
     * The packages as this service currently sees them, plus what the world runs.
     * @returns {{ scanned: boolean, mods: Array<Object>, invalid: Array<Object>, live: Object }}
     */
    list() {
        return {
            scanned: this.discovered !== null,
            mods: this.view(),
            invalid: this.invalid,
            live: this.liveView()
        };
    }

    /**
     * What an apply of the current packages would change, per kind.
     *
     * Built from a fresh discovery (not the cached one): a plan an operator acts on
     * must describe the disk as it is now, and the cached scan can be hours old.
     * `enabled` is read from the loader's state exactly as an apply would read it, so
     * a disabled package contributes nothing here and nothing there.
     * @returns {{ applied: false, fromVersion: number, kinds: Array<Object>, shadowed: Array<Object>, invalid: Array<Object> }}
     */
    plan() {
        const { discovered, invalid } = this.loader.discover();
        const built = this.loader.build(discovered);
        const kinds = [];
        for (const kind of REGISTRY_KIND_LIST) {
            if (!isRegistryKind(kind)) continue;
            const diff = diffRegistry(this.registryStore.read(kind), built.registries[kind]);
            if (diff.addedCount === 0 && diff.removedCount === 0 && diff.changedCount === 0) continue;
            kinds.push({ kind, ...diff, providers: built.providers[kind] });
        }
        return {
            applied: false,
            fromVersion: this.registryStore.version(),
            kinds,
            shadowed: built.shadowed,
            invalid
        };
    }

    // =========================================================================
    // View helpers
    // =========================================================================

    /**
     * One row per package, as the loader described it. A package that failed to load
     * is NOT here — it is in `invalid`, with a code and a reason.
     * @returns {Array<Object>}
     */
    view() {
        return (this.discovered ?? []).map((mod) => ({
            id: mod.manifest.id,
            version: mod.manifest.version,
            // Derived by the loader from the reserved prefix, never from the manifest.
            official: mod.manifest.official,
            enabled: mod.enabled,
            loadOrder: mod.loadOrder,
            content: mod.manifest.content
        }));
    }

    /**
     * The vocabulary a `mod.json` `content` array is written in: every registry kind,
     * the file it reads, and how many definitions of it the world currently holds.
     *
     * This is the machine-readable half of the mod contract, and the answer to a
     * rejected package: the kind ids are registry ids inherited from the data files,
     * not the concept names, so the entity blueprints a content mod wants to add are
     * the `npcs` kind (`core-npcs/npcs.json`). A mod author needs this list, and an
     * editor can autocomplete from it. The loader's rejection message names the same
     * vocabulary.
     * @returns {Array<{ kind: string, file: string, coreDir: string, liveCount: number }>}
     */
    kinds() {
        const counts = this.registryStore.definitionCounts();
        return REGISTRY_KIND_LIST.map((kind) => {
            // The vocabulary lives in shared/RegistryKinds.js; the path each kind is
            // read from lives with the data seam (`CR B-3`). Metadata only — no read.
            const segments = DataLoader.registrySourcePath(kind).split('/');
            return {
                kind,
                file: segments[segments.length - 1],
                coreDir: segments[segments.length - 2],
                liveCount: counts[kind]
            };
        });
    }

    /**
     * The definition the world runs: its version and how many definitions each kind
     * currently holds.
     * @returns {{ version: number, definitionCounts: Object.<string, number> }}
     */
    liveView() {
        return {
            version: this.registryStore.version(),
            definitionCounts: this.registryStore.definitionCounts()
        };
    }
}

export default ModService;
