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
];

/** Ids, for the one-line guard in `filterKnowledge`. @type {string[]} */
const SECTION_ID_LIST = ['traitStats', 'recipes', 'items', 'materials', 'actions'];

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
 * Filter the codex payload by the global query, then narrow the active section
 * by the refine term. Returns a payload of the SAME shape the renderers expect
 * (arrays stay arrays, keyed objects stay keyed objects) plus the per-section
 * counts of what the GLOBAL query found.
 * @param {Object|null} payload - The unwrapped knowledge payload.
 * @param {Object} [options]
 * @param {string} [options.query] - The global search bar.
 * @param {string} [options.refine] - The sub bar (active section only).
 * @param {string} [options.activeSection] - Which tab is showing.
 * @returns {{payload: Object, counts: Object<string, number>,
 *   display: Object<string, number>, querying: boolean, refining: boolean}}
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
    return [];
}

/** A row's identity for a jump: item type, material type, or action name. */
function rowIdOf(row, section) {
    if (!row || typeof row !== 'object') return null;
    if (section === 'actions') return typeof row.name === 'string' ? row.name : null;
    return typeof row.type === 'string' ? row.type : null;
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
