/**
 * materialLook — names what a material's `visual` numbers look like, in English.
 *
 * Owns the vocabulary and nothing else: hue/saturation/lightness to a colour
 * word, metalness + roughness to a finish, grain and translucency to a clause.
 *
 * Three of the colour words are not on the wheel: light red is pink, dark orange
 * is brown, mid orange is tan. English built them and does not build them back
 * out of hue and lightness, so the module says them and a renderer agrees.
 * Reads plain objects, writes plain strings: no Node, no DOM, no registry, no
 * world — which is what lets the round-prose builder (its only consumer today)
 * stay the pure reader its own header promises.
 *
 * It deliberately does NOT blend several materials into one look. The word for a
 * 60%-iron / 40%-wood knife is "metal", because the blade is what the part is
 * made of where it matters and what a reader of the sentence pictures; averaging
 * the numbers first answers "blue" for a knife. Per-material blending stays the
 * renderer's own job, in a real colour space (linear light, not the naming space
 * here), when a renderer exists. Where a composition's dominant material is
 * decided, it is decided once by `MaterialController.getPrimaryMaterial`, so the
 * look and the damage chip never disagree about which material a part reads as.
 *
 * Words are DERIVED from the numbers, never authored beside them: a second claim
 * about the same matter is a second thing that can be wrong, and it goes stale
 * the first time somebody tunes a value (`DOC-1`). `wiki/decisions/visual-stats.md`.
 *
 * It also owns the ONE narrowing of a `visual` block (`narrowVisualBlock`): the
 * vocabulary and the rule that accepts it are the same claim, and two copies of it
 * drift the first time a key is added. Materials are not the only authored
 * appearance any more — an item recipe declares a `visual` of its own (what a
 * garment looks like is not what the matter it is modelled from looks like), and
 * that owner narrows through this module too
 * (`wiki/decisions/visual-stats.md`, amendment).
 *
 * Pure functions over plain objects; deterministic output, like the prose that
 * reads it (identically built worlds produce byte-identical text).
 *
 * @module materialLook
 */

/**
 * The closed vocabulary of a material's `visual` block: every key it accepts and
 * the range each one must fall in. A key outside this list is a typo, and a typo
 * that silently names nothing is exactly the kind of dead data the material
 * system was built to prevent (`wiki/basic_traits_and_stats_spec.md`).
 * @type {Object<string, { min: number, max: number }>}
 */
export const VISUAL_KEYS = Object.freeze({
    hue: Object.freeze({ min: 0, max: 360 }),
    saturation: Object.freeze({ min: 0, max: 100 }),
    lightness: Object.freeze({ min: 0, max: 100 }),
    metalness: Object.freeze({ min: 0, max: 100 }),
    roughness: Object.freeze({ min: 0, max: 100 }),
    grain: Object.freeze({ min: 0, max: 100 }),
    translucency: Object.freeze({ min: 0, max: 100 }),
});

// Naming thresholds. Named because they ARE the vocabulary: moving one changes
// which English word a material gets, and that belongs in one place (`API-5`).

/** At or below this lightness, hue stops reading: the material is near-black. */
const NEAR_BLACK_LIGHTNESS = 14;
/** At or above this lightness, colour washes out to near-white. */
const NEAR_WHITE_LIGHTNESS = 90;
/** Below this saturation, hue is invisible to the eye: the word is "grey". */
const GREY_SATURATION = 12;
/** At or above this saturation, the colour is worth calling vivid rather than plain. */
const VIVID_SATURATION = 70;
/** Under this lightness, "dark"; at or above the pale mark, "pale". */
const DARK_LIGHTNESS = 34;
const PALE_LIGHTNESS = 62;
/** Light red is not "pale red" — it is pink. Above this lightness, say pink. */
const PINK_LIGHTNESS = 55;
/** Dark orange is not "dark orange" — it is brown. At or below, say brown. */
const BROWN_LIGHTNESS = 52;
/**
 * Mid orange is not "orange" either — on a body it is TAN. The band exists
 * because skin lives in it: measured against real skin samples, every tone from
 * fair to tan sat at hue 15-45 with a lightness in here, and without this word
 * the prose called a human "orange" (`wiki/decisions/visual-stats.md`). Below it
 * is brown, above it the orange is fair enough to name pale.
 */
const TAN_LIGHTNESS = 53;
/** Above this lightness, orange reads as a fair pale orange rather than a tan. */
const TAN_CEILING = 66;

/** Metal is named by its finish (polished / brushed / dull); below this share it is not metal. */
const METALLIC_SHARE = 60;
/** Finish bands, shared by metal and non-metal but named differently. */
const POLISHED_ROUGHNESS = 25;
const SATIN_ROUGHNESS = 55;
const ROUGH_ROUGHNESS = 80;

/** Grain bands: a strong grain is worth the word, a trace of it is a clause. */
const GRAIN_STRONG = 70;
const GRAIN_FAINT = 35;

/** Translucency bands: light through flesh (ears, fingers) is worth saying. */
const TRANSLUCENT_STRONG = 50;
const TRANSLUCENT_FAINT = 20;

/**
 * Hue buckets in degrees, ascending by upper bound. Red wraps: the last entry
 * closes the wheel back at 360.
 * @type {Array<[number, string]>}
 */
const HUE_WORDS = Object.freeze([
    Object.freeze([14, 'red']),
    Object.freeze([45, 'orange']),
    Object.freeze([70, 'yellow']),
    Object.freeze([165, 'green']),
    Object.freeze([195, 'cyan']),
    Object.freeze([255, 'blue']),
    Object.freeze([290, 'violet']),
    Object.freeze([330, 'magenta']),
    Object.freeze([360, 'red']),
]);

/** A finite number, or null for anything else (undefined, string, NaN, Infinity). */
function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The plain hue word, wrapping the wheel. Null when hue is unreadable. */
function hueWord(hue) {
    if (hue === null) return null;
    const wrapped = ((hue % 360) + 360) % 360;
    for (const [upper, word] of HUE_WORDS) {
        if (wrapped <= upper) return word;
    }
    return null;
}

/**
 * The colour word: "near-black", "grey", "tan", "brown", "pale pink", "vivid green".
 * Null when the visual block says nothing about colour (no lightness to judge,
 * and no hue to name).
 */
function colorPhrase(visual) {
    const lightness = finite(visual.lightness);
    const saturation = finite(visual.saturation);
    if (lightness === null) return null;
    if (lightness <= NEAR_BLACK_LIGHTNESS) return 'near-black';
    if (lightness >= NEAR_WHITE_LIGHTNESS) return 'near-white';

    const hue = hueWord(finite(visual.hue));
    // No hue at all, or a hue too washed out to read, is a grey.
    if (hue === null || saturation === null || saturation <= GREY_SATURATION) {
        return lightness <= DARK_LIGHTNESS ? 'dark grey' : 'grey';
    }

    // Two hue words that English does not build from the wheel: light red is
    // pink, dark orange is brown. Saying "pale red" or "dark orange" would name
    // a colour nobody sees. The lightness modifier still applies on top (a pale
    // pink is not a vivid pink), and the bands make the impossible combinations
    // impossible: pink needs lightness >= PINK_LIGHTNESS, so it is never "dark";
    // brown needs lightness <= BROWN_LIGHTNESS, so it is never "pale".
    const vivid = saturation >= VIVID_SATURATION ? 'vivid' : null;
    const hueNamed = (hue === 'red' && lightness >= PINK_LIGHTNESS) ? 'pink'
        : (hue === 'orange' && lightness <= BROWN_LIGHTNESS) ? 'brown'
            : (hue === 'orange' && lightness >= TAN_LIGHTNESS && lightness <= TAN_CEILING) ? 'tan'
                : hue;
    // Tan names the lightness band it lives in, so it takes no modifier: English
    // says "dark tan", never "pale tan", and a vivid one is a contradiction. The
    // bands make the impossible pairs impossible the same way they do for pink.
    const modifier = hueNamed === 'tan' ? null
        : lightness <= DARK_LIGHTNESS ? 'dark'
            : lightness >= PALE_LIGHTNESS ? 'pale'
                : vivid;
    return modifier ? `${modifier} ${hueNamed}` : hueNamed;
}

/**
 * The finish word, from metalness and roughness together: "polished metal",
 * "brushed metal", "dull metal", "smooth", "satin", "rough", "coarse".
 * Null when neither value is present.
 */
function finishPhrase(visual) {
    const metalness = finite(visual.metalness);
    const roughness = finite(visual.roughness);
    if (roughness === null && metalness === null) return null;
    const rough = roughness ?? 50;
    if (metalness !== null && metalness >= METALLIC_SHARE) {
        if (rough < POLISHED_ROUGHNESS) return 'polished metal';
        if (rough < SATIN_ROUGHNESS) return 'brushed metal';
        return 'dull metal';
    }
    if (rough < POLISHED_ROUGHNESS) return 'smooth';
    if (rough < SATIN_ROUGHNESS) return 'satin';
    if (rough < ROUGH_ROUGHNESS) return 'rough';
    return 'coarse';
}

/** A grain clause, or null when the material reads as grainless. */
function grainClause(visual) {
    const grain = finite(visual.grain);
    if (grain === null) return null;
    if (grain >= GRAIN_STRONG) return 'grained';
    if (grain >= GRAIN_FAINT) return 'with a faint grain';
    return null;
}

/** A translucency clause, or null when light does not pass through it. */
function translucencyClause(visual) {
    const translucency = finite(visual.translucency);
    if (translucency === null) return null;
    if (translucency >= TRANSLUCENT_STRONG) return 'translucent';
    if (translucency >= TRANSLUCENT_FAINT) return 'slightly translucent';
    return null;
}

/**
 * The one narrowing of a `visual` block: every key must be in `VISUAL_KEYS`, and
 * every value a finite number inside that key's declared range.
 *
 * It lives beside the vocabulary on purpose (see the header). It throws
 * `TypeError` rather than returning a verdict, because a key outside the vocabulary
 * names nothing and an out-of-range number names a colour nobody can see: a boot
 * that accepts either can tell the author nothing went wrong, which is the dead data
 * this block exists to prevent (`T-1`, `E-8`). A caller that would rather quarantine
 * one bad definition than break a world collects the thrown message instead
 * (`src/services/CompositionClassifier.js`).
 *
 * Absence is not a failure: an `undefined` block narrows to `null`, and the reader
 * then says nothing about appearance rather than inventing one.
 *
 * @param {unknown} visual - The `visual` block as authored (any value).
 * @param {string} label - Whose data this is, as it should read in the message
 *   ('Material "iron"', 'Item "tshirt"').
 * @returns {Object|null} A plain copy of the narrowed block, or null when absent.
 * @throws {TypeError} When a block is present and malformed.
 */
export function narrowVisualBlock(visual, label) {
    if (visual === undefined) return null;
    if (typeof visual !== 'object' || visual === null || Array.isArray(visual)) {
        throw new TypeError(`${label}: "visual" must be an object of numbers.`);
    }
    const clean = {};
    for (const [key, value] of Object.entries(visual)) {
        const range = VISUAL_KEYS[key];
        if (!range) {
            throw new TypeError(`${label}: unknown visual key "${key}" (allowed: ${Object.keys(VISUAL_KEYS).join(', ')}).`);
        }
        if (typeof value !== 'number' || !Number.isFinite(value) || value < range.min || value > range.max) {
            throw new TypeError(`${label}: visual "${key}" must be a number in [${range.min}, ${range.max}].`);
        }
        clean[key] = value;
    }
    return clean;
}

/**
 * The one primary export: a material's `visual` block as English.
 *
 * @param {unknown} visual - A material's `visual` block (plain object of numbers).
 * @returns {{ color: string|null, finish: string|null, texture: string|null,
 *             translucency: string|null, phrase: string }|null} Null when the
 *          block is absent, not an object, or says nothing readable — callers
 *          drop the clause rather than inventing a look.
 */
export function describeVisual(visual) {
    if (!visual || typeof visual !== 'object' || Array.isArray(visual)) return null;
    const color = colorPhrase(visual);
    const finish = finishPhrase(visual);
    const texture = grainClause(visual);
    const translucent = translucencyClause(visual);
    const words = [color, finish, texture, translucent].filter((word) => typeof word === 'string' && word !== '');
    if (words.length === 0) return null;
    return { color, finish, texture, translucency: translucent, phrase: words.join(', ') };
}
