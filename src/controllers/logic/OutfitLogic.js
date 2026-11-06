/**
 * OutfitLogic — what a body is born wearing, by blueprint (registry kind
 * `outfits`, `data/mods/core-outfits/outfits.json`).
 *
 * `WearLogic` answers "can this component wear this item" (pure volume fit). The
 * spawn loadouts answer "what does this spawn carry". Neither answered "what does
 * THIS body wear, and on which part" — so a body designed from a character card
 * could be built out of any parts at all and still be dressed like a generic M1,
 * the shirt landing wherever the volume happened to be free.
 *
 * The outfit registry is that missing claim. It is keyed by BLUEPRINT key — which,
 * for a card designed in the "Create Agent Body" tab, IS the card's display name:
 * the same key its saved body is stored under, so designing a body and dressing it
 * are two writes to two registries keyed by one thing. Each entry names a garment
 * (an `inventoryItems` definition that declares `wear.minVolume`) and the component
 * TYPE of that body to wear it on.
 *
 * THE ONE RULE BOTH SPAWN READERS SHARE — and the reason `clothedByOutfit` is
 * exported rather than inlined: when the registry clothes a body, the default
 * clothing of the spawn loadouts (`wear: true` in `core-world` initialSpawns, in
 * `core-npcs` npcs.json, or in the card profile's initialItems) is NOT applied. A
 * body wears its outfit; the world's shirt is for bodies nobody dressed. Nothing
 * else in those loadouts moves — coal, toolbelts and knives are not clothing.
 *
 * What this module deliberately does NOT do: no fit invention, no layers, no
 * "best available part". A garment goes on the component the data named, through
 * `facade.wearItem` — the same seam an NPC uses when it dresses itself — and a
 * garment that cannot go on is a warning. Spawning never fails because of
 * clothing, the discipline every other spawn side-effect follows.
 *
 * Dependencies: the facade (WorldStateController) for the live registries, the
 * inventory and the wear seam; `DataLoader` only for a facade built without a
 * registry store. Boot validation (`validateOutfitRegistry`) is called by the
 * composition root, and by `CompositionClassifier` at a mod swap, so the rule that
 * accepts an outfit is one claim with two readers (`T-1`, `CHG-2`).
 *
 * @module src/controllers/logic/OutfitLogic
 */

import { REGISTRY_KINDS } from '../../../shared/RegistryKinds.js';
import Logger from '../../utils/Logger.js';
import DataLoader from '../../utils/DataLoader.js';
import { GameError } from '../../utils/CustomErrors.js';

/**
 * The outfit registry the server is actually running (the live store when a store
 * was injected, the data seam when it was not — same idiom as
 * `readRegistryFrom`, and the reason a mod swap re-dresses the world at the round
 * boundary instead of needing a restart).
 * @param {import('../WorldStateController.js').default} facade
 * @returns {Object}
 * @private
 */
function outfitRegistry(facade) {
    if (facade && typeof facade.getRegistry === 'function') {
        return facade.getRegistry(REGISTRY_KINDS.OUTFITS) || {};
    }
    return DataLoader.loadRegistry(REGISTRY_KINDS.OUTFITS, {});
}

/**
 * One entry of an outfit, narrowed once (`T-1`): `{ item, component }`, both
 * non-empty strings. Anything else is a half-written wish and is skipped with a
 * warn — an outfit is a wish about a body, and a wish nobody can read puts
 * nothing on anybody.
 * @param {Object} entry
 * @returns {{ item: string, component: string }|null}
 * @private
 */
function narrowOutfitEntry(entry) {
    const item = (entry && typeof entry.item === 'string') ? entry.item.trim() : '';
    const component = (entry && typeof entry.component === 'string') ? entry.component.trim() : '';
    return (item && component) ? { item, component } : null;
}

/**
 * The outfit authored for one blueprint key. An absent key (or a value that is not
 * an array) means this body authors no outfit — the normal state of a world where
 * most bodies are undressed by hand, not a defect.
 * @param {import('../WorldStateController.js').default} facade
 * @param {string} blueprintKey - the entity's blueprint key (`entity.blueprint`).
 * @returns {Array<{ item: string, component: string }>}
 */
function outfitForBlueprint(facade, blueprintKey) {
    if (typeof blueprintKey !== 'string' || blueprintKey === '') return [];
    const authored = outfitRegistry(facade)[blueprintKey];
    if (!Array.isArray(authored)) return [];
    const entries = [];
    for (const raw of authored) {
        const entry = narrowOutfitEntry(raw);
        if (!entry) {
            Logger.warn(`[OutfitLogic] Outfit entry for "${blueprintKey}" needs both "item" and "component"; skipped.`);
            continue;
        }
        entries.push(entry);
    }
    return entries;
}

/**
 * Does the registry clothe this body? THE question both spawn readers ask before
 * applying their default `wear` entries: a body the registry speaks about does not
 * also wear the world's default shirt (`wiki/decisions/agent-body-design.md`).
 *
 * An authored EMPTY list counts, and means what it says: born wearing NOTHING. An
 * absent key means nobody dressed this body, and the default stays in force. That
 * distinction is the only reason the save is allowed to write an empty outfit at all
 * (`wiki/decisions/outfits.md`). A key whose entries are all malformed counts as
 * nothing authored - the body falls back to the default rather than going naked
 * because of a typo, and `outfitForBlueprint` already warned about each entry.
 * @param {import('../WorldStateController.js').default} facade
 * @param {Object|null|undefined} entity - the spawned entity record.
 * @returns {boolean}
 */
function clothedByOutfit(facade, entity) {
    const blueprintKey = entity && entity.blueprint;
    if (typeof blueprintKey !== 'string' || blueprintKey === '') return false;
    const authored = outfitRegistry(facade)[blueprintKey];
    if (!Array.isArray(authored)) return false;
    return authored.length === 0 || outfitForBlueprint(facade, blueprintKey).length > 0;
}

/**
 * Puts one garment on the body: added to the component it is worn on (a garment has
 * to exist in an inventory before the wear seam can take it — the same order the
 * spawn loadout follows), then worn through `facade.wearItem`, so the fit rule is
 * the wear system's and not a second opinion here.
 * @param {import('../WorldStateController.js').default} facade
 * @param {Object} entity - the spawned entity record.
 * @param {{ item: string, component: string }} entry
 * @returns {boolean} true when the garment is on.
 * @private
 */
function wearOutfitEntry(facade, entity, entry) {
    const itemDef = facade.inventoryManager.getItemDefinitions()[entry.item];
    if (!itemDef) {
        Logger.warn(`[OutfitLogic] Outfit for "${entity.blueprint}" names item "${entry.item}", which the item registry does not define.`);
        return false;
    }
    const target = entity.components.find((component) => component.type === entry.component) || null;
    if (!target) {
        Logger.warn(`[OutfitLogic] Outfit for "${entity.blueprint}" puts "${entry.item}" on "${entry.component}", which this body does not have.`);
        return false;
    }
    const added = facade.inventoryManager.addItem(entity, entry.item, target.id, {
        componentController: facade.componentController
    });
    if (!added.success || !added.item || !added.item.id) {
        Logger.warn(`[OutfitLogic] Outfit "${entry.item}" could not be added to ${entity.id}/${target.type}: ${added.message}`);
        return false;
    }
    const worn = facade.wearItem(entity.id, added.item.id, target.id);
    if (!worn.success) {
        Logger.warn(`[OutfitLogic] Outfit "${entry.item}" does not fit ${entity.id}/${target.type}: ${worn.message}`);
        return false;
    }
    Logger.info(`[OutfitLogic] "${entity.blueprint}" wears "${entry.item}" on ${target.type} (${entity.id}).`);
    return true;
}

/**
 * Dresses a just-spawned entity: every garment its blueprint's outfit names, on the
 * component the outfit named for it. Warn-only, like every spawn side-effect: a
 * garment that does not fit, or a part this body does not have, leaves the body
 * undressed and the spawn intact.
 * @param {import('../WorldStateController.js').default} facade
 * @param {string} entityId
 * @returns {{ applied: number, failed: number }}
 */
function applyOutfit(facade, entityId) {
    const entity = facade.stateEntityController.getEntity(entityId);
    const entries = outfitForBlueprint(facade, entity && entity.blueprint);
    if (entries.length === 0) return { applied: 0, failed: 0 };
    if (!entity || !Array.isArray(entity.components)) {
        Logger.warn(`[OutfitLogic] Entity "${entityId}" has no components to dress (${entries.length} outfit entry(ies) not worn).`);
        return { applied: 0, failed: entries.length };
    }
    let applied = 0;
    let failed = 0;
    for (const entry of entries) {
        if (wearOutfitEntry(facade, entity, entry)) applied += 1;
        else failed += 1;
    }
    return { applied, failed };
}

/**
 * The rule an outfit definition has to satisfy, as one claim with two readers: the
 * composition root calls it at boot (fail fast — `E-8`), `CompositionClassifier`
 * calls it per definition at a mod swap (quarantine the entry that cannot be
 * worn, keep the world running).
 *
 * It checks what the world can know at boot: the entry is `{ item, component }` of
 * non-empty strings, the item exists, and the item is wearable (it declares
 * `wear.minVolume`). It does NOT check that the component exists in the blueprint:
 * a garment for a part this body does not have is a spawn-time warning, not a
 * broken world — and a boot rule that opened every blueprint to check would be a
 * second owner of the body tree.
 * @param {Object} outfits - the outfits registry (a `_`-prefixed key is file metadata).
 * @param {Object} itemRegistry - the item registry (`inventoryItems`).
 * @throws {GameError} OUTFIT_DEFINITION_INVALID - names the blueprint key and the defect.
 */
function validateOutfitRegistry(outfits, itemRegistry) {
    const itemDefs = itemRegistry || {};
    for (const [blueprintKey, entries] of Object.entries(outfits || {})) {
        if (blueprintKey.startsWith('_')) continue;
        if (!Array.isArray(entries)) {
            throw new GameError(
                `OutfitLogic: outfit for "${blueprintKey}" must be an array of { item, component }`,
                'OUTFIT_DEFINITION_INVALID'
            );
        }
        for (const raw of entries) {
            const entry = narrowOutfitEntry(raw);
            if (!entry) {
                throw new GameError(
                    `OutfitLogic: outfit for "${blueprintKey}" needs both "item" and "component"`,
                    'OUTFIT_DEFINITION_INVALID'
                );
            }
            const itemDef = itemDefs[entry.item];
            if (!itemDef) {
                throw new GameError(
                    `OutfitLogic: outfit for "${blueprintKey}" names item "${entry.item}", which the item registry does not define`,
                    'OUTFIT_DEFINITION_INVALID'
                );
            }
            if (!itemDef.wear || typeof itemDef.wear.minVolume !== 'number') {
                throw new GameError(
                    `OutfitLogic: outfit for "${blueprintKey}" puts "${entry.item}" on a body, but that item is not wearable (no wear.minVolume)`,
                    'OUTFIT_DEFINITION_INVALID'
                );
            }
        }
    }
}

export { outfitForBlueprint, clothedByOutfit, applyOutfit, validateOutfitRegistry };
