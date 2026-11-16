/**
 * KnowledgeSearch — the search of the Knowledge codex, as pure functions.
 *
 * WHY client-side: the codex payload is fetched once per session and is static
 * at runtime (see wiki/subMDs/frontend/knowledge_viewer.md §7). A search
 * endpoint would re-read server-side what the browser already holds; the panel
 * is disposable, this filter is the panel's own reading of data it was given.
 *
 * WHAT is searched: everything a row carries, including the raw definition dump
 * that only reaches the screen when the reader opens the appendix. That was the
 * chosen contract — the search can surface a field the panel does not display.
 * The cost of that choice is stated where it matters: a query can match a KEY
 * name (`range`, `wear`) as well as a value, because the row is serialised whole.
 *
 * The rule lives ONCE: `filterKnowledge` produces both the filtered payload and
 * the per-section counts, so a tab badge can never disagree with what the tab
 * actually renders. A refine query narrows the ACTIVE section only — the global
 * bar is the search, the sub bar is a second term over what the first found.
 *
 * Pure module: no DOM, no fetch, no timers. Terms are matched case-insensitively
 * as substrings, and every term must appear somewhere in the row (AND).
 *
 * THE DEFINITION TABS: below the codex's own tabs sits one tab per registry kind
 * (`Components`, `Rooms`, `World Rules`...), grouped under family captions the
 * server sends. The rows stay ONE flat `definitions` list in the payload; a tab
 * is a window onto that list, so the filter keeps one rule and the badges stay
 * honest: `definitionTabsOf` says which tabs exist, and a per-tab count is
 * computed in the same pass (`counts['def:rooms']`). A kind present in the rows
 * but missing from the server's map still gets a tab — a row with no tab is a
 * definition the reader cannot reach (knowledge_viewer.md Sec. 12).
 *
 * @module KnowledgeSearch
 */

/**
 * Section ids are the panel's own `SECTION_IDS` values, which are also the
 * payload's key names (`traitStats`, `recipes`, `items`, `materials`,
 * `actions`). They are deliberately NOT re-declared here — a second constant
 * table is how the two drift apart. `test/unit/KnowledgeSearch.test.js` pins
 * that every `SECTION_IDS` value is a section this module filters, so a rename
 * on either side fails the suite instead of silently losing a tab from the
 * search. (`materials` is the only id without a top-level payload key: it names
 * the `traitStats.materials` block, exactly as in the panel.)
 */

/** The sections whose payload entry is a list of rows. @type {Array<{id: string, key: string}>} */
const LIST_SECTIONS = [
    { id: 'items', key: 'items' },
    { id: 'recipes', key: 'recipes' },
    { id: 'actions', key: 'actions' },
    // The definition rows: every registry the codex does not show on its own tab,
    // ONE flat list under the key `definitions`. The bar renders it as one tab per
    // kind (see `definitionTabsOf`), but the list stays flat so a row is searched
    // whole like every other - a term reaches the raw definition the card keeps
    // collapsed, including the fields no facet reads
    // (wiki/subMDs/frontend/knowledge_viewer.md Sec. 12).
    { id: 'definitions', key: 'definitions' },
];

/**
 * The prefix of a definition tab's id (`def:rooms`). Prefixed because the flat
 * payload key (`definitions`) is a section id of its own, and a tab id must never
 * be mistaken for it - nor for a registry kind that a mod might name `items`.
 * Exported because the panel builds the same ids from the same map and sums the
 * global total over the sections only (a tab count is a slice of one section, and
 * adding it to the total would count the same row twice).
 */
export const DEFINITION_TAB_PREFIX = 'def:';

/**
 * Every id `filterKnowledge` reports a count under: the table-driven sections
 * first, then the two the `traitStats` branch fills itself (the derivation chain
 * and its materials table are searched as units, not as a list of rows). The two
 * are listed here rather than implied by the branch, because the branch is
 * conditional on a payload carrying a `traitStats` object: without this, a
 * degraded payload leaves a tab with no number at all instead of a zero.
 * @type {ReadonlyArray<string>}
 */
export const SECTION_ID_LIST = Object.freeze([
    ...LIST_SECTIONS.map((section) => section.id),
    'traitStats',
    'materials',
]);

/**
 * The searchable text of one value: everything it carries, lowercased, keys
 * included (the row is serialised whole — see the module header). A cycle or a
 * BigInt cannot kill the search: the worst case is an empty string, i.e. a row
 * that matches nothing.
 * @param {*} value
 * @returns {string}
 */
export function searchTextOf(value) {
    try {
        const json = JSON.stringify(value);
        return typeof json === 'string' ? json.toLowerCase() : '';
    } catch (_error) {
        return '';
    }
}

/**
 * A query split into terms: lowercased, whitespace-separated, deduplicated,
 * order preserved.
 * @param {*} query
 * @returns {string[]}
 */
export function termsOf(query) {
    if (typeof query !== 'string') return [];
    const seen = new Set();
    for (const term of query.toLowerCase().split(/\s+/)) {
        if (term !== '') seen.add(term);
    }
    return [...seen];
}

/**
 * Every term appears somewhere (AND). An empty term list matches everything —
 * no query is not a filter.
 * @param {string} text - Lowercased searchable text.
 * @param {string[]} terms
 * @returns {boolean}
 */
export function matchesTerms(text, terms) {
    for (const term of terms) {
        if (!text.includes(term)) return false;
    }
    return true;
}

/**
 * The family bands the payload names, normalized and in the order the server
 * sent them: each entry carries the codex view tabs (`sections`) and the registry
 * kinds (`kinds`) of one band, arrays present even when the payload is missing
 * them. This is where the client reads the server's grouping — it owns no family
 * of its own, only the tab ids, labels and views `sections` names.
 * @param {Object|null} payload - The unwrapped knowledge payload.
 * @returns {Array<{id: string, label: string, sections: string[], kinds: string[]}>}
 */
export function definitionGroupsOf(payload) {
    const raw = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload.definitionGroups
        : null;
    const groups = [];
    if (!Array.isArray(raw)) return groups;
    for (const group of raw) {
        if (!group || typeof group !== 'object') continue;
        groups.push({
            id: typeof group.id === 'string' ? group.id : '',
            label: typeof group.label === 'string' ? group.label : '',
            sections: stringList(group.sections),
            kinds: stringList(group.kinds),
        });
    }
    return groups;
}

/** Entries of a payload list that are usable ids; anything else is dropped. @private */
function stringList(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((entry) => typeof entry === 'string' && entry.length > 0);
}

/**
 * Which tabs the definition side of the bar has, in the family order the payload
 * names. One tab per registry kind; a kind with rows and no family entry still
 * gets a tab (under no caption), because the rows are the truth of what exists.
 * @param {Object|null} payload - The unwrapped knowledge payload.
 * @returns {Array<{id: string, kind: string, groupId: string, groupLabel: string}>}
 */
export function definitionTabsOf(payload) {
    const tabs = [];
    const seen = new Set();
    for (const group of definitionGroupsOf(payload)) {
        for (const kind of group.kinds) {
            if (seen.has(kind)) continue;
            seen.add(kind);
            tabs.push({ id: DEFINITION_TAB_PREFIX + kind, kind, groupId: group.id, groupLabel: group.label });
        }
    }
    // The map is the server's ordering; the rows are the truth of what exists. A
    // kind with rows and no entry (a vocabulary addition the map has not caught
    // up with, or a degraded payload) opens a tab of its own under no caption.
    const rows = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload.definitions
        : null;
    if (Array.isArray(rows)) {
        for (const row of rows) {
            const kind = row && typeof row === 'object' && typeof row.kind === 'string' ? row.kind : '';
            if (kind === '' || seen.has(kind)) continue;
            seen.add(kind);
            tabs.push({ id: DEFINITION_TAB_PREFIX + kind, kind, groupId: '', groupLabel: '' });
        }
    }
    return tabs;
}

/**
 * Filter the codex payload by the global query, then narrow the active section
 * by the refine term. Returns a payload of the SAME shape the renderers expect
 * (arrays stay arrays, keyed objects stay keyed objects) plus the per-section
 * counts of what the GLOBAL query found.
 * @param {Object|null} payload - The unwrapped knowledge payload.
 * @param {Object} [options]
 * @param {string} [options.query] - The global search bar.
 * @param {string} [options.refine] - The sub bar (active section only).
 * @param {string} [options.activeSection] - Which tab is showing. A definition
 *   tab (`def:<kind>`) narrows the flat `definitions` list to that kind.
 * @returns {{payload: Object, counts: Object<string, number>,
 *   display: Object<string, number>, querying: boolean, refining: boolean}}
 *   `counts`/`display` carry the section ids AND one entry per definition tab
 *   (keyed by its `def:<kind>` id).
 */
export function filterKnowledge(payload, options = {}) {
    const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const terms = termsOf(options.query);
    const refineTerms = termsOf(options.refine);
    const activeSection = typeof options.activeSection === 'string' ? options.activeSection : null;
    const refining = refineTerms.length > 0;
    const querying = terms.length > 0;
    const out = { ...source };
    const counts = {};

    const display = {};
    for (const { id, key } of LIST_SECTIONS) {
        const kept = filterList(source[key], terms);
        counts[id] = kept.length;
        out[key] = activeSection === id && refining
            ? kept.filter((row) => matchesTerms(searchTextOf(row), refineTerms))
            : kept;
        display[id] = out[key].length;
    }

    applyDefinitionTabs(out, source, { activeSection, refining, refineTerms, counts, display });

    const traitStats = source.traitStats && typeof source.traitStats === 'object' && !Array.isArray(source.traitStats)
        ? source.traitStats
        : null;
    const refineFor = (section) => activeSection === section && refining ? refineTerms : null;

    if (traitStats) {
        const stats = { ...traitStats };

        const materials = filterCollection(traitStats.materials, terms);
        counts.materials = countOfCollection(materials);
        stats.materials = refineCollection(materials, refineFor('materials'));
        display.materials = countOfCollection(stats.materials);

        const mappings = filterCollection(traitStats.mappings, terms);
        const groups = filterGroups(traitStats.groups, terms);
        // The Traits tab counts what it renders: one unit per mapping row and one
        // per surviving stat cell (the tab has no single row type to count).
        counts.traitStats = countOfCollection(mappings) + countStatCells(groups);
        stats.mappings = refineCollection(mappings, refineFor('traitStats'));
        stats.groups = refineGroups(groups, refineFor('traitStats'));
        display.traitStats = countOfCollection(stats.mappings) + countStatCells(stats.groups);

        // The pinned vocabulary block is reference chrome, not content: with a
        // query active it would show identical badges under every search, so it
        // is dropped. Without a query it is untouched.
        if (querying) delete stats.vocabulary;

        out.traitStats = stats;
    }

    for (const id of SECTION_ID_LIST) {
        counts[id] = counts[id] ?? 0;
        display[id] = display[id] ?? 0;
    }
    return { payload: out, counts, display, querying, refining };
}

/**
 * The definition tabs over the flat `definitions` list: per-tab badges (the
 * global term's, like every other badge), the rendered list narrowed to the
 * ACTIVE kind, and the refine term applied to that kind only. It rewrites
 * `out.definitions` and fills the per-tab entries of `counts`/`display`, so the
 * panel's two lookups (`counts[tab.id]`, `display[activeSection]`) need no
 * special case for a tab that is a slice of a section.
 * @private
 */
function applyDefinitionTabs(out, source, { activeSection, refining, refineTerms, counts, display }) {
    const tabs = definitionTabsOf(source);
    const rows = Array.isArray(out.definitions) ? out.definitions : [];
    const activeKind = typeof activeSection === 'string' && activeSection.startsWith(DEFINITION_TAB_PREFIX)
        ? activeSection.slice(DEFINITION_TAB_PREFIX.length)
        : null;
    // The refine term belongs to the active tab; on a definition tab it narrows
    // that tab's kind, and no other tab's count is touched by it.
    const kept = refining && activeKind !== null
        ? rows.filter((row) => matchesTerms(searchTextOf(row), refineTerms))
        : rows;
    const perKind = new Map();
    for (const row of kept) {
        const kind = row && typeof row === 'object' && typeof row.kind === 'string' ? row.kind : '';
        perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
    }
    // The badge is the GLOBAL term's per-kind total: a badge describes the search,
    // never one tab's narrowing of it (knowledge_viewer.md Sec. 10). `perKind` is
    // what a tab shows once the sub bar's term is applied.
    const globalPerKind = new Map();
    for (const row of rows) {
        const kind = row && typeof row === 'object' && typeof row.kind === 'string' ? row.kind : '';
        globalPerKind.set(kind, (globalPerKind.get(kind) ?? 0) + 1);
    }
    for (const tab of tabs) {
        counts[tab.id] = globalPerKind.get(tab.kind) ?? 0;
        display[tab.id] = perKind.get(tab.kind) ?? 0;
    }
    // The active tab renders its own kind only; every other tab's rows stay in
    // the list (the search walked them, and the badges came from them).
    out.definitions = activeKind !== null ? kept.filter((row) => row && row.kind === activeKind) : kept;
    display.definitions = out.definitions.length;
}

/**
 * Count what the query finds in each section (the tab badges). Built on
 * `filterKnowledge` with no refine term, so the badges keep describing the
 * GLOBAL result even while the active tab is narrowed.
 * @param {Object|null} payload
 * @param {string} query
 * @returns {Object<string, number>}
 */
export function countMatches(payload, query) {
    return filterKnowledge(payload, { query }).counts;
}

/**
 * True when the section shows nothing because of the search — as opposed to the
 * data itself being empty, which keeps the renderer's own empty state. Pass the
 * `display` counts (after the refine term), not the global ones.
 * @param {Object<string, number>} display - Per-section counts as rendered.
 * @param {boolean} searching - A global or refine term is active.
 * @param {string} section - The section id.
 * @returns {boolean}
 */
export function isSearchEmpty(display, searching, section) {
    if (!searching) return false;
    return (display[section] ?? 0) === 0;
}

/**
 * Does a cross-link target survive the current query? A jump to a card the
 * search has filtered out would flash an absent card and read as a broken link,
 * so the panel asks this first and clears the search when the target cannot be
 * shown. A target this module cannot locate does NOT clear anything: the search
 * gives up its opinion rather than deleting the reader's term on a guess.
 * @param {Object|null} payload - The UNFILTERED payload.
 * @param {string} section - Section id of the jump target.
 * @param {string} query - The current global query.
 * @param {string} targetId - The id the jump is addressed to.
 * @returns {boolean} true when the target is visible (or cannot be checked).
 */
export function targetSurvivesQuery(payload, section, query, targetId) {
    const terms = termsOf(query);
    if (terms.length === 0) return true;
    for (const row of sectionRows(payload, section)) {
        if (rowIdOf(row, section) === targetId) return matchesTerms(searchTextOf(row), terms);
    }
    return true;
}

/** The raw rows of a jumpable section (the three the cross-links address). */
function sectionRows(payload, section) {
    if (!payload || typeof payload !== 'object') return [];
    if (section === 'items' || section === 'recipes' || section === 'actions') {
        return Array.isArray(payload[section]) ? payload[section] : [];
    }
    if (section === 'materials') {
        const raw = payload.traitStats && typeof payload.traitStats === 'object'
            ? payload.traitStats.materials
            : null;
        if (Array.isArray(raw)) return raw;
        if (raw && typeof raw === 'object') return Object.values(raw);
        return [];
    }
    // A definition tab (`def:<kind>`, the facet links of a definition card) is the
    // other thing a jump addresses: the flat `definitions` rows of that kind. Left
    // unknown, a jump onto such a tab could not check its target, and the reader's
    // term would survive onto a no-match screen instead of showing the card they
    // clicked.
    if (typeof section === 'string' && section.startsWith(DEFINITION_TAB_PREFIX)) {
        const kind = section.slice(DEFINITION_TAB_PREFIX.length);
        return (Array.isArray(payload.definitions) ? payload.definitions : [])
            .filter((row) => row && typeof row === 'object' && row.kind === kind);
    }
    return [];
}

/**
 * A row's identity for a jump: item type, material type, action name, or — for a
 * definition row — the entry id the facet link carried.
 */
function rowIdOf(row, section) {
    if (!row || typeof row !== 'object') return null;
    if (section === 'actions') return typeof row.name === 'string' ? row.name : null;
    if (typeof row.type === 'string') return row.type;
    if (typeof row.id === 'string') return row.id;
    return null;
}

// --- the filtering primitives (one rule per shape, no forks) ------------------

function filterList(raw, terms) {
    if (!Array.isArray(raw)) return [];
    if (terms.length === 0) return [...raw];
    return raw.filter((row) => matchesTerms(searchTextOf(row), terms));
}

/**
 * Filter a collection that may be an array OR a keyed object (the payload mixes
 * both). The input's kind is preserved so the shape* readers keep working.
 */
function filterCollection(raw, terms) {
    if (Array.isArray(raw)) return filterList(raw, terms);
    if (raw && typeof raw === 'object') {
        if (terms.length === 0) return { ...raw };
        const kept = {};
        for (const [key, value] of Object.entries(raw)) {
            if (matchesTerms(`${key.toLowerCase()} ${searchTextOf(value)}`, terms)) kept[key] = value;
        }
        return kept;
    }
    return raw;
}

function refineCollection(collection, refineTerms) {
    if (!refineTerms) return collection;
    return filterCollection(collection, refineTerms);
}

function countOfCollection(collection) {
    if (Array.isArray(collection)) return collection.length;
    if (collection && typeof collection === 'object') return Object.keys(collection).length;
    return 0;
}

/**
 * The trait-group tables: a group whose NAME matches keeps all its stats (the
 * reader asked for the group); otherwise only the stat cells that match survive.
 */
function filterGroups(rawGroups, terms) {
    if (!rawGroups || typeof rawGroups !== 'object' || Array.isArray(rawGroups)) return rawGroups;
    const kept = {};
    for (const [group, stats] of Object.entries(rawGroups)) {
        if (terms.length === 0) {
            kept[group] = stats;
            continue;
        }
        if (terms.every((t) => group.toLowerCase().includes(t))) {
            kept[group] = stats;
            continue;
        }
        const keptStats = filterStatCells(group, stats, terms);
        if (Object.keys(keptStats).length > 0) kept[group] = keptStats;
    }
    return kept;
}

function filterStatCells(group, stats, terms) {
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return {};
    const kept = {};
    for (const [stat, value] of Object.entries(stats)) {
        if (matchesTerms(`${group.toLowerCase()}.${stat.toLowerCase()} ${String(value)}`, terms)) kept[stat] = value;
    }
    return kept;
}

function refineGroups(groups, refineTerms) {
    if (!refineTerms) return groups;
    return filterGroups(groups, refineTerms);
}

function countStatCells(groups) {
    if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return 0;
    let total = 0;
    for (const stats of Object.values(groups)) {
        total += stats && typeof stats === 'object' && !Array.isArray(stats) ? Object.keys(stats).length : 0;
    }
    return total;
}
