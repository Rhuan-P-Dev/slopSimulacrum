/**
 * repo — File I/O for the editor's local store, the live game registry, and
 * pre-apply backups.
 *
 * WHY this exists:
 *   The user chose a *local store + apply* model. The local store
 *   (editor/data/actions.json) is the editable source of truth for a session;
 *   "apply" copies it over the game's data/actions.json — the only mutation the
 *   editor performs against the parent project.
 *
 *   A timestamped backup of the *current* live file is written to
 *   editor/data/backups/ before every apply, so a botched edit is always
 *   revertible without touching git history.
 *
 * @module repo
 */

import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';

/**
 * Read a JSON file, returning `fallback` on any I/O or parse error.
 * @param {string} filePath
 * @param {*} fallback
 * @returns {*}
 */
export function readJsonSafe(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        return fallback;
    }
}

/**
 * Read the game's live action registry.
 * @returns {Object|null} The registry, or null if missing/unparseable.
 */
export function readLiveRegistry() {
    return readJsonSafe(paths.liveActionsFile, null);
}

/**
 * Read (or lazily seed) the local editable store.
 *
 * Seeding from the live file means a fresh editor always starts from the
 * current game state. Once the store exists on disk, it is the user's work
 * and is never overwritten by a seed.
 * @returns {Object}
 */
export function readLocalStore() {
    // If there is real local content, trust it (never re-seed over user work).
    const existing = readJsonSafe(paths.localStoreFile, null);
    let store = existing && Object.keys(existing).length > 0 ? { ...existing } : null;

    if (store === null) {
        // First run: seed from live, or start empty.
        const live = readLiveRegistry();
        store = live && Object.keys(live).length > 0 ? { ...live } : {};
        // Persist the seed so the store file is defined on disk.
        persistStore(store);
    }
    return store;
}

/**
 * Write the local editable store to disk.
 * @param {Object} registry
 * @returns {{ok:boolean, error?:string}}
 */
export function saveLocalStore(registry) {
    return persistStore(registry);
}

/**
 * Persist a registry to the local store file.
 * @param {Object} registry
 * @returns {{ok:boolean, error?:string}}
 * @private
 */
function persistStore(registry) {
    try {
        fs.mkdirSync(path.dirname(paths.localStoreFile), { recursive: true });
        fs.writeFileSync(paths.localStoreFile, JSON.stringify(registry, null, 2) + '\n');
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Copy the local store over the game's live registry, writing a backup of the
 * current live file first.
 * @param {Object} registry
 * @returns {{ok:boolean, backupPath?:string, error?:string}}
 */
export function applyToLive(registry) {
    const live = paths.liveActionsFile;
    try {
        fs.mkdirSync(paths.backupDir, { recursive: true });

        let backupPath = null;
        if (fs.existsSync(live)) {
            const stamp = new Date().toISOString().replace(/[:T._]/g, '-').slice(0, 19);
            backupPath = path.join(paths.backupDir, `actions.${stamp}.json`);
            fs.copyFileSync(live, backupPath);
        }

        fs.mkdirSync(path.dirname(live), { recursive: true });
        fs.writeFileSync(live, JSON.stringify(registry, null, 2) + '\n');
        return { ok: true, backupPath };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Restore a backup over the live registry. `backupPath` may be an absolute
 * path, a bare name, or 'latest' (newest backup).
 * @param {string} [backupPath='latest']
 * @returns {{ok:boolean, restoredPath?:string, error?:string}}
 */
export function revertLive(backupPath = 'latest') {
    try {
        fs.mkdirSync(paths.backupDir, { recursive: true });
        const files = fs
            .readdirSync(paths.backupDir)
            .filter((f) => f.endsWith('.json'))
            .sort(); // timestamp-prefixed names sort chronologically

        if (files.length === 0) {
            return { ok: false, error: `no backups in ${paths.backupDir}` };
        }

        let chosen = backupPath === 'latest' ? files[files.length - 1] : backupPath;
        let target;
        if (fs.existsSync(chosen)) {
            target = chosen;
        } else if (fs.existsSync(path.join(paths.backupDir, chosen))) {
            target = path.join(paths.backupDir, chosen);
        } else {
            // Fall back to latest when the named backup is not found.
            target = path.join(paths.backupDir, files[files.length - 1]);
        }

        const live = paths.liveActionsFile;
        fs.mkdirSync(path.dirname(live), { recursive: true });
        fs.copyFileSync(target, live);
        return { ok: true, restoredPath: target };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * List available backups, newest first.
 * @returns {{name:string, size:number, mtime:number}[]}
 */
export function listBackups() {
    try {
        return fs
            .readdirSync(paths.backupDir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => {
                const p = path.join(paths.backupDir, f);
                const st = fs.statSync(p);
                return { name: f, size: st.size, mtime: st.mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);
    } catch {
        return [];
    }
}

/**
 * Diff the local store against the live registry.
 * @param {Object} local
 * @param {Object} live
 * @returns {{added:string[], removed:string[], changed:string[], same:boolean}}
 */
export function diffRegistries(local, live) {
    const localKeys = new Set(Object.keys(local || {}));
    const liveKeys = new Set(Object.keys(live || {}));
    const added = [...localKeys].filter((k) => !liveKeys.has(k));
    const removed = [...liveKeys].filter((k) => !localKeys.has(k));
    const changed = [...localKeys].filter(
        (k) =>
            liveKeys.has(k) &&
            JSON.stringify(local[k], undefined, 2) !== JSON.stringify(live[k], undefined, 2),
    );
    return { added, removed, changed, same: added.length === 0 && removed.length === 0 && changed.length === 0 };
}
