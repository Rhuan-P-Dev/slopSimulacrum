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

import ModLoader, {
    resolveRequirements, sortModsForLoad, DEFAULT_LOAD_ORDER, MOD_ERROR_CODES,
    MANIFEST_FILE, contributingMods
} from './ModLoader.js';
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

/** `moveMod`: toward the top of the stack — composes earlier, so it LOSES a shared key. */
export const MOVE_UP = 'up';

/** `moveMod`: toward the bottom of the stack — composes last, so it WINS a shared key. */
export const MOVE_DOWN = 'down';

/**
 * The gap between two stack levels; rank 1 sits at exactly this number, so the top of a
 * renumbered stack stays on the level an untuned install sits at.
 *
 * The consequence is worth knowing before dropping a package in: a package with no state
 * entry takes `DEFAULT_LOAD_ORDER` (the loader's fallback), which is this same number, so a
 * package added AFTER a move ties with rank 1 and composes near the top of the stack. The
 * move control is what places it; nothing infers a level from a package's content.
 */
export const LOAD_ORDER_STRIDE = DEFAULT_LOAD_ORDER;

/**
 * Group shadow facts by owner: `kind -> key -> the package the world runs for it`.
 *
 * `shadowed` only carries keys somebody else also ships, so this map is exactly "the keys
 * whose owner a reorder can change" — a key no other package ships has no owner to move and
 * is not in it.
 * @param {Array<{ kind: string, key: string, to: string }>} shadowed - from `ModLoader.build`
 * @returns {Map<string, Map<string, string>>}
 */
export function ownersOf(shadowed) {
    const owners = new Map();
    for (const entry of shadowed) {
        if (!owners.has(entry.kind)) owners.set(entry.kind, new Map());
        owners.get(entry.kind).set(entry.key, entry.to);
    }
    return owners;
}

/**
 * Keys whose owner differs between two stacks — the honest headline for "what did that move
 * do?". A key present on only one side means the move also changed who ships it at all, which
 * happens when a move crosses a package that was refused: `was`/`now` is then `null`.
 * @param {Map<string, Map<string, string>>} before
 * @param {Map<string, Map<string, string>>} after
 * @returns {Array<{ kind: string, key: string, was: string|null, now: string|null }>}
 */
export function ownerChanges(before, after) {
    const changed = [];
    for (const [kind, keys] of after) {
        const wasKeys = before.get(kind);
        for (const [key, now] of keys) {
            const was = wasKeys?.get(key) ?? null;
            if (was !== now) changed.push({ kind, key, was, now });
        }
    }
    for (const [kind, keys] of before) {
        const nowKeys = after.get(kind);
        for (const [key, was] of keys) {
            if (nowKeys?.has(key)) continue;
            changed.push({ kind, key, was, now: null });
        }
    }
    // kind then key, so the list does not depend on insertion order (`CR D-1`).
    return changed.sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

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
     * @param {() => boolean} [options.roundGate] - Whether a round is open right now,
     *   asked by `requestApply()` before it swaps a definition, so an operator's
     *   "apply now" cannot land in the middle of a round (`CR D-6`). Absent means
     *   "no round is open" - a test, or a world built without a turn system.
     * @param {(swappedKinds: Array<string>) => (Object|null)} [options.afterSwap] - What the
     *   running world does with a definition it has just taken on. Called by `applyNow()`
     *   after a successful swap with the kinds that changed; whatever it returns rides along
     *   in the apply report as `map`. Absent means nothing downstream cares. A plain
     *   callback for the same reason `roundGate` is one: the map lives in
     *   `RoomsController`, and this module stays the package manager (`CR B-1`).
     */
    constructor({ registryStore, loader = new ModLoader(), stateStore = null, roundGate = null, afterSwap = null } = {}) {
        if (!registryStore || typeof registryStore.read !== 'function') {
            throw new TypeError('ModService: registryStore is required');
        }
        this.registryStore = registryStore;
        this.loader = loader;
        this.roundGate = roundGate;
        this.afterSwap = afterSwap;
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
     *
     * `unsafeKeys` lists every `__proto__`-class key found in a package, with its location.
     * Such a package is refused whole, so it appears nowhere in `kinds`: the plan would
     * otherwise promise an install that the loader already said no to.
     * @returns {{ applied: false, fromVersion: number, kinds: Array<Object>, quarantine: Array<Object>, shadowed: Array<Object>, invalid: Array<Object>, blocked: Array<Object>, unsafeKeys: Array<Object> }}
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
            blocked: built.blocked,
            // Refused outright, not composed: a package carrying a key that is never data
            // (`ModLoader` `UNSAFE_KEYS`). Named here so the answer is not just "nothing".
            unsafeKeys: built.unsafeKeys
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

    // =========================================================================
    // Moving a package in the stack
    // =========================================================================

    /**
     * Move one package one slot in the stack, and queue the recomposition.
     *
     * Place is what a package means: for any key two packages ship, the world runs the
     * definition of the one that composes LAST (`ModLoader.build`). So moving a package moves
     * who wins, and `direction` is written the way the launcher draws the stack — `up` is
     * toward the top, which composes FIRST and therefore loses; `down` composes last and wins.
     * The ordinal gutter in the panel is the same numbering: rank 1 is the top.
     *
     * Like enable/disable, this writes the wish, not the world. `data/mods/loadorder.json` is
     * rewritten and `pending` says when it lands; nothing is swapped here, so a round in
     * progress resolves against one definition (`wiki/decisions/mod-system.md` decision 4).
     *
     * The whole stack is renumbered, not just the moved package (`reassignLoadOrders`).
     *
     * @param {string} id - A package id, as `GET /mods` lists it.
     * @param {'up'|'down'} direction - Which way it moves in the drawn stack.
     * @returns {{ id: string, moved: true, direction: string, rank: number, total: number,
     *   loadOrder: number, previousLoadOrder: number, pending: boolean, appliesAt: string,
     *   shadowChanged: Array<Object>, shadowChangedTruncated: boolean }}
     * @throws {GameError} MOD_ID_INVALID - not a non-empty string.
     * @throws {GameError} MOD_MOVE_DIRECTION_INVALID - anything other than `up` / `down`.
     * @throws {GameError} MOD_NOT_FOUND - no package with that id is installed.
     * @throws {GameError} MOD_MOVE_AT_EDGE - it is already at that end of the stack.
     * @throws {GameError} MOD_MOVE_BREAKS_REQUIRES - the move would compose it above something
     *   it requires. Carries `mod`, `requires`, `from`, `to` for the client.
     */
    moveMod(id, direction) {
        if (typeof id !== 'string' || id.length === 0) {
            throw new GameError('ModService: mod id must be a non-empty string', MOD_ERROR_CODES.ID_INVALID);
        }
        if (direction !== MOVE_UP && direction !== MOVE_DOWN) {
            throw new GameError(
                `ModService: move direction must be "${MOVE_UP}" or "${MOVE_DOWN}", ` 
                + `got ${typeof direction === 'string' ? `"${direction}"` : String(direction)}`,
                MOD_ERROR_CODES.MOVE_DIRECTION_INVALID
            );
        }
        // Discovered now, exactly as `setEnabled` does: queueing a position for a package that
        // was deleted since the last scan would write a state entry nothing can ever apply.
        const { discovered } = this.remember(this.discover());
        const ordered = sortModsForLoad(discovered);
        const from = ordered.findIndex((mod) => mod.manifest.id === id);
        if (from === -1) {
            throw new GameError(`ModService: no mod package named "${id}" is installed`, 'MOD_NOT_FOUND');
        }
        const to = direction === MOVE_UP ? from - 1 : from + 1;
        if (to < 0 || to >= ordered.length) {
            throw new GameError(
                `ModService: "${id}" is already at the ${direction === MOVE_UP ? 'top' : 'bottom'} of the `
                + `stack (${ordered.length} package(s), position ${from + 1})`,
                MOD_ERROR_CODES.MOVE_AT_EDGE
            );
        }
        const moved = ordered[from];
        const refusal = this.moveOrderRefusal(ordered, moved, from, to, direction);
        if (refusal) {
            const error = new GameError(`ModService: ${refusal.message}`, MOD_ERROR_CODES.MOVE_BREAKS_REQUIRES);
            // The route forwards these, so the client names the package and the positions
            // instead of parsing them back out of a sentence.
            error.mod = id;
            error.requires = refusal.requires;
            error.from = from + 1;
            error.to = to + 1;
            throw error;
        }
        // Composed twice — as it stands, and as it will be — so the answer can name the keys
        // whose owner the move changes. `build()` is the only thing that knows who wins a key:
        // it accounts for disabled packages, refused packages and three-way overlaps, and a
        // second, narrower model of the merge here would disagree with it the day someone
        // edits the real one (`CR H-1`). Two scans of the package set for a rate-limited
        // operator action is the cheap half of that trade.
        const ownersBefore = this.ownersByLevel();
        this.state = this.reassignLoadOrders(ordered, from, to);
        this.stateStore.save(this.state);
        this.pending = true;
        const changed = ownerChanges(ownersBefore, this.ownersByLevel());
        const rank = to + 1;
        Logger.info(`[ModService] mod "${id}" moved ${direction} to stack position ${rank} of `
            + `${ordered.length}; applies at the ${APPLY_AT}`);
        return {
            id,
            moved: true,
            direction,
            rank,
            total: ordered.length,
            loadOrder: rank * LOAD_ORDER_STRIDE,
            previousLoadOrder: moved.loadOrder,
            pending: this.pending,
            appliesAt: APPLY_AT,
            shadowChanged: changed.slice(0, MAX_KEYS_PER_KIND),
            shadowChangedTruncated: changed.length > MAX_KEYS_PER_KIND
        };
    }

    /**
     * Does this move break the one ordering rule the stack has?
     *
     * A package composes BELOW (after) everything it `requires`. `requires` means "my
     * definitions name things that package provides", so a provider composing last would
     * stamp its own definitions over the dependent's edits and silently undo the package
     * written on top of it. This is a rule about shadow precedence, not about availability:
     * `resolveRequirements` still decides whether a package can contribute at all, and still
     * does not care about order.
     *
     * Only the moved package's own edges are read, and only to required packages that actually
     * compose. That keeps the refusal about THIS move.
     *
     * WHAT IS COMPARED, AND WHY THE POST-MOVE STATE ALONE IS NOT ENOUGH. The refusal is
     * `depth_after > depth_before`, where depth counts how many positions the package sits
     * ABOVE the packages it requires. The obvious rule — refuse if the post-move state has the
     * package above a provider at all — is the one that reads best and does not work: the
     * shipped install already composes six edges the wrong way round (every package sits at the
     * default level, so the tiebreak is the id and `core-components` sorts above
     * `core-materials`), so those five packages would be frozen in place — unable to move up
     * (still inverted) and unable to move down (still inverted, one step short). No move is
     * illegal per step, yet the only legal destination is twenty steps away. Depth makes the
     * rule monotone: a move that walks a package toward its providers is progress and is
     * allowed, a move that carries it further above them is refused. On a package with nothing
     * inverted — the state this rule was written for — depth_before is 0 and the two rules
     * refuse exactly the same moves.
     *
     * Refusing an inversion the operator did not create would blame them for a stack they
     * inherited (`CR H-4`); refusing one they are deepening is the whole point.
     *
     * @param {Array<Object>} ordered - The stack as it is, in load order.
     * @param {Object} moved - The package being moved (an entry of `ordered`).
     * @param {number} from - Its index now.
     * @param {number} to - Its index after the move (always adjacent).
     * @param {string} direction - `up` or `down`, for the message.
     * @returns {{ message: string, requires: string }|null}
     */
    moveOrderRefusal(ordered, moved, from, to, direction) {
        // Who composes at all. A required package that is off or blocked composes nowhere, so
        // there is no precedence to protect against it; the index is the position in the
        // STACK, not in the filtered list, because rank is what the operator is shown.
        const composes = new Set(
            ordered.filter((mod) => mod.enabled !== false && !mod.blocked).map((mod) => mod.manifest.id)
        );
        // The moved package contributes nothing, so ordering it protects nothing.
        if (!composes.has(moved.manifest.id)) return null;

        const ids = ordered.map((mod) => mod.manifest.id);
        // Positions are only ever read through these two maps, so the crossing (an adjacent
        // move SWAPS the two packages, it does not jump past them) is the loader's own
        // `splice` semantics and not a second guess at it.
        const positionsAt = (hasMoved) => {
            const list = ids.slice();
            if (hasMoved) list.splice(to, 0, list.splice(from, 1)[0]);
            return list;
        };
        const depthAbove = (list) => {
            const index = new Map();
            list.forEach((modId, i) => {
                if (composes.has(modId)) index.set(modId, i);
            });
            const mine = index.get(moved.manifest.id);
            let depth = 0;
            let deepest = null;
            for (const dep of moved.manifest.requires) {
                const depIndex = index.get(dep);
                if (depIndex === undefined) continue;
                const over = depIndex - mine;
                if (over > 0) {
                    depth += over;
                    // Named for the message: the provider the package is sitting on top of.
                    if (!deepest || depIndex > index.get(deepest)) deepest = dep;
                }
            }
            return { depth, deepest };
        };

        const before = depthAbove(positionsAt(false));
        // `depth > 0` wherever the refusal fires, so `deepest` is a named package here.
        const after = depthAbove(positionsAt(true));
        if (after.depth <= before.depth) return null;

        // The provider named is the one being moved further away from, which is the fact the
        // operator can act on: going the other way is always legal from here. Its position is
        // read off the moved stack, because that is the stack the message describes.
        const depIndex = positionsAt(true).indexOf(after.deepest);
        return {
            requires: after.deepest,
            message: `cannot move "${moved.manifest.id}" ${direction}: it requires "${after.deepest}", `
                + `and a package composes below everything it requires. This move would carry it `
                + `further above it — to position ${to + 1}, with "${after.deepest}" at position `
                + `${depIndex + 1}. Moving it down is allowed from here.`
        };
    }

    /**
     * The state after the move: EVERY installed package renumbered to its rank times
     * `LOAD_ORDER_STRIDE`.
     *
     * Renumbering the whole stack instead of slipping one number between two neighbours is
     * what keeps ties out. Ties are not neutral here: they fall to the id (`sortModsForLoad`),
     * so a half-numbered stack is one where an unrelated package name silently decides who
     * wins a key. `enabled` is spread over, never recomputed — this moves position and
     * nothing else.
     * @param {Array<Object>} ordered - The stack as it is, in load order.
     * @param {number} from - Index of the moving package.
     * @param {number} to - Index it moves to (adjacent).
     * @returns {Object.<string, {enabled?: boolean, loadOrder: number}>} a new state object
     * @private
     */
    reassignLoadOrders(ordered, from, to) {
        const next = ordered.slice();
        next.splice(to, 0, next.splice(from, 1)[0]);
        const state = { ...this.currentState() };
        next.forEach((mod, index) => {
            const modId = mod.manifest.id;
            state[modId] = { ...(state[modId] ?? {}), loadOrder: (index + 1) * LOAD_ORDER_STRIDE };
        });
        return state;
    }

    /**
     * Who the world runs for each shared key, under the state the loader currently holds.
     *
     * Goes through the same seam as `plan()` (`discover()` then `loader.build()`), so there is
     * one path from "what is on disk" to "who wins". The discovery is remembered, as every
     * other verb does, so a `list()` right after a move describes the world that move saw.
     * @returns {Map<string, Map<string, string>>} kind -> key -> the package the world runs
     * @private
     */
    ownersByLevel() {
        const { discovered } = this.remember(this.discover());
        return ownersOf(this.loader.build(discovered).shadowed);
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
     * A package refused for an unsafe key never reaches the candidate, so an apply succeeds
     * without it and `unsafeKeys` names what was left out.
     * @returns {{ ok: true, version: number, swappedKinds: Array<string>, quarantined: Array<Object>, mods: number, unsafeKeys: Array<Object> }}
     */
    applyNow() {
        const { discovered } = this.remember(this.discover());
        const built = this.loader.build(discovered);
        const { valid, quarantined } = classifyComposition(built.registries);
        const swapped = this.registryStore.replace(valid);

        // The swap installed the definition; what the running world makes of it is the
        // caller's business. The composition root wires this to the map, so a room that was
        // just authored becomes a room the live world has, at the same moment the definition
        // moved - and at no other moment (`wiki/decisions/world-structure-authoring.md`).
        // Guarded: the definition is already swapped, and a downstream step that throws must
        // not turn a successful apply into a reported failure. It names itself in the report
        // instead (`CR E-1`, and never a silent swallow).
        let map = null;
        let mapError = null;
        if (typeof this.afterSwap === 'function' && swapped.swappedKinds.length > 0) {
            try {
                map = this.afterSwap(swapped.swappedKinds) ?? null;
            } catch (error) {
                mapError = error?.message ?? String(error);
                Logger.warn(`[ModService] post-swap step failed: ${mapError}`);
            }
        }

        return {
            ok: true,
            version: swapped.version,
            swappedKinds: swapped.swappedKinds,
            quarantined,
            mods: discovered.filter((mod) => mod.enabled !== false).length,
            unsafeKeys: built.unsafeKeys,
            map,
            mapError
        };
    }

    /**
     * Apply on request - now, or at the next round boundary, and never in the
     * middle of a round.
     *
     * This is the HTTP verb behind an operator's "apply now" button. It is not a
     * second apply mechanism: it queues the same ask and calls the same `applyNow()`
     * the round boundary calls. The gate is the point. A round is open from the
     * moment it starts planning until its resolution closes, and a definition that
     * changes while agents are planning or actions are resolving is a different
     * world than the one those agents were reading - so when a round is open the
     * answer is `applied: false, pending: true, appliesAt: 'round-boundary'`, which
     * is a deferral with a named moment, not a failure. When no round is open
     * (a process that has not started one, or a world with no turn system) the
     * swap happens here and the report comes back.
     * @returns {{ applied: boolean, pending: boolean, appliesAt: string, reason?: string, report?: Object }}
     */
    requestApply() {
        const roundActive = typeof this.roundGate === 'function' ? !!this.roundGate() : false;
        if (roundActive) {
            this.pending = true;
            return { applied: false, pending: true, appliesAt: APPLY_AT, reason: 'ROUND_ACTIVE' };
        }
        const report = this.applyNow();
        this.lastApply = report;
        this.pending = false;
        return { applied: true, pending: false, appliesAt: 'immediate', report };
    }

    /**
     * The package's own files, as they are on disk right now.
     *
     * The "show me what I installed" view: the manifest and every JSON file of the
     * package, each tagged with the registry kind it feeds (`entities.json` feeds
     * `entities`). A mod author debugging a quarantined definition reads this
     * instead of the directory on the server.
     *
     * Only `.json` content comes back; any other file in the package is listed by
     * name. Nothing is read outside the package directory - the id is matched
     * against the discovery scan, which only admits directories whose name is a
     * valid mod id (`MOD_ID_PATTERN`).
     * @param {string} id
     * @returns {{ id: string, dir: string, manifest: Object|null, files: Array<{name: string, json: boolean, kind: string|null, content: Object|null}> }}
     * @throws {GameError} MOD_NOT_FOUND - no installed package with that id.
     */
    packageFiles(id) {
        const mod = (this.discovered ?? []).find((entry) => entry.manifest.id === id);
        if (!mod) {
            throw new GameError(`ModService: no mod package named "${id}" is installed`, 'MOD_NOT_FOUND');
        }
        const dir = `${this.loader.baseDir}/${mod.dir}`;
        const files = [];
        for (const entry of DataLoader.listDir(dir)) {
            if (entry.isDirectory) continue;
            const json = entry.name.toLowerCase().endsWith('.json');
            const stem = entry.name.slice(0, -'.json'.length);
            files.push({
                name: entry.name,
                json,
                kind: json && isRegistryKind(stem) ? stem : null,
                content: json ? DataLoader.loadJsonSafe(`${dir}/${entry.name}`, null) : null
            });
        }
        files.sort((a, b) => a.name.localeCompare(b.name));
        const manifestFile = files.find((file) => file.name === MANIFEST_FILE);
        return { id, dir, manifest: manifestFile ? manifestFile.content : null, files };
    }

    /**
     * The "line" of a package — the Mod Line Viewer (dev tab) renders this: for
     * each kind the package ships, each definition key it declares, which
     * packages carry the same key, and which copy the world runs.
     * 
     * Fresh discovery, like `plan()`: the answer agrees with what the world runs
     * in a round, and the only thing the method answers is about the *install*
     * — who shadows whom, in the world's own load order (`sortModsForLoad`), the
     * very order the merge walks. Values are never touched: the line says which
     * copy wins, and `packageFiles` is what the caller asks for the bytes of the
     * definition it wants to expand. Keys that begin with an underscore are the
     * registry's comment convention (core ships `_comment`) and are not
     * definitions, so they get no line.
     * 
     * @param {string} id - the package to inspect
     * @returns {{ id: string, enabled: boolean, loadOrder: number,
     *   blocked: Object|null, contributes: boolean, version: number,
     *   lines: Object.<string, Array<Object>> } - `lines` is keyed by the kinds
     *   the package ships (a kind with a missing or unreadable file is absent:
     *   that is a defect, and its report lives in Plan). Each row:
     *   { key, overriddenBy: [{ modId, loadOrder }], overrides:
     *   [{ modId, loadOrder }], winner: { modId, loadOrder } | null } -
     *   `overriddenBy` is later in the stack than the package (the merge would
     *   shadow it), `overrides` is earlier (the package would win over those),
     *   and `winner` is the last contributing holder of the key, or null when
     *   no package contributes one.
     * }
     * @throws {GameError} `MOD_NOT_FOUND` when `id` is not an installed package.
     */
    linesForMod(id) {
        const { discovered } = this.discover();
        const mod = discovered.find((entry) => entry.manifest.id === id);
        if (!mod) {
            throw new GameError(
                `ModService: no mod package named "${id}" is installed`,
                'MOD_NOT_FOUND'
            );
        }

        // Stack order: enabled + requirement-satisfied first, then every
        // installed package. The merge walks this very list, so "later"
        // here is exactly the merge's "on top".
        const ordered = sortModsForLoad(discovered);
        const position = new Map(ordered.map((entry, index) => [entry.manifest.id, index]));
        const contributing = new Set(contributingMods(discovered).map((entry) => entry.manifest.id));
        const selfId = mod.manifest.id;
        const selfPos = position.get(selfId);
        const contributes = contributing.has(selfId);

        const lines = {};
        for (const kind of mod.manifest.content) {
            if (!isRegistryKind(kind)) continue;
            const dir = `${this.loader.baseDir}/${mod.dir}`;
            const selfDef = DataLoader.loadJsonSafe(`${dir}/${kind}.json`, null);
            if (selfDef === null || typeof selfDef !== 'object' || Array.isArray(selfDef)) {
                continue;
            }

            // One read per contributing holder of this kind (P-4: read once,
            // map it in memory, never per key).
            const holderKeys = new Map();
            for (const otherId of contributing) {
                if (otherId === selfId) continue;
                const content = DataLoader.loadJsonSafe(
                    `${this.loader.baseDir}/${otherId}/${kind}.json`,
                    null
                );
                holderKeys.set(
                    otherId,
                    content === null || typeof content !== 'object' || Array.isArray(content)
                        ? new Set()
                        : new Set(Object.keys(content).filter((k) => !k.startsWith('_')))
                );
            }

            lines[kind] = Object.keys(selfDef)
                .filter((key) => !key.startsWith('_'))
                .map((key) => {
                    const overriddenBy = [];
                    const overrides = [];
                    let winner = null;

                    // Holders of the key, in stack order: the package itself
                    // (when it contributes) plus every contributing mod that
                    // carries it.
                    for (const entry of ordered) {
                        const otherId = entry.manifest.id;
                        const holds =
                            otherId === selfId
                                ? contributes
                                : holderKeys.has(otherId) && holderKeys.get(otherId).has(key);
                        if (!holds) continue;
                        const pos = position.get(otherId);
                        const meta = { modId: otherId, loadOrder: entry.loadOrder };
                        if (pos > selfPos) {
                            overriddenBy.push(meta);
                        } else if (pos < selfPos) {
                            overrides.push(meta);
                        }
                        if (winner === null || pos > position.get(winner.modId)) {
                            winner = meta;
                        }
                    }

                    return { key, overriddenBy, overrides, winner };
                });
        }

        return {
            id: selfId,
            enabled: mod.enabled,
            loadOrder: mod.loadOrder,
            blocked: mod.blocked ?? null,
            contributes: contributes,
            version: this.registryStore.version(),
            lines
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
            // The author's own sentence about the package, narrowed by the loader. It is
            // the only text in this answer that says what a package is FOR. It is `''`
            // when the manifest declares none, and the panel renders nothing for an empty
            // string rather than inventing a sentence the author never wrote.
            description: mod.manifest.description,
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
