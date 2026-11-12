/**
 * AgentBodyDesignRules — the shared validation and normalization rules for the
 * agent body design.
 *
 * Single source of truth (DRY-1, CHG-2): the pipeline validates each stage with
 * these same functions the controller's monolithic `_validateDesign` composes
 * (the save-time revalidation and the pipeline's final safety net), so a rule
 * the stages enforce and the rule the save enforces cannot drift into two
 * implementations. The pipeline's per-stage prompts say the same law in the
 * model's language at the decision point; this module is the law itself.
 *
 * Everything here is PURE (T-4): the world vocabulary comes in as parameters
 * (the controller loads it through the data seam at construction), errors
 * accumulate into a passed-in array, and the results are plain values. No
 * registries, no sockets, no file access in this module.
 *
 * @module src/controllers/networking/AgentBodyDesignRules
 */

import { FLAG_NAMES, STAT_NAMES, TRAIT_GROUPS, flatKey } from '../../../shared/StatVocabulary.js';
import { narrowVisualBlock } from '../../utils/materialLook.js';

// ---------------------------------------------------------------------------
// Closed vocabulary bounds (A-7: nothing in this feature is unbounded).
// ---------------------------------------------------------------------------

/** A droid identifier: letters and digits, 1..31, first letter. */
export const SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

/** Max component nodes in the designed body tree (a small body, not a forest). */
export const MAX_BODY_NODES = 16;

/** Max nesting depth of the body tree (defensive; a body is a few levels). */
export const MAX_TREE_DEPTH = 8;

/** A fraction must land in (0, 1] within this much to count as 1.0. */
export const MATERIAL_FRACTION_TOLERANCE = 0.005;

/** Max NEW organs (internal component recipes) one design may propose. */
export const MAX_IC_RECIPES = 8;

/** Max NEW wearable items one design may propose. */
export const MAX_GARMENTS = 8;

/** Max outfit entries (a small ensemble, not an inventory). */
export const MAX_OUTFIT_ENTRIES = 8;

/** Max characters for a new organ's display name. */
export const MAX_IC_LABEL_CHARS = 64;

/** Max characters for a new garment's display name. */
export const MAX_GARMENT_LABEL_CHARS = 64;

// Concept stage bounds (the seed the later stages read; small on purpose).
export const MAX_RATIONALE_CHARS = 500;
export const MAX_FOCUS_PHRASES = 6;
export const MAX_FOCUS_PHRASE_CHARS = 80;

/**
 * The closed vocabulary a designer organ may grant or mark (A-7: a designer
 * organ is a static claim; the per-turn machinery stays the world's).
 * A designer organ can ONLY grant the four function stats, and only mark
 * the four non-lethal flags.
 */
export const GRANTABLE_STAT_KEYS = Object.freeze([
    flatKey(TRAIT_GROUPS.PHYSICAL, STAT_NAMES.STRENGTH),
    flatKey(TRAIT_GROUPS.MOVEMENT, STAT_NAMES.MOVE),
    flatKey(TRAIT_GROUPS.MANIPULATION, STAT_NAMES.FINE_CONTROLS),
    flatKey(TRAIT_GROUPS.MIND, STAT_NAMES.THINK_LEVEL)
]);

export const GRANTABLE_FLAGS = Object.freeze(Object.values(FLAG_NAMES));

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * A droid identifier: letters and digits, 1..31, first letter (A-7).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSlug(value) {
    return typeof value === 'string' && value.length > 0 && SLUG_PATTERN.test(value);
}

/**
 * Parses a JSON object out of the model content, tolerating a markdown
 * code fence (```json ... ```) around the payload.
 * @param {string|null} content - raw model content.
 * @returns {Object|null} - the parsed object, or null when there is no
 *   parseable JSON object (the caller turns null into a validation error).
 */
export function extractDesignJson(content) {
    if (typeof content !== 'string') {
        return null;
    }
    let text = content.trim();
    if (text.startsWith('```')) {
        const fenceEnd = text.lastIndexOf('```');
        if (fenceEnd === -1) {
            return null;
        }
        text = text.slice(3, fenceEnd).trimStart();
        // Skip an optional language marker (e.g. `json`) on the first
        // line of the fence — the model often emits it before the payload.
        const firstNewline = text.indexOf('\n');
        if (firstNewline !== -1) {
            const marker = text.slice(0, firstNewline).trim();
            if (/^[a-z0-9+-]+$/i.test(marker) && marker.length <= 32) {
                text = text.slice(firstNewline);
            }
        }
        text = text.trim();
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        return null;
    }
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
}

/**
 * The material list a recipe authors: available materials, fractions in (0, 1],
 * summing to 1.0 within `MATERIAL_FRACTION_TOLERANCE`. One rule for the two
 * things a design can be made of, a component and a garment (`CHG-2`).
 * @param {unknown} materials
 * @param {string} at - where it came from, for the error text.
 * @param {string[]} errors - collector.
 * @param {Record<string, object>} availableMaterials - the closed vocabulary.
 * @returns {Array<{material: string, fraction: number}>|null} (used only when
 *   validation passes); null on a shape failure — the caller skips the rest
 *   of the part.
 */
export function narrowMaterials(materials, at, errors, availableMaterials) {
    if (materials === undefined || materials === null) {
        errors.push(`${at} must be a non-empty array`);
        return null;
    }
    if (!Array.isArray(materials) || materials.length === 0) {
        errors.push(`${at} must be a non-empty array`);
        return null;
    }
    const narrowed = [];
    let total = 0;
    for (const entry of materials) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            errors.push(`${at} entries must be objects with "material" and "fraction"`);
            return null;
        }
        const { material, fraction } = entry;
        if (typeof material !== 'string' || !availableMaterials[material]) {
            errors.push(`${at} material "${String(material)}" is not an available material`);
            return null;
        }
        if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
            errors.push(`${at} fraction for "${material}" must be a number in (0, 1]`);
            return null;
        }
        narrowed.push({ material, fraction });
        total += fraction;
    }
    if (Math.abs(total - 1) > MATERIAL_FRACTION_TOLERANCE) {
        errors.push(`${at} fractions sum to ${total} (must sum to 1.0)`);
        return null;
    }
    return narrowed;
}

/**
 * The stat contributions a designer organ grants. A designer organ is a
 * FUNCTION source: it grants only the four function stats the world derives
 * from organs, keyed in the `Group.stat` wire form. Returns `{}` when absent,
 * `null` on a shape violation, else the narrowed object.
 *
 * @param {unknown} rawGrants
 * @param {string} at
 * @param {string[]} errors
 * @returns {Record<string, number>|null}
 */
export function validateOrganGrants(rawGrants, at, errors) {
    if (rawGrants === undefined || rawGrants === null) return {};
    if (typeof rawGrants !== 'object' || Array.isArray(rawGrants)) {
        errors.push(`${at}.grants must be an object of stat key to number`);
        return null;
    }
    const narrowed = {};
    for (const [key, value] of Object.entries(rawGrants)) {
        if (!GRANTABLE_STAT_KEYS.includes(key)) {
            errors.push(`${at}.grants key "${String(key)}" is not grantable by an organ (allowed: ${GRANTABLE_STAT_KEYS.join(', ')})`);
            return null;
        }
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            errors.push(`${at}.grants["${key}"] must be a number >= 0`);
            return null;
        }
        narrowed[key] = value;
    }
    return narrowed;
}

/**
 * The flags a designer organ marks on its host — the world's closed flag
 * vocabulary. Returns `[]` when absent, `null` on a shape violation, else the
 * narrowed (de-duplicated) list.
 *
 * @param {unknown} rawFlags
 * @param {string} at
 * @param {string[]} errors
 * @returns {string[]|null}
 */
export function validateOrganFlags(rawFlags, at, errors) {
    if (rawFlags === undefined || rawFlags === null) return [];
    if (!Array.isArray(rawFlags)) {
        errors.push(`${at}.grantsFlags must be an array of flag names`);
        return null;
    }
    const narrowed = [];
    for (const flag of rawFlags) {
        if (typeof flag !== 'string' || !GRANTABLE_FLAGS.includes(flag)) {
            errors.push(`${at}.grantsFlags "${String(flag)}" is not a known flag (allowed: ${GRANTABLE_FLAGS.join(', ')})`);
            return null;
        }
        if (!narrowed.includes(flag)) {
            narrowed.push(flag);
        }
    }
    return narrowed;
}

/**
 * One designer organ definition: a STATIC claim (grants/flags/volume), a name
 * that is a slug, not a world organ and not already proposed, a display-name
 * bound, and the closed vocabularies. Mutates `errors` and
 * `proposedOrganNames` (a name is proposed as soon as it passes the identity
 * checks, so a later duplicate is caught even if its shape is then rejected).
 *
 * @param {unknown} organ
 * @param {number} index
 * @param {{
 *   availableOrgans: Record<string, object>,
 *   proposedOrganNames: Set<string>,
 *   allowExtraKeys?: string[]
 * }} context - `allowExtraKeys` names keys a caller may carry beyond the static
 *   shape (the organs stage carries `component`; the monolithic validator
 *   allows none)
 * @param {string[]} errors
 * @returns {{name: string, displayName: string, volume: number, grants?: object, grantsFlags?: string[]}|null}
 *   the narrowed organ (displayName defaults to the name, as the world's IC
 *   shape does), or null (the caller skips the rest of this organ)
 */
export function validateOrganDefinition(organ, index, context, errors) {
    const { availableOrgans, proposedOrganNames, allowExtraKeys = [] } = context;
    const at = `"internalComponents[${index}]"`;
    if (!organ || typeof organ !== 'object' || Array.isArray(organ)) {
        errors.push(`${at} must be an organ object`);
        return null;
    }
    const allowedKeys = ['name', 'displayName', 'grants', 'grantsFlags', 'volume', ...allowExtraKeys];
    for (const key of Object.keys(organ)) {
        if (!allowedKeys.includes(key)) {
            errors.push(`${at} carries "${key}": a designer organ is a static claim (name, displayName, grants, grantsFlags, volume${allowExtraKeys.length ? ' + ' + allowExtraKeys.join(', ') : ''}); it installs nothing, does nothing between turns`);
            return null;
        }
    }
    const name = organ.name;
    if (!isSlug(name)) {
        errors.push(`${at}.name must be an id (letters and digits only, 1-31 chars)`);
        return null;
    }
    if (availableOrgans[name]) {
        errors.push(`${at}.name "${name}" collides with an organ the world already has`);
        return null;
    }
    if (proposedOrganNames.has(name)) {
        errors.push(`${at}.name "${name}" is already proposed by this design`);
        return null;
    }
    proposedOrganNames.add(name);
    let displayName = String(name);
    if (organ.displayName !== undefined) {
        if (typeof organ.displayName !== 'string') {
            errors.push(`${at}.displayName must be a string`);
            return null;
        }
        const label = organ.displayName.trim();
        if (label.length === 0) {
            errors.push(`${at}.displayName must be a non-empty string`);
            return null;
        }
        if (label.length > MAX_IC_LABEL_CHARS) {
            errors.push(`${at}.displayName must be at most ${MAX_IC_LABEL_CHARS} characters`);
            return null;
        }
        displayName = label;
    }
    const grants = validateOrganGrants(organ.grants, at, errors);
    if (grants === null) {
        return null;
    }
    const flags = validateOrganFlags(organ.grantsFlags, at, errors);
    if (flags === null) {
        return null;
    }
    if (Object.keys(grants).length === 0 && flags.length === 0) {
        errors.push(`${at} grants no stat and marks no flag (would be inert, like a component without an organ)`);
        return null;
    }
    if (!Number.isInteger(organ.volume) || organ.volume < 1 || organ.volume > 40) {
        errors.push(`${at}.volume must be an integer in 1..40 (it must fit inside its host part)`);
        return null;
    }
    const narrowed = {
        name,
        displayName,
        volume: organ.volume
    };
    if (Object.keys(grants).length > 0) {
        narrowed.grants = grants;
    }
    if (flags.length > 0) {
        narrowed.grantsFlags = flags;
    }
    return narrowed;
}

/**
 * Walk the body tree: a node is `{ component, slot, children?, hidesWithParent? }`;
 * `component` a droid-id slug, `slot` null or a non-empty string, `children` an
 * array of the same, `hidesWithParent` an optional boolean (absent, never
 * false — the world writes the mark and never its negation). Mutates `refs`
 * (every valid `component` string, tree order) and `errors`.
 *
 * @param {unknown} node
 * @param {string[]} refs
 * @param {number} depth
 * @param {string[]} errors
 */
export function walkStructure(node, refs, depth, errors) {
    if (depth > MAX_TREE_DEPTH) {
        errors.push(`the body tree is deeper than ${MAX_TREE_DEPTH} levels`);
        return;
    }
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        errors.push('a body-tree node must be an object');
        return;
    }
    const component = node.component;
    if (!isSlug(component)) {
        errors.push('a body-tree node has a bad component id: ' + JSON.stringify(node.component));
        return;
    }
    refs.push(component);
    const slot = node.slot;
    if (slot !== null && slot !== undefined) {
        if (typeof slot !== 'string' || slot.trim().length === 0) {
            errors.push('a body-tree slot must be null or a non-empty string');
        }
    }
    if (node.hidesWithParent !== undefined && typeof node.hidesWithParent !== 'boolean') {
        errors.push('a body-tree node "hidesWithParent" must be a boolean when present');
    }
    const children = node.children;
    if (children !== undefined && children !== null) {
        if (!Array.isArray(children)) {
            errors.push('"children" of a body-tree node must be an array');
            return;
        }
        for (const child of children) {
            walkStructure(child, refs, depth + 1, errors);
        }
    }
}

/**
 * Validate one NEW component recipe (the anatomy stage and the monolithic
 * validator share this; only the organ law differs, via `allowDesignOrgans`).
 * Mutates `errors` and `proposedNames` (a name is registered as soon as it
 * passes the identity checks, so a later duplicate is caught even if its
 * shape is then rejected). Returns the narrowed recipe or null on a shape
 * failure.
 *
 * @param {unknown} recipe
 * @param {number} index
 * @param {{
 *   availableComponents: Record<string, object>,
 *   availableOrgans: Record<string, object>,
 *   availableMaterials: Record<string, object>,
 *   proposedNames: Set<string>,
 *   proposedOrganNames: Set<string>,
 *   allowDesignOrgans: boolean
 * }} context - `allowDesignOrgans`: the monolithic validator accepts a recipe
 *   organ that the design itself proposes; the anatomy stage accepts only
 *   organs the world already has (a later stage invents and attaches the new
 *   ones, and the composed body is then re-validated monolithically).
 * @param {string[]} errors
 * @returns {{name: string, form: {volume: number, position: {x: number, y: number}}, materials: Array, internalComponents: Array, energyCapacity?: number}|null}
 */
export function validateComponentRecipe(recipe, index, context, errors) {
    const { availableComponents, availableOrgans, availableMaterials, proposedNames, proposedOrganNames, allowDesignOrgans } = context;
    const at = `"components[${index}]"`;
    if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
        errors.push(`${at} must be an object`);
        return null;
    }
    const name = recipe.name;
    if (!isSlug(name)) {
        errors.push(`${at}.name must be an id (letters and digits only, 1-31 chars)`);
        return null;
    }
    if (availableComponents[name] || proposedNames.has(name)) {
        errors.push(`${at}.name "${name}" collides with an existing or previously proposed component`);
        return null;
    }
    proposedNames.add(name);

    const form = recipe.form;
    if (!form || typeof form !== 'object' || Array.isArray(form)) {
        errors.push(`${at}.form must be an object`);
        return null;
    }
    if (typeof form.volume !== 'number' || !Number.isInteger(form.volume) || form.volume < 1 || form.volume > 40) {
        errors.push(`${at}.form.volume must be an integer in 1..40`);
        return null;
    }
    if (!form.position || typeof form.position !== 'object' || Array.isArray(form.position)
        || typeof form.position.x !== 'number' || !Number.isInteger(form.position.x)
        || typeof form.position.y !== 'number' || !Number.isInteger(form.position.y)) {
        errors.push(`${at}.form.position must be { x: integer, y: integer }`);
        return null;
    }

    const materials = narrowMaterials(recipe.materials, `${at}.materials`, errors, availableMaterials);
    if (materials === null) {
        return null;
    }

    if (recipe.internalComponents !== undefined && !Array.isArray(recipe.internalComponents)) {
        errors.push(`${at}.internalComponents must be an array of organ ids`);
        return null;
    }
    if (recipe.internalComponents) {
        for (const organRef of recipe.internalComponents) {
            const organName = typeof organRef === 'string'
                ? organRef
                : (organRef && typeof organRef === 'object' && typeof organRef.type === 'string' ? organRef.type : null);
            if (allowDesignOrgans) {
                if (!organName || (!availableOrgans[organName] && !proposedOrganNames.has(organName))) {
                    errors.push(`${at}.internalComponents "${String(organName)}" is not an available organ and not proposed in "internalComponents"`);
                    return null;
                }
            } else {
                if (!organName || !availableOrgans[organName]) {
                    errors.push(`${at}.internalComponents "${String(organName)}" is not an available (world) organ; this stage only references world organs, and a later stage invents and attaches the new ones`);
                    return null;
                }
            }
        }
    }

    if (recipe.energyCapacity !== undefined
        && (typeof recipe.energyCapacity !== 'number' || !Number.isInteger(recipe.energyCapacity) || recipe.energyCapacity < 0)) {
        errors.push(`${at}.energyCapacity must be an integer >= 0`);
        return null;
    }

    const narrowed = {
        name,
        form: {
            volume: form.volume,
            position: { x: form.position.x, y: form.position.y }
        },
        materials,
        internalComponents: (recipe.internalComponents || []).map((ic) => (typeof ic === 'string' ? ic : { type: ic.type, grants: ic.grants }))
    };
    if (recipe.energyCapacity !== undefined) {
        narrowed.energyCapacity = recipe.energyCapacity;
    }
    return narrowed;
}

/**
 * The new WEARABLE ITEMS a design invents (`garments`). A garment is an item
 * the character carries and wears — it always carries the `wear` block that
 * makes an item wearable — never a node of the body tree, so its rules are
 * the item registry's: matter, volume, and a `wear.minVolume` the part it
 * goes on must have free. Mutates `errors`; returns the narrowed array (empty
 * when none were proposed).
 *
 * @param {unknown} rawGarments
 * @param {{
 *   availableItems: Record<string, object>,
 *   availableComponents: Record<string, object>,
 *   availableMaterials: Record<string, object>
 * }} vocabulary
 * @param {string[]} errors
 * @returns {Array<object>}
 */
export function validateGarments(rawGarments, vocabulary, errors) {
    const { availableItems, availableComponents, availableMaterials } = vocabulary;
    const garments = [];
    if (rawGarments === undefined || rawGarments === null) {
        return garments;
    }
    if (!Array.isArray(rawGarments)) {
        errors.push('"garments" must be an array of new wearable item recipes');
        return garments;
    }
    if (rawGarments.length > MAX_GARMENTS) {
        errors.push(`"garments" has ${rawGarments.length} entries (max ${MAX_GARMENTS})`);
        return garments;
    }
    const proposed = new Set();
    for (const [index, garment] of rawGarments.entries()) {
        const at = `"garments[${index}]"`;
        if (!garment || typeof garment !== 'object' || Array.isArray(garment)) {
            errors.push(`${at} must be an object`);
            continue;
        }
        const name = garment.name;
        if (!isSlug(name)) {
            errors.push(`${at}.name must be an id (letters and digits only, 1-31 chars)`);
            continue;
        }
        if (availableItems[name] || availableComponents[name] || proposed.has(name)) {
            errors.push(`${at}.name "${name}" collides with an existing item, component, or previously proposed garment`);
            continue;
        }
        proposed.add(name);

        const form = garment.form;
        if (!form || typeof form !== 'object' || Array.isArray(form)) {
            errors.push(`${at}.form must be an object with "volume"`);
            continue;
        }
        const volume = form.volume;
        if (typeof volume !== 'number' || !Number.isInteger(volume) || volume < 1 || volume > 40) {
            errors.push(`${at}.form.volume must be an integer in 1..40`);
            continue;
        }

        const materials = narrowMaterials(garment.materials, `${at}.materials`, errors, availableMaterials);
        if (materials === null) {
            continue;
        }

        // A garment IS an item with a wear block; the block is not optional.
        const wear = garment.wear;
        const minVolume = (wear && typeof wear === 'object' && !Array.isArray(wear)) ? wear.minVolume : undefined;
        if (typeof minVolume !== 'number' || !Number.isInteger(minVolume) || minVolume < 1 || minVolume > volume) {
            errors.push(`${at}.wear.minVolume must be an integer in 1..${volume} (a garment asks no more of a body than it takes itself)`);
            continue;
        }

        let displayName = '';
        if (garment.displayName !== undefined) {
            const label = typeof garment.displayName === 'string' ? garment.displayName.trim() : '';
            if (label.length === 0 || label.length > MAX_GARMENT_LABEL_CHARS) {
                errors.push(`${at}.displayName must be a string of 1-${MAX_GARMENT_LABEL_CHARS} characters when present`);
                continue;
            }
            displayName = label;
        }

        let visual;
        if (garment.visual !== undefined) {
            try {
                visual = narrowVisualBlock(garment.visual, at);
            } catch (error) {
                errors.push(error.message);
                continue;
            }
        }

        const narrowed = {
            name,
            displayName: displayName || String(name),
            form: { volume },
            materials,
            wear: { minVolume }
        };
        if (visual) {
            narrowed.visual = visual;
        }
        garments.push(narrowed);
    }
    return garments;
}

/**
 * Validate the outfit (what the body is born wearing). Each entry:
 * `{ item, component }` where the item resolves to a proposed garment or a
 * SHIPPED wearable item, and the component is a name that appears in the
 * body structure. Mutates `errors`; returns the narrowed array (empty when
 * the outfit is absent).
 *
 * @param {unknown} rawOutfit
 * @param {{
 *   structureRefs: string[],
 *   garments: Array<{name: string}>,
 *   availableItems: Record<string, object>
 * }} context
 * @param {string[]} errors
 * @returns {Array<{item: string, component: string}>}
 */
export function validateOutfit(rawOutfit, context, errors) {
    const { structureRefs, garments, availableItems } = context;
    const outfit = [];
    if (rawOutfit === undefined || rawOutfit === null) {
        return outfit;
    }
    if (!Array.isArray(rawOutfit)) {
        errors.push('"outfit" must be an array of { item, component }');
        return outfit;
    }
    if (rawOutfit.length > MAX_OUTFIT_ENTRIES) {
        errors.push(`"outfit" has ${rawOutfit.length} entries (max ${MAX_OUTFIT_ENTRIES})`);
        return outfit;
    }
    const bodyParts = new Set(structureRefs);
    const proposedGarments = new Set(garments.map((garment) => garment.name));
    for (const [index, entry] of rawOutfit.entries()) {
        const at = `"outfit[${index}]"`;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            errors.push(`${at} must be an object with "item" and "component"`);
            continue;
        }
        const { item, component } = entry;
        const isProposed = typeof item === 'string' && proposedGarments.has(item);
        const known = (typeof item === 'string') ? availableItems[item] : undefined;
        if (!isProposed && !(known && known.minVolume !== null && known.minVolume !== undefined)) {
            errors.push(`${at}.item "${String(item)}" is neither a proposed garment nor a wearable item in the world`);
            continue;
        }
        if (typeof component !== 'string' || !bodyParts.has(component)) {
            errors.push(`${at}.component "${String(component)}" is not a component of this body's structure`);
            continue;
        }
        outfit.push({ item, component });
    }
    return outfit;
}

/**
 * Normalize the body tree for the mod file: `slot` null stays null,
 * `hidesWithParent` absent (never false) and `children` always present (an
 * empty array on a leaf) — the same shape rules the live instance follows.
 *
 * @param {object} node
 * @returns {object}
 */
export function normalizeTree(node) {
    const normalized = {
        component: node.component,
        slot: (node.slot == null) ? null : node.slot,
        children: (Array.isArray(node.children))
            ? node.children.map((child) => normalizeTree(child))
            : []
    };
    // Absent, not false - the same rule the live instance follows.
    if (node.hidesWithParent === true) {
        normalized.hidesWithParent = true;
    }
    return Object.freeze(normalized);
}

/**
 * Build the final normalized design object from validated pieces (the shape
 * the panel's Save posts and the mod package reads). Frozen (D-1). `outfit`
 * is present only when the design spoke about clothing (`outfitDeclared`) —
 * absent, not empty, when it said nothing.
 *
 * @param {{
 *   blueprintId: string,
 *   rationale: string,
 *   structure: object,
 *   components: Array<object>,
 *   garments: Array<object>,
 *   internalComponents: Array<object>,
 *   outfit: Array<{item: string, component: string}>,
 *   outfitDeclared: boolean
 * }} parts
 * @returns {object}
 */
export function normalizeDesign(parts) {
    const { blueprintId, rationale, structure, components, garments, internalComponents, outfit, outfitDeclared } = parts;
    return Object.freeze({
        blueprintId,
        rationale,
        structure: normalizeTree(structure),
        components,
        garments,
        internalComponents,
        ...(outfitDeclared ? { outfit } : {})
    });
}
