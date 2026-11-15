/**
 * CompositionClassifier — which definitions in a candidate survive the world's own
 * composition rules, and which do not.
 *
 * The throwing validators stay where they are: `MaterialController.validateComposition`
 * keeps its contract, `CraftingController` and `MachineRegistryController` keep
 * validating at boot (`wiki/decisions/mod-system.md`, decision 6). What they cannot do
 * is answer "and what else would be wrong?" — they throw on the first defect, which is
 * the right behaviour for a boot you want to fail and the wrong one for a plan you want
 * to read. This module runs the same rules and collects every failure instead of
 * stopping at it.
 *
 * IT REUSES THE OWNERS, ON PURPOSE. A second implementation of "materials must sum to
 * one" or "a machine's recipe must exist" is a second truth that starts disagreeing the
 * day the real rule changes. So classification calls the owner: one construction over
 * the whole registry in the happy case, and per-definition constructions only to name
 * the culprit after that construction threw. The rule text lives in exactly one place
 * either way.
 *
 * ORDER IS A DEPENDENCY CHAIN, NOT A STYLE CHOICE: materials (the base) → components and
 * items → crafting recipes → machines. A machine is checked against the recipes that
 * SURVIVED, so a recipe quarantined for a bad material takes its machine down with it and
 * the report says so — which is the "missing dependency" row of the decision table.
 *
 * WHAT IT DOES NOT COVER. `worldRules`, `traits`, `entityAttributes`,
 * `sensitiveParts`, `internalComponents`, `world` and `synergy` have no cross-definition
 * rule at boot today, so there is nothing to classify: they pass through. `rooms` and
 * `worldObjects` ARE classified now (section 5) — they are the two world-structure kinds
 * somebody may author, and a room the map cannot be built from is a crash at the next
 * boot, so it has to be refused at the candidate. `KnowledgeController` also validates at
 * boot, but it validates a codex it DERIVES from registries this classifier already
 * classified; a defect there costs a documentation page, not a world capability, so it is
 * not a quarantine rule. Adding a rule to an owner means adding it here — and the fixture
 * test pins that the chain fires.
 *
 * QUARANTINE IS PER DEFINITION AND NAMED. Never a whole registry when one definition is
 * bad, never silent, never a `{}` default (`AP-3`). The only registry-scope entries are
 * the material registries themselves: with a broken materials registry there is no base
 * to check anything against, and saying so once is truer than quarantining every
 * component in the game.
 *
 * @module CompositionClassifier
 */

import MaterialController from '../controllers/materials/MaterialController.js';
import CraftingController from '../controllers/crafting/CraftingController.js';
import MachineRegistryController from '../controllers/core/MachineRegistryController.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';
import { narrowVisualBlock } from '../utils/materialLook.js';
import { parseConsumeBlock } from './ConsumableRules.js';
import { validateOutfitRegistry } from '../controllers/logic/OutfitLogic.js';
import {
    roomDefinitionErrors,
    roomDefinitionsErrors,
    worldObjectDefinitionErrors
} from './WorldStructureRules.js';

/** Where a quarantine applies: one definition, or a registry that cannot be used. */
export const QUARANTINE_SCOPE = Object.freeze({
    DEFINITION: 'definition',
    REGISTRY: 'registry'
});

/** Registry-level kinds checked by constructing the material owner. */
const MATERIAL_REGISTRY_KINDS = Object.freeze([
    REGISTRY_KINDS.MATERIALS,
    REGISTRY_KINDS.PROPERTY_TRAIT_MAPPING,
    REGISTRY_KINDS.MATERIAL_DAMAGE_TYPES,
    REGISTRY_KINDS.MATERIAL_DROP_RATES
]);

/** Documentation keys (`_comment`): metadata, not definitions, never classified. */
function isMetadataKey(key) {
    return key.startsWith('_');
}

/**
 * Run `fn` and turn a throw into a quarantine entry.
 * @param {Function} fn - The real validation call.
 * @returns {string|null} The failure message, or null when it passed.
 */
function failureOf(fn) {
    try {
        fn();
        return null;
    } catch (error) {
        return error?.message ?? String(error);
    }
}

/**
 * Classify a candidate registry set.
 *
 * The candidate is NOT modified: `valid` is a new object of new per-kind objects with
 * the failing definitions left out. Anything the classifier does not know about passes
 * through unchanged, so a candidate carrying kinds this module has never heard of is
 * still a candidate.
 *
 * @param {Object.<string, Object>} candidate - kind -> content, as `ModLoader.build()`
 *   produces it.
 * @returns {{ valid: Object.<string, Object>, quarantined: Array<{ kind: string, key: string, scope: string, reason: string }> }}
 */
export function classifyComposition(candidate = {}) {
    const quarantined = [];
    const valid = {};
    for (const [kind, content] of Object.entries(candidate)) {
        valid[kind] = content && typeof content === 'object' && !Array.isArray(content) ? { ...content } : content;
    }
    const quarantine = (kind, key, scope, reason) => {
        quarantined.push({ kind, key, scope, reason });
        if (scope === QUARANTINE_SCOPE.DEFINITION && valid[kind]) delete valid[kind][key];
    };

    // ---- 1. The material base, as one construction -------------------------
    // Success here is the common case and costs one controller. Failure means the base
    // is unusable, so per-component material checks would only multiply the noise.
    let materialsUsable = true;
    const baseFailure = failureOf(() => new MaterialController(
        valid[REGISTRY_KINDS.MATERIALS] ?? {},
        valid[REGISTRY_KINDS.PROPERTY_TRAIT_MAPPING] ?? {},
        valid[REGISTRY_KINDS.MATERIAL_DAMAGE_TYPES] ?? {},
        valid[REGISTRY_KINDS.MATERIAL_DROP_RATES] ?? {}
    ));
    if (baseFailure) {
        materialsUsable = false;
        // One entry, not one per family member: they are validated as a single unit, so
        // four entries blaming four files would send the reader hunting through three
        // that are fine. The covered kinds are named in the message instead.
        const covered = MATERIAL_REGISTRY_KINDS.filter((kind) => Object.keys(valid[kind] ?? {}).length > 0);
        quarantine(
            REGISTRY_KINDS.MATERIALS,
            '*',
            QUARANTINE_SCOPE.REGISTRY,
            `material registries could not be validated (${covered.join(', ')}): ${baseFailure}`
        );
    }

    // ---- 2. Components and items: their materials against that base ---------
    if (materialsUsable) {
        const materialController = new MaterialController(
            valid[REGISTRY_KINDS.MATERIALS] ?? {},
            valid[REGISTRY_KINDS.PROPERTY_TRAIT_MAPPING] ?? {},
            valid[REGISTRY_KINDS.MATERIAL_DAMAGE_TYPES] ?? {},
            valid[REGISTRY_KINDS.MATERIAL_DROP_RATES] ?? {}
        );
        for (const kind of [REGISTRY_KINDS.COMPONENTS, REGISTRY_KINDS.INVENTORY_ITEMS]) {
            for (const [key, def] of Object.entries(valid[kind] ?? {})) {
                if (isMetadataKey(key) || !def || !def.materials) continue;
                const reason = failureOf(() => materialController.validateComposition(key, def.materials));
                if (reason) quarantine(kind, key, QUARANTINE_SCOPE.DEFINITION, reason);
            }
        }
    }

    // ---- 2b. An item's own appearance (a garment's look) --------------------
    // The same vocabulary a material's `visual` block is narrowed by, and the same
    // rule (`narrowVisualBlock`): a key outside it names nothing, so the definition
    // that carries it is dropped rather than shipped as dead data. Independent of
    // section 2 on purpose — a look is authored on the item, not derived from the
    // matter, so a broken material base must not hide a broken look (or vice versa).
    for (const [key, def] of Object.entries(valid[REGISTRY_KINDS.INVENTORY_ITEMS] ?? {})) {
        if (isMetadataKey(key) || !def || def.visual === undefined) continue;
        const reason = failureOf(() => narrowVisualBlock(def.visual, `Item "${key}"`));
        if (reason) quarantine(REGISTRY_KINDS.INVENTORY_ITEMS, key, QUARANTINE_SCOPE.DEFINITION, reason);
    }

    // ---- 2c. Outfits against the items that survived -----------------------
    // The outfit's rule is `OutfitLogic.validateOutfitRegistry` - the same call the
    // composition root makes at boot, so a swap does not get a looser world than a
    // cold start. Granularity is the blueprint key, which is what a definition IS
    // here: dropping it leaves that body undressed by outfit, and the spawn readers
    // then apply their default clothing again (`OutfitLogic.clothedByOutfit`).
    for (const [key, entries] of Object.entries(valid[REGISTRY_KINDS.OUTFITS] ?? {})) {
        if (isMetadataKey(key)) continue;
        const reason = failureOf(() => validateOutfitRegistry(
            { [key]: entries },
            valid[REGISTRY_KINDS.INVENTORY_ITEMS] ?? {}
        ));
        if (reason) quarantine(REGISTRY_KINDS.OUTFITS, key, QUARANTINE_SCOPE.DEFINITION, reason);
    }

    // ---- 2d. A consumable's block against the closed vocabulary -------------
    // An item that declares `consume` promises the eat action a meter to charge
    // (`ConsumableRules`, `wiki/decisions/consumable-items.md`). A block naming a
    // stat outside the vocabulary, or no amount at all, is data that would ship as
    // a dead button — so the definition is dropped, the same treatment a bad `visual`
    // block gets in 2b. The rule text lives in the rules module, not here: the eat
    // consequence reads the same block through it, so plan and world cannot disagree.
    for (const [key, def] of Object.entries(valid[REGISTRY_KINDS.INVENTORY_ITEMS] ?? {})) {
        if (isMetadataKey(key) || !def || def.consume === undefined) continue;
        const reason = failureOf(() => parseConsumeBlock(def, `Item "${key}"`));
        if (reason) quarantine(REGISTRY_KINDS.INVENTORY_ITEMS, key, QUARANTINE_SCOPE.DEFINITION, reason);
    }

    // ---- 3. Recipes against the items that survived ------------------------
    const recipes = valid[REGISTRY_KINDS.CRAFTING] ?? {};
    const recipeFailure = failureOf(() => new CraftingController(recipes, valid[REGISTRY_KINDS.INVENTORY_ITEMS] ?? {}));
    if (recipeFailure) {
        for (const key of Object.keys(recipes)) {
            if (isMetadataKey(key)) continue;
            const reason = failureOf(() => new CraftingController({ [key]: recipes[key] }, valid[REGISTRY_KINDS.INVENTORY_ITEMS] ?? {}));
            if (reason) quarantine(REGISTRY_KINDS.CRAFTING, key, QUARANTINE_SCOPE.DEFINITION, reason);
        }
    }

    // ---- 4. Machines against surviving blueprints, items and recipes -------
    const machines = valid[REGISTRY_KINDS.MACHINES] ?? {};
    const machineFailure = failureOf(() => new MachineRegistryController(
        machines,
        valid[REGISTRY_KINDS.BLUEPRINTS] ?? {},
        valid[REGISTRY_KINDS.INVENTORY_ITEMS] ?? {},
        valid[REGISTRY_KINDS.CRAFTING] ?? {}
    ));
    if (machineFailure) {
        for (const key of Object.keys(machines)) {
            if (isMetadataKey(key)) continue;
            const reason = failureOf(() => new MachineRegistryController(
                { [key]: machines[key] },
                valid[REGISTRY_KINDS.BLUEPRINTS] ?? {},
                valid[REGISTRY_KINDS.INVENTORY_ITEMS] ?? {},
                valid[REGISTRY_KINDS.CRAFTING] ?? {}
            ));
            if (reason) quarantine(REGISTRY_KINDS.MACHINES, key, QUARANTINE_SCOPE.DEFINITION, reason);
        }
    }

    // ---- 5. The map and its props, against each other ----------------------
    // A room is data a spatial model is built from, and a prop is an entity built from a
    // blueprint inside one of those rooms. Both are authorable, and a room the map cannot
    // be built from is a boot that refuses to start (`RoomsController` throws), so the
    // candidate — not the swap, and certainly not the next process start — is where a bad
    // one is refused. The rules ARE the boot rules (`WorldStructureRules`), so the plan,
    // the System's proposal and a cold start answer with one set of texts (`CR T-2`).
    // Rooms first: a prop's `room` and a room's connection target are checked against the
    // rooms that SURVIVED, so a prop pointing at a quarantined room goes down with it,
    // named — the missing-dependency row of the decision table.
    const rooms = valid[REGISTRY_KINDS.ROOMS] ?? {};
    const roomKeys = Object.keys(rooms);
    if (roomKeys.length > 0) {
        const roomFailure = roomDefinitionsErrors(rooms, { knownLogicalIds: roomKeys });
        if (roomFailure.length > 0) {
            for (const key of roomKeys) {
                if (isMetadataKey(key)) continue;
                const reasons = roomDefinitionErrors(key, rooms[key], { knownLogicalIds: roomKeys });
                if (reasons.length > 0) {
                    quarantine(REGISTRY_KINDS.ROOMS, key, QUARANTINE_SCOPE.DEFINITION, reasons.join('; '));
                }
            }
        }
    }

    for (const [key, def] of Object.entries(valid[REGISTRY_KINDS.WORLD_OBJECTS] ?? {})) {
        if (isMetadataKey(key)) continue;
        const reasons = worldObjectDefinitionErrors(key, def, {
            blueprints: valid[REGISTRY_KINDS.BLUEPRINTS] ?? {},
            rooms: Object.keys(valid[REGISTRY_KINDS.ROOMS] ?? {})
        });
        if (reasons.length > 0) {
            quarantine(REGISTRY_KINDS.WORLD_OBJECTS, key, QUARANTINE_SCOPE.DEFINITION, reasons.join('; '));
        }
    }

    return { valid, quarantined };
}

export default classifyComposition;
