/**
 * MachineRegistryController — state controller owning the machine registry.
 *
 * A machine is a world entity built from a named blueprint whose component carries a
 * self-sustaining organ (e.g. `knifeGeneratorIC` — forges a knife every interval).
 * The registry (data/systems/machines.json) binds the three forms of the same thing:
 *   - `itemKey`   — the inventory item type a player carries and crafts,
 *   - `blueprint` — the entity blueprint materialized in the world when PLACED,
 *   - `recipeId`  — the crafting recipe that produces the item form.
 *
 * Per the State Controller pattern (wiki/subMDs/controllers/controller_patterns.md §4)
 * this controller holds raw data and has NO cross-controller dependencies: it is
 * constructed by the composition root with the raw registries (machines / blueprints /
 * items / crafting) for fail-fast cross-validation at boot — a machine whose
 * blueprint, item, or recipe is missing fails the server at startup, not a player
 * mid-game. It never touches entity/item state: the actual place/retrieve work lives
 * in the consequence handlers (PlaceMachineHandler / RetrieveMachineHandler).
 *
 * Deliberately has NO `getAll()`: the static machine registry must stay out of the
 * full-state broadcast aggregation (same exclusion rule as CraftingController /
 * RoomChatController).
 *
 * @module MachineRegistryController
 */

import Logger from '../../utils/Logger.js';

class MachineRegistryController {
    /**
     * @param {Object} machineRegistry - Raw data from data/systems/machines.json:
     *   `{ [machineKey]: { name, blueprint, itemKey, recipeId } }`.
     * @param {Object} blueprintRegistry - Raw data from data/entities/blueprints.json,
     *   to validate each machine's blueprint is known.
     * @param {Object} itemRegistry - Raw data from data/components/inventoryItems.json,
     *   to validate each machine's itemKey exists.
     * @param {Object} craftingRegistry - Raw data from data/systems/crafting.json,
     *   to validate each machine's recipeId exists.
     */
    constructor(machineRegistry, blueprintRegistry = {}, itemRegistry = {}, craftingRegistry = {}) {
        this._registry = machineRegistry && typeof machineRegistry === 'object' && !Array.isArray(machineRegistry)
            ? machineRegistry
            : {};
        this._blueprintRegistry = blueprintRegistry || {};
        this._itemRegistry = itemRegistry || {};
        this._craftingRegistry = craftingRegistry || {};
        this._validate();
        Logger.info(`[MachineRegistryController] initialized with ${this.getMachineTypes().length} machine(s)`);
    }

    /**
     * Validates the machine registry at boot (project rule §6). Skips `_`-prefixed
     * documentation keys. Throws TypeError on a malformed entry or a dangling
     * reference (unknown blueprint / item / recipe).
     * @private
     */
    _validate() {
        for (const [key, def] of Object.entries(this._registry)) {
            if (key.startsWith('_')) continue;
            if (!def || typeof def !== 'object' || Array.isArray(def)) {
                throw new TypeError(`Machine "${key}" must be an object.`);
            }
            if (typeof def.name !== 'string' || def.name.length === 0) {
                throw new TypeError(`Machine "${key}" has a missing or empty "name".`);
            }
            if (typeof def.blueprint !== 'string' || !this._blueprintRegistry[def.blueprint]) {
                throw new TypeError(`Machine "${key}" references unknown blueprint "${def.blueprint}".`);
            }
            if (typeof def.itemKey !== 'string' || !this._itemRegistry[def.itemKey]) {
                throw new TypeError(`Machine "${key}" references unknown item type "${def.itemKey}".`);
            }
            if (def.recipeId !== undefined && (typeof def.recipeId !== 'string' || !this._craftingRegistry[def.recipeId])) {
                throw new TypeError(`Machine "${key}" references unknown recipe "${def.recipeId}".`);
            }
        }
    }

    /**
     * Returns all machine definitions as an array (with the registry key attached as
     * `type`). Defensive deep copy.
     * @returns {Array<Object>}
     */
    getMachines() {
        return Object.entries(this._registry)
            .filter(([key]) => !key.startsWith('_'))
            .map(([key, def]) => structuredClone({ type: key, ...def }));
    }

    /**
     * Returns one machine definition by its registry key (with `type` attached).
     * @param {string} machineType - The machine registry key (e.g. "knifeGenerator").
     * @returns {Object|null} Defensive deep copy, or null if unknown.
     */
    getMachine(machineType) {
        const def = this._registry[machineType];
        if (!def || machineType.startsWith('_')) return null;
        return structuredClone({ type: machineType, ...def });
    }

    /**
     * Finds the machine whose `itemKey` matches the given inventory item type.
     * @param {string} itemKey - An inventory item type (e.g. "knifeGenerator").
     * @returns {Object|null} The machine def (with `type`), or null if the item is not a machine.
     */
    machineForItem(itemKey) {
        if (typeof itemKey !== 'string') return null;
        for (const [key, def] of Object.entries(this._registry)) {
            if (key.startsWith('_')) continue;
            if (def.itemKey === itemKey) return this.getMachine(key);
        }
        return null;
    }

    /**
     * Whether the given inventory item type is a machine item.
     * @param {string} itemKey
     * @returns {boolean}
     */
    isMachineItem(itemKey) {
        return this.machineForItem(itemKey) !== null;
    }

    /**
     * Returns the machine keys (array of strings).
     * @returns {Array<string>}
     */
    getMachineTypes() {
        return Object.keys(this._registry).filter((k) => !k.startsWith('_'));
    }
}

export default MachineRegistryController;
