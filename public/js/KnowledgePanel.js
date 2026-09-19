/**
 * KnowledgePanel
 * Client-side Knowledge overlay panel (wiki/subMDs/frontend/knowledge_viewer.md): a
 * read-only reference codex of the game's static data files. Three sub-tabs
 * share one content area:
 *   1. "Traits & Stats" — the material-property → trait → stat derivation
 *      chain: the global trait molds, the property-to-stat mapping table,
 *      per-material property values, and the cross-layer pinned vocabulary.
 *   2. "Crafting & Items" — every recipe with display names already resolved
 *      by the server (the client never re-resolves names).
 *   3. "Items" — every item type with its fields: volume (with the
 *      external-volume override shown when it differs), declared trait
 *      badges grouped by trait group, and the material composition list
 *      when present.
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
 * The pure helpers (unwrapKnowledgeEnvelope, escapeHtml, and the per-section
 * shapers) are named exports unit-tested without any DOM
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
};

/** Section block titles (wiki/subMDs/frontend/knowledge_viewer.md block names). */
const BLOCK_TITLES = {
    TRAIT_MOLDS: 'Global trait molds',
    MAPPINGS: 'Property to stat mappings',
    MATERIALS: 'Materials',
    VOCABULARY: 'Shared vocabulary',
};

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
};

// =============================================================================
// Section identity + payload contract
// =============================================================================

/**
 * The three sub-tab section ids. Tab buttons carry these in their
 * `data-section` attribute; lookups compare against these constants
 * (dataset comparison, never selector interpolation).
 */
export const SECTION_IDS = {
    TRAITS: 'traitStats',
    RECIPES: 'recipes',
    ITEMS: 'items',
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
 * `{ type, name, density, properties }` sorted by type; `name` falls back to
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
 * Item rows (wiki/subMDs/frontend/knowledge_viewer.md): `{ type, name, description,
 * volume, externalVolume, materials, traits }` sorted by type, with the
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
        });
    }
    rows.sort((a, b) => compareStrings(a.type, b.type));
    return rows;
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
 * `overlayManager.register('knowledge', panel, 'btn-knowledge', null)` —
 * no numeric keyboard shortcut (same treatment as crafting/room-chat/events).
 */
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
        /**
         * @private {Object|null} Session-cached knowledge payload
         * (fetched once — the data is static at runtime).
         */
        this._payload = null;
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
        this._content.innerHTML = this._renderTabs() +
            `<div class="knowledge-section">${this._renderSection(this._payload)}</div>`;
        this._bindTabs();
    }

    /**
     * The three sub-tab buttons, active state from _activeSection.
     * @returns {string} HTML.
     * @private
     */
    _renderTabs() {
        const tabs = [
            { id: SECTION_IDS.TRAITS, label: KNOWLEDGE_LABELS.TAB_TRAITS },
            { id: SECTION_IDS.RECIPES, label: KNOWLEDGE_LABELS.TAB_CRAFTING },
            { id: SECTION_IDS.ITEMS, label: KNOWLEDGE_LABELS.TAB_ITEMS },
        ];
        const buttons = tabs.map((tab) => {
            const activeClass = tab.id === this._activeSection ? ' knowledge-tab--active' : '';
            return `<button type="button" class="knowledge-tab${activeClass}" data-section="${escapeHtml(tab.id)}">${escapeHtml(tab.label)}</button>`;
        }).join('');
        return `<div class="knowledge-tabs">${buttons}</div>`;
    }

    /**
     * Wires the (re-rendered) tab buttons: dataset comparison against the
     * known section ids — never selector interpolation.
     * @private
     */
    _bindTabs() {
        if (!this._content) return;
        const tabs = this._content.querySelectorAll('.knowledge-tab');
        const known = Object.values(SECTION_IDS);
        for (const tab of tabs) {
            tab.addEventListener('click', () => {
                const section = tab.dataset.section;
                if (!section || !known.includes(section) || section === this._activeSection) return;
                this._activeSection = section;
                this._render();
            });
        }
    }

    /**
     * Dispatches to the active section's renderer.
     * @param {Object} payload - The unwrapped knowledge payload.
     * @returns {string} HTML.
     * @private
     */
    _renderSection(payload) {
        switch (this._activeSection) {
            case SECTION_IDS.RECIPES:
                return this._renderRecipes(payload.recipes);
            case SECTION_IDS.ITEMS:
                return this._renderItems(payload.items);
            case SECTION_IDS.TRAITS:
            default:
                return this._renderTraitStats(payload.traitStats);
        }
    }

    /**
     * Tab 1: Traits & Stats — the four derivation-chain blocks of
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
        html += this._renderMaterialCards(shapeMaterials(ts.materials));
        html += this._renderVocabulary(shapeVocabulary(ts.vocabulary));
        return html;
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
     * One card per material — name, density, property values.
     * @param {Array<Object>} materials - Shaped material rows.
     * @returns {string} HTML (empty string when no materials).
     * @private
     */
    _renderMaterialCards(materials) {
        if (materials.length === 0) return '';
        const cards = materials.map((material) => {
            const props = Object.entries(material.properties).map(([key, value]) =>
                `<span class="knowledge-source-chip">${escapeHtml(key)} ${MULTIPLICATION_SIGN} ${escapeHtml(value)}</span>`);
            return `<div class="knowledge-material-card">` +
                `<div class="knowledge-card-name">${escapeHtml(material.name)}</div>` +
                `<div class="knowledge-card-desc">${escapeHtml(FIELD_LABELS.DENSITY)} ${escapeHtml(material.density)}</div>` +
                `<div class="knowledge-source-list">${props.join('')}</div>` +
                `</div>`;
        });
        return `<div class="knowledge-block"><div class="knowledge-block-title">${escapeHtml(BLOCK_TITLES.MATERIALS)}</div>` +
            `<div class="knowledge-card-grid">${cards.join('')}</div></div>`;
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
        const renderRefs = (refs) => refs.map((ref) =>
            `<span class="knowledge-ref-item">${escapeHtml(ref.quantity)} ${MULTIPLICATION_SIGN} ${escapeHtml(ref.name)}</span>`);
        const cards = recipes.map((recipe) => {
            const desc = recipe.description !== null
                ? `<div class="knowledge-card-desc">${escapeHtml(recipe.description)}</div>`
                : '';
            return `<div class="knowledge-recipe-card">` +
                `<div class="knowledge-card-name">${escapeHtml(recipe.name)}</div>` +
                desc +
                `<div class="knowledge-ref-line">${renderRefs(recipe.inputs).join('')}` +
                `<span class="knowledge-arrow">${ARROW}</span>` +
                `${renderRefs(recipe.outputs).join('')}</div>` +
                `</div>`;
        });
        return `<div class="knowledge-card-grid knowledge-recipes">${cards.join('')}</div>`;
    }

    /**
     * Tab 3: Items — one card per item type: name, description, volume line
     * (external volume shown when it differs), static trait badges grouped
     * by trait group (no hover-to-hide), and the material composition list
     * when present.
     * @param {*} rawItems - Raw `items` section.
     * @returns {string} HTML.
     * @private
     */
    _renderItems(rawItems) {
        const items = shapeItems(rawItems);
        if (items.length === 0) {
            return this._renderEmpty(KNOWLEDGE_LABELS.EMPTY_ITEMS);
        }
        const cards = items.map((item) => {
            const desc = item.description !== null
                ? `<div class="knowledge-card-desc">${escapeHtml(item.description)}</div>`
                : '';
            let volumeLine = `<span class="knowledge-item-volume">${escapeHtml(VOLUME_LABELS.VOLUME)} ${escapeHtml(item.volume)}</span>`;
            if (item.externalVolume !== null && item.externalVolume !== item.volume) {
                volumeLine += ` <span class="knowledge-item-volume">${escapeHtml(VOLUME_LABELS.EXTERNAL)} ${escapeHtml(item.externalVolume)}</span>`;
            }
            const traitGroups = Object.keys(item.traits).map((group) => {
                const badges = Object.entries(item.traits[group]).map(([stat, value]) =>
                    `<span class="knowledge-stat-badge">${escapeHtml(stat)} ${escapeHtml(value)}</span>`);
                return `<div class="knowledge-trait-group"><span class="knowledge-trait-label">${escapeHtml(group)}</span>${badges.join('')}</div>`;
            });
            const composition = item.materials !== null && item.materials.length > 0
                ? `<div class="knowledge-composition">${item.materials.map((mat) => {
                    const role = mat.role !== null ? ` ${escapeHtml(mat.role)}` : '';
                    return `<div class="knowledge-composition-row">${escapeHtml(mat.material)} ${escapeHtml(mat.fraction)}${role}</div>`;
                }).join('')}</div>`
                : '';
            return `<div class="knowledge-item-card">` +
                `<div class="knowledge-card-name">${escapeHtml(item.name)}</div>` +
                desc +
                `<div class="knowledge-item-meta">${volumeLine}</div>` +
                traitGroups.join('') +
                composition +
                `</div>`;
        });
        return `<div class="knowledge-card-grid knowledge-items">${cards.join('')}</div>`;
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
