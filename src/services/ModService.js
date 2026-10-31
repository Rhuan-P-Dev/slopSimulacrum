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

import ModLoader, { resolveRequirements, MOD_ERROR_CODES } from './ModLoader.js';
import classifyComposition from './CompositionClassifier.js';
import DataLoader from '../utils/DataLoader.js';
import Logger from '../utils/Logger.js';
import { GameError } from '../utils/CustomErrors.js';
import { REGISTRY_KIND_LIST, isRegistryKind } from '../../shared/RegistryKinds.js';

/** How many blocking packages a refusal names before saying "and N more". */
export const MAX_HOLDERS_NAMED = 6;

/** How many key names per kind a plan lists before saying `truncated`. */
export const MAX_KEYS_PER_KIND = 50;

/**
 * When a queued change takes effect. There is exactly one answer, by owner decision:
 * a definition swap never happens mid-round, so an enable is confirmed at the next round
 * boundary and `pending` is the honest answer until then — including on a server whose
 * turn loop is stopped, where it stays pending until someone starts a round.
 */
export const APPLY_AT = 'next round boundary';

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
     * @param {{ load: Function, save: Function }} [options.stateStore] - Where the
     *   enable / load-order state lives. Defaults to the data seam
     *   (`DataLoader.loadModState` / `saveModState`, i.e. `data/mods/loadorder.json`);
     *   a test injects an in-memory pair, because a unit test of "what is enabled" has no
     *   business writing the file the next boot reads.
     */
    constructor({ registryStore, loader = new ModLoader(), stateStore = null } = {}) {
        if (!registryStore || typeof registryStore.read !== 'function') {
            throw new TypeError('ModService: registryStore is required');
        }
        this.registryStore = registryStore;
        this.loader = loader;
        this.stateStore = stateStore ?? {
            load: () => DataLoader.loadModState(),
            save: (state) => DataLoader.saveModState(state)
        };
        /** @type {Array<Object>|null} discovery result, null until the first scan */
        this.discovered = null;
        /** @type {Array<Object>} */
        this.invalid = [];
        /**
         * State handed in by the caller (a test, or a caller that keeps its own state
         * object). Kept apart from the on-disk state so the two can be merged without one
         * silently becoming the other: whatever the caller injected always wins.
         * @type {Object.<string, Object>}
         * @private
         */
        this.injectedState = loader.state ? { ...loader.state } : {};
        /** @type {Object.<string, Object>|null} effective per-mod state, null until loaded */
        this.state = null;
        /** @type {boolean} a change that has been written but not yet swapped in */
        this.pending = false;
        /** @type {Object|null} the report of the last apply this service performed */
        this.lastApply = null;
    }

    /**
     * The effective per-mod state, read from the seam on first use.
     *
     * Lazy on purpose: the composition root constructs this service every time it builds a
     * world, which is in every integration test, and a disk read at construction would be
     * paid then and explained nowhere.
     * @returns {Object.<string, {enabled?: boolean, loadOrder?: number}>}
     */
    currentState() {
        if (this.state === null) {
            this.state = { ...this.stateStore.load(), ...this.injectedState };
        }
        return this.state;
    }

    /**
     * Discover with the effective state. The loader reads `loader.state`, so this is the
     * one place that pushes the service's state into it — a second writer would make
     * "what is enabled" depend on who called last.
     * @returns {{ discovered: Array<Object>, invalid: Array<Object> }}
     */
    discover() {
        this.loader.state = { ...this.currentState() };
        return this.loader.discover();
    }

    /**
     * Look at the package directory again — including the state file, so an edit to
     * `data/mods/loadorder.json` without a restart is picked up here. Installs nothing,
     * changes nothing.
     * @returns {{ scanned: true, mods: Array<Object>, invalid: Array<Object> }}
     */
    rescan() {
        this.state = null;
        this.remember(this.discover());
        return { scanned: true, mods: this.view(), invalid: this.invalid };
    }

    /**
     * @param {{ discovered: Array<Object>, invalid: Array<Object> }} result
     * @returns {{ discovered: Array<Object>, invalid: Array<Object> }} the same result
     * @private
     */
    remember(result) {
        this.discovered = result.discovered;
        this.invalid = result.invalid;
        return result;
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
            // Whether a written change is still waiting for the boundary, and what the
            // last swap did. Without `pending` an operator who disabled a mod would see
            // `enabled: false` and no way to tell whether the world had taken it yet.
            pending: this.pending,
            appliesAt: APPLY_AT,
            lastApply: this.lastApply,
            // Enabled, installed, and contributing nothing - see `view()`. Derived from the
            // same scan `mods` came from, so the two lists cannot disagree.
            blocked: (this.discovered ?? [])
                .filter((mod) => mod.blocked)
                .map((mod) => ({ id: mod.manifest.id, requires: mod.manifest.requires, ...mod.blocked })),
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
     *
     * `quarantine` comes from `CompositionClassifier`: definitions that would not survive
     * the world's own composition rules, each with the reason its owner gave. They are
     * NOT in the `kinds` diff, because an apply installs the classified candidate. A plan
     * can therefore answer the two different questions an operator has — what lands, and
     * what was dropped for cause.
     * @returns {{ applied: false, fromVersion: number, kinds: Array<Object>, quarantine: Array<Object>, shadowed: Array<Object>, invalid: Array<Object>, blocked: Array<Object> }}
     */
    plan() {
        const { discovered, invalid } = this.discover();
        const built = this.loader.build(discovered);
        // The diff is computed against the definitions that would SURVIVE composition, not
        // against the raw merge: an apply installs the classified candidate, so a plan
        // that counted a quarantined definition as "added" would promise a definition the
        // world refuses to hold.
        const { valid, quarantined } = classifyComposition(built.registries);
        const kinds = [];
        for (const kind of REGISTRY_KIND_LIST) {
            if (!isRegistryKind(kind)) continue;
            const diff = diffRegistry(this.registryStore.read(kind), valid[kind]);
            if (diff.addedCount === 0 && diff.removedCount === 0 && diff.changedCount === 0) continue;
            kinds.push({ kind, ...diff, providers: built.providers[kind] });
        }
        return {
            applied: false,
            fromVersion: this.registryStore.version(),
            kinds,
            quarantine: quarantined,
            shadowed: built.shadowed,
            invalid,
            // Packages that are installed and enabled but contribute nothing, because a
            // `requires` of theirs cannot be met in this install. Without this line an
            // operator reads "enabled" and waits for content that will never arrive.
            blocked: built.blocked
        };
    }

    // =========================================================================
    // Enable / disable, and the swap at the round boundary
    // =========================================================================

    /**
     * Enable or disable an installed package.
     *
     * This writes the wish, not the world: the state file is updated and the change is
     * queued, and `pending` stays true until a round boundary swaps the definition. That
     * is the whole point of the boundary (`wiki/decisions/mod-system.md` decision 4) - a
     * round resolves against one definition, and nothing changes underneath it. A server
     * whose turn loop is idle leaves the change pending; it is not lost, it is written.
     *
     * Idempotent by state (`H-3`): enabling what is already enabled writes the same value
     * and queues nothing new to apply.
     * @param {string} id - A package id, as `GET /mods` lists it.
     * @param {boolean} enabled
     * @returns {{ id: string, enabled: boolean, pending: boolean, appliesAt: string }}
     * @throws {GameError} MOD_ID_INVALID - not a non-empty string.
     * @throws {GameError} MOD_NOT_FOUND - no package with that id is installed. A typo
     *   must not create a state entry for a mod that does not exist.
     */
    setEnabled(id, enabled) {
        if (typeof id !== 'string' || id.length === 0) {
            throw new GameError('ModService: mod id must be a non-empty string', 'MOD_ID_INVALID');
        }
        // Installed means discovered now, not remembered from an earlier scan: the
        // directory may have been removed since, and queueing a change for a package that
        // is gone would be a state entry nothing can ever apply. The result is also
        // remembered, so `list()` after an action describes the world that action saw
        // rather than asking the caller to rescan before it can see anything.
        const { discovered } = this.remember(this.discover());
        const mod = discovered.find((candidate) => candidate.manifest.id === id);
        if (!mod) {
            throw new GameError(`ModService: no mod package named "${id}" is installed`, 'MOD_NOT_FOUND');
        }
        const refusal = this.requirementRefusal(discovered, id, enabled);
        if (refusal) {
            throw new GameError(`ModService: ${refusal.message}`, refusal.code);
        }
        const state = this.currentState();
        const already = mod.enabled === enabled;
        this.state = { ...state, [id]: { ...(state[id] ?? {}), enabled } };
        this.stateStore.save(this.state);
        if (!already) this.pending = true;
        Logger.info(`[ModService] mod "${id}" ${enabled ? 'enabled' : 'disabled'}${already ? ' (already in that state)' : ''}; applies at the ${APPLY_AT}`);
        return { id, enabled, pending: this.pending, appliesAt: APPLY_AT };
    }

    /**
     * Would this change leave a package that cannot work? The question is asked once, in
     * the one place the requirement graph lives.
     *
     * The change is applied to the discovered set, `resolveRequirements` runs on the result,
     * and the answer is read off it:
     *   - enabling a package that STILL cannot contribute -> `MOD_REQUIREMENT_UNMET`. Without
     *     this, enabling A while a package it requires is off would write a state the loader
     *     then refuses, and the operator would see `enabled: true` next to content that never
     *     arrived;
     *   - disabling a package another enabled package requires -> `MOD_REQUIREMENT_HELD`,
     *     naming who. That is the whole point of `requires`: it is what stops an operator
     *     from removing `core-materials` from under the damage types that name a material.
     *     Disable the dependents first, in dependency order.
     * Nothing here restates a rule the loader already has - a second graph walks a different
     * path the day someone edits one of them (`CODE_RULES.md` H-1).
     *
     * @param {Array<Object>} discovered - The pre-change scan.
     * @param {string} id - The package being switched.
     * @param {boolean} enabled - The state it is being switched to.
     * @returns {{ code: string, message: string }|null}
     */
    requirementRefusal(discovered, id, enabled) {
        // Packages already unable to contribute before this change are not this change's
        // doing, and naming them would blame the wrong action.
        const wasBlocked = new Set(discovered.filter((mod) => mod.blocked).map((mod) => mod.manifest.id));
        const prospective = discovered.map((mod) => ({
            ...mod,
            blocked: null,
            enabled: mod.manifest.id === id ? enabled : mod.enabled
        }));
        resolveRequirements(prospective);

        if (enabled) {
            const self = prospective.find((candidate) => candidate.manifest.id === id);
            if (self?.blocked) {
                return {
                    code: MOD_ERROR_CODES.REQUIREMENT_UNMET,
                    message: `cannot enable "${id}": ${self.blocked.message}`
                };
            }
            return null;
        }

        const holders = prospective.filter((candidate) => candidate.enabled !== false
            && candidate.blocked
            && candidate.manifest.id !== id
            && !wasBlocked.has(candidate.manifest.id));
        if (holders.length === 0) return null;

        const names = holders.slice(0, MAX_HOLDERS_NAMED).map((candidate) => candidate.manifest.id);
        const more = holders.length > names.length ? ` (+${holders.length - names.length} more)` : '';
        return {
            code: MOD_ERROR_CODES.REQUIREMENT_HELD,
            message: `cannot disable "${id}": ${names.join(', ')}${more} require${holders.length === 1 ? 's' : ''} it`
                + ' - disable those first'
        };
    }

    /**
     * @param {string} id - A package id.
     * @returns {{ id: string, enabled: boolean, pending: boolean, appliesAt: string }}
     */
    enable(id) {
        return this.setEnabled(id, true);
    }

    /**
     * @param {string} id - A package id.
     * @returns {{ id: string, enabled: boolean, pending: boolean, appliesAt: string }}
     */
    disable(id) {
        return this.setEnabled(id, false);
    }

    /**
     * Swap in the queued change if there is one. This is the round-boundary entry point:
     * the turn system calls it as the first thing it does when a round opens, so the round
     * resolves against the definition it starts with.
     *
     * A failed apply is recorded and reported, not retried every round: a candidate that
     * the world refuses would otherwise be rebuilt and refused again at every boundary,
     * and a hot loop of warnings is how a real problem gets tuned out. The state file
     * still says what was asked, so `plan` keeps showing the mismatch.
     * @returns {Object|null} the apply report, or null when nothing was queued
     */
    applyPending() {
        if (!this.pending) return null;
        this.pending = false;
        try {
            this.lastApply = this.applyNow();
            Logger.info(
                `[ModService] applied at round boundary: version ${this.lastApply.version}, `
                + `${this.lastApply.swappedKinds.length} kind(s), ${this.lastApply.quarantined.length} definition(s) quarantined`
            );
        } catch (error) {
            this.lastApply = { ok: false, error: error?.message ?? String(error) };
            Logger.warn(`[ModService] apply at round boundary failed: ${this.lastApply.error}`);
        }
        return this.lastApply;
    }

    /**
     * Build the candidate from the packages on disk and install it in one swap.
     *
     * No diffing, no partial write: `RegistryStore.replace` validates the whole candidate
     * before touching anything, so a candidate with one unusable kind leaves every registry
     * as it was. What is installed is the CLASSIFIED candidate - definitions the world's
     * own composition rules refuse are dropped, and the report names them.
     * @returns {{ ok: true, version: number, swappedKinds: Array<string>, quarantined: Array<Object>, mods: number }}
     */
    applyNow() {
        const { discovered } = this.remember(this.discover());
        const built = this.loader.build(discovered);
        const { valid, quarantined } = classifyComposition(built.registries);
        const swapped = this.registryStore.replace(valid);
        return {
            ok: true,
            version: swapped.version,
            swappedKinds: swapped.swappedKinds,
            quarantined,
            mods: discovered.filter((mod) => mod.enabled !== false).length
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
            // The wish, resolved from this service's state, falling back to what the loader
            // derived. Reading state here rather than the scan entry is what lets `list()`
            // answer correctly right after an enable, without scanning the disk twice.
            enabled: this.state?.[mod.manifest.id]?.enabled ?? mod.enabled,
            loadOrder: mod.loadOrder,
            content: mod.manifest.content,
            requires: mod.manifest.requires,
            // Why a package contributes nothing although it is enabled, or null.
            blocked: mod.blocked ?? null
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
