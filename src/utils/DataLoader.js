import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Logger from './Logger.js';
import { GameError } from './CustomErrors.js';
import { REGISTRY_KINDS, isRegistryKind } from '../../shared/RegistryKinds.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Where each registry kind lives on disk, relative to the project root.
 *
 * This is the ONLY place in the codebase that maps a registry kind to a file.
 * Readers ask for a kind (`loadRegistry(REGISTRY_KINDS.MATERIALS)`), never for a
 * path, so the world definition can be re-homed (a mod package becoming the
 * source of a kind) without touching a single reader. Before this table, 49
 * references in `src/` named paths and the filesystem was the interface of the
 * world.
 *
 * @type {Object.<string, string>}
 */
const REGISTRY_SOURCE_PATHS = Object.freeze({
    [REGISTRY_KINDS.COMPONENTS]: 'data/components/components.json',
    [REGISTRY_KINDS.HOLDING_COST]: 'data/components/holdingCost.json',
    [REGISTRY_KINDS.INTERNAL_COMPONENTS]: 'data/components/internalComponents.json',
    [REGISTRY_KINDS.INVENTORY_ITEMS]: 'data/components/inventoryItems.json',
    [REGISTRY_KINDS.SENSITIVE_PARTS]: 'data/components/sensitiveParts.json',
    [REGISTRY_KINDS.TRAITS]: 'data/components/traits.json',
    [REGISTRY_KINDS.BLUEPRINTS]: 'data/entities/blueprints.json',
    [REGISTRY_KINDS.ENTITY_ATTRIBUTES]: 'data/entities/entity_attributes.json',
    [REGISTRY_KINDS.NPCS]: 'data/entities/npcs.json',
    [REGISTRY_KINDS.MATERIALS]: 'data/materials/materials.json',
    [REGISTRY_KINDS.MATERIAL_DAMAGE_TYPES]: 'data/materials/materialDamageTypes.json',
    [REGISTRY_KINDS.MATERIAL_DROP_RATES]: 'data/materials/materialDropRates.json',
    [REGISTRY_KINDS.PROPERTY_TRAIT_MAPPING]: 'data/materials/propertyTraitMapping.json',
    [REGISTRY_KINDS.ACTIONS]: 'data/systems/actions.json',
    [REGISTRY_KINDS.CRAFTING]: 'data/systems/crafting.json',
    [REGISTRY_KINDS.MACHINES]: 'data/systems/machines.json',
    [REGISTRY_KINDS.SYNERGY]: 'data/systems/synergy.json',
    [REGISTRY_KINDS.ROOMS]: 'data/world/rooms.json',
    [REGISTRY_KINDS.WORLD]: 'data/world/world.json',
    [REGISTRY_KINDS.WORLD_OBJECTS]: 'data/world/worldObjects.json',
    [REGISTRY_KINDS.WORLD_RULES]: 'data/world/world_rules.json'
});

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
