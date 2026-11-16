/**
 * definitionSemantics — the `definitions` section of the Knowledge codex
 * (wiki/subMDs/frontend/knowledge_viewer.md Sec. 12).
 *
 * WHAT IT IS: one row per top-level entry of every registry kind the codex does
 * NOT already present on its own tab. The codex had four tabs of content
 * (traits/mappings/materials, recipes, items, actions) and no way to answer the
 * plain question "what is defined in this world, and what does its definition
 * say". This module answers it for the remaining kinds — components, organs,
 * blueprints, NPCs, rooms, props, machines, effects, outfits, sensitivity,
 * synergy, the world rules — straight from the same loaded registries.
 *
 * ONE ROW PER ENTRY, INCLUDING THE ODD ONES. A registry is usually a keyed map
 * of objects, but the data uses every shape: `blueprints` maps an id to an array
 * of child ids, `sensitiveParts` maps a part type to a bare number, `outfits`
 * maps a blueprint key to a list of wear claims, `worldRules` wraps its body in
 * one named block. ONE EXCEPTION, AND IT IS THE RUNTIME'S: `entityAttributes`
 * also wraps (`{ "attributes": { <blueprint>: { <Group.stat>: {…} } } }`), and
 * the holder is NOT an entry — `EntityAttributeData.getAttributes(blueprint)`
 * looks an entity TYPE up inside it, so the rows are the keys of that block, one
 * per entity type (`REGISTRY_ENTRY_HOLDERS`). Reading the wrapper as an entry
 * would have been the more literal rule and the less true one: the codex then
 * showed one card titled after the word `attributes` and buried every number in
 * the appendix. The rule is still "an entry is what the reader of this registry
 * calls an entry". See `entryContent`.
 *
 * A row is therefore
 * `{ kind, id, name, description, facets, definition }` where `definition` is
 * the entry VERBATIM (object, array or scalar) — the shape is the author's, and
 * rewriting it here would make the reference disagree with the file it mirrors.
 * Metadata keys (`_comment` and friends) are skipped, the same convention every
 * other codex builder uses.
 *
 * WHY THE HEADER IS RESOLVED SERVER-SIDE. Each row's `facets` are a few fields
 * read off the entry with their references turned into display names — the
 * composition's material names, an organ list, a room's exits, a machine's
 * recipe. This is the same placement `actionSemantics.js` chose: the reading is
 * world knowledge (which key means what, which registry names what), and the
 * client is disposable. The reading never computes anything the engine computes
 * — no derivation, no volume arithmetic, no stat claim (CR DETERM-1, and the
 * codex's own boundary in knowledge_viewer.md Sec. 8). It renames references
 * and copies scalars.
 *
 * A RESOLVED REFERENCE NAMES ITS TARGET, NEVER A TAB. Where a facet names an
 * entry of another registry — a material, an organ, the room a door opens onto,
 * the blueprint a machine runs — the facet also carries `parts`: the same
 * sentence split into plain text and named targets, each target saying which
 * registry kind it belongs to and under what key. It stops there. Which tab that
 * kind is rendered on is a client fact (`KnowledgePanel.referenceTabIdOf`), and a
 * facet that named a tab would be a card pointing at a screen the panel may not
 * draw. `value` stays the plain-text sentence and is, by construction, the
 * concatenation of the parts, so the search, a client that knows nothing about
 * links, and the rendered row cannot disagree about what the facet says.
 *
 * WHAT IT DOES NOT DO: validate. The owners of these registries validate them
 * at boot (the composition root's startup pass, `validateOutfitRegistry`,
 * `MachineRegistryController`, the world-rules owner). A second copy of any of
 * those rules here would be a forked rule (CR CHG-2); this module only guards
 * its own row shape so a junk entry can never produce a half-read card.
 *
 * Pure module: no fs, no DOM, no timers, no controller import. The registries
 * arrive as plain objects and the resolvers are built from those same objects.
 *
 * @module controllers/knowledge/definitionSemantics
 */

import { REGISTRY_KIND_LIST, REGISTRY_KINDS } from '../../../shared/RegistryKinds.js';

/**
 * The kinds the codex already renders on a dedicated tab, mapped to the payload
 * section that carries them. They are NOT repeated in the Entities tab: a
 * material row would otherwise appear twice, once as a card with its property
 * values and once as a bare definition, and the reader would have no way to
 * tell which one the codex means.
 *
 * This is the ONLY exclusion rule. A new registry kind added to
 * `REGISTRY_KINDS` appears in the Entities tab with no change here, because the
 * kind list is derived from the shared vocabulary, not hand-listed
 * (knowledge_viewer.md Sec. 2: adding data is all that is needed).
 * @type {Readonly<Record<string, string>>}
 */
export const CODEX_TAB_OWNED_KINDS = Object.freeze({
    [REGISTRY_KINDS.TRAITS]: 'traitStats',
    [REGISTRY_KINDS.PROPERTY_TRAIT_MAPPING]: 'traitStats',
    [REGISTRY_KINDS.MATERIALS]: 'materials',
    [REGISTRY_KINDS.CRAFTING]: 'recipes',
    [REGISTRY_KINDS.INVENTORY_ITEMS]: 'items',
    [REGISTRY_KINDS.ACTIONS]: 'actions',
});

/**
 * The kinds the Entities section lists, in `REGISTRY_KIND_LIST` order (the
 * order the composition root loads them, which also groups the families: parts,
 * bodies, matter, verbs, effects, world). Frozen so no caller can append a kind
 * at runtime.
 * @type {ReadonlyArray<string>}
 */
export const DEFINITION_REGISTRY_KINDS = Object.freeze(
    REGISTRY_KIND_LIST.filter((kind) => !Object.hasOwn(CODEX_TAB_OWNED_KINDS, kind))
);

/**
 * The families the definition tabs are grouped under, in bar order. One ENTRY
 * PER REGISTRY KIND: a kind is a tab, and a family is the caption over a run of
 * tabs (`Parts | Internal Parts | Sensitive Parts` under `PARTS`). The single
 * flat Entities tab that this replaced asked the reader to scroll a wall of 17
 * unrelated families and find, say, the world rules between the props and the
 * organ types (knowledge_viewer.md Sec. 12).
 *
 * A family's run holds BOTH kinds of tab: the codex's own view tabs (the
 * derivation chain, the material table, the item table, the recipes, the action
 * rules — named in `sections` by the tab id the client uses) and one tab per
 * registry kind (named in `kinds`). So `Parts` reads
 * `Traits & Stats | Materials | Items | Components | Internal Parts | Sensitive
 * Parts`, and the five view tabs are not left in a block of their own at the top
 * of the bar, which is the same complaint the reader made about the flat Entities
 * tab in a smaller shape.
 *
 * WHY THIS TABLE IS SERVER-SIDE. Which family a tab belongs to is a statement
 * about the WORLD's data (a room is world, a burden lever is balance, an item is
 * a thing), and the codex's rule is that the client knows no registry — it
 * renders the groups it is given. What the client keeps is its own: the tab ids,
 * the labels and the views behind them, so a family can name a view tab but can
 * never render one the codex does not have (`CODEX_TAB_SECTION_IDS` is checked,
 * and `KnowledgePanel.test.js` pins the id list against the panel's own). The
 * list is explicit rather than derived because "parts", "world" and "data" are
 * names a human chose; deriving them from a camelCase identifier would give 17
 * captions that repeat the identifier.
 *
 * A kind this table does not name is NOT hidden: it joins the `data` family and
 * the boot says so (`ungroupedDefinitionKinds`). A codex tab no family names is
 * not hidden either — it lands in the same family. Completeness of the reference
 * outranks tidiness of the bar.
 * @type {ReadonlyArray<{id: string, label: string, sections: ReadonlyArray<string>, kinds: ReadonlyArray<string>}>}
 */
export const DEFINITION_FAMILY_LIST = Object.freeze([
    Object.freeze({
        id: 'parts',
        label: 'Parts',
        // The three views that read the same matter: what a trait is worth, what
        // a material is made of, what an item can do.
        sections: Object.freeze(['traitStats', 'materials', 'items']),
        kinds: Object.freeze([
            REGISTRY_KINDS.COMPONENTS,
            REGISTRY_KINDS.INTERNAL_COMPONENTS,
            REGISTRY_KINDS.SENSITIVE_PARTS,
        ]),
    }),
    Object.freeze({
        id: 'blueprints',
        label: 'Blueprints',
        // A recipe is a blueprint with steps, so the crafting tab sits with them.
        sections: Object.freeze(['recipes']),
        kinds: Object.freeze([REGISTRY_KINDS.BLUEPRINTS, REGISTRY_KINDS.MACHINES]),
    }),
    Object.freeze({
        id: 'world',
        label: 'World',
        sections: Object.freeze([]),
        kinds: Object.freeze([
            REGISTRY_KINDS.WORLD,
            REGISTRY_KINDS.ROOMS,
            REGISTRY_KINDS.WORLD_OBJECTS,
        ]),
    }),
    Object.freeze({
        id: 'characters',
        label: 'Characters',
        sections: Object.freeze([]),
        kinds: Object.freeze([
            REGISTRY_KINDS.NPCS,
            REGISTRY_KINDS.OUTFITS,
            REGISTRY_KINDS.ENTITY_ATTRIBUTES,
        ]),
    }),
    // The balance levers and the matter rules: definitions of the same kind as
    // every other (a registry, a tab), but not things that exist in a room.
    Object.freeze({
        id: 'data',
        label: 'Data',
        // Actions are rules about what may be done, not things in a room.
        sections: Object.freeze(['actions']),
        kinds: Object.freeze([
            REGISTRY_KINDS.HOLDING_COST,
            REGISTRY_KINDS.WORLD_RULES,
            REGISTRY_KINDS.EFFECTS,
            REGISTRY_KINDS.SYNERGY,
            REGISTRY_KINDS.MATERIAL_DAMAGE_TYPES,
            REGISTRY_KINDS.MATERIAL_DROP_RATES,
        ]),
    }),
]);

/**
 * The family a kind the table does not name falls back to. It is a real family
 * (not a synthetic one), so the bar never grows a caption nobody wrote.
 */
export const DEFINITION_FALLBACK_FAMILY_ID = 'data';

/**
 * The codex's OWN tabs — the ones that render an assembled view rather than a
 * list of definitions. These ids are the vocabulary a family may name in
 * `sections`, and they are the values of the client's `SECTION_IDS`: the server
 * can place a view tab in a band, but it cannot invent one (the pin lives in
 * `test/unit/KnowledgePanel.test.js`, which reads the panel's own list).
 * @type {ReadonlyArray<string>}
 */
export const CODEX_TAB_SECTION_IDS = Object.freeze(['traitStats', 'materials', 'items', 'recipes', 'actions']);

/**
 * The family map the payload carries: one entry per family, each naming the
 * codex view tabs (`sections`) and the registry kinds (`kinds`) it holds, in the
 * order the bar shows them. Total on both sides — every kind lands in exactly one
 * family, and so does every view tab.
 * @param {string[]} [kinds] - The kinds to group (`DEFINITION_REGISTRY_KINDS`).
 * @returns {Array<{id: string, label: string, sections: string[], kinds: string[]}>}
 * @throws {TypeError} a kind or a view tab declared twice, a family naming a
 *   kind the vocabulary does not have, or a family naming a tab the codex does
 *   not render — all authoring mistakes in this file, and a codex that quietly
 *   mis-groups its own bar is worse than one that refuses to boot (the fail-fast
 *   contract of Sec. 4).
 */
export function buildDefinitionGroups(kinds = DEFINITION_REGISTRY_KINDS) {
    if (!Array.isArray(kinds)) {
        throw new TypeError('[definitionSemantics] buildDefinitionGroups needs an array of registry kinds.');
    }
    const wanted = new Set(kinds);
    const claimed = new Set();
    const claimedSections = new Set();
    const groups = [];
    for (const family of DEFINITION_FAMILY_LIST) {
        // A view tab in two bands draws one view twice and leaves two tabs that
        // can both be active; an id outside the vocabulary names no view at all.
        for (const section of family.sections) {
            if (!CODEX_TAB_SECTION_IDS.includes(section)) {
                throw new TypeError(
                    `[definitionSemantics] family "${family.id}" names "${section}", which is not a codex tab.`
                );
            }
            if (claimedSections.has(section)) {
                throw new TypeError(`[definitionSemantics] codex tab "${section}" is grouped twice.`);
            }
            claimedSections.add(section);
        }
        const owned = [];
        for (const kind of family.kinds) {
            if (!DEFINITION_REGISTRY_KINDS.includes(kind)) {
                throw new TypeError(
                    `[definitionSemantics] family "${family.id}" names "${kind}", which is not a ` +
                    'definition registry kind (the codex already shows it, or it is not in the vocabulary).'
                );
            }
            if (claimed.has(kind)) {
                throw new TypeError(`[definitionSemantics] registry kind "${kind}" is grouped twice.`);
            }
            claimed.add(kind);
            if (wanted.has(kind)) owned.push(kind);
        }
        groups.push({ id: family.id, label: family.label, sections: [...family.sections], kinds: owned });
    }
    // A kind nobody grouped joins the fallback family rather than disappearing —
    // and the same for a view tab no family named, so the bar can never lose a
    // tab to an omission in the table above.
    const fallback = groups.find((group) => group.id === DEFINITION_FALLBACK_FAMILY_ID);
    for (const kind of kinds) {
        if (!claimed.has(kind)) fallback.kinds.push(kind);
    }
    for (const section of CODEX_TAB_SECTION_IDS) {
        if (!claimedSections.has(section)) fallback.sections.push(section);
    }
    return groups;
}

/**
 * The kinds the family table does not name — the ones that land in the fallback
 * family. The controller warns with these at boot, so adding a registry kind to
 * the shared vocabulary says in the log where it turned up in the codex.
 * @param {string[]} kinds
 * @returns {string[]}
 */
export function ungroupedDefinitionKinds(kinds = DEFINITION_REGISTRY_KINDS) {
    const grouped = new Set();
    for (const family of DEFINITION_FAMILY_LIST) {
        for (const kind of family.kinds) grouped.add(kind);
    }
    return (Array.isArray(kinds) ? kinds : []).filter((kind) => !grouped.has(kind));
}

/**
 * Reads the Entities registries from the registry source (the composition
 * root's `RegistryStore`, so a kind is named and never a path — CR B-1).
 * Called ONCE, at boot, by the composition root: the codex is a boot-time
 * snapshot like every other section of the payload (knowledge_viewer.md
 * Sec. 3, Sec. 7).
 * @param {{ read: (kind: string) => * }} store - The live registry holder.
 * @returns {Object<string, *>} `{ kind: rawRegistry }` for every
 *   `DEFINITION_REGISTRY_KINDS` entry.
 */
export function readDefinitionRegistries(store) {
    if (!store || typeof store.read !== 'function') {
        throw new TypeError('[definitionSemantics] readDefinitionRegistries needs a registry source with read(kind).');
    }
    const registries = {};
    for (const kind of DEFINITION_REGISTRY_KINDS) {
        registries[kind] = store.read(kind);
    }
    return registries;
}

/**
 * The reference registries the facets resolve names against. They are NOT rows
 * (each has its own tab); they are lookup tables, and a lookup table is never
 * filtered by the reader's search (knowledge_viewer.md Sec. 10: "reference data
 * is not display data").
 * @typedef {Object} DefinitionReferences
 * @property {Object} [materials] - The materials registry (composition names).
 * @property {Object} [items] - The inventory-items registry (machine/item refs).
 * @property {Object} [recipes] - The crafting registry (machine recipe refs).
 */

/**
 * Builds every Entities row, sorted by kind (registry-load order) and then by
 * id (code-unit order, so the wire contract is locale-independent — the same
 * comparator rule the other sections use).
 * @param {Object} input
 * @param {Object<string, *>} [input.registries] - `{ kind: rawRegistry }`.
 *   A kind that is absent contributes no rows (a degraded group, never a
 *   crash): the section is complete over what the caller supplied.
 * @param {DefinitionReferences} [input.references] - Name-resolution tables.
 * @returns {Array<{kind: string, id: string, name: string|null,
 *   description: string|null,
 *   facets: Array<{label: string, value: string, parts?: FacetPart[]}>,
 *   definition: *}>}
 */
export function buildDefinitionRows({ registries = {}, references = {} } = {}) {
    const ctx = buildContext(registries, references);
    const rows = [];
    for (const kind of DEFINITION_REGISTRY_KINDS) {
        const kindRows = [];
        for (const entry of entriesOf(entryContent(kind, registries[kind]))) {
            const row = buildRow(kind, entry.id, entry.value, ctx);
            if (row) kindRows.push(row);
        }
        // Sorted by id inside a kind (code-unit order, like every other section);
        // the KINDS keep the shared vocabulary's order, which groups the families.
        kindRows.sort((a, b) => compareStrings(a.id, b.id));
        rows.push(...kindRows);
    }
    return rows;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The lookup tables every facet reader shares, keyed by what they resolve.
 * Built once per assembly (not once per row).
 * @private
 */
function buildContext(registries, references) {
    return {
        registries,
        materials: references.materials ?? null,
        items: references.items ?? null,
        recipes: references.recipes ?? null,
        rooms: registries[REGISTRY_KINDS.ROOMS] ?? null,
        components: registries[REGISTRY_KINDS.COMPONENTS] ?? null,
        internalComponents: registries[REGISTRY_KINDS.INTERNAL_COMPONENTS] ?? null,
        blueprints: registries[REGISTRY_KINDS.BLUEPRINTS] ?? null,
    };
}

/**
 * The registries whose FILE wraps its entries in one named block, by kind. The
 * codex opens the same block the runtime reads (`EntityAttributeData` looks an
 * entity type up under `attributes`), so a row is one entry and not the wrapper.
 * A kind this table does not name is entered as it stands.
 * @type {Readonly<Record<string, string>>}
 */
const REGISTRY_ENTRY_HOLDERS = Object.freeze({
    [REGISTRY_KINDS.ENTITY_ATTRIBUTES]: 'attributes',
});

/**
 * The content whose entries become rows: the holder block when the kind names one
 * and the raw registry carries it as a plain object, the raw registry otherwise
 * (a mod is free to write the map at the top level, and an absent holder is not
 * an empty one — nothing is hidden by a unwrap that found nothing).
 * @param {string} kind - The registry kind.
 * @param {*} registry - The raw registry content.
 * @returns {*} The content to enumerate.
 * @private
 */
function entryContent(kind, registry) {
    const holder = REGISTRY_ENTRY_HOLDERS[kind];
    if (!holder) return registry;
    const body = registry && typeof registry === 'object' ? registry[holder] : null;
    return body && typeof body === 'object' && !Array.isArray(body) ? body : registry;
}

/**
 * The top-level entries of one registry: `[id, value]` pairs in the file's own
 * order, metadata keys (`_`-prefixed) dropped.
 *
 * A keyed map yields its keys; an array yields `entry.id` when it declares one
 * and the index otherwise. A scalar or null registry yields nothing (there is
 * no entry to name).
 * @param {*} registry - The raw registry content.
 * @returns {Array<{id: string, value: *}>}
 * @private
 */
function entriesOf(registry) {
    if (Array.isArray(registry)) {
        return registry
            .map((value, index) => ({ id: idOfEntry(value) ?? String(index), value }))
            .filter((entry) => entry.id !== null);
    }
    if (!registry || typeof registry !== 'object') return [];
    return Object.entries(registry)
        .filter(([key]) => !key.startsWith('_'))
        .map(([id, value]) => ({ id, value }));
}

/** An array element's own id, when the element is an object declaring one. @private */
function idOfEntry(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return typeof value.id === 'string' && value.id.length > 0 ? value.id : null;
}

/**
 * One row, or null when the entry cannot be a row at all (a null or empty
 * entry has nothing to show). Every other shape becomes a row: the codex does
 * not decide which of the author's entries are worth reading.
 * @private
 */
function buildRow(kind, id, value, ctx) {
    if (value === undefined) return null;
    if (value === null) return null;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return null;
    return {
        kind,
        id,
        name: nameOf(value),
        description: descriptionOf(value),
        facets: buildFacets(kind, value, ctx, id),
        definition: structuredClone(value),
    };
}

/**
 * The row's display name: `name`, else `displayName` (the two fields the
 * registries use), else null — the card then shows the id, and the codex never
 * invents a label. Only a string entry can carry a name; a scalar entry has
 * none (`sensitiveParts` values are numbers, and the part type IS the name).
 * @private
 */
function nameOf(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.name === 'string' && value.name.length > 0) return value.name;
    if (typeof value.displayName === 'string' && value.displayName.length > 0) return value.displayName;
    return null;
}

/** The row's description, when the entry declares one as a string. @private */
function descriptionOf(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return typeof value.description === 'string' && value.description.length > 0
        ? value.description
        : null;
}

/**
 * The resolved header of a row: a small set of fields the reader asks for
 * first, with their references turned into display names.
 *
 * Each reader is a rule about a FIELD, not about a kind (with two exceptions
 * that name a shape the data genuinely keys by kind — a blueprint's array of
 * child ids, a room's `connections`). A field the entry does not declare
 * produces nothing; a reference this server cannot resolve keeps its raw key
 * (the codex never fabricates a name it does not have).
 *
 * A facet that names entries of other registries also carries `parts` — see
 * `facetOf`, and the module header on why a part names a kind and never a tab.
 *
 * A reader returns one facet or an ARRAY of them (the entity-attribute entry has
 * one line per attribute, and its labels are the data's own stat keys, so there
 * is no single field to name the block). A reader may also be given `rowId` —
 * the key the entry is written by — for the one shape where the KEY is the datum:
 * an entity-attribute entry is keyed by blueprint, so its row states its own key
 * as a reference. No other reader is called with more than `(kind, entry, ctx)`.
 * @param {string} kind - The row's registry kind.
 * @param {*} value - The raw entry.
 * @param {Object} ctx - The shared lookup tables.
 * @param {string|null} [rowId] - The key this entry is written by, when it has one.
 * @returns {Array<{label: string, value: string, parts?: FacetPart[]}>}
 */
export function buildFacets(kind, value, ctx = buildContext({}, {}), rowId = null) {
    const facets = [];
    for (const read of FACET_READERS) {
        const produced = read(kind, value, ctx, rowId);
        if (!produced) continue;
        facets.push(...(Array.isArray(produced) ? produced : [produced]));
    }
    return facets;
}

/**
 * One piece of a facet's text. A part that names an entry of another registry
 * carries the target — `kind` (a `REGISTRY_KINDS` value) and `id` (the key that
 * entry is written by) — and the client renders it as a link into the tab that
 * kind lives on. A part with no target is plain text.
 * @typedef {{ text: string, kind?: string, id?: string }} FacetPart
 */

/**
 * A facet reader: `(kind, entry, ctx) => { label, value, parts? } | null`. An
 * empty or unreadable facet returns null and is dropped — a facet never renders
 * as an empty row.
 * @type {Array<(kind: string, entry: *, ctx: Object) => ({label: string, value: string, parts?: FacetPart[]}|null)>}
 */
const FACET_READERS = [
    // An entry that IS its value: `sensitiveParts` maps a part type to a bare
    // number, `holdingCost.model` to a bare string. Without this line the card
    // would show an id and hide the only datum the registry holds behind the
    // collapsed appendix.
    (kind, entry) => {
        if (entry === null || entry === undefined || typeof entry === 'object') return null;
        const text = typeof entry === 'string' ? entry : String(entry);
        return text.length > 0 ? { label: 'value', value: text } : null;
    },
    // The size of the thing, read with the same precedence the runtime uses
    // (form.volume first, then a legacy top-level volume — the rule the item
    // rows already mirror, so the header cannot disagree with the Items tab).
    (kind, entry) => {
        const volume = readVolume(entry);
        return volume === null ? null : { label: 'volume', value: String(volume) };
    },
    // The matter: `[{ material, fraction }]`, each material named against the
    // materials registry and linked to it. The fraction is decoration around the
    // name, never part of the target.
    (kind, entry, ctx) => {
        const materials = arrayOfObjects(entry?.materials)
            .filter((m) => typeof m.material === 'string' && m.material.length > 0);
        if (materials.length === 0) return null;
        return facetOf('composition', joinParts(
            materials.map((m) => [
                refPart(ctx.materials, m.material, REGISTRY_KINDS.MATERIALS),
                ...(typeof m.fraction === 'number' ? [{ text: ` x${m.fraction}` }] : []),
            ]),
            ', ',
        ));
    },
    // The organs a part carries, read the way the internal-component controller
    // reads them: a bare type string or an object with a `type`. Each one names
    // the organ's own registry entry, so each one is a link to that entry.
    (kind, entry, ctx) => {
        const list = nameList(entry?.internalComponents);
        if (list.length === 0) return null;
        return facetOf('organs', joinParts(
            list.map((type) => [refPart(ctx.internalComponents, type, REGISTRY_KINDS.INTERNAL_COMPONENTS)]),
            ', ',
        ));
    },
    // A blueprint is an id mapped to its children; an outfit is a blueprint key
    // mapped to its wear claims. Both are arrays, and each says what it holds.
    (kind, entry, ctx) => {
        if (!Array.isArray(entry)) return null;
        const wears = arrayOfObjects(entry)
            .filter((w) => typeof w.item === 'string' && w.item.length > 0);
        if (wears.length > 0) {
            // The garment is an `inventoryItems` entry, so it names a link; the
            // component it mounts on is a raw key this reader never resolves to a
            // name, so it stays plain text.
            return facetOf('wears', joinParts(
                wears.map((w) => [
                    refPart(ctx.items, w.item, REGISTRY_KINDS.INVENTORY_ITEMS),
                    ...(typeof w.component === 'string' && w.component.length > 0
                        ? [{ text: ` on ${w.component}` }]
                        : []),
                ]),
                ', ',
            ));
        }
        const parts = partRefsOf(entry);
        if (parts.length === 0) return null;
        const label = kind === REGISTRY_KINDS.BLUEPRINTS ? 'parts' : 'entries';
        // A body part authored with a mount (`["crafterArm","left"]`) shows the
        // mount it hangs on, because a body whose two arms are both "Crafter Arm"
        // is only readable with the side named. The tuple is the engine's own row
        // form (`EntityController` expands `[name, slot, parentIndex]`). Only a
        // blueprint's children are read against the components registry — another
        // kind's list holds the author's own keys, so nothing there is a link.
        const table = kind === REGISTRY_KINDS.BLUEPRINTS ? ctx.components : null;
        return facetOf(label, joinParts(
            parts.map((part) => [
                refPart(table, part.type, REGISTRY_KINDS.COMPONENTS),
                ...(part.slot ? [{ text: ` [${part.slot}]` }] : []),
            ]),
            ', ',
        ));
    },
    // A room's doors, with the room each one opens onto resolved by name.
    (kind, entry, ctx) => {
        if (kind !== REGISTRY_KINDS.ROOMS) return null;
        const connections = entry?.connections;
        if (!connections || typeof connections !== 'object' || Array.isArray(connections)) return null;
        const exits = Object.entries(connections).map(([door, value]) => {
            const target = value && typeof value === 'object' && typeof value.target === 'string'
                ? value.target
                : null;
            // The door's own name belongs to this room; only the room it opens
            // onto is a reference, so only that half is a link.
            if (!target) return [{ text: door }];
            return [{ text: `${door} -> ` }, refPart(ctx.rooms, target, REGISTRY_KINDS.ROOMS)];
        });
        return exits.length === 0 ? null : facetOf('exits', joinParts(exits, ', '));
    },
    // Which room a prop or an NPC is in, resolved to the room's own name.
    (kind, entry, ctx) => {
        const room = entry?.room;
        if (typeof room !== 'string' || room.length === 0) return null;
        return facetOf('room', [refPart(ctx.rooms, room, REGISTRY_KINDS.ROOMS)]);
    },
    // A machine's three forms (item / blueprint / recipe), each resolved where a
    // name exists. These are references the engine itself resolves at runtime.
    (kind, entry, ctx) => {
        if (typeof entry?.blueprint !== 'string' || entry.blueprint.length === 0) return null;
        return facetOf('blueprint', [refPart(ctx.blueprints, entry.blueprint, REGISTRY_KINDS.BLUEPRINTS)]);
    },
    (kind, entry, ctx) => {
        if (typeof entry?.itemKey !== 'string' || entry.itemKey.length === 0) return null;
        return facetOf('item', [refPart(ctx.items, entry.itemKey, REGISTRY_KINDS.INVENTORY_ITEMS)]);
    },
    (kind, entry, ctx) => {
        if (typeof entry?.recipeId !== 'string' || entry.recipeId.length === 0) return null;
        return facetOf('recipe', [refPart(ctx.recipes, entry.recipeId, REGISTRY_KINDS.CRAFTING)]);
    },
    // What an organ grants, as declared: `stat` and the value the engine seeds.
    (kind, entry) => {
        const grants = entry?.grants;
        if (!grants || typeof grants !== 'object' || Array.isArray(grants)) return null;
        const cells = Object.entries(grants)
            .filter(([, value]) => typeof value === 'number')
            .map(([stat, value]) => `${stat} ${value}`);
        return cells.length === 0 ? null : { label: 'grants', value: cells.join(', ') };
    },
    // Which blueprint an entity-attribute row belongs to. The entry's KEY is a
    // blueprint name — that is how the spawn flow reads this registry, by entity
    // type (`EntityAttributeData.getAttributes(blueprint)`) — so the row states
    // its own key as a reference into the blueprint that owns these attributes.
    // A key no blueprint declares keeps the raw word (`refPart`), and a row built
    // without a key states nothing.
    (kind, entry, ctx, rowId) => {
        if (kind !== REGISTRY_KINDS.ENTITY_ATTRIBUTES) return null;
        if (typeof rowId !== 'string' || rowId.length === 0) return null;
        return facetOf('blueprint', [refPart(ctx.blueprints, rowId, REGISTRY_KINDS.BLUEPRINTS)]);
    },
    // What an entity type owns, one line per attribute. The entry is a map from
    // the flat "Group.stat" wire form to a declaration of up to three numbers: the
    // value seeded at spawn, the cap the value is clamped into, and the drain the
    // per-turn step subtracts. A clause the entry does not declare is left out —
    // the runtime's own default (`drainPerTurn` absent means no drain) is not the
    // author's claim to show — and NOTHING IS DIVIDED: the turns a full tank lasts
    // would be arithmetic the engine never performs (Sec. 8, CR DETERM-1).
    (kind, entry, ctx) => {
        if (kind !== REGISTRY_KINDS.ENTITY_ATTRIBUTES) return null;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
        const facets = [];
        for (const [stat, decl] of Object.entries(entry)) {
            if (stat.startsWith('_')) continue;
            if (!decl || typeof decl !== 'object' || Array.isArray(decl)) continue;
            const clauses = [];
            if (typeof decl.value === 'number') clauses.push({ text: `starts ${decl.value}` });
            if (typeof decl.max === 'number') clauses.push({ text: `${clauses.length ? ', ' : ''}cap ${decl.max}` });
            if (typeof decl.drainPerTurn === 'number') {
                clauses.push({ text: `${clauses.length ? ', ' : ''}drains ${decl.drainPerTurn} per turn` });
            }
            if (clauses.length === 0) continue;
            facets.push(facetOf(stat, clauses));
            // The two lines that answer "where does this trait show up": what writes
            // it, then what grants it. Both follow the attribute line they belong to,
            // and both are dropped when no entry in the tables names that stat.
            const charged = chargeParts(ctx, stat);
            if (charged !== null) facets.push(facetOf('charged by', charged));
            const granted = grantParts(ctx, stat);
            if (granted !== null) facets.push(facetOf('granted by', granted));
        }
        return facets.length > 0 ? facets : null;
    },
    // What an NPC starts with. `count` is copied as the data states it; `wear`
    // and `equip` stay in the raw definition rather than being paraphrased here.
    (kind, entry, ctx) => {
        const items = arrayOfObjects(entry?.initialItems)
            .filter((it) => typeof it.item === 'string' && it.item.length > 0);
        if (items.length === 0) return null;
        return facetOf('carries', joinParts(
            items.map((it) => [
                refPart(ctx.items, it.item, REGISTRY_KINDS.INVENTORY_ITEMS),
                ...(typeof it.count === 'number' ? [{ text: ` x${it.count}` }] : []),
            ]),
            ', ',
        ));
    },
];

/**
 * A facet from its parts: `value` is the parts' text concatenated, so the
 * sentence a link-free reader reads and the sentence the links are drawn into
 * are the same sentence by construction (`test/unit/definitionSemantics.test.js`
 * pins it for every facet this module can emit).
 * @param {string} label - The facet's label.
 * @param {FacetPart[]} parts - The sentence, in order.
 * @returns {{label: string, value: string, parts: FacetPart[]}|null} null when
 *   the parts say nothing at all.
 * @private
 */
function facetOf(label, parts) {
    const value = parts.map((part) => part.text).join('');
    return value.length === 0 ? null : { label, value, parts };
}

/**
 * Part groups joined by a plain-text separator (`, ` for every facet the codex
 * reads as a list). No separator goes before the first group, so an empty group
 * cannot leave a leading comma.
 * @param {FacetPart[][]} groups - One group of parts per listed thing.
 * @param {string} separator - Text put between the groups.
 * @returns {FacetPart[]}
 * @private
 */
function joinParts(groups, separator) {
    const parts = [];
    for (const group of groups) {
        if (parts.length > 0) parts.push({ text: separator });
        parts.push(...group);
    }
    return parts;
}

/**
 * The part naming one entry of another registry. When that registry holds the
 * entry, the part is a link (`kind` + `id`) — there is a card to land on. When
 * it does not, the part is plain text and keeps whatever name or raw key the
 * reference had: an unresolved reference stays visible, and the codex never
 * offers a destination that would lead nowhere. A target with no display name
 * still links, under the key it is written by (a card titled by its id is the
 * codex's own rule, not a failure to name it).
 * @param {Object|null} registry - The keyed table the reference resolves against.
 * @param {string} key - The raw key the data holds.
 * @param {string} kind - The registry kind the target belongs to.
 * @returns {FacetPart}
 * @private
 */
function refPart(registry, key, kind) {
    const text = displayNameIn(registry, key) ?? key;
    return entryExistsIn(registry, key) ? { text, kind, id: key } : { text };
}

/**
 * Whether a keyed registry holds an entry under `key`. A list-shaped table is
 * not one: its rows are addressed by the `id` they declare or by their index
 * (`entriesOf`), so no key held by the referring data can name one — a part that
 * claimed such a target would point at a card the codex does not have.
 * @private
 */
function entryExistsIn(registry, key) {
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return false;
    return Object.hasOwn(registry, key) && registry[key] !== null && registry[key] !== undefined;
}

/**
 * A charge clause for one entry that targets `stat`: the interval and the amount
 * in parentheses, or null when the entry targets a different stat. An entry that
 * names the target and no number still counts (a bare mention is the author's
 * claim), hence the empty string rather than null. Nothing is divided or turned
 * into a rate the engine never states (Sec. 8, CR DETERM-1).
 * @param {*} target - The stat the entry says it writes, raw.
 * @param {string} stat - The attribute this row is asking about.
 * @param {*} intervalTurns - The entry's interval, when it declares one.
 * @param {*} gain - The amount the entry declares, when it declares one.
 * @returns {string|null} The clause text (`''` when the entry states no numbers).
 * @private
 */
function chargeClauseOf(target, stat, intervalTurns, gain) {
    if (typeof target !== 'string' || target !== stat) return null;
    const words = [];
    if (typeof intervalTurns === 'number') words.push(`every ${intervalTurns} turns`);
    if (typeof gain === 'number') words.push(`+${gain}`);
    return words.length === 0 ? '' : ` (${words.join(', ')})`;
}

/**
 * Which entries WRITE one entity attribute: an inventory item declares the stat it
 * charges under `consume.targetStat` (the `eat` action spends the item), an organ
 * under each `overTime[]` effect (`targetStat`, with `intervalTurns` and
 * `energyGainPerInterval`). Those are the two field paths the shipped tables use;
 * a craft recipe or an outfit naming a stat would be read only once some world
 * writes one, and the codex does not invent the line in the meantime.
 * @param {ReturnType<typeof buildContext>} ctx - The assembly's tables.
 * @param {string} stat - The attribute's flat "Group.stat" key.
 * @returns {FacetPart[]|null} null when nothing in the tables names it.
 * @private
 */
function chargeParts(ctx, stat) {
    const groups = [];
    for (const { id, value } of entriesOf(ctx.items)) {
        const consume = value?.consume;
        if (!consume || typeof consume !== 'object' || Array.isArray(consume)) continue;
        const clause = chargeClauseOf(consume.targetStat, stat, null, consume.energyGain);
        if (clause === null) continue;
        groups.push([refPart(ctx.items, id, REGISTRY_KINDS.INVENTORY_ITEMS), { text: clause }]);
    }
    for (const { id, value } of entriesOf(ctx.internalComponents)) {
        for (const effect of arrayOfObjects(value?.overTime)) {
            const clause = chargeClauseOf(
                effect.targetStat,
                stat,
                effect.intervalTurns,
                effect.energyGainPerInterval,
            );
            if (clause === null) continue;
            groups.push([refPart(ctx.internalComponents, id, REGISTRY_KINDS.INTERNAL_COMPONENTS), { text: clause }]);
        }
    }
    return groups.length === 0 ? null : joinParts(groups, ', ');
}

/**
 * Which organs GRANT one entity attribute: an organ's `grants` is keyed by the same
 * flat stat name and its number is the organ's static contribution to whatever
 * carries it. In the shipped world the organs grant the FUNCTION stats
 * (`Physical.strength`, `Movement.move`, ...) and not the entity attributes, so this
 * line is usually absent — and an absent line says that, rather than the card
 * naming a carrier the data never declared.
 * @param {ReturnType<typeof buildContext>} ctx - The assembly's tables.
 * @param {string} stat - The attribute's flat "Group.stat" key.
 * @returns {FacetPart[]|null} null when no organ grants it.
 * @private
 */
function grantParts(ctx, stat) {
    const groups = [];
    for (const { id, value } of entriesOf(ctx.internalComponents)) {
        const grants = value?.grants;
        if (!grants || typeof grants !== 'object' || Array.isArray(grants)) continue;
        if (typeof grants[stat] !== 'number') continue;
        groups.push([
            refPart(ctx.internalComponents, id, REGISTRY_KINDS.INTERNAL_COMPONENTS),
            { text: ` (+${grants[stat]})` },
        ]);
    }
    return groups.length === 0 ? null : joinParts(groups, ', ');
}

/**
 * The volume of an entry with the runtime's own precedence: `form.volume`
 * first, then a legacy top-level `volume`. A non-finite value is no volume
 * (the same guard the item rows use).
 * @private
 */
function readVolume(entry) {
    const formVolume = entry && typeof entry === 'object' && !Array.isArray(entry) && entry.form
        && typeof entry.form === 'object' && !Array.isArray(entry.form)
        ? entry.form.volume
        : undefined;
    if (typeof formVolume === 'number' && Number.isFinite(formVolume)) return formVolume;
    const legacy = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.volume : undefined;
    return typeof legacy === 'number' && Number.isFinite(legacy) ? legacy : null;
}

/** The plain objects of a list (strings, nulls and nested lists are dropped). @private */
function arrayOfObjects(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter((el) => el && typeof el === 'object' && !Array.isArray(el));
}

/**
 * A part reference: the component type and, when the author mounted it, the slot
 * it hangs on. Covers the three forms the blueprint registries use — a bare type
 * string, an object declaring `type` (and optionally `slot`), and the engine's own
 * `[type, slot]` tuple.
 * @param {*} raw - A list (array) of part entries.
 * @returns {Array<{type: string, slot: string|null}>}
 * @private
 */
function partRefsOf(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const el of raw) {
        if (typeof el === 'string' && el.length > 0) {
            out.push({ type: el, slot: null });
        } else if (el && typeof el === 'object' && !Array.isArray(el)
            && typeof el.type === 'string' && el.type.length > 0) {
            out.push({ type: el.type, slot: typeof el.slot === 'string' && el.slot.length > 0 ? el.slot : null });
        } else if (Array.isArray(el) && typeof el[0] === 'string' && el[0].length > 0) {
            out.push({ type: el[0], slot: typeof el[1] === 'string' && el[1].length > 0 ? el[1] : null });
        }
    }
    return out;
}

/** A list's strings (a bare type or an object with a string `type`). @private */
function nameList(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const el of raw) {
        if (typeof el === 'string' && el.length > 0) out.push(el);
        else if (el && typeof el === 'object' && typeof el.type === 'string' && el.type.length > 0) out.push(el.type);
    }
    return out;
}

/**
 * Locale-independent, deterministic string comparator (code-unit order) — the
 * same rule the other codex sections sort with, so the wire contract does not
 * depend on the runtime locale.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 * @private
 */
function compareStrings(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

/**
 * The display name a registry declares for `key` (`name`, else `displayName`),
 * or null when the registry has no entry or no name for it. Callers fall back
 * to the raw key — the codex never fabricates a name.
 * @private
 */
function displayNameIn(registry, key) {
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return null;
    const entry = registry[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (typeof entry.name === 'string' && entry.name.length > 0) return entry.name;
    if (typeof entry.displayName === 'string' && entry.displayName.length > 0) return entry.displayName;
    return null;
}
