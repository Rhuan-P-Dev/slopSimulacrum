/**
 * KnowledgePanel
 * Client-side Knowledge overlay panel (wiki/subMDs/frontend/knowledge_viewer.md): a
 * read-only reference codex of the game's static data files. The tabs share one
 * content area:
 *   1. "Traits & Stats" — the material-property → trait → stat derivation
 *      chain: the global trait molds, the property-to-stat mapping table,
 *      and the cross-layer pinned vocabulary.
 *   2. "Crafting & Items" — every recipe with display names already resolved
 *      by the server (the client never re-resolves names).
 *   3. "Items" — every item type with its FULL definition: a flat key: value
 *      listing of every field (form, materials, traits, internalComponents,
 *      visual, wear, and anything a future mod adds), under the
 *      runtime-resolved volume line. A string value of a "material" key that
 *      names a known material renders as a cross-link button to the Materials
 *      tab; unknown references stay plain text (the codex never fabricates a
 *      navigation target).
 *   4. "Materials" — every material type: density, the property values, and
 *      the renderer's visual (look) block when the material declares one.
 *      Clicking a material cross-link opens this tab, scrolls to the card and
 *      flashes its highlight.
 *   5. "Actions" — every action definition and the stat gate that governs it.
 *   6. The definition tabs — ONE PER REGISTRY KIND (Components, Rooms, World
 *      Rules, ...), captioned by the family the server groups them under (Parts,
 *      Blueprints, World, Characters, Data). They render the flat `definitions`
 *      list as a window per kind; the grouping is the server's, never a table
 *      maintained here (wiki/subMDs/frontend/knowledge_viewer.md Sec. 12).
 *
 * A FACET LINK IN A DEFINITION CARD CARRIES A TARGET, NOT A TAB. Where a facet
 * names an entry of another registry — the matter a component is made of, the
 * organ it carries, the room a machine runs in — the server sends that name as a
 * `part` carrying the target's registry `kind` and `id` (`definitionSemantics.js`);
 * this module decides where it lands. `referenceTabIdOf` maps a kind to the view
 * tab that kind owns (matter → Materials, items → Items, verbs → Crafting & Items,
 * the trait tables → Traits & Stats) or to that kind's own definition tab
 * (`def:internalComponents` for an organ). The jump then follows the rules every
 * other jump here follows: the sub bar clears, the global term survives when the
 * target can survive it (`targetSurvivesQuery`), the card scrolls into view and
 * flashes. A kind the payload has no tab for is a no-op — a link never moves the
 * reader to an empty screen.
 *
 * Data flow (wiki/subMDs/frontend/knowledge_viewer.md): the payload is fetched
 * ONCE per session from GET /knowledge and cached — the data is immutable
 * at runtime (registries are validated once at boot), so per-open refetches
 * would be pure waste. Every failure class (network error, non-2xx status,
 * JSON parse error, malformed envelope) renders the in-panel error state
 * with a Retry action; a well-shaped but empty payload renders per-section
 * empty states instead. Logging goes through ClientLogger only (BUG-123 —
 * never console.* on the client).
 *
 * The pure helpers (unwrapKnowledgeEnvelope, escapeHtml, the per-section
 * shapers, and renderDefinitionListing, which renders a full-field key: value
 * listing) are named exports unit-tested without any DOM
 * (test/unit/KnowledgePanel.test.js); the class owns the DOM wiring.
 * Standing rules: every server-fetched structure is guarded before
 * iteration (Array.isArray / typeof-object checks); every server-sourced
 * string is interpolated only through escapeHtml; tab lookups use dataset
 * comparison, never selector interpolation. Helpers are local per module
 * (no cross-panel imports).
 *
 * @module KnowledgePanel
 */
import { AppConfig } from './Config.js';
import ClientLogger from '/utils/ClientLogger.js';
import {
    TRAIT_GROUPS,
    STAT_NAMES,
    EXISTENCE_GONE_AT,
    EXISTENCE_USABLE_MIN,
} from '../../shared/StatVocabulary.js';
import { DEFAULT_ITEM_VOLUME } from '../../shared/Defaults.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';
import {
    filterKnowledge,
    isSearchEmpty,
    targetSurvivesQuery,
    definitionGroupsOf,
    definitionTabsOf,
    DEFINITION_TAB_PREFIX,
} from './KnowledgeSearch.js';

// =============================================================================
// Presentation constants (wiki/subMDs/frontend/knowledge_viewer.md)
// =============================================================================

/** Multiplication sign used in "qty × name" / "property × weight" labels. */
const MULTIPLICATION_SIGN = '×';

/** Arrow glyph separating a recipe's inputs from its outputs. */
const ARROW = '→';

/**
 * The one formula the spec annotates inline (wiki/subMDs/frontend/knowledge_viewer.md):
 * the densityVolume formula badge gets the human-readable expansion.
 */
const DENSITY_VOLUME_FORMULA = 'densityVolume';
const DENSITY_VOLUME_ANNOTATION = 'mass = density × volume';

/**
 * Neutral numeric fallback for a malformed/missing numeric field in a
 * server-fetched row (the server guarantees real numbers; this only ever
 * fires on corrupted data and keeps rendering non-fatal).
 * @type {number}
 */
const FALLBACK_NUMBER = 0;

/** Smallest valid recipe quantity (mirrors the server validator: integer >= 1). */
const MIN_QUANTITY = 1;

/**
 * The EXACT English label contract of wiki/subMDs/frontend/knowledge_viewer.md. These
 * strings are the visible UI text and are pinned character-for-character by
 * test/unit/KnowledgePanel.test.js (and indirectly guarded by the
 * ptLanguageRegression scanner, which rejects Portuguese words / accented
 * characters in this codebase).
 */
export const KNOWLEDGE_LABELS = {
    /** Config-bar button tooltip. */
    BUTTON_TITLE: 'Knowledge',
    /** Config-bar button glyph. */
    BUTTON_GLYPH: '📚',
    /** Overlay panel header (emoji + title). */
    PANEL_HEADER: '🧠 Knowledge',
    /** Sub-tab 1 (default). */
    TAB_TRAITS: 'Traits & Stats',
    /** Sub-tab 2. */
    TAB_CRAFTING: 'Crafting & Items',
    /** Sub-tab 3. */
    TAB_ITEMS: 'Items',
    /** Sub-tab 4. */
    TAB_MATERIALS: 'Materials',
    /** Sub-tab 5 — the action definitions and their stat gates. */
    TAB_ACTIONS: 'Actions',
    /** Global search bar label (filters all five sections at once). */
    SEARCH_LABEL: 'Search',
    /** Global search placeholder — what it walks, stated where it is typed. */
    SEARCH_PLACEHOLDER: 'name, description, stat, material, raw field',
    /** Clear button (both bars share the title). */
    SEARCH_CLEAR: 'Clear the search',
    /** Sub-bar label: the second term, scoped to the tab on screen. */
    REFINE_LABEL: 'In this tab',
    /** Sub-bar placeholder. */
    REFINE_PLACEHOLDER: 'refine the result here',
    /** Nothing in this section matches — the search's empty state, distinct
     * from the data's own empty state, which the renderers keep. */
    NO_MATCH: 'No entry matches this search',
    /** Count unit for the status lines. */
    MATCHES_ONE: 'match',
    /** Count unit (plural) for the status lines. */
    MATCHES_MANY: 'matches',
    /** Error state message (all failure classes). */
    ERROR_MESSAGE: 'Could not load the knowledge reference',
    /** Error state action button. */
    ERROR_RETRY: 'Retry',
    /** Traits section empty state (mappings array empty). */
    EMPTY_TRAITS: 'No trait mappings defined',
    /** Recipes section empty state. */
    EMPTY_RECIPE: 'No recipes defined',
    /** Items section empty state. */
    EMPTY_ITEMS: 'No items defined',
    /** Materials section empty state. */
    EMPTY_MATERIALS: 'No materials defined',
    /** Actions section empty state. */
    EMPTY_ACTIONS: 'No actions defined',
    /**
     * Definition tab empty state: the kind is a real registry, this server simply
     * has nothing in it (a mod removed the entries, a world has no props yet).
     */
    EMPTY_DEFINITION: 'Nothing defined in this registry',
};

/** Section block titles (wiki/subMDs/frontend/knowledge_viewer.md block names). */
const BLOCK_TITLES = {
    TRAIT_MOLDS: 'Global trait molds',
    MAPPINGS: 'Property to stat mappings',
    MATERIALS: 'Materials',
    VOCABULARY: 'Shared vocabulary',
};

/**
 * Action card labels. The requirement VALUES are the data's (trait, stat,
 * minValue); only these words are UI text.
 */
const ACTION_UI_LABELS = {
    REQUIRES: 'Requires',
    UNIVERSAL: 'no requirements — any component that exists can perform it',
    HOW: 'How',
    NARRATES: 'narrates as',
    ON_SUCCESS: 'On success',
    IF_FAILS: 'If it fails',
    RAW: 'Raw definition (every field)',
    // Tooltip on a red targeting cell: the data declared a targeting type this
    // viewer has no reading for, so the raw value is shown instead of a phrase.
    UNDECLARED_TARGETING: 'targeting type outside the known vocabulary - shown as declared',
};

/** The "at least" glyph between a required stat and its threshold. */
const REQ_AT_LEAST = '&ge;';

/** Shared-vocabulary block labels (wiki/subMDs/frontend/knowledge_viewer.md). */
const VOCAB_LABELS = {
    PINNED_TRAIT_GROUPS: 'Pinned trait groups',
    PINNED_STATS: 'Pinned stats',
    EXISTENCE: 'Existence',
    EXISTENCE_GONE_AT: 'broken at',
    EXISTENCE_USABLE_MIN: 'usable minimum',
    PINNED_SUBSET_NOTE: 'Pinned subset frozen by the shared module; not an exhaustive list of the data.',
};

/** Item volume line labels (wiki/subMDs/frontend/knowledge_viewer.md). */
const VOLUME_LABELS = {
    VOLUME: 'volume',
    EXTERNAL: 'external volume',
};

/** Field labels for the material cards (wiki/subMDs/frontend/knowledge_viewer.md). */
const FIELD_LABELS = {
    DENSITY: 'density',
    VISUAL: 'visual',
};

/**
 * Item capability row labels. The capability VALUES are server-derived (the
 * codex computes them from the action registry, the holdingCost equip list and
 * the item's matter — see KnowledgeController); only these words are UI text.
 */
const CAPABILITY_UI_LABELS = {
    TITLE: 'Capabilities',
    EQUIPABLE: 'Equipable',
    NOT_EQUIPABLE: 'Not equipable',
    CAPACITY: 'Capacity',
    OCCUPIES: 'occupies',
};

// =============================================================================
// Section identity + payload contract
// =============================================================================

/**
 * The six sub-tab section ids. Tab buttons carry these in their
 * `data-section` attribute; lookups compare against these constants
 * (dataset comparison, never selector interpolation). MATERIALS has no
 * top-level payload section of its own — it renders the materials block of
 * the `traitStats` section, so a material cross-link can jump straight to the
 * dedicated Materials tab.
 */
export const SECTION_IDS = {
    TRAITS: 'traitStats',
    RECIPES: 'recipes',
    ITEMS: 'items',
    MATERIALS: 'materials',
    ACTIONS: 'actions',
};

/**
 * The default (initial) active section: the traits section — the first tab
 * (wiki/subMDs/frontend/knowledge_viewer.md).
 */
export const DEFAULT_SECTION = SECTION_IDS.TRAITS;

/**
 * The total empty-shape payload (wiki/subMDs/frontend/knowledge_viewer.md invariant 1,
 * client side): the shape a malformed envelope falls back to, and the
 * fallback vocabulary the server assembles from the same shared constants.
 * Never mutated by the panel (shapers always return fresh structures).
 */
export const EMPTY_KNOWLEDGE = {
    traitStats: {
        groups: {},
        mappings: [],
        materials: [],
        vocabulary: {
            traitGroups: Object.values(TRAIT_GROUPS),
            stats: Object.values(STAT_NAMES),
            existence: {
                goneAt: EXISTENCE_GONE_AT,
                usableMin: EXISTENCE_USABLE_MIN,
            },
        },
    },
    recipes: [],
    items: [],
    actions: [],
    definitions: [],
    // No families known before the payload arrives — the client holds no family
    // table of its own (the grouping is the server's authority, Sec. 12).
    definitionGroups: [],
};

// =============================================================================
// Pure helpers (named exports — unit-tested without a DOM)
// =============================================================================

/**
 * Locale-independent, deterministic string comparator (code-unit order).
 * The server sorts the payload; the client re-sorts as a defensive second
 * line so output is deterministic regardless of the runtime locale.
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
 * Unwraps the GET /knowledge response envelope (wiki/subMDs/frontend/knowledge_viewer.md):
 * a 200 body is `{ knowledge: <payload> }`; a bare object without that key,
 * an array, null, or any non-object body is NOT a valid envelope and yields
 * the fallback (default: EMPTY_KNOWLEDGE, the total empty shape).
 *
 * The panel itself calls this with an explicit `null` fallback so a
 * malformed envelope can be distinguished from a well-shaped (possibly
 * empty) payload and routed to the error state — the server guarantees the
 * payload is well-shaped even when a data file is missing (degraded but
 * renderable: per-section empty states, not an error).
 *
 * @param {*} body - Parsed JSON response body.
 * @param {Object|null} [fallback=EMPTY_KNOWLEDGE] - What to return for a
 *   malformed envelope; `null` means "report malformed" (used by the panel).
 * @returns {Object|null} The unwrapped payload, or the fallback.
 */
export function unwrapKnowledgeEnvelope(body, fallback = EMPTY_KNOWLEDGE) {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
        const inner = body.knowledge;
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
            return inner;
        }
    }
    return fallback;
}

/**
 * HTML-escapes a value for interpolation into innerHTML
 * (wiki/subMDs/frontend/knowledge_viewer.md: escapeHtml-only rendering). Local helper —
 * the same five-character behavior as the CraftingPanel's private helper,
 * extended with backtick and equals-sign for completeness (helpers are per
 * module; no cross-panel imports).
 * @param {*} value - The server-sourced value to escape (stringified).
 * @returns {string}
 */
export function escapeHtml(value) {
    // Replacements are built by concatenation so the source text never
    // contains a raw entity (tooling that HTML-decodes file content would
    // otherwise corrupt the replacement strings). Same behavior as the
    // CraftingPanel's private helper (helpers are per module).
    return String(value)
        .replace(/&/g, '&' + 'amp;')
        .replace(/</g, '&' + 'lt;')
        .replace(/>/g, '&' + 'gt;')
        .replace(/"/g, '&' + 'quot;')
        .replace(/'/g, '&' + '#39;')
        .replace(/`/g, '&' + '#96;')
        .replace(/=/g, '&' + '#61;');
}

/**
 * Data listing (the item card's full-field block, and the material card's
 * visual block): render an object's fields as nested, indented key: value
 * rows. Pure string builders (no DOM), every server-sourced string escaped
 * through escapeHtml, every structure guarded.
 */

export function renderDefinitionListing(definition, materialNames) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
        return '';
    }
    const names = materialNames && typeof materialNames === 'object' ? materialNames : {};
    return Object.entries(definition)
        .filter(([key]) => !key.startsWith('_') && key !== 'name' && key !== 'description')
        .map(([key, value]) => renderDataKey(key, value, 1, names))
        .join('');
}

/**
 * One key row: the label, then either an inline scalar or a dedicated
 * indented sub-block for objects/arrays. The `materials` field renders each
 * entry as a clickable Materials-tab link (see renderMaterialRef).
 * @private
 */
function renderDataKey(key, value, depth, materialNames) {
    const pad = indentFor(depth);
    const open = `<div class="knowledge-data-row" style="padding-left:${pad}px">` +
        `<span class="knowledge-data-key">${escapeHtml(key)}</span>` +
        `<span class="knowledge-data-sep">:</span>`;
    const close = '</div>';
    const scalar = (v) =>
        v === null ? 'null'
            : (typeof v === 'string' ? escapeHtml(v) : String(v));
    const sub = (content) =>
        `<div class="knowledge-data-sub" style="padding-left:${pad}px">${content}</div>`;

    if (key === 'materials' && Array.isArray(value) && value.length > 0) {
        const refs = value.map((m) => renderMaterialRef(m, depth + 1, materialNames)).join('');
        return open + close + sub(refs);
    }
    if (Array.isArray(value)) {
        if (value.length === 0) return open + `<span class="knowledge-data-value">[]</span>` + close;
        const elements = value.map((el) => renderArrayElement(el, depth + 1, materialNames)).join('');
        return open + close + sub(elements);
    }
    if (value !== null && typeof value === 'object') {
        if (Object.keys(value).length === 0) return open + `<span class="knowledge-data-value">{}</span>` + close;
        const children = Object.entries(value)
            .filter(([k]) => !k.startsWith('_'))
            .map(([k, v]) => renderDataKey(k, v, depth + 1, materialNames))
            .join('');
        return open + close + sub(children);
    }
    return open + `<span class="knowledge-data-value">${scalar(value)}</span>` + close;
}

/**
 * One array element row: an object element expands into nested key rows; a
 * scalar element renders inline.
 * @private
 */
function renderArrayElement(el, depth, materialNames) {
    const pad = indentFor(depth);
    if (el !== null && typeof el === 'object' && !Array.isArray(el)) {
        const children = Object.entries(el)
            .filter(([k]) => !k.startsWith('_'))
            .map(([k, v]) => renderDataKey(k, v, depth, materialNames))
            .join('');
        return `<div class="knowledge-data-sub" style="padding-left:${pad}px">${children}</div>`;
    }
    return `<div class="knowledge-data-row" style="padding-left:${pad}px"><span class="knowledge-data-value">${el === null ? 'null' : (typeof el === 'string' ? escapeHtml(el) : String(el))}</span></div>`;
}

/**
 * One entry of an item's `materials` composition: a known material renders as
 * a clickable Materials-tab cross-link (data-material = the raw type, the
 * scroll target; label = the registry display name); an unknown or malformed
 * reference stays plain text (the codex never fabricates a navigation target).
 * Plus the fraction, and (when present) its role.
 * @private
 */
function renderMaterialRef(m, depth, materialNames) {
    const pad = indentFor(depth);
    const type = (m && typeof m === 'object') ? m.material : null;
    const frac = (m && typeof m.fraction === 'number') ? ` ${escapeHtml(String(m.fraction))}` : '';
    const role = (m && typeof m.role === 'string' && m.role.length > 0)
        ? ` <span class="knowledge-data-role">${escapeHtml(m.role)}</span>`
        : '';
    const isKnownLink = type && typeof type === 'string' && materialNames[type] !== undefined;
    const labelHtml = isKnownLink
        ? `<button type="button" class="knowledge-material-link" data-material="${escapeHtml(type)}">${escapeHtml(materialNames[type])}</button>`
        : (type && typeof type === 'string') ? escapeHtml(type) : '';
    return `<div class="knowledge-data-row" style="padding-left:${pad}px">${labelHtml}${frac}${role}</div>`;
}

/**
 * Indent for a nesting depth (px, inline padding-left).
 * @private
 */
function indentFor(depth) {
    return `${depth * 14}px`;
}

/**
 * The item card's "Capabilities" block (wiki/subMDs/frontend/knowledge_viewer.md).
 * Everything here is server-derived and read as-is: the equip state, the
 * capacity/footprint pair (storing is the generic inventory rule, so capacity is
 * the item's volume and the footprint is what it occupies on its host — the pair
 * is what makes a T1 hold 10 while taking 1), the actions whose stat
 * requirements the item's base stats satisfy, and those base stats themselves
 * (the numbers the equip flow seeds from matter). Nothing is computed here. Each
 * action is a button carrying `data-action` with the raw action name: clicking it
 * jumps to the Actions tab and flashes that action's card — the same cross-link
 * convention the material links and the recipe refs use.
 * @param {*} capabilities - The shaped `capabilities` block (null -> '').
 * @returns {string} HTML block, or '' when there is nothing to show.
 */
export function renderItemCapabilities(capabilities) {
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
        return '';
    }
    const rows = [];

    // The equip state is a FLAG, not the first word of the field after it. As plain
    // text it shared a class with the capacity next to it and the row read as one
    // label - "Equipable Capacity 10". The modifier class is a whole literal inside
    // the interpolation, the shape the markup integrity pin reads.
    const equipable = capabilities.equipable === true;
    const flagModifier = equipable
        ? ' knowledge-capability-flag--equipable'
        : ' knowledge-capability-flag--not-equipable';
    let stateCell = `<span class="knowledge-capability-flag${flagModifier}">` +
        `${escapeHtml(equipable ? CAPABILITY_UI_LABELS.EQUIPABLE : CAPABILITY_UI_LABELS.NOT_EQUIPABLE)}</span>`;
    if (typeof capabilities.capacity === 'number') {
        // No class of its own on purpose: the row styles it, and a second unstyled
        // marker beside the flag would be exactly the mistaking flag it.
        stateCell += `<span>${escapeHtml(CAPABILITY_UI_LABELS.CAPACITY)} ${escapeHtml(String(capabilities.capacity))}</span>`;
        if (typeof capabilities.footprint === 'number' && capabilities.footprint !== capabilities.capacity) {
            stateCell += ` <span class="knowledge-capability-dim">(${escapeHtml(CAPABILITY_UI_LABELS.OCCUPIES)} ${escapeHtml(String(capabilities.footprint))})</span>`;
        }
    }
    rows.push(`<div class="knowledge-capability-row">${stateCell}</div>`);

    const actions = Array.isArray(capabilities.actions) ? capabilities.actions : [];
    if (actions.length > 0) {
        const chips = actions.map((action) => {
            const title = action && typeof action.description === 'string' && action.description.length > 0
                ? ` title="${escapeHtml(action.description)}"`
                : '';
            return `<button type="button" class="knowledge-capability-chip" data-action="${escapeHtml(action.name)}"${title}>` +
                `${escapeHtml(action.name)}</button>`;
        });
        rows.push(`<div class="knowledge-capability-row knowledge-capability-actions">${chips.join('')}</div>`);
    }

    const stats = capabilityStatCells(capabilities.baseStats);
    if (stats.length > 0) {
        rows.push(`<div class="knowledge-capability-row knowledge-capability-stats">${stats.join('')}</div>`);
    }

    return `<div class="knowledge-item-capabilities">` +
        `<span class="knowledge-item-capabilities-title">${escapeHtml(CAPABILITY_UI_LABELS.TITLE)}</span>` +
        rows.join('') +
        `</div>`;
}

/**
 * Derived base stats as `stat value` cells, sorted by "Group.stat". `volume` is
 * left out — the card already prints it on its own volume line — and the rest
 * are shown exactly as the server derived them.
 * @param {*} baseStats - Stats keyed by trait.
 * @returns {string[]} Escaped HTML cells.
 * @private
 */
function capabilityStatCells(baseStats) {
    if (!baseStats || typeof baseStats !== 'object' || Array.isArray(baseStats)) return [];
    const cells = [];
    for (const [trait, data] of Object.entries(baseStats)) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        for (const [stat, value] of Object.entries(data)) {
            if (typeof value !== 'number') continue;
            if (stat === 'volume') continue;
            cells.push({ key: `${trait}.${stat}`, text: `${escapeHtml(stat)} ${escapeHtml(String(value))}` });
        }
    }
    cells.sort((a, b) => compareStrings(a.key, b.key));
    return cells.map((cell) => `<span class="knowledge-capability-stat">${cell.text}</span>`);
}

/**
 * One action card of the Actions section, read as meaning first: the requirement
 * gate spelled out (`Physical.sharpness ≥ 20`, or the universal note when the
 * data declares no gate), how the action aims and is narrated, one line per
 * consequence and per failure consequence (the sentences are the SERVER's reading
 * of its own data — see src/controllers/knowledge/actionSemantics.js), and only
 * then the raw definition, collapsed, so every field is still exposed without
 * being the first thing the reader meets. The card carries `data-action` with the
 * raw action name, the same convention the item cards use for `data-item`, so a
 * capability chip can jump to it.
 * @param {*} action - A shaped action row (missing/malformed -> '').
 * @returns {string} HTML.
 */
export function renderActionCard(action) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return '';
    if (typeof action.name !== 'string' || action.name.length === 0) return '';
    const desc = typeof action.description === 'string' && action.description.length > 0
        ? `<div class="knowledge-card-desc">${escapeHtml(action.description)}</div>`
        : '';
    const reqs = Array.isArray(action.requirements) ? action.requirements : [];
    const cells = reqs.map((req) => renderRequirementCell(req)).join('');
    const gate = cells.length > 0
        ? cells
        : `<span class="knowledge-action-req knowledge-action-req--universal">${escapeHtml(ACTION_UI_LABELS.UNIVERSAL)}</span>`;
    const summary = action.summary && typeof action.summary === 'object' && !Array.isArray(action.summary)
        ? action.summary
        : {};
    const listing = renderDefinitionListing(action.definition, {});
    return `<div class="knowledge-action-card" data-action="${escapeHtml(action.name)}">` +
        `<div class="knowledge-card-name">${escapeHtml(action.name)}</div>` +
        desc +
        `<div class="knowledge-action-requirements">` +
        `<span class="knowledge-action-req-label">${escapeHtml(ACTION_UI_LABELS.REQUIRES)}</span>` +
        gate +
        `</div>` +
        renderActionHow(summary) +
        renderEffectList(summary.effects, ACTION_UI_LABELS.ON_SUCCESS, '') +
        renderEffectList(summary.failureEffects, ACTION_UI_LABELS.IF_FAILS, ' knowledge-action-effects--failure') +
        (listing
            ? `<details class="knowledge-action-raw"><summary>${escapeHtml(ACTION_UI_LABELS.RAW)}</summary>` +
              `<div class="knowledge-item-fields">${listing}</div></details>`
            : '') +
        `</div>`;
}

/**
 * The "how" line: how the action acquires its target, how far, and how the round
 * narration words it. Every piece is the server's reading of the action's own
 * fields; a piece the data does not declare is simply absent.
 * @param {Object} summary - The shaped action summary.
 * @returns {string} HTML block ('' when nothing is declared).
 * @private
 */
function renderActionHow(summary) {
    const cells = [];
    if (typeof summary.targeting === 'string' && summary.targeting.length > 0) {
        // Red = the world declares something the interpreter cannot read. Shown
        // raw, never paraphrased, never left out (the same rule as an unknown
        // consequence type).
        const undeclared = summary.targetingDeclared === false;
        cells.push('<span class="knowledge-action-how-cell'
            + `${undeclared ? ' knowledge-action-how-cell--undeclared' : ''}"`
            + `${undeclared ? ` title="${escapeHtml(ACTION_UI_LABELS.UNDECLARED_TARGETING)}"` : ''}>`
            + `${escapeHtml(summary.targeting)}</span>`);
    }
    if (typeof summary.range === 'number') {
        cells.push(`<span class="knowledge-action-how-cell">${escapeHtml(`within ${summary.range}`)}</span>`);
    }
    if (typeof summary.narration === 'string' && summary.narration.length > 0) {
        cells.push('<span class="knowledge-action-how-cell knowledge-action-narration">'
            + `${escapeHtml(ACTION_UI_LABELS.NARRATES)} “${escapeHtml(summary.narration)}”</span>`);
    }
    if (cells.length === 0) return '';
    return `<div class="knowledge-action-how">` +
        `<span class="knowledge-action-effects-label">${escapeHtml(ACTION_UI_LABELS.HOW)}</span>` +
        cells.join('') +
        `</div>`;
}

/**
 * One consequence block (success or failure): the server's sentence per
 * consequence, with the raw type beside it so the reader can still tie the line
 * back to the data. A consequence the interpreter does not know is shown marked
 * as undeclared rather than dressed up as something it is not.
 * @param {*} effects - Shaped effect rows.
 * @param {string} label - Block heading text.
 * @param {string} modifier - Extra class on the block ('' or a variant).
 * @returns {string} HTML block ('' when there are no rows).
 * @private
 */
function renderEffectList(effects, label, modifier) {
    const list = Array.isArray(effects) ? effects : [];
    const items = list.map((effect) => {
        if (!effect || typeof effect !== 'object' || Array.isArray(effect)) return '';
        const text = typeof effect.text === 'string' && effect.text.length > 0
            ? effect.text
            : (typeof effect.type === 'string' ? effect.type : '');
        if (!text) return '';
        const undeclared = effect.described === false ? ' knowledge-action-effect--undeclared' : '';
        const badge = typeof effect.type === 'string' && effect.type.length > 0
            ? `<span class="knowledge-action-effect-type">${escapeHtml(effect.type)}</span>`
            : '';
        // The party is a marker, not a word of the sentence: the server returns it
        // separately because no single preposition reads right across the types.
        const party = typeof effect.on === 'string' && effect.on.length > 0
            ? `<span class="knowledge-action-effect-on">\u2192 ${escapeHtml(effect.on)}</span>`
            : '';
        return `<li class="knowledge-action-effect${undeclared}">${badge}` +
            `<span class="knowledge-action-effect-text">${escapeHtml(text)}</span>${party}</li>`;
    }).join('');
    if (items === '') return '';
    return `<div class="knowledge-action-effects${modifier}">` +
        `<span class="knowledge-action-effects-label">${escapeHtml(label)}</span>` +
        `<ul class="knowledge-action-effect-list">${items}</ul>` +
        `</div>`;
}

/**
 * One requirement of one action as a cell: "Movement.move ≥ 5". A null trait or
 * stat renders the other half alone (the data is shown as declared, never
 * invented into a full key); a null threshold renders no comparison.
 * @param {*} req - A shaped requirement row.
 * @returns {string} HTML cell ('' when the row carries nothing to show).
 * @private
 */
function renderRequirementCell(req) {
    if (!req || typeof req !== 'object' || Array.isArray(req)) return '';
    const stat = typeof req.stat === 'string' ? req.stat : null;
    const trait = typeof req.trait === 'string' ? req.trait : null;
    const key = stat && trait ? `${trait}.${stat}` : (stat || trait);
    if (!key) return '';
    const threshold = typeof req.minValue === 'number'
        ? ` ${REQ_AT_LEAST} ${escapeHtml(String(req.minValue))}`
        : '';
    return `<span class="knowledge-action-req">${escapeHtml(key)}${threshold}</span>`;
}

/**
 * Shapers: normalize one server-fetched section into render-ready rows.
 * They are the defensive second line (the server already validates and
 * sorts): non-object entries are SKIPPED, non-array lists collapse to [],
 * missing optionals fall back to their spec nullability, and output is
 * re-sorted for determinism. They never throw on malformed input.
 */

/**
 * Property-to-stat mapping rows (wiki/subMDs/frontend/knowledge_viewer.md MappingRow):
 * `{ statKey, trait, stat, formula: string|null, sources: [{property, weight}] }`,
 * sorted by statKey; `sources` sorted by property.
 * @param {*} raw - Raw `traitStats.mappings` (array or anything malformed).
 * @returns {Array<Object>}
 */
export function shapeMappings(raw) {
    if (!Array.isArray(raw)) return [];
    const rows = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const statKey = typeof entry.statKey === 'string' && entry.statKey.length > 0
            ? entry.statKey
            : null;
        if (!statKey) continue; // the flat key is the row's identity
        const dotIndex = statKey.indexOf('.');
        const formula = typeof entry.formula === 'string' && entry.formula.length > 0
            ? entry.formula
            : null;
        rows.push({
            statKey,
            trait: dotIndex > 0 ? statKey.slice(0, dotIndex) : '',
            stat: dotIndex > 0 ? statKey.slice(dotIndex + 1) : '',
            formula,
            // Contract exclusivity: exactly one of formula /
            // sources is populated. A formula wins (renderer precedence); the
            // other side collapses to its empty default.
            sources: formula !== null ? [] : shapeSources(entry.sources),
        });
    }
    rows.sort((a, b) => compareStrings(a.statKey, b.statKey));
    return rows;
}

/**
 * Normalizes a mapping row's `sources` list to property-sorted
 * `{ property, weight }` entries (malformed entries skipped, non-numeric
 * weights fall back to 0).
 * @param {*} raw
 * @returns {Array<{property: string, weight: number}>}
 * @private
 */
function shapeSources(raw) {
    if (!Array.isArray(raw)) return [];
    const sources = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        if (typeof entry.property !== 'string' || entry.property.length === 0) continue;
        sources.push({
            property: entry.property,
            weight: typeof entry.weight === 'number' ? entry.weight : FALLBACK_NUMBER,
        });
    }
    sources.sort((a, b) => compareStrings(a.property, b.property));
    return sources;
}

/**
 * Per-material property rows (wiki/subMDs/frontend/knowledge_viewer.md MaterialRow):
 * `{ type, name, density, properties, visual }` sorted by type; `name` falls back to
 * the type key, `density` to 0, and `properties` to a filtered numeric map.
 * @param {*} raw - Raw `traitStats.materials`.
 * @returns {Array<Object>}
 */
export function shapeMaterials(raw) {
    if (!Array.isArray(raw)) return [];
    const rows = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const type = typeof entry.type === 'string' && entry.type.length > 0
            ? entry.type
            : null;
        if (!type) continue;
        rows.push({
            type,
            name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : type,
            density: typeof entry.density === 'number' ? entry.density : FALLBACK_NUMBER,
            properties: shapePropertyMap(entry.properties),
            visual: entry.visual !== undefined ? entry.visual : null,
        });
    }
    rows.sort((a, b) => compareStrings(a.type, b.type));
    return rows;
}

/**
 * Filters a property map down to string-keyed / numeric-valued entries.
 * @param {*} raw
 * @returns {Object<string, number>}
 * @private
 */
function shapePropertyMap(raw) {
    const out = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [key, value] of Object.entries(raw)) {
            if (typeof value === 'number') out[key] = value;
        }
    }
    return out;
}

/**
 * The cross-layer pinned vocabulary block (wiki/subMDs/frontend/knowledge_viewer.md
 * Vocabulary): `{ traitGroups: string[], stats: string[], existence: { goneAt, usableMin } }`.
 * Falls back to the shared-module constants when any part is malformed —
 * the client never invents names the server did not send.
 * @param {*} raw - Raw `traitStats.vocabulary`.
 * @returns {{traitGroups: string[], stats: string[], existence: {goneAt: number, usableMin: number}}}
 */
export function shapeVocabulary(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {
            traitGroups: [],
            stats: [],
            existence: {
                goneAt: EXISTENCE_GONE_AT,
                usableMin: EXISTENCE_USABLE_MIN,
            },
        };
    }
    const existence = raw.existence;
    return {
        traitGroups: toNonEmptyStringArray(raw.traitGroups),
        stats: toNonEmptyStringArray(raw.stats),
        existence: {
            goneAt: existence && typeof existence.goneAt === 'number'
                ? existence.goneAt
                : EXISTENCE_GONE_AT,
            usableMin: existence && typeof existence.usableMin === 'number'
                ? existence.usableMin
                : EXISTENCE_USABLE_MIN,
        },
    };
}

/**
 * Filters an array down to non-empty string entries (malformed entries
 * skipped) — used for the vocabulary name lists.
 * @param {*} raw
 * @returns {string[]}
 * @private
 */
function toNonEmptyStringArray(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((v) => typeof v === 'string' && v.length > 0);
}

/**
 * Recipe rows (wiki/subMDs/frontend/knowledge_viewer.md): `{ id, name, description,
 * inputs, outputs }` sorted by id. `description` falls back to null;
 * item-ref names fall back to the raw `type` string (the defensive
 * fallback of the label contract — never a raw ID-shaped label).
 * @param {*} raw - Raw `recipes`.
 * @returns {Array<Object>}
 */
export function shapeRecipes(raw) {
    if (!Array.isArray(raw)) return [];
    const rows = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const id = typeof entry.id === 'string' && entry.id.length > 0
            ? entry.id
            : null;
        if (!id) continue;
        rows.push({
            id,
            name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
            description: typeof entry.description === 'string' && entry.description.length > 0
                ? entry.description
                : null,
            inputs: shapeRecipeItemRefs(entry.inputs),
            outputs: shapeRecipeItemRefs(entry.outputs),
        });
    }
    rows.sort((a, b) => compareStrings(a.id, b.id));
    return rows;
}

/**
 * Normalizes one recipe's input/output list to `{ type, quantity, name }`
 * refs (order preserved as in the data file; malformed refs skipped).
 * @param {*} raw
 * @returns {Array<{type: string, quantity: number, name: string}>}
 * @private
 */
function shapeRecipeItemRefs(raw) {
    if (!Array.isArray(raw)) return [];
    const refs = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const type = typeof entry.type === 'string' && entry.type.length > 0
            ? entry.type
            : null;
        if (!type) continue;
        refs.push({
            type,
            quantity: Number.isInteger(entry.quantity) && entry.quantity >= MIN_QUANTITY
                ? entry.quantity
                : MIN_QUANTITY,
            name: typeof entry.name === 'string' && entry.name.length > 0
                ? entry.name
                : type,
        });
    }
    return refs;
}

/**
 * One recipe input/output list: each ref is a chip ("qty × name") whose
 * item name is a clickable button into the Items tab
 * (.knowledge-recipe-ref, data-item = the raw item type — the scroll/highlight
 * target), mirroring the material cross-link (renderMaterialRef). Refs are the
 * shaped shapeRecipeItemRefs rows. All strings pass through escapeHtml.
 * @param {Array<Object>} refs - Shaped refs ({ type, quantity, name }).
 * @returns {string} HTML.
 */
export function renderRecipeRefs(refs) {
    if (!Array.isArray(refs)) return '';
    const chips = refs
        .map((ref) => {
            const type = (ref && typeof ref.type === 'string') ? ref.type : '';
            if (!type) return '';
            const name = (ref && typeof ref.name === 'string' && ref.name.length > 0)
                ? ref.name
                : type;
            const qty = (ref && typeof ref.quantity === 'number') ? ref.quantity : MIN_QUANTITY;
            return `<span class="knowledge-ref-item">${escapeHtml(String(qty))} ${MULTIPLICATION_SIGN} ` +
                `<button type="button" class="knowledge-recipe-ref" data-item="${escapeHtml(type)}">` +
                `${escapeHtml(name)}</button></span>`;
        });
    return chips.filter((chip) => chip).join(' ');
}

/**
 * Item rows (wiki/subMDs/frontend/knowledge_viewer.md): `{ type, name, description,
 * volume, externalVolume, materials, traits, definition }` sorted by type, with the
 * spec nullability rules: `description` -> null, `volume` ->
 * DEFAULT_ITEM_VOLUME, `externalVolume` -> null, `materials` -> null when
 * absent (else normalized rows with `role` -> null), `traits` -> {} (the
 * declared/blueprint-override layer, not merged runtime values).
 * @param {*} raw - Raw `items`.
 * @returns {Array<Object>}
 */
export function shapeItems(raw) {
    if (!Array.isArray(raw)) return [];
    const rows = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const type = typeof entry.type === 'string' && entry.type.length > 0
            ? entry.type
            : null;
        if (!type) continue;
        rows.push({
            type,
            name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : type,
            description: typeof entry.description === 'string' && entry.description.length > 0
                ? entry.description
                : null,
            volume: typeof entry.volume === 'number' ? entry.volume : DEFAULT_ITEM_VOLUME,
            externalVolume: typeof entry.externalVolume === 'number'
                ? entry.externalVolume
                : null,
            materials: shapeItemMaterials(entry.materials),
            traits: shapeTraitMap(entry.traits),
            capabilities: shapeItemCapabilities(entry.capabilities),
            definition: entry.definition && typeof entry.definition === 'object'
                && !Array.isArray(entry.definition) ? entry.definition : null,
        });
    }
    rows.sort((a, b) => compareStrings(a.type, b.type));
    return rows;
}

/**
 * Normalizes the Actions section: rows keyed by a non-empty `name` (rows without
 * one are skipped), description null when absent, requirements normalized to
 * `{ trait, stat, minValue }` (null per missing field), definition passed
 * through as the raw block (null when the server omits it). Re-sorted by name as
 * the defensive second line on the server's sort order.
 * @param {*} raw
 * @returns {Array<{name: string, description: string|null, requirements: Array<Object>, definition: Object|null}>}
 */
export function shapeActions(raw) {
    if (!Array.isArray(raw)) return [];
    const rows = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        if (typeof entry.name !== 'string' || entry.name.length === 0) continue;
        rows.push({
            name: entry.name,
            description: typeof entry.description === 'string' && entry.description.length > 0
                ? entry.description
                : null,
            requirements: shapeActionRequirements(entry.requirements),
            summary: shapeActionSummary(entry.summary),
            definition: entry.definition && typeof entry.definition === 'object'
                && !Array.isArray(entry.definition) ? entry.definition : null,
        });
    }
    rows.sort((a, b) => compareStrings(a.name, b.name));
    return rows;
}

/**
 * Normalizes the server's reading of one action (targeting / range / narration /
 * the consequence sentences). Absent or malformed yields the empty summary — the
 * card then shows only what it can still show (name, gate, raw listing).
 * @param {*} raw
 * @returns {Object}
 * @private
 */
function shapeActionSummary(raw) {
    const empty = { targeting: null, targetingDeclared: true, range: null, narration: null, effects: [], failureEffects: [] };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
    return {
        targeting: typeof raw.targeting === 'string' && raw.targeting.length > 0 ? raw.targeting : null,
        // A payload without the flag is an older reading, not an undeclared one.
        targetingDeclared: raw.targetingDeclared !== false,
        range: typeof raw.range === 'number' ? raw.range : null,
        narration: typeof raw.narration === 'string' && raw.narration.length > 0 ? raw.narration : null,
        effects: shapeEffectRows(raw.effects),
        failureEffects: shapeEffectRows(raw.failureEffects),
    };
}

/**
 * Normalizes effect rows: an entry without a type or without a sentence is
 * dropped (the raw listing below still shows it — nothing is hidden, only
 * unrenderable rows are skipped).
 * @param {*} raw
 * @returns {Array<{type: string, on: string|null, text: string, described: boolean}>}
 * @private
 */
function shapeEffectRows(raw) {
    if (!Array.isArray(raw)) return [];
    const rows = [];
    for (const effect of raw) {
        if (!effect || typeof effect !== 'object' || Array.isArray(effect)) continue;
        if (typeof effect.type !== 'string' || effect.type.length === 0) continue;
        if (typeof effect.text !== 'string' || effect.text.length === 0) continue;
        rows.push({
            type: effect.type,
            on: typeof effect.on === 'string' ? effect.on : null,
            text: effect.text,
            described: effect.described !== false,
        });
    }
    return rows;
}

/**
 * Normalizes one action's requirement gate; a non-array yields [] (an absent gate
 * is a universal action, not a malformed one).
 * @param {*} raw
 * @returns {Array<{trait: string|null, stat: string|null, minValue: number|null}>}
 * @private
 */
function shapeActionRequirements(raw) {
    if (!Array.isArray(raw)) return [];
    const rows = [];
    for (const req of raw) {
        if (!req || typeof req !== 'object' || Array.isArray(req)) continue;
        rows.push({
            trait: typeof req.trait === 'string' ? req.trait : null,
            stat: typeof req.stat === 'string' ? req.stat : null,
            minValue: typeof req.minValue === 'number' ? req.minValue : null,
        });
    }
    return rows;
}

/**
 * Normalizes the server-derived capability block. Absent or malformed -> null
 * (the card then shows no capability row at all - never an empty shell). Action
 * rows keep `name` + optional `description`; base stats keep numeric leaves only.
 * @param {*} raw
 * @returns {Object|null}
 * @private
 */
function shapeItemCapabilities(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const actions = Array.isArray(raw.actions)
        ? raw.actions
            .filter((action) => action && typeof action === 'object' && typeof action.name === 'string' && action.name.length > 0)
            .map((action) => ({
                name: action.name,
                description: typeof action.description === 'string' && action.description.length > 0
                    ? action.description
                    : null,
            }))
            .sort((a, b) => compareStrings(a.name, b.name))
        : [];
    const baseStats = {};
    if (raw.baseStats && typeof raw.baseStats === 'object' && !Array.isArray(raw.baseStats)) {
        for (const [trait, data] of Object.entries(raw.baseStats)) {
            if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
            const numeric = {};
            for (const [stat, value] of Object.entries(data)) {
                if (typeof value === 'number') numeric[stat] = value;
            }
            if (Object.keys(numeric).length > 0) baseStats[trait] = numeric;
        }
    }
    return {
        equipable: raw.equipable === true,
        capacity: typeof raw.capacity === 'number' ? raw.capacity : null,
        footprint: typeof raw.footprint === 'number' ? raw.footprint : null,
        baseStats,
        actions,
    };
}

/**
 * Normalizes an item's material composition to `{ material, fraction, role }`
 * rows (`role` -> null when absent); returns null when the item has no
 * composition at all (no derived layer).
 * @param {*} raw
 * @returns {Array<{material: string, fraction: number, role: string|null}>|null}
 * @private
 */
function shapeItemMaterials(raw) {
    if (!Array.isArray(raw)) return null;
    const mats = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        if (typeof entry.material !== 'string' || entry.material.length === 0) continue;
        mats.push({
            material: entry.material,
            fraction: typeof entry.fraction === 'number' ? entry.fraction : FALLBACK_NUMBER,
            role: typeof entry.role === 'string' && entry.role.length > 0 ? entry.role : null,
        });
    }
    return mats;
}

/**
 * Normalizes an item's declared trait map `{ group: { stat: number } }`,
 * keeping only non-empty string keys and numeric values ({} when absent —
 * never merged runtime values).
 * @param {*} raw
 * @returns {Object<string, Object<string, number>>}
 * @private
 */
function shapeTraitMap(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [group, stats] of Object.entries(raw)) {
        if (typeof group !== 'string' || group.length === 0) continue;
        if (!stats || typeof stats !== 'object' || Array.isArray(stats)) continue;
        const shaped = {};
        for (const [stat, value] of Object.entries(stats)) {
            if (typeof stat !== 'string' || stat.length === 0) continue;
            if (typeof value === 'number') shaped[stat] = value;
        }
        if (Object.keys(shaped).length > 0) out[group] = shaped;
    }
    return out;
}

// =============================================================================
// Panel class (DOM wiring)
// =============================================================================

/**
 * The Knowledge overlay panel. Registered with the OverlayManager as
 * `overlayManager.register('knowledge', panel, 'btn-knowledge')`.
 */
/**
 * The body of a raw definition block, whatever shape the author used. The
 * definition rows carry an entry VERBATIM, and the registries use every shape the
 * data format allows: a keyed object (`components`), an array of child ids
 * (`blueprints`), an array of wear claims (`outfits`), or a bare number
 * (`sensitiveParts`). `renderDefinitionListing` walks an object and returns
 * nothing for the rest, so the two other shapes get their own body here — the
 * reference never drops an entry because its shape is unusual.
 * @param {*} definition - The row's raw definition (object, array or scalar).
 * @returns {string} HTML (empty string when there is nothing to list).
 * @public
 */
export function renderDefinitionBody(definition) {
    if (definition === null || definition === undefined) return '';
    if (Array.isArray(definition)) {
        return definition.map((element) => renderArrayElement(element, 1)).join('');
    }
    if (typeof definition === 'object') {
        return renderDefinitionListing(definition);
    }
    return `<div class="knowledge-data-row knowledge-entity-value">` +
        `<span class="knowledge-data-value">${escapeHtml(String(definition))}</span></div>`;
}

/**
 * The label of a kind tab. A registry kind is a machine identifier
 * (`materialDamageTypes`); the label is its own words, pluralized — not a
 * hand-written table, so a kind a mod adds appears with a readable tab and
 * nothing is ever hidden for want of a label. `npcs` is the one acronym the
 * camelCase split cannot get right, so it is spelled out.
 * @param {string} kind - The raw registry kind (the payload's word for it).
 * @returns {string} The tab label.
 * @public
 */
export function kindGroupLabel(kind) {
    // The one exception, and it is a fact about the data rather than about words:
    // the `world` registry holds the world's own settings (one entry, id `world`,
    // a name and a tick rate). The plural the rule below forms — "Worlds" — names
    // a thing this server has exactly one of.
    if (kind === REGISTRY_KINDS.WORLD) return 'World';
    const words = String(kind ?? '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(' ')
        .filter((word) => word.length > 0);
    if (words.length === 0) return String(kind ?? '');
    words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
    if (words[0] === 'Npcs') words[0] = 'NPCs';
    if (words[0] === 'Npc') words[0] = 'NPC';
    const last = words.length - 1;
    words[last] = pluralizeKind(words[last]);
    return words.join(' ');
}

/**
 * One word's plural, by ending. A word already ending in "s" is left as the
 * author wrote it (`worldRules` is plural in the data, and adding another "es"
 * would be a word the data never used).
 * @param {string} word
 * @returns {string}
 * @private
 */
function pluralizeKind(word) {
    if (word.length === 0) return word;
    if (/s$/.test(word)) return word;
    if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
    if (/(x|ch|sh|z)$/.test(word)) return `${word}es`;
    return `${word}s`;
}

/**
 * Read the `definitions` array of the payload (the definition rows). Tolerant of
 * anything the wire is not: a non-array becomes [], a row that is not an object
 * or carries no `kind`/`id` is skipped rather than guessed at (a row this reader
 * cannot name is a row it must not render).
 * @param {*} raw - The raw `definitions` section.
 * @returns {Array<{kind: string, id: string, name: string|null,
 *   description: string|null,
 *   facets: Array<{label: string, value: string, parts: Array<Object>|null}>,
 *   definition: *}>} Rows in payload order (the server sorts them).
 * @public
 */
export function shapeDefinitions(raw) {
    if (!Array.isArray(raw)) return [];
    const rows = [];
    for (const row of raw) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        if (typeof row.kind !== 'string' || row.kind.length === 0) continue;
        if (typeof row.id !== 'string' || row.id.length === 0) continue;
        rows.push({
            kind: row.kind,
            id: row.id,
            name: typeof row.name === 'string' && row.name.length > 0 ? row.name : null,
            description: typeof row.description === 'string' && row.description.length > 0
                ? row.description
                : null,
            facets: shapeEntityFacets(row.facets),
            // NOT `|| null`: a defined scalar (0, '') is the entry, not an absent one.
            definition: row.definition === undefined ? null : row.definition,
        });
    }
    return rows;
}

/**
 * The facet pairs of one definition row: a label, the sentence to print, and the
 * `parts` that sentence is built from when any of its names points at another
 * registry. The reading itself is server-side (`definitionSemantics.js`); this
 * reader only keeps what it can print.
 * @param {*} raw - The row's raw `facets` array.
 * @returns {Array<{label: string, value: string, parts: Array<Object>|null}>}
 * @private
 */
function shapeEntityFacets(raw) {
    if (!Array.isArray(raw)) return [];
    const facets = [];
    for (const facet of raw) {
        if (!facet || typeof facet !== 'object' || Array.isArray(facet)) continue;
        if (typeof facet.label !== 'string' || facet.label.length === 0) continue;
        if (typeof facet.value !== 'string' || facet.value.length === 0) continue;
        facets.push({ label: facet.label, value: facet.value, parts: facetPartsOf(facet.parts) });
    }
    return facets;
}

/**
 * The parts of one facet sentence, or null when the facet carries none (an older
 * or degraded payload still renders as plain text). A part is kept only if it has
 * text; a target is kept only if it names BOTH a kind and an id — half a target
 * is not a destination, and renders as text.
 *
 * A target part adds the kind word to the row's searchable text (the search
 * serialises the whole row, `KnowledgeSearch.searchTextOf`) — the same rule the
 * collapsed raw appendix has always followed.
 * @param {*} raw - The facet's raw `parts` array.
 * @returns {Array<{text: string, kind?: string, id?: string}>|null}
 * @private
 */
function facetPartsOf(raw) {
    if (!Array.isArray(raw)) return null;
    const parts = [];
    for (const part of raw) {
        if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
        if (typeof part.text !== 'string' || part.text.length === 0) continue;
        const kind = typeof part.kind === 'string' && part.kind.length > 0 ? part.kind : null;
        const id = typeof part.id === 'string' && part.id.length > 0 ? part.id : null;
        parts.push(kind !== null && id !== null ? { text: part.text, kind, id } : { text: part.text });
    }
    return parts.length > 0 ? parts : null;
}

/**
 * The codex views that OWN a registry kind — the kinds rendered on a tab of their
 * own rather than on a `def:<kind>` tab. It is the mirror of the server's
 * `CODEX_TAB_OWNED_KINDS`, which names the same kinds to EXCLUDE them from the
 * definition tabs (`definitionSemantics.js`); `test/unit/KnowledgePanel.test.js`
 * pins the two against each other, so a kind cannot be excluded by the server and
 * left without a destination here. Every value is a `SECTION_IDS` value of the
 * codex view set (`KnowledgeSearch.test.js` keeps those section ids searchable).
 */
export const VIEW_TAB_OF_REFERENCE_KIND = Object.freeze({
    [REGISTRY_KINDS.MATERIALS]: SECTION_IDS.MATERIALS,
    [REGISTRY_KINDS.INVENTORY_ITEMS]: SECTION_IDS.ITEMS,
    [REGISTRY_KINDS.CRAFTING]: SECTION_IDS.RECIPES,
    [REGISTRY_KINDS.ACTIONS]: SECTION_IDS.ACTIONS,
    [REGISTRY_KINDS.TRAITS]: SECTION_IDS.TRAITS,
    [REGISTRY_KINDS.PROPERTY_TRAIT_MAPPING]: SECTION_IDS.TRAITS,
});

/**
 * Which tab the entries of a referenced registry kind are rendered on: the codex
 * view that owns it, or that kind's own definition tab — but only when the
 * payload actually has that tab. Returning null is an honest answer (no tab, no
 * jump), and it is what keeps a facet link from switching the reader to a screen
 * with nothing on it.
 * @param {Object|null} payload - The unwrapped knowledge payload.
 * @param {string} kind - The registry kind a facet part points at.
 * @returns {string|null} A tab id (`SECTION_IDS` value or `def:<kind>`).
 * @public
 */
export function referenceTabIdOf(payload, kind) {
    if (typeof kind !== 'string' || kind.length === 0 || !payload || typeof payload !== 'object') {
        return null;
    }
    const view = Object.hasOwn(VIEW_TAB_OF_REFERENCE_KIND, kind)
        ? VIEW_TAB_OF_REFERENCE_KIND[kind]
        : null;
    if (view !== null) return view;
    const tabId = `${DEFINITION_TAB_PREFIX}${kind}`;
    return definitionTabsOf(payload).some((tab) => tab.id === tabId) ? tabId : null;
}

/**
 * The value cell of one facet: its parts rendered in order — plain text, and each
 * named target as a button carrying the target's kind and id
 * (`.knowledge-facet-link`, `data-ref-kind` / `data-ref-id`). With no parts the
 * cell is the facet's plain text, exactly as a link-free reader would print it.
 * @param {{value: string, parts?: Array<{text: string, kind?: string, id?: string}>}} facet
 * @returns {string} HTML (everything escaped, including the plain text).
 * @public
 */
export function renderFacetValue(facet) {
    if (!facet || typeof facet !== 'object') return '';
    if (!Array.isArray(facet.parts)) return escapeHtml(String(facet.value ?? ''));
    const cells = facet.parts.map((part) => {
        const text = escapeHtml(String(part && typeof part.text === 'string' ? part.text : ''));
        const kind = part && typeof part.kind === 'string' ? part.kind : null;
        const id = part && typeof part.id === 'string' ? part.id : null;
        if (text === '' || kind === null || id === null || kind === '' || id === '') return text;
        return `<button type="button" class="knowledge-facet-link" ` +
            `data-ref-kind="${escapeHtml(kind)}" data-ref-id="${escapeHtml(id)}">${text}</button>`;
    });
    return cells.join('');
}

export class KnowledgePanel {
    /**
     * Creates the panel. No DOM access in the constructor (constructible in
     * node-environment tests); call init() once before show().
     */
    constructor() {
        /** @private {HTMLElement|null} */
        this._overlay = null;
        /** @private {HTMLElement|null} */
        this._content = null;
        /** @private {boolean} */
        this._initialized = false;
        /** @private {string} Active sub-tab section id (default: traits). */
        this._activeSection = DEFAULT_SECTION;
        /** @private {string} Global search term (all five sections). */
        this._query = '';
        /** @private {string} Refine term — narrows the ACTIVE section only. */
        this._refine = '';
        /**
         * @private {'query'|'refine'|null} Which search input held focus before
         * the re-render this keystroke caused. Every render replaces the DOM, so
         * focus and caret are restored by role, not by node reference.
         */
        this._focusRole = null;
        /** @private {number} Caret offset to restore with the focused input. */
        this._caret = 0;
        /**
         * @private {Object|null} Session-cached knowledge payload
         * (fetched once — the data is static at runtime).
         */
        this._payload = null;
        /**
         * @private {string|null} Material type to scroll/highlight after a
         * material cross-link click; cleared by _highlightMaterialTarget().
         */
        this._pendingHighlightMaterial = null;
        /**
         * @private {string|null} Item type to scroll/highlight after a
         * recipe-ref click; cleared by _highlightItemTarget().
         */
        this._pendingHighlightItem = null;
        /**
         * @private {string|null} Action name to scroll/highlight after a
         * capability-chip click; cleared by _highlightActionTarget().
         */
        this._pendingHighlightAction = null;
        /** @private {number|null} Timer handle for the highlight flash. */
        this._highlightTimer = null;
    }

    /**
     * Binds the panel to its overlay markup (idempotent). Resolves
     * #knowledge-overlay / #knowledge-content and wires the close button.
     * @public
     */
    init() {
        if (this._initialized) return;
        this._overlay = document.getElementById('knowledge-overlay');
        this._content = document.getElementById('knowledge-content');
        if (!this._overlay || !this._content) {
            ClientLogger.error('KnowledgePanel', 'Overlay or content element not found. Cannot init.');
            return;
        }
        const closeBtn = this._overlay.querySelector('.overlay-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hide());
        }
        // Cross-links live inside the (re-rendered) sections; one persistent
        // listener on the content container (event delegation) survives every
        // innerHTML replacement and never needs re-wiring. A material cross-link
        // (an item's materials field / a material visual block) jumps to the
        // Materials tab; a recipe item ref jumps to the Items tab; a facet link in
        // a definition card jumps to whichever tab the target's kind lives on.
        this._content.addEventListener('click', (event) => {
            // The clear buttons are checked before any cross-link: a chip or link
            // check on them would return nothing, but ordering states the intent.
            if (this._isClearTarget(event.target)) {
                this._clearSearch(event.target.classList.contains('knowledge-refine-clear'));
                return;
            }
            // A capability chip is checked first: it lives INSIDE an item card,
            // and jumps to the action it names rather than the item around it.
            const actionName = this._actionRefNameForTarget(event.target);
            if (actionName) {
                this._jumpToAction(actionName);
                return;
            }
            // A facet link names a registry kind, not a type, so it resolves on its
            // own attributes and never collides with the item/material links below.
            const reference = this._facetReferenceForTarget(event.target);
            if (reference) {
                this._jumpToDefinitionReference(reference.kind, reference.id);
                return;
            }
            const materialType = this._materialLinkTypeForTarget(event.target);
            if (materialType) {
                this._jumpToMaterial(materialType);
                return;
            }
            const itemType = this._recipeRefTypeForTarget(event.target);
            if (itemType) this._jumpToItem(itemType);
        });
        // The search inputs are replaced by every render, so they are wired by
        // delegation on the container — bound ONCE here, never per render (a
        // listener added in _render would stack one handler per keystroke).
        this._content.addEventListener('input', (event) => this._onSearchInput(event));
        this._initialized = true;
        this._overlay.style.display = 'none';
    }

    /**
     * Shows the overlay and ensures the session payload is loaded
     * (fetch-once cache; renders immediately when already loaded).
     * @param {Object|null} _data - OverlayManager panel data (unused).
     * @public
     */
    show(_data) {
        if (!this._initialized) this.init();
        if (!this._overlay) return;
        if (this._overlay.style.display === 'block') return; // already open
        this._overlay.style.display = 'block';
        this._ensureLoaded();
    }

    /**
     * Hides the overlay. The session payload cache is intentionally kept
     * (the data is static; a later re-open re-renders from cache without a
 * refetch — wiki/subMDs/frontend/knowledge_viewer.md).
     * @public
     */
    hide() {
        if (this._overlay) this._overlay.style.display = 'none';
    }

    /**
     * Toggles the overlay open/closed.
     * @public
     */
    toggle() {
        if (this._overlay && this._overlay.style.display === 'block') {
            this.hide();
        } else {
            this.show();
        }
    }

    /**
     * The panel's root overlay element (for the OverlayManager).
     * @returns {HTMLElement|null}
     * @public
     */
    get overlay() {
        return this._overlay;
    }

    /**
     * The active sub-tab section id (read-only view of _activeSection;
     * public seam for default-section verification).
     * @returns {string} One of SECTION_IDS.
     * @public
     */
    get activeSection() {
        return this._activeSection;
    }

    // =========================================================================
    // Data loading
    // =========================================================================

    /**
     * Ensures the session payload is loaded and rendered. Fetches
     * GET /knowledge exactly once per session; every failure class (network,
     * non-2xx, JSON parse, malformed envelope) is caught, logged through
     * ClientLogger, and rendered as the in-panel error state with a Retry
 * action (the panel stays open — wiki/subMDs/frontend/knowledge_viewer.md).
     * @private
     */
    async _ensureLoaded() {
        if (this._payload) {
            this._render();
            return;
        }
        try {
            const response = await fetch(AppConfig.ENDPOINTS.KNOWLEDGE);
            if (!response.ok) {
                throw new Error(`Failed to fetch knowledge (HTTP ${response.status})`);
            }
            const body = await response.json();
            // null fallback (not EMPTY_KNOWLEDGE): a malformed envelope must
            // reach the error state, while a well-shaped-but-empty payload
            // (missing data files at boot) renders per-section empty states.
            const payload = unwrapKnowledgeEnvelope(body, null);
            if (!payload) {
                throw new Error('Malformed knowledge envelope');
            }
            this._payload = payload;
        } catch (error) {
            ClientLogger.error('KnowledgePanel', 'Failed to load the knowledge payload:', error);
            this._renderError();
            return;
        }
        // Stale-response guard: if the user closed the panel while the
        // fetch was in flight, skip the render (the next show() re-renders
        // from the now-cached payload).
        if (!this._overlay || this._overlay.style.display !== 'block') return;
        this._render();
    }

    // =========================================================================
    // Rendering
    // =========================================================================

    /**
     * Renders the sub-tab bar plus the active section's content into
     #knowledge-content. All server-sourced strings pass through escapeHtml.
     * @private
     */
    _render() {
        if (!this._content || !this._payload) return;
        // ONE pass of the single filter rule: the payload the renderers read, the
        // per-tab badges and the counts the empty state judges all come from the
        // same object, so a badge can never disagree with its own tab.
        const filtered = filterKnowledge(this._payload, {
            query: this._query,
            refine: this._refine,
            activeSection: this._activeSection,
        });
        const searching = filtered.querying || filtered.refining;
        this._content.innerHTML = this._renderSearchBar(filtered)
            + this._renderTabs(filtered.counts, filtered.querying)
            + this._renderRefineBar(filtered)
            + `<div class="knowledge-section">${this._renderSection(filtered.payload, filtered.display, searching, this._payload)}</div>`;
        this._bindTabs();
        this._restoreSearchFocus();
    }

    /**
     * Every tab of the bar, flattened: the codex's own tabs first, then one tab
     * per registry kind. The flat list is what the click guard and the sub-bar
     * label look an id up in; `_renderTabs` draws the same list as captioned rows.
     * @returns {Array<{id: string, label: string}>}
     * @private
     */
    _tabDefs() {
        const bands = this._familyBands();
        // No family map (a payload from before the bar was grouped): the codex's
        // own tabs alone, in their old flat order.
        if (bands.length === 0) return this._coreTabDefs();
        return bands.flatMap((band) => band.tabs);
    }

    /**
     * The bar as family bands, in the order the server sent them: the codex's own
     * view tabs a family names come first (a view of the matter before the lists
     * of that matter), then one tab per registry kind of the family. The client
     * invents no grouping of its own — it draws what `definitionGroups` says —
     * with two guards, because a tab the bar loses is the only way to reach a
     * view: a family naming a tab this codex does not render is skipped, and what
     * the map left out joins the LAST band.
     * @returns {Array<{key: string, label: string, tabs: Array<object>}>} empty
     *   when the payload names no family
     * @private
     */
    _familyBands() {
        const groups = definitionGroupsOf(this._payload);
        if (groups.length === 0) return [];
        const coreTabs = this._coreTabDefs();
        const kindTabs = this._definitionTabDefs();
        const placed = new Set();
        const bands = [];
        for (const group of groups) {
            const tabs = [];
            for (const id of Array.isArray(group.sections) ? group.sections : []) {
                const tab = coreTabs.find((candidate) => candidate.id === id);
                // A family cannot show a view it has no tab for, and a payload
                // that placed one twice gets it drawn once.
                if (!tab || placed.has(id)) continue;
                placed.add(id);
                tabs.push(tab);
            }
            for (const tab of kindTabs) {
                if (tab.groupId === group.id) tabs.push(tab);
            }
            bands.push({ key: group.id, label: group.label, tabs });
        }
        // Completeness outranks tidiness on both sides of a band: a view tab no
        // family named and a kind the map has not caught up with (a row with no
        // entry) both land in the LAST band, which is where the server appends
        // what the family table left out. A tab the bar drops is unreachable.
        const known = new Set(groups.map((group) => group.id));
        const forgotten = coreTabs.filter((tab) => !placed.has(tab.id));
        const orphans = kindTabs.filter((tab) => !known.has(tab.groupId));
        if (forgotten.length || orphans.length) {
            bands[bands.length - 1].tabs.push(...forgotten, ...orphans);
        }
        return bands;
    }

    /** The codex's own tabs, in bar order. @private */
    _coreTabDefs() {
        return [
            { id: SECTION_IDS.TRAITS, label: KNOWLEDGE_LABELS.TAB_TRAITS },
            { id: SECTION_IDS.RECIPES, label: KNOWLEDGE_LABELS.TAB_CRAFTING },
            { id: SECTION_IDS.ITEMS, label: KNOWLEDGE_LABELS.TAB_ITEMS },
            { id: SECTION_IDS.MATERIALS, label: KNOWLEDGE_LABELS.TAB_MATERIALS },
            { id: SECTION_IDS.ACTIONS, label: KNOWLEDGE_LABELS.TAB_ACTIONS },
        ];
    }

    /**
     * The definition tabs, in the family order the server sent: one per registry
     * kind, labelled by the kind's own words (`kindGroupLabel`), so a kind a mod
     * adds appears with a readable tab and no label table to maintain here. A tab
     * exists because the registry kind exists — an empty kind is still a tab, and
     * says so with its own empty state.
     * @returns {Array<{id: string, label: string, groupId: string, groupLabel: string}>}
     * @private
     */
    _definitionTabDefs() {
        return definitionTabsOf(this._payload).map((tab) => ({
            id: tab.id,
            label: kindGroupLabel(tab.kind),
            groupId: tab.groupId,
            groupLabel: tab.groupLabel,
        }));
    }

    /**
     * The tab bar: one row per family, each row the tabs of that family — the
     * codex's view tabs and its kind tabs together (`Traits & Stats | Materials
     * | Items | Components | ...` under `Parts`) — with the family's caption
     * beside it. Active state comes from _activeSection, and while a search is
     * active every tab carries its own match count, so the reader sees where the
     * hits are before switching (the count is the GLOBAL term's, never the sub
     * bar's — the badge describes the search, not one tab's narrowing of it).
     * @param {Object<string, number>} counts - Global per-section matches.
     * @param {boolean} querying - Whether a global term is active.
     * @returns {string} HTML.
     * @private
     */
    _renderTabs(counts, querying) {
        const bands = this._familyBands();
        if (bands.length === 0) {
            return `<div class="knowledge-tabs">${this._coreTabDefs()
                .map((tab) => this._renderTabButton(tab, counts, querying))
                .join('')}</div>`;
        }
        // A band whose tabs the payload named nowhere draws no caption, so the bar
        // never shows an empty row. The bar is drawn in the order it was given,
        // never re-sorted.
        return bands
            .filter((band) => band.tabs.length > 0)
            .map((band) => {
                const caption = band.label === ''
                    ? ''
                    : `<span class="knowledge-tab-family-label">${escapeHtml(band.label)}</span>`;
                const buttons = band.tabs
                    .map((tab) => this._renderTabButton(
                        tab,
                        counts,
                        querying,
                        // The kind tabs read as a row of lists; a view tab keeps
                        // the weight of the tab it has always had.
                        String(tab.id).startsWith(DEFINITION_TAB_PREFIX) ? ' knowledge-tab--kind' : ''
                    ))
                    .join('');
                return `<div class="knowledge-tab-family">${caption}` +
                    `<div class="knowledge-tab-family-tabs">${buttons}</div></div>`;
            })
            .join('');
    }

    /**
     * One tab button. The id goes into `data-section` (dataset comparison on
     * click, never selector interpolation), and the badge is that tab's count of
     * the GLOBAL term.
     * @param {{id: string, label: string}} tab
     * @param {Object<string, number>} counts
     * @param {boolean} querying
     * @param {string} [extraClass] - The kind tabs get ` knowledge-tab--kind`.
     * @returns {string} HTML.
     * @private
     */
    _renderTabButton(tab, counts, querying, extraClass = '') {
        const activeClass = tab.id === this._activeSection ? ' knowledge-tab--active' : '';
        const badge = querying
            ? `<span class="knowledge-tab-count">${counts[tab.id] ?? 0}</span>`
            : '';
        return `<button type="button" class="knowledge-tab${extraClass}${activeClass}" ` +
            `data-section="${escapeHtml(tab.id)}">${escapeHtml(tab.label)}${badge}</button>`;
    }

    /**
     * The global search bar: one term, every section. The count beside it is the
     * total across the five, so the reader knows what the sub bar is narrowing.
     * @param {{counts: Object<string, number>}} filtered
     * @returns {string} HTML.
     * @private
     */
    _renderSearchBar(filtered) {
        const clear = this._query !== ''
            ? `<button type="button" class="knowledge-search-clear" title="${escapeHtml(KNOWLEDGE_LABELS.SEARCH_CLEAR)}">&times;</button>`
            : '';
        return `<div class="knowledge-search">` +
            `<span class="knowledge-search-label">${escapeHtml(KNOWLEDGE_LABELS.SEARCH_LABEL)}</span>` +
            `<input class="knowledge-search-input" type="text" autocomplete="off" spellcheck="false" ` +
            `placeholder="${escapeHtml(KNOWLEDGE_LABELS.SEARCH_PLACEHOLDER)}" value="${escapeHtml(this._query)}">` +
            clear +
            `<span class="knowledge-search-status">${escapeHtml(this._formatCount(this._totalMatches(filtered.counts)))}</span>` +
            `</div>`;
    }

    /**
     * The sub bar: a second term over what the global bar found, applied to the
     * ACTIVE tab only. Always present so switching tabs does not jump the layout,
     * and it names the tab it is narrowing.
     * @param {{display: Object<string, number>}} filtered
     * @returns {string} HTML.
     * @private
     */
    _renderRefineBar(filtered) {
        const clear = this._refine !== ''
            ? `<button type="button" class="knowledge-refine-clear" title="${escapeHtml(KNOWLEDGE_LABELS.SEARCH_CLEAR)}">&times;</button>`
            : '';
        const shown = filtered.display[this._activeSection] ?? 0;
        return `<div class="knowledge-refine">` +
            `<span class="knowledge-refine-label">${escapeHtml(`${KNOWLEDGE_LABELS.REFINE_LABEL}: ${this._activeSectionLabel()}`)}</span>` +
            `<input class="knowledge-refine-input" type="text" autocomplete="off" spellcheck="false" ` +
            `placeholder="${escapeHtml(KNOWLEDGE_LABELS.REFINE_PLACEHOLDER)}" value="${escapeHtml(this._refine)}">` +
            clear +
            `<span class="knowledge-refine-status">${escapeHtml(this._formatCount(shown))}</span>` +
            `</div>`;
    }

    /**
     * The search's own empty state — deliberately NOT the data's: "this section
     * has no items" and "no item matches your term" are different facts and must
     * not share one message.
     * @returns {string} HTML.
     * @private
     */
    _renderNoMatch() {
        // Whichever bar emptied the section is the term to echo. The global term
        // wins when both are set; a narrowing typed into the sub bar with nothing
        // in the global one would otherwise echo an empty string.
        return `<div class="knowledge-empty knowledge-search-empty">` +
            `<span>${escapeHtml(KNOWLEDGE_LABELS.NO_MATCH)}</span>` +
            `<span class="knowledge-search-empty-term">${escapeHtml(this._query || this._refine)}</span>` +
            `</div>`;
    }

    /**
     * Sum of the per-SECTION matches (the global result). A definition tab's
     * count is a slice of the `definitions` section, so adding the tab counts to
     * the section's own would show the same row twice.
     * @private
     */
    _totalMatches(counts) {
        let total = 0;
        for (const [id, count] of Object.entries(counts)) {
            if (id.startsWith(DEFINITION_TAB_PREFIX)) continue;
            total += count;
        }
        return total;
    }

    /** "12 matches" / "1 match" — the panel's own plural rule. @private */
    _formatCount(n) {
        return `${n} ${n === 1 ? KNOWLEDGE_LABELS.MATCHES_ONE : KNOWLEDGE_LABELS.MATCHES_MANY}`;
    }

    /** The label of the active tab, for the sub bar. @private */
    _activeSectionLabel() {
        const found = this._tabDefs().find((tab) => tab.id === this._activeSection);
        return found ? found.label : this._activeSection;
    }

    /**
     * Keystroke handler for either search input (delegated from the container).
     * @param {Event} event
     * @private
     */
    _onSearchInput(event) {
        const input = event.target;
        if (!input || !input.classList) return;
        if (input.classList.contains('knowledge-search-input')) {
            this._query = typeof input.value === 'string' ? input.value : '';
            this._focusRole = 'query';
        } else if (input.classList.contains('knowledge-refine-input')) {
            this._refine = typeof input.value === 'string' ? input.value : '';
            this._focusRole = 'refine';
        } else {
            return;
        }
        this._caret = typeof input.selectionStart === 'number' ? input.selectionStart : this._caret;
        this._render();
    }

    /**
     * True when the click landed on a clear button (either bar).
     * @param {EventTarget|null} target
     * @returns {boolean}
     * @private
     */
    _isClearTarget(target) {
        if (!target || !target.classList) return false;
        return target.classList.contains('knowledge-search-clear')
            || target.classList.contains('knowledge-refine-clear');
    }

    /**
     * Clears the sub bar alone, or both bars. The global clear takes the narrowing
     * with it: a refine term without its parent search is meaningless.
     * @param {boolean} refineOnly
     * @private
     */
    _clearSearch(refineOnly) {
        if (refineOnly) {
            this._refine = '';
            this._focusRole = 'refine';
        } else {
            this._query = '';
            this._refine = '';
            this._focusRole = 'query';
        }
        this._caret = 0;
        this._render();
    }

    /**
     * Puts focus and caret back where the keystroke came from. Every render
     * replaces the DOM, so without this the input would lose focus after one
     * letter and typing a word would be impossible.
     * @private
     */
    _restoreSearchFocus() {
        if (!this._focusRole || !this._content) return;
        const selector = this._focusRole === 'refine'
            ? '.knowledge-refine-input'
            : '.knowledge-search-input';
        const input = this._content.querySelector(selector);
        if (!input) return;
        input.focus();
        const caret = Math.min(this._caret, input.value.length);
        try {
            input.setSelectionRange(caret, caret);
        } catch (_error) {
            // An input without a selection range: focus alone is all there is.
            // The restore must never break the render.
        }
    }

    /**
     * A cross-link jump is a change of intent. The sub bar is a per-tab
     * narrowing, so it always resets on a jump. The GLOBAL term resets only when
     * the target cannot survive it — a jump to a filtered-out card would flash
     * nothing at all, and clearing a term the reader typed is not done on a guess.
     * @param {string} section - Section the jump targets.
     * @param {string} targetId - Id the flash is addressed to.
     * @private
     */
    _prepareSearchForTarget(section, targetId) {
        this._refine = '';
        if (!targetSurvivesQuery(this._payload, section, this._query, targetId)) this._query = '';
        this._focusRole = null;
    }

    /**
     * Wires the (re-rendered) tab buttons: dataset comparison against the
     * known section ids — never selector interpolation.
     * @private
     */
    _bindTabs() {
        if (!this._content) return;
        const tabs = this._content.querySelectorAll('.knowledge-tab');
        const known = this._tabDefs().map((tab) => tab.id);
        for (const tab of tabs) {
            tab.addEventListener('click', () => {
                const section = tab.dataset.section;
                if (!section || !known.includes(section) || section === this._activeSection) return;
                this._activeSection = section;
                // The sub bar narrows THE TAB ON SCREEN; carried over, it would keep
                // filtering rows the reader never asked about on the tab they switched
                // to (wiki/subMDs/frontend/knowledge_viewer.md Sec. 10). The GLOBAL
                // term survives the click - it is still the reader's question - and
                // focus goes with the click, not back into the emptied sub bar.
                this._refine = '';
                this._focusRole = null;
                this._render();
            });
        }
    }

    /**
     * Dispatches to the active section's renderer. The payload handed to it is
     * already filtered; when the search emptied this section the no-match state
     * replaces the renderer (whose own empty state speaks about the DATA, not
     * about the reader's term).
     * @param {Object} payload - The filtered knowledge payload (items/recipes/
     *   actions filtered; `traitStats` holds the filtered materials, mappings and
     *   groups).
     * @param {Object<string, number>} [display] - Per-section counts as rendered.
     * @param {boolean} [searching] - Whether either search term is active.
     * @param {Object|null} [reference] - The UNFILTERED payload, used only for
     *   reference lookups (material names). Falls back to the session payload.
     * @returns {string} HTML.
     * @private
     */
    _renderSection(payload, display = {}, searching = false, reference = null) {
        const source = reference && typeof reference === 'object' && !Array.isArray(reference)
            ? reference
            : this._payload;
        const referenceTraitStats = source && typeof source === 'object' && !Array.isArray(source)
            ? (source.traitStats ?? null)
            : null;
        if (isSearchEmpty(display, searching, this._activeSection)) {
            return this._renderNoMatch();
        }
        if (typeof this._activeSection === 'string' && this._activeSection.startsWith(DEFINITION_TAB_PREFIX)) {
            // A definition tab: the filter already narrowed `definitions` to this
            // tab's kind (and to the sub bar's term, if any).
            return this._renderDefinitions(payload.definitions);
        }
        switch (this._activeSection) {
            case SECTION_IDS.ACTIONS:
                return this._renderActions(payload.actions);
            case SECTION_IDS.RECIPES:
                return this._renderRecipes(payload.recipes);
            case SECTION_IDS.ITEMS:
                // The item rows are the filtered ones; the material-name map is
                // REFERENCE data, not displayed content. Filtering it with the
                // query would turn an item's material cross-links into plain text
                // whenever the search happened to narrow the Materials tab.
                return this._renderItems(payload.items, referenceTraitStats);
            case SECTION_IDS.MATERIALS:
                return this._renderMaterials(payload.traitStats);
            case SECTION_IDS.TRAITS:
            default:
                return this._renderTraitStats(payload.traitStats);
        }
    }

    /**
     * Tab 1: Traits & Stats — the three derivation-chain blocks of
 * wiki/subMDs/frontend/knowledge_viewer.md. Section empty state fires when the
     * mappings array is empty (the section's identity array).
     * @param {*} traitStats - Raw `traitStats` section.
     * @returns {string} HTML.
     * @private
     */
    _renderTraitStats(traitStats) {
        const ts = traitStats && typeof traitStats === 'object' && !Array.isArray(traitStats)
            ? traitStats
            : {};
        const mappings = shapeMappings(ts.mappings);
        if (mappings.length === 0) {
            return this._renderEmpty(KNOWLEDGE_LABELS.EMPTY_TRAITS);
        }
        let html = this._renderMoldTables(ts.groups);
        html += this._renderMappingRows(mappings);
        html += this._renderVocabulary(shapeVocabulary(ts.vocabulary));
        return html;
    }

    /**
     * Tab 4: Materials — one card per material (density, property values, and
     * the renderer's visual block when the material declares one).
     * @param {*} traitStats - Raw `traitStats` section.
     * @returns {string} HTML (empty state when no materials).
     * @private
     */
    _renderMaterials(traitStats) {
        const materials = shapeMaterials(
            traitStats && typeof traitStats === 'object' && !Array.isArray(traitStats)
                ? traitStats.materials
                : null
        );
        if (materials.length === 0) {
            return this._renderEmpty(KNOWLEDGE_LABELS.EMPTY_MATERIALS);
        }
        return this._renderMaterialCards(materials);
    }

    /**
     * One table per trait group (caption = group name; rows are
     * stat and value).
     * @param {*} groups - Raw `traitStats.groups` ({ group: { stat: number } }).
     * @returns {string} HTML (empty string when no groups).
     * @private
     */
    _renderMoldTables(groups) {
        if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return '';
        const groupNames = Object.keys(groups);
        if (groupNames.length === 0) return '';
        const tables = groupNames.map((group) => {
            const stats = groups[group];
            if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return '';
            const rows = Object.entries(stats)
                .filter(([, value]) => typeof value === 'number')
                .map(([stat, value]) =>
                    `<tr><td class="knowledge-mold-stat">${escapeHtml(stat)}</td>` +
                    `<td class="knowledge-mold-value">${escapeHtml(value)}</td></tr>`);
            return `<table class="knowledge-mold-table"><caption>${escapeHtml(group)}</caption>` +
                `<tbody>${rows.join('')}</tbody></table>`;
        }).join('');
        return `<div class="knowledge-block"><div class="knowledge-block-title">${escapeHtml(BLOCK_TITLES.TRAIT_MOLDS)}</div>${tables}</div>`;
    }

    /**
     * One row per mapping — stat key, then the formula badge (with
     * the inline annotation for densityVolume) OR the property source list.
     * Widest content of the panel; the row wraps on narrow panels.
     * @param {Array<Object>} mappings - Shaped mapping rows.
     * @returns {string} HTML.
     * @private
     */
    _renderMappingRows(mappings) {
        const rows = mappings.map((row) => {
            let detail;
            if (row.formula !== null) {
                const annotation = row.formula === DENSITY_VOLUME_FORMULA
                    ? ` <span class="knowledge-mapping-annotation">(${escapeHtml(DENSITY_VOLUME_ANNOTATION)})</span>`
                    : '';
                detail = `<span class="knowledge-formula-badge">${escapeHtml(row.formula)}${annotation}</span>`;
            } else if (row.sources.length > 0) {
                const chips = row.sources.map((source) =>
                    `<span class="knowledge-source-chip">${escapeHtml(source.property)} ${MULTIPLICATION_SIGN} ${escapeHtml(source.weight)}</span>`);
                detail = `<span class="knowledge-source-list">${chips.join('')}</span>`;
            } else {
                detail = `<span class="knowledge-mapping-annotation">none</span>`;
            }
            return `<div class="knowledge-mapping-row"><span class="knowledge-mapping-key">${escapeHtml(row.statKey)}</span>${detail}</div>`;
        });
        return `<div class="knowledge-block"><div class="knowledge-block-title">${escapeHtml(BLOCK_TITLES.MAPPINGS)}</div>${rows.join('')}</div>`;
    }

    /**
     * One card per material — name, density, property values, and the renderer's
     * visual (look) block when declared. Each card carries the raw `type` in
     * data-material (the target for the scroll/highlight jump).
     * @param {Array<Object>} materials - Shaped material rows.
     * @returns {string} HTML (empty string when no materials).
     * @private
     */
    _renderMaterialCards(materials) {
        if (materials.length === 0) return '';
        const cards = materials.map((material) => {
            const props = Object.entries(material.properties).map(([key, value]) =>
                `<span class="knowledge-source-chip">${escapeHtml(key)} ${MULTIPLICATION_SIGN} ${escapeHtml(value)}</span>`);
            const visualBlock = material.visual && typeof material.visual === 'object' && !Array.isArray(material.visual)
                ? `<div class="knowledge-material-visual">` +
                  `<span class="knowledge-visual-label">${escapeHtml(FIELD_LABELS.VISUAL)}</span>` +
                  `<div class="knowledge-data-sub">${renderDefinitionListing(material.visual)}</div>` +
                  `</div>`
                : '';
            return `<div class="knowledge-material-card" data-material="${escapeHtml(material.type)}">` +
                `<div class="knowledge-card-name">${escapeHtml(material.name)}</div>` +
                `<div class="knowledge-card-desc">${escapeHtml(FIELD_LABELS.DENSITY)} ${escapeHtml(material.density)}</div>` +
                `<div class="knowledge-source-list">${props.join('')}</div>` +
                visualBlock +
                `</div>`;
        });
        return `<div class="knowledge-block"><div class="knowledge-block-title">${escapeHtml(BLOCK_TITLES.MATERIALS)}</div>` +
            `<div class="knowledge-card-grid">${cards.join('')}</div></div>`;
    }

    /**
     * Jump to a material referenced by a click on a material cross-link in the
     * Items section: activates the Materials tab and, after re-render, scrolls
     * the matching card into view and flashes its highlight.
     * @param {string} materialType - The raw material type (the link's
     *     data-material attribute).
     * @private
     */
    _jumpToMaterial(materialType) {
        if (!materialType || typeof materialType !== 'string' || materialType.length === 0) return;
        this._prepareSearchForTarget(SECTION_IDS.MATERIALS, materialType);
        this._activeSection = SECTION_IDS.MATERIALS;
        this._pendingHighlightMaterial = materialType;
        this._render();
        this._highlightMaterialTarget();
    }

    /**
     * After a render, if a highlight target is pending, scrolls the matching
     * material card into view and flashes its highlight (auto-cleared after
     * 1.5 s).
     * @private
     */
    _highlightMaterialTarget() {
        const type = this._pendingHighlightMaterial;
        this._pendingHighlightMaterial = null;
        if (!type || !this._content) return;
        const cards = this._content.querySelectorAll('.knowledge-material-card');
        const card = Array.from(cards).find((c) => c.dataset.material === type);
        if (!card) return;
        if (this._highlightTimer !== null) {
            clearTimeout(this._highlightTimer);
            this._highlightTimer = null;
        }
        card.classList.add('knowledge-material-highlight');
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        this._highlightTimer = setTimeout(() => {
            card.classList.remove('knowledge-material-highlight');
            this._highlightTimer = null;
        }, 1500);
    }

    /**
     * Resolves an event target to the raw material type it belongs to (a
     * material cross-link button, or an ancestor of one). Returns null when
     * the target is not a material link.
     * @param {EventTarget|null} target - event.target.
     * @private
     */
    _materialLinkTypeForTarget(target) {
        if (!target || typeof target.closest !== 'function') return null;
        const link = target.closest('.knowledge-material-link');
        const type = link ? link.dataset.material : null;
        return type && typeof type === 'string' ? type : null;
    }

    /**
     * Resolves an event target to the registry entry a definition facet links to
     * (the `.knowledge-facet-link` button, or an ancestor of one). Returns null
     * when the target is not a facet link, or when the link names no target.
     * @param {EventTarget|null} target - event.target.
     * @returns {{kind: string, id: string}|null}
     * @private
     */
    _facetReferenceForTarget(target) {
        if (!target || typeof target.closest !== 'function') return null;
        const link = target.closest('.knowledge-facet-link');
        const kind = link ? link.dataset.refKind : null;
        const id = link ? link.dataset.refId : null;
        if (typeof kind !== 'string' || kind.length === 0) return null;
        if (typeof id !== 'string' || id.length === 0) return null;
        return { kind, id };
    }

    /**
     * Jump to a definition a facet link named: the tab that kind is rendered on
     * (`referenceTabIdOf` — the Materials tab for matter, the Internal Components
     * tab for an organ, ...), then the same scroll-and-flash every other jump
     * performs. A kind with no tab in this payload is a no-op: the reader stays
     * on the card they were reading rather than landing on an empty screen.
     * @param {string} kind - The target's registry kind (the link's data-ref-kind).
     * @param {string} id - The target's entry id (the link's data-ref-id).
     * @private
     */
    _jumpToDefinitionReference(kind, id) {
        const tabId = referenceTabIdOf(this._payload, kind);
        if (tabId === null) return;
        // Three of the codex views already own a jump for their own card family
        // (`_jumpToMaterial`, `_jumpToItem`, `_jumpToAction` — they predate the
        // definition tabs). A facet naming a material, an item or an action goes
        // through that door, so one card family has exactly one flasher and a facet
        // link cannot disagree with the chip click that opens the same card.
        if (tabId === SECTION_IDS.MATERIALS) { this._jumpToMaterial(id); return; }
        if (tabId === SECTION_IDS.ITEMS) { this._jumpToItem(id); return; }
        if (tabId === SECTION_IDS.ACTIONS) { this._jumpToAction(id); return; }
        this._prepareSearchForTarget(tabId, id);
        this._activeSection = tabId;
        this._render();
        // The Crafting & Items view renders recipe cards, not definition cards;
        // every other destination of a facet link is a `def:<kind>` tab of cards.
        if (tabId === SECTION_IDS.RECIPES) {
            this._flashCard('.knowledge-recipe-card[data-recipe]', 'recipe', id,
                'knowledge-recipe-highlight');
        } else {
            this._flashCard('.knowledge-entity-card[data-definition]', 'definition', id,
                'knowledge-entity-highlight');
        }
    }

    /**
     * Scroll the card a jump named into view and flash it for 1.5 s. `selector`
     * scopes the search to the card family the tab being opened renders, `attr` is
     * the data attribute carrying the target's identity on such a card, and
     * `highlightClass` the flash that family is styled with. Only the card the
     * facet named lights up, never every card mentioning it.
     * @param {string} selector - Card family to search.
     * @param {string} attr - Data attribute (camelCased) holding the target id.
     * @param {string} value - The target the facet named.
     * @param {string} highlightClass - The flash class of that card family.
     * @private
     */
    _flashCard(selector, attr, value, highlightClass) {
        if (!value || !this._content) return;
        const cards = this._content.querySelectorAll(selector);
        const card = Array.from(cards).find((c) => c.dataset[attr] === value);
        if (!card) return;
        if (this._highlightTimer !== null) {
            clearTimeout(this._highlightTimer);
            this._highlightTimer = null;
        }
        card.classList.add(highlightClass);
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        this._highlightTimer = setTimeout(() => {
            card.classList.remove(highlightClass);
            this._highlightTimer = null;
        }, 1500);
    }

    /**
     * Jumps to the Items tab and flashes the item named by a recipe ref.
     * @param {string} itemType - Raw item type.
     * @private
     */
    _jumpToItem(itemType) {
        if (!itemType || typeof itemType !== 'string' || itemType.length === 0) return;
        this._prepareSearchForTarget(SECTION_IDS.ITEMS, itemType);
        this._activeSection = SECTION_IDS.ITEMS;
        this._pendingHighlightItem = itemType;
        this._render();
        this._highlightItemTarget();
    }

    /**
     * After a render, if an item highlight target is pending, scrolls the
     * matching item card into view and flashes its highlight (auto-cleared
     * after 1.5 s). Keyed on the card's data-item attribute.
     * @private
     */
    _highlightItemTarget() {
        const type = this._pendingHighlightItem;
        this._pendingHighlightItem = null;
        if (!type || !this._content) return;
        const cards = this._content.querySelectorAll('.knowledge-item-card');
        const card = Array.from(cards).find((c) => c.dataset.item === type);
        if (!card) return;
        if (this._highlightTimer !== null) {
            clearTimeout(this._highlightTimer);
            this._highlightTimer = null;
        }
        card.classList.add('knowledge-item-highlight');
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        this._highlightTimer = setTimeout(() => {
            card.classList.remove('knowledge-item-highlight');
            this._highlightTimer = null;
        }, 1500);
    }

    /**
     * Tab 5: Actions — every action definition with its stat gate spelled out and
     * its full field listing (wiki/subMDs/frontend/knowledge_viewer.md).
     * @param {*} rawActions - Raw `actions` section.
     * @returns {string} HTML.
     * @private
     */
    _renderActions(rawActions) {
        const actions = shapeActions(rawActions);
        if (actions.length === 0) {
            return this._renderEmpty(KNOWLEDGE_LABELS.EMPTY_ACTIONS);
        }
        const cards = actions.map((action) => renderActionCard(action)).join('');
        return `<div class="knowledge-card-grid knowledge-actions">${cards}</div>`;
    }

    /**
     * Jumps to the Actions tab and flashes the action named by an item card's
     * capability chip.
     * @param {string} actionName - Raw action name.
     * @private
     */
    _jumpToAction(actionName) {
        if (!actionName || typeof actionName !== 'string' || actionName.length === 0) return;
        this._prepareSearchForTarget(SECTION_IDS.ACTIONS, actionName);
        this._activeSection = SECTION_IDS.ACTIONS;
        this._pendingHighlightAction = actionName;
        this._render();
        this._highlightActionTarget();
    }

    /**
     * After a render, if an action highlight target is pending, scrolls the
     * matching action card into view and flashes its highlight (auto-cleared
     * after 1.5 s). Keyed on the card's data-action attribute.
     * @private
     */
    _highlightActionTarget() {
        const name = this._pendingHighlightAction;
        this._pendingHighlightAction = null;
        if (!name || !this._content) return;
        const cards = this._content.querySelectorAll('.knowledge-action-card');
        const card = Array.from(cards).find((c) => c.dataset.action === name);
        if (!card) return;
        if (this._highlightTimer !== null) {
            clearTimeout(this._highlightTimer);
            this._highlightTimer = null;
        }
        card.classList.add('knowledge-action-highlight');
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        this._highlightTimer = setTimeout(() => {
            card.classList.remove('knowledge-action-highlight');
            this._highlightTimer = null;
        }, 1500);
    }

    /**
     * Resolves an event target to the raw action name it belongs to (an item
     * card's capability chip, or an ancestor of one). Returns null when the
     * target is not a capability chip.
     * @param {EventTarget|null} target - event.target.
     * @private
     */
    _actionRefNameForTarget(target) {
        if (!target || typeof target.closest !== 'function') return null;
        const chip = target.closest('.knowledge-capability-chip');
        const name = chip ? chip.dataset.action : null;
        return name && typeof name === 'string' ? name : null;
    }

    /**
     * Resolves an event target to the raw item type it belongs to (a recipe
     * item-ref button, or an ancestor of one). Returns null when the target is
     * not a recipe ref.
     * @param {EventTarget|null} target - event.target.
     * @private
     */
    _recipeRefTypeForTarget(target) {
        if (!target || typeof target.closest !== 'function') return null;
        const link = target.closest('.knowledge-recipe-ref');
        const type = link ? link.dataset.item : null;
        return type && typeof type === 'string' ? type : null;
    }

    /**
     * Pinned vocabulary — trait groups, stats, the two
     * existence boundaries, and the pinned-subset note.
     * @param {{traitGroups: string[], stats: string[], existence: Object}} vocabulary - Shaped vocabulary.
     * @returns {string} HTML.
     * @private
     */
    _renderVocabulary(vocabulary) {
        const badges = (list) => list
            .map((name) => `<span class="knowledge-stat-badge">${escapeHtml(name)}</span>`);
        const rows = [
            `<div class="knowledge-vocab-row"><span class="knowledge-vocab-label">${escapeHtml(VOCAB_LABELS.PINNED_TRAIT_GROUPS)}</span>${badges(vocabulary.traitGroups).join('')}</div>`,
            `<div class="knowledge-vocab-row"><span class="knowledge-vocab-label">${escapeHtml(VOCAB_LABELS.PINNED_STATS)}</span>${badges(vocabulary.stats).join('')}</div>`,
            `<div class="knowledge-vocab-row"><span class="knowledge-vocab-label">${escapeHtml(VOCAB_LABELS.EXISTENCE)}</span>` +
                `<span class="knowledge-vocab-boundary">${escapeHtml(VOCAB_LABELS.EXISTENCE_GONE_AT)} ${escapeHtml(vocabulary.existence.goneAt)}</span>` +
                `<span class="knowledge-vocab-sep">/</span>` +
                `<span class="knowledge-vocab-boundary">${escapeHtml(VOCAB_LABELS.EXISTENCE_USABLE_MIN)} ${escapeHtml(vocabulary.existence.usableMin)}</span></div>`,
            `<div class="knowledge-vocab-note">${escapeHtml(VOCAB_LABELS.PINNED_SUBSET_NOTE)}</div>`,
        ];
        return `<div class="knowledge-block"><div class="knowledge-block-title">${escapeHtml(BLOCK_TITLES.VOCABULARY)}</div>` +
            `<div class="knowledge-vocab-block">${rows.join('')}</div></div>`;
    }

    /**
     * Tab 2: Crafting & Items — one card per recipe (grid, like the
     * crafting panel's recipe cards): name, description, input refs, arrow,
     * output refs.
     * @param {*} rawRecipes - Raw `recipes` section.
     * @returns {string} HTML.
     * @private
     */
    _renderRecipes(rawRecipes) {
        const recipes = shapeRecipes(rawRecipes);
        if (recipes.length === 0) {
            return this._renderEmpty(KNOWLEDGE_LABELS.EMPTY_RECIPE);
        }
        const cards = recipes.map((recipe) => {
            const desc = recipe.description !== null
                ? `<div class="knowledge-card-desc">${escapeHtml(recipe.description)}</div>`
                : '';
            return `<div class="knowledge-recipe-card" data-recipe="${escapeHtml(recipe.id)}">` +
                `<div class="knowledge-card-name">${escapeHtml(recipe.name)}</div>` +
                desc +
                `<div class="knowledge-ref-line">${renderRecipeRefs(recipe.inputs)}` +
                `<span class="knowledge-arrow">${ARROW}</span>` +
                `${renderRecipeRefs(recipe.outputs)}</div>` +
                `</div>`;
        });
        return `<div class="knowledge-card-grid knowledge-recipes">${cards.join('')}</div>`;
    }

    /**
     * Tab 3: Items — one card per item type: name, description, the runtime
     * volume line (external volume shown when it differs), and the FULL
     * definition as a flat key: value listing of every field (form, materials,
     * traits, internalComponents, visual, wear, and anything a future mod adds).
     * The materials field renders each entry's material as a cross-link button
     * to the Materials tab; unknown references stay plain text.
     * @param {*} rawItems - Raw `items` section.
     * @param {*} traitStats - Raw `traitStats` section (materials for link names).
     * @returns {string} HTML.
     * @private
     */
    _renderItems(rawItems, traitStats) {
        const items = shapeItems(rawItems);
        if (items.length === 0) {
            return this._renderEmpty(KNOWLEDGE_LABELS.EMPTY_ITEMS);
        }
        // Material display names for the cross-link buttons: the Materials
        // registry, shaped and keyed by raw type. A type not in the registry
        // stays plain text in renderDefinitionListing (no fabricated target).
        const materialNames = {};
        const rawMaterials = traitStats && typeof traitStats === 'object' && !Array.isArray(traitStats)
            ? traitStats.materials
            : null;
        for (const material of shapeMaterials(rawMaterials)) {
            if (material.type) materialNames[material.type] = material.name;
        }
        const cards = items.map((item) => {
            const desc = item.description !== null
                ? `<div class="knowledge-card-desc">${escapeHtml(item.description)}</div>`
                : '';
            let volumeLine = `<span class="knowledge-item-volume">${escapeHtml(VOLUME_LABELS.VOLUME)} ${escapeHtml(item.volume)}</span>`;
            if (item.externalVolume !== null && item.externalVolume !== item.volume) {
                volumeLine += ` <span class="knowledge-item-volume">${escapeHtml(VOLUME_LABELS.EXTERNAL)} ${escapeHtml(item.externalVolume)}</span>`;
            }
            // Full definition listing: every field (form, materials, traits,
            // internalComponents, visual, wear, and anything a future mod adds),
            // with the materials field's entries as cross-link buttons.
            const listing = renderDefinitionListing(item.definition, materialNames);
            const capabilityBlock = renderItemCapabilities(item.capabilities);
            return `<div class="knowledge-item-card" data-item="${escapeHtml(item.type)}">` +
                `<div class="knowledge-card-name">${escapeHtml(item.name)}</div>` +
                desc +
                `<div class="knowledge-item-meta">${volumeLine}</div>` +
                capabilityBlock +
                `<div class="knowledge-item-fields">${listing}</div>` +
                `</div>`;
        });
        return `<div class="knowledge-card-grid knowledge-items">${cards.join('')}</div>`;
    }

    /**
     * A definition tab: the entries of ONE registry kind, in the payload's order
     * (the server sorts by id inside a kind). The tab names the kind, so the cards
     * carry no group heading any more — the heading one flat tab needed to separate
     * seventeen families in a single scroll is the tab itself now
     * (wiki/subMDs/frontend/knowledge_viewer.md Sec. 12). Each card keeps the
     * entry's verbatim definition in a collapsed `<details>`, the appendix
     * convention the Actions cards use.
     * @param {*} rawDefinitions - The `definitions` rows of the active kind.
     * @returns {string} HTML (the tab's empty state when the registry has nothing).
     * @private
     */
    _renderDefinitions(rawDefinitions) {
        const rows = shapeDefinitions(rawDefinitions);
        if (rows.length === 0) {
            return this._renderEmpty(KNOWLEDGE_LABELS.EMPTY_DEFINITION);
        }
        const cards = rows.map((row) => this._renderDefinitionCard(row)).join('');
        return `<div class="knowledge-entity-group" data-kind="${escapeHtml(rows[0].kind)}">` +
            `<div class="knowledge-card-grid">${cards}</div>` +
            `</div>`;
    }

    /**
     * One definition card: the entry's name (or its id, when the registry declares
     * no name — the codex never invents a label), the resolved facets the server
     * read off the entry, and the full definition as a collapsed appendix. The
     * id is always shown: it is what a mod, a blueprint or a `chunk_<material>`
     * type is written by, and hiding it behind the display name would make the
     * card unreadable against the data files.
     *
     * A facet value is rendered by `renderFacetValue`: where the facet names an
     * entry of another registry, that name is a link into the tab the kind lives
     * on. The card carries its own id (`data-definition`) so such a jump can light
     * up exactly the card it landed on, the way an item or material card already
     * carries `data-item` / `data-material`.
     * @param {Object} row - A shaped definition row.
     * @returns {string} HTML.
     * @private
     */
    _renderDefinitionCard(row) {
        const title = row.name ?? row.id;
        const idLine = row.name !== null && row.name !== row.id
            ? `<div class="knowledge-entity-id">${escapeHtml(row.id)}</div>`
            : '';
        const desc = row.description !== null
            ? `<div class="knowledge-card-desc">${escapeHtml(row.description)}</div>`
            : '';
        const facets = row.facets.length > 0
            ? `<div class="knowledge-entity-facets">${row.facets.map((facet) =>
                `<div class="knowledge-entity-facet">` +
                `<span class="knowledge-entity-facet-label">${escapeHtml(facet.label)}</span>` +
                `<span class="knowledge-entity-facet-value">${renderFacetValue(facet)}</span>` +
                `</div>`).join('')}</div>`
            : '';
        const body = renderDefinitionBody(row.definition);
        // One label for the appendix, shared with the Actions cards: the two
        // blocks say the same thing ("every field, as the data has it").
        const raw = body === ''
            ? ''
            : `<details class="knowledge-entity-raw"><summary>${escapeHtml(ACTION_UI_LABELS.RAW)}</summary>` +
              `<div class="knowledge-item-fields">${body}</div></details>`;
        return `<div class="knowledge-entity-card" data-definition="${escapeHtml(row.id)}">` +
            `<div class="knowledge-card-name">${escapeHtml(title)}</div>` +
            idLine +
            desc +
            facets +
            raw +
            `</div>`;
    }

    /**
     * The per-section empty state (centered note; exact strings from the
     * label contract).
     * @param {string} message - The section's empty-state string.
     * @returns {string} HTML.
     * @private
     */
    _renderEmpty(message) {
        return `<div class="knowledge-empty">${escapeHtml(message)}</div>`;
    }

    /**
     * The in-panel error state: the message plus a Retry button that
     * re-runs _ensureLoaded() while keeping the panel open (the payload
     * cache stays null until a fetch succeeds).
     * @private
     */
    _renderError() {
        if (!this._content) return;
        this._content.innerHTML =
            `<div class="knowledge-error">` +
            `<div class="knowledge-error-message">${escapeHtml(KNOWLEDGE_LABELS.ERROR_MESSAGE)}</div>` +
            `<button type="button" class="knowledge-retry-btn">${escapeHtml(KNOWLEDGE_LABELS.ERROR_RETRY)}</button>` +
            `</div>`;
        const retryBtn = this._content.querySelector('.knowledge-retry-btn');
        if (retryBtn) {
            retryBtn.addEventListener('click', () => this._ensureLoaded());
        }
    }
}

export default KnowledgePanel;
