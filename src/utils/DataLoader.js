import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Logger from './Logger.js';
import { GameError } from './CustomErrors.js';
import { REGISTRY_KINDS, isRegistryKind } from '../../shared/RegistryKinds.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Where each registry kind lives ON DISK, relative to the project root: the
 * file of the OFFICIAL mod package that ships it (`data/mods/core-<id>/`).
 *
 * This is the ONLY place in the codebase that maps a registry kind to a file.
 * Readers ask for a kind (`loadRegistry(REGISTRY_KINDS.MATERIALS)`), never for a
 * path, so the world definition can be re-homed without touching a single
 * reader. Before the table, 49 references in `src/` named paths and the
 * filesystem was the interface of the world.
 *
 * WHAT THIS TABLE IS NOT: it is not the live world definition. The live one is
 * what the `RegistryStore` holds, merged from every enabled mod package. This
 * table is the *shipped* source of a kind, which is what a WRITE needs — the
 * component recipes and blueprints `AgentBodyController.saveDesign` persists
 * must land in the official package, not in some overlay, and they take the
 * path from here so the two can never disagree.
 *
 * The two snake_case files this table used to name are renamed to the kind
 * (`worldRules.json`, `entityAttributes.json`): inside a mod package a content
 * file is `<kind>.json`, always, so a manifest never names a file and no path
 * is ever built from package content (`SEC-7`).
 *
 * @type {Object.<string, string>}
 */
const REGISTRY_SOURCE_PATHS = Object.freeze({
    [REGISTRY_KINDS.COMPONENTS]: 'data/mods/core-components/components.json',
    [REGISTRY_KINDS.HOLDING_COST]: 'data/mods/core-holding-cost/holdingCost.json',
    [REGISTRY_KINDS.INTERNAL_COMPONENTS]: 'data/mods/core-internal-components/internalComponents.json',
    [REGISTRY_KINDS.INVENTORY_ITEMS]: 'data/mods/core-inventory-items/inventoryItems.json',
    [REGISTRY_KINDS.SENSITIVE_PARTS]: 'data/mods/core-sensitive-parts/sensitiveParts.json',
    [REGISTRY_KINDS.TRAITS]: 'data/mods/core-traits/traits.json',
    [REGISTRY_KINDS.BLUEPRINTS]: 'data/mods/core-blueprints/blueprints.json',
    [REGISTRY_KINDS.ENTITY_ATTRIBUTES]: 'data/mods/core-entity-attributes/entityAttributes.json',
    [REGISTRY_KINDS.NPCS]: 'data/mods/core-npcs/npcs.json',
    [REGISTRY_KINDS.OUTFITS]: 'data/mods/core-outfits/outfits.json',
    [REGISTRY_KINDS.MATERIALS]: 'data/mods/core-materials/materials.json',
    [REGISTRY_KINDS.MATERIAL_DAMAGE_TYPES]: 'data/mods/core-material-damage-types/materialDamageTypes.json',
    [REGISTRY_KINDS.MATERIAL_DROP_RATES]: 'data/mods/core-material-drop-rates/materialDropRates.json',
    [REGISTRY_KINDS.PROPERTY_TRAIT_MAPPING]: 'data/mods/core-property-trait-mapping/propertyTraitMapping.json',
    [REGISTRY_KINDS.ACTIONS]: 'data/mods/core-actions/actions.json',
    [REGISTRY_KINDS.CRAFTING]: 'data/mods/core-crafting/crafting.json',
    [REGISTRY_KINDS.MACHINES]: 'data/mods/core-machines/machines.json',
    [REGISTRY_KINDS.SYNERGY]: 'data/mods/core-synergy/synergy.json',
    [REGISTRY_KINDS.EFFECTS]: 'data/mods/core-effects/effects.json',
    [REGISTRY_KINDS.ROOMS]: 'data/mods/core-rooms/rooms.json',
    [REGISTRY_KINDS.WORLD]: 'data/mods/core-world/world.json',
    [REGISTRY_KINDS.WORLD_OBJECTS]: 'data/mods/core-world-objects/worldObjects.json',
    [REGISTRY_KINDS.WORLD_RULES]: 'data/mods/core-world-rules/worldRules.json'
});

/**
 * Where the mod enable / load-order state lives. User-visible and user-editable
 * (`wiki/decisions/mod-system.md` §7), which is why reading it degrades instead of
 * throwing and writing it goes through the same atomic path as everything else here.
 */
export const MOD_STATE_PATH = 'data/mods/loadorder.json';

/**
 * DataLoader provides a centralized way to load JSON configuration files.
 * This ensures that controllers remain generic interpreters of data
 * and are not tightly coupled to the filesystem.
 */
class DataLoader {
    /**
     * Loads a JSON file from the specified relative path.
     * @param {string} relativePath - Path relative to the project root.
     * @returns {any} The parsed JSON content.
     * @throws {Error} If the file cannot be read or parsed.
     */
    static loadJson(relativePath) {
        try {
            const absolutePath = path.resolve(__dirname, '..', '..', relativePath);
            const data = fs.readFileSync(absolutePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            Logger.error(`[DataLoader] Failed to load file at ${relativePath}:`, error.stack || error);
            throw new Error(`[DataLoader] Failed to load file at ${relativePath}: ${error.message}`, { cause: error });
        }
    }

    /**
     * The file a registry kind is read from today. Exposed for reports and for
     * the mod loader's provenance output; readers never need it.
     * @param {string} kind - A registry kind from `shared/RegistryKinds.js`.
     * @returns {string} Path relative to the project root.
     * @throws {GameError} REGISTRY_KIND_UNKNOWN - the kind is not in the vocabulary.
     */
    static registrySourcePath(kind) {
        if (!isRegistryKind(kind)) {
            throw new GameError(
                `DataLoader: unknown registry kind "${kind}"`,
                'REGISTRY_KIND_UNKNOWN'
            );
        }
        return REGISTRY_SOURCE_PATHS[kind];
    }

    /**
     * Loads one registry by KIND (the safe variant: a missing or unreadable
     * source yields `defaultValue`, and that part of the world is simply empty).
     *
     * This is what a reader calls. Naming a kind rather than a path is what
     * lets the same registry come from a mod package while the server runs
     * (`wiki/decisions/mod-system.md`); the live definition is the one the
     * `RegistryStore` holds, and this method is how the boot path fills it.
     * @param {string} kind - A registry kind from `shared/RegistryKinds.js`.
     * @param {any} defaultValue - Value returned when the source cannot be read.
     * @returns {any}
     */
    static loadRegistry(kind, defaultValue = {}) {
        return this.loadJsonSafe(this.registrySourcePath(kind), defaultValue);
    }

    /**
     * Safely loads a JSON file, returning a default value if loading fails.
     * @param {string} relativePath - Path relative to the project root.
     * @param {any} defaultValue - Value to return on failure.
     * @returns {any}
     */
    static loadJsonSafe(relativePath, defaultValue = {}) {
        try {
            return this.loadJson(relativePath);
        } catch (error) {
            Logger.warn(`[DataLoader] Failed to load ${relativePath}, using default: ${error.message}`);
            return defaultValue;
        }
    }

    /**
     * Names the entries of a directory under the project root, sorted, each with
     * the kind flag the caller needs.
     *
     * This exists for mod discovery (`wiki/decisions/mod-system.md`): the loader
     * must see which packages are installed without importing `fs` itself, which
     * stays inside the data seam (`CR B-3`). An absent directory returns an EMPTY
     * list rather than throwing — "no mods installed" is the normal state of a
     * fresh checkout, not a failure.
     * @param {string} relativePath - Path relative to the project root.
     * @returns {Array<{name: string, isDirectory: boolean}>} Sorted by name.
     */
    static listDir(relativePath) {
        const absolutePath = path.resolve(__dirname, '..', '..', relativePath);
        let names;
        try {
            names = fs.readdirSync(absolutePath);
        } catch (error) {
            Logger.debug(`[DataLoader] No directory at ${relativePath}: ${error.message}`);
            return [];
        }
        return names.sort().map((name) => {
            let isDirectory = false;
            try {
                isDirectory = fs.statSync(path.join(absolutePath, name)).isDirectory();
            } catch (error) {
                // A dangling entry is not a mod directory; report it as a file.
                Logger.debug(`[DataLoader] Cannot stat ${relativePath}/${name}: ${error.message}`);
            }
            return { name, isDirectory };
        });
    }

    /**
     * Reads the mod state: which packages are enabled and in what order.
     *
     * The file is user-editable tuning data, so it degrades rather than throwing:
     * absent means "everything enabled at the default order", and an entry whose fields
     * are the wrong type has that field ignored (with a warn) instead of taking the
     * server down. What it never does is fail silently — every deviation is logged, and
     * `POST /mods/rescan` shows the resulting per-package truth (`WR-1` reasoning, and
     * the opposite of `AP-3`: this is a documented default for a config file, not a
     * catch-and-`{}` around a computation).
     * @returns {Object.<string, {enabled?: boolean, loadOrder?: number}>} keyed by mod id
     */
    static loadModState() {
        const raw = this.loadJsonSafe(MOD_STATE_PATH, null);
        const state = {};
        if (raw === null || raw === undefined) return state;
        if (typeof raw !== 'object' || Array.isArray(raw)) {
            Logger.warn(`[DataLoader] Mod state at ${MOD_STATE_PATH} is not an object; using defaults`);
            return state;
        }
        if (!Array.isArray(raw.mods)) {
            Logger.warn(`[DataLoader] Mod state at ${MOD_STATE_PATH} has no "mods" array; using defaults`);
            return state;
        }
        for (const entry of raw.mods) {
            if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.length === 0) {
                Logger.warn(`[DataLoader] Mod state entry without an id in ${MOD_STATE_PATH}; skipped`);
                continue;
            }
            const perMod = {};
            if (typeof entry.enabled === 'boolean') perMod.enabled = entry.enabled;
            else if (entry.enabled !== undefined) {
                Logger.warn(`[DataLoader] Mod "${entry.id}" has a non-boolean "enabled"; ignored`);
            }
            if (typeof entry.loadOrder === 'number' && Number.isFinite(entry.loadOrder)) perMod.loadOrder = entry.loadOrder;
            else if (entry.loadOrder !== undefined) {
                Logger.warn(`[DataLoader] Mod "${entry.id}" has a non-numeric "loadOrder"; ignored`);
            }
            state[entry.id] = perMod;
        }
        return state;
    }

    /**
     * Writes the mod state (atomic, like every write through the seam).
     *
     * Sorted by id so the file has a stable diff: the state is written by the server on
     * an enable/disable, and a file whose entries shuffle on every write turns a review
     * into a guess.
     * @param {Object.<string, {enabled?: boolean, loadOrder?: number}>} state - keyed by mod id
     * @returns {string} the relative path written
     */
    static saveModState(state = {}) {
        const mods = Object.keys(state).sort().map((id) => {
            const entry = { id };
            if (typeof state[id]?.enabled === 'boolean') entry.enabled = state[id].enabled;
            if (typeof state[id]?.loadOrder === 'number') entry.loadOrder = state[id].loadOrder;
            return entry;
        });
        this.saveJson(MOD_STATE_PATH, { mods });
        return MOD_STATE_PATH;
    }

    /**
     * Saves a JSON-serializable value to the specified relative path. Atomic:
     * writes to a sibling ".tmp" file then renames over the target, so a process
     * that dies mid-write never leaves a half-written (corrupt) data file.
     * @param {string} relativePath - Path relative to the project root (same
     *   resolution as loadJson).
     * @param {*} data - Value to serialize.
     */
    static saveJson(relativePath, data) {
        const absolutePath = path.resolve(__dirname, '..', '..', relativePath);
        const tempPath = absolutePath + '.tmp';
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
        fs.renameSync(tempPath, absolutePath);
    }

    /**
     * True when a path inside the data tree exists.
     *
     * WHY THIS IS NOT `loadJsonSafe(path, null) !== null`: asking "is it there?" by
     * reading it logs an ERROR on every absent first write (`loadJson` logs before
     * `loadJsonSafe` degrades), and a package write that has to create its first file
     * would scream about a file it is about to make. Existence is its own question, so it
     * gets its own seam call.
     * @param {string} relativePath - Path relative to the project root.
     * @returns {boolean}
     */
    static exists(relativePath) {
        return fs.existsSync(path.resolve(__dirname, '..', '..', relativePath));
    }

    /**
     * Creates a directory (and any missing parent) inside the data tree.
     *
     * WHY THIS IS HERE AND NOT IN THE CALLER. A new mod package is a directory
     * before it is a file, and `cr/no-direct-file-read` (CR B-3) keeps `fs` out of
     * every other module: the package writer asks the seam for the directory rather
     * than importing `fs` itself, so the seam stays the one place that touches the
     * disk (`wiki/decisions/mod-system.md`, `CR B-3b`). It is recursive, because a
     * package directory has exactly one level to create and a missing parent is a
     * real first-write case, not a bug.
     *
     * The path is resolved the same way every other seam path is, from a caller that
     * must already have validated its own segment (a mod id is matched against
     * `MOD_ID_PATTERN` before it reaches here — `SEC-7`).
     * @param {string} relativePath - Path relative to the project root.
     * @returns {string} the relative path created.
     */
    static ensureDir(relativePath) {
        const absolutePath = path.resolve(__dirname, '..', '..', relativePath);
        fs.mkdirSync(absolutePath, { recursive: true });
        return relativePath;
    }

    /**
     * Copies one data file to another (used for timestamped pre-write backups).
     * Returns the destination relative path.
     * @param {string} fromRelative - Source path relative to the project root.
     * @param {string} toRelative - Destination path relative to the project root.
     * @returns {string} the destination relative path.
     */
    static copyFile(fromRelative, toRelative) {
        const fromAbsolute = path.resolve(__dirname, '..', '..', fromRelative);
        const toAbsolute = path.resolve(__dirname, '..', '..', toRelative);
        fs.copyFileSync(fromAbsolute, toAbsolute);
        return toRelative;
    }
}

export default DataLoader;
