/**
 * actionSemantics — reads one action definition and says what it DOES.
 *
 * WHY here, on the server: what a consequence type means is world knowledge, and
 * every rule of this world lives server-side (the client is disposable). The
 * codex used to hand the client a raw field dump; a reader had to already know
 * that `damageComponent` with `{ channel: 'cut', value: ':Physical.sharpness' }`
 * means "the target is cut, scaled by the instrument's sharpness". This module
 * holds that reading, next to the codex that serves it.
 *
 * The vocabulary is not invented here:
 *   - the consequence types are the keys of the dispatcher's handler map
 *     (src/controllers/consequences/consequenceHandlers.js `_buildHandlerMap`);
 *   - `target` is the CLOSED vocabulary the dispatcher resolves
 *     (`ConsequenceDispatcher._resolveTargetForConsequence`: `self | target |
 *     entity`, anything else is a logged error);
 *   - the targeting types are the shared `TARGETING_TYPES` constant.
 *
 * A consequence sentence NEVER carries the party it lands on: the party is
 * returned separately (`on`) and shown as its own marker by the viewer. Forcing
 * it into the sentence produced lines like "moves toward its target on the acting
 * entity" — grammatically wrong for half the types, and the party is a fact of
 * the dispatcher, not a word choice.
 *
 * What the viewer cannot read, it shows RAW and marked, in both directions: an
 * unknown consequence type comes back `described: false` ("runs the undeclared
 * behavior \"x\"") and an unknown targeting type comes back with its declared
 * value and `targetingDeclared: false`. The client paints both red. Nothing is
 * dropped, and nothing is paraphrased into a meaning the code does not have.
 *
 * Pure module: no I/O, no world state, no DOM.
 *
 * @module actionSemantics
 */

import { TARGETING_TYPES } from '../../../shared/ActionVocabulary.js';

/**
 * The dispatcher's `target` vocabulary, in the words a reader needs: which party
 * of the action an effect lands on.
 * @type {Object<string, string>}
 */
export const CONSEQUENCE_TARGET_WORDS = {
    self: 'the acting component',
    target: 'the target',
    entity: 'the acting entity',
};

/**
 * How each targeting type acquires its target (shared TARGETING_TYPES values).
 * @type {Object<string, string>}
 */
const TARGETING_WORDS = {
    [TARGETING_TYPES.SPATIAL]: 'targets a point in space',
    [TARGETING_TYPES.COMPONENT]: 'targets a component',
    [TARGETING_TYPES.SELF_TARGET]: 'targets the actor itself',
    [TARGETING_TYPES.NONE]: 'needs no target',
};

/** How a `:Stat` binding left in the data is explained to the reader. */
const BINDING_NOTE = 'resolved at run time';

/**
 * One sentence per consequence type, read off its params. Each builder returns
 * the sentence alone; the party comes back separately as `on`.
 * @type {Object<string, function(Object): string>}
 */
const EFFECT_PHRASES = {
    damageComponent: (c) => `deals ${channelOf(c)} damage, scaled by ${valueOf(c)}`,
    damageRandomComponents: (c) => `deals ${channelOf(c)} damage across ${countOf(c)} random spreads of `
        + `the target's living components, each scaled by ${valueOf(c)}`,
    consumeItemAndDamage: (c) => 'consumes one item stored inside the equipped component and deals '
        + `${channelOf(c)} damage${damageSourceOf(c)}`,
    dropMaterialChunk: () => 'sheds a material chunk',
    updateComponentStatDelta: (c) => `${deltaVerbOf(c)} ${statKeyOf(c)} by ${magnitudeOf(c)}`,
    updateStat: (c) => `sets ${statKeyOf(c)}`,
    updateSpatial: () => 'is moved to a stated position',
    deltaSpatial: (c) => `moves toward its target at speed ${paramOf(c, 'speed')}`,
    dropItem: () => 'puts down the given item at the stated position',
    pickUpItem: () => 'takes the targeted item into the inventory',
    traverseDoor: (c) => `walks through ${paramOf(c, 'door')} into the room beyond`,
    placeMachine: (c) => `sets the carried machine ${paramOf(c, 'itemType')} down in the world `
        + '(static and self-running)',
    retrieveMachine: (c) => `takes the placed machine ${paramOf(c, 'machineType')} back into the `
        + 'inventory, spilling what it held',
    stimulateSensitivePart: () => 'raises the pleasure of the touched sensitive part',
    triggerEvent: (c) => `raises the ${paramOf(c, 'event')} event`,
    log: (c) => `records ${articleOf(levelOf(c))} ${levelOf(c)} entry: ${messageOf(c)}`,
};

/**
 * Interpret one action definition.
 * @param {Object} action - The raw action entry from the registry.
 * @returns {{targeting: string|null, targetingDeclared: boolean, range: number|null,
 *   narration: string|null, effects: Array<Object>, failureEffects: Array<Object>}}
 */
export function describeAction(action) {
    const def = action && typeof action === 'object' && !Array.isArray(action) ? action : {};
    const targeting = targetingOf(def.targetingType);
    return {
        targeting: targeting.text,
        targetingDeclared: targeting.declared,
        range: typeof def.range === 'number' ? def.range : null,
        narration: narrationOf(def.prose),
        effects: describeList(def.consequences),
        failureEffects: describeList(def.failureConsequences),
    };
}

/**
 * Interpret a consequence list (a single object reads as a one-item list, the
 * shape the dispatcher's own target resolution also accepts).
 * @param {Array<Object>|Object|undefined} list
 * @returns {Array<{type: string, on: string|null, text: string, described: boolean}>}
 */
function describeList(list) {
    const items = Array.isArray(list)
        ? list
        : (list && typeof list === 'object' ? [list] : []);
    const rows = [];
    for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        if (typeof item.type !== 'string' || item.type.length === 0) continue;
        rows.push(describeConsequence(item));
    }
    return rows;
}

/**
 * Interpret one consequence: what happens (`text`), and on whom (`on`, read from
 * the closed `target` vocabulary — null when the data names a party the
 * dispatcher would reject, which the raw listing still shows).
 * @param {Object} consequence - The raw consequence entry.
 * @returns {{type: string, on: string|null, text: string, described: boolean}}
 */
export function describeConsequence(consequence) {
    const type = consequence.type;
    const on = typeof consequence.target === 'string'
        ? (CONSEQUENCE_TARGET_WORDS[consequence.target] ?? null)
        : null;
    const phrase = EFFECT_PHRASES[type];
    if (!phrase) {
        return { type, on, text: `runs the undeclared behavior "${type}"`, described: false };
    }
    return { type, on, text: phrase(consequence), described: true };
}

/**
 * The prose line: how the round narration words this act. `verbPhrase` is the
 * phrase used, `instrumental.verb` the base form the same data feeds to the
 * instrumented wording (src/utils/RoundProseBuilder.js).
 * @param {*} prose - The action's `prose` block.
 * @returns {string|null}
 */
function narrationOf(prose) {
    if (!prose || typeof prose !== 'object' || Array.isArray(prose)) return null;
    const phrase = typeof prose.verbPhrase === 'string' && prose.verbPhrase.trim() !== ''
        ? prose.verbPhrase.trim()
        : null;
    if (!phrase) return null;
    const instrumental = prose.instrumental && typeof prose.instrumental === 'object'
        && typeof prose.instrumental.verb === 'string' && prose.instrumental.verb.trim() !== ''
        ? prose.instrumental.verb.trim()
        : null;
    return instrumental ? `${phrase} (instrumental: ${instrumental})` : phrase;
}

/**
 * The targeting reading. A type in the shared vocabulary gets its phrase; a type
 * outside it is returned EXACTLY as declared and flagged `declared: false`, so
 * the viewer can show it raw and red. The two states must not look alike: a
 * silent omission would let a new targeting type reach the world and read as
 * "this action has no targeting", which is a different claim entirely.
 * @param {*} targetingType
 * @returns {{text: string|null, declared: boolean}}
 */
function targetingOf(targetingType) {
    if (typeof targetingType !== 'string' || targetingType.length === 0) {
        return { text: null, declared: true };
    }
    const phrase = TARGETING_WORDS[targetingType];
    return phrase
        ? { text: phrase, declared: true }
        : { text: targetingType, declared: false };
}

// --- phrase fragments (every one reads the data, never invents a value) -------

function paramsOf(c) {
    return c.params && typeof c.params === 'object' && !Array.isArray(c.params) ? c.params : {};
}

function paramOf(c, key) {
    const value = paramsOf(c)[key];
    if (value === undefined || value === null || value === '') return BINDING_NOTE;
    return readableBinding(String(value));
}

function channelOf(c) {
    const channel = paramsOf(c).channel;
    return typeof channel === 'string' && channel.length > 0 ? channel : 'an unstated channel of';
}

function valueOf(c) {
    const value = paramsOf(c).value;
    if (value === undefined || value === null) return BINDING_NOTE;
    return readableBinding(String(value));
}

/**
 * A run-time binding (`:Physical.sharpness`, `:Movement.move*2`) says so in the
 * reader's words instead of leaving a cryptic ':' / '*' in the sentence.
 * @param {string} text
 * @returns {string}
 */
function readableBinding(text) {
    const bare = text.startsWith(':') ? text.slice(1) : text;
    const withTimes = bare.replace(/\*(\d+(?:\.\d+)?)/g, ' × $1');
    return text.startsWith(':') ? `${withTimes} (${BINDING_NOTE})` : withTimes;
}

function countOf(c) {
    const count = paramsOf(c).count;
    if (count === undefined || count === null || count === '') return 'several';
    return `${count}`;
}

/** "an info entry", "a warn entry" — the article follows the level's first letter. */
function articleOf(word) {
    return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

function damageSourceOf(c) {
    const source = typeof c.damageSource === 'string' && c.damageSource.length > 0 ? c.damageSource : null;
    return source ? `, from the ${source} (${BINDING_NOTE})` : '';
}

function statKeyOf(c) {
    const trait = typeof paramsOf(c).trait === 'string' ? paramsOf(c).trait : null;
    const stat = typeof paramsOf(c).stat === 'string' ? paramsOf(c).stat : null;
    const key = trait && stat ? `${trait}.${stat}` : (stat || trait);
    return key || 'an unstated stat';
}

/**
 * The direction of a stat delta, in words: -1 reads as "lowers", +0.1 as
 * "raises". A non-numeric delta is shown as declared.
 * @param {Object} c - The consequence.
 * @returns {string} "lowers" | "raises" | "changes"
 */
function deltaVerbOf(c) {
    const value = paramsOf(c).value;
    if (typeof value !== 'number') return 'changes';
    if (value < 0) return 'lowers';
    if (value > 0) return 'raises';
    return 'leaves';
}

/** The magnitude of a delta (the sign already lives in the verb). */
function magnitudeOf(c) {
    const value = paramsOf(c).value;
    if (typeof value === 'number') return String(Math.abs(value));
    return paramOf(c, 'value');
}

function levelOf(c) {
    return typeof c.level === 'string' && c.level.length > 0 ? c.level : 'info';
}

/**
 * The log line. `message` sits at the TOP level of a log consequence (next to
 * `level`), not inside `params` — reading only `params` reported every log as
 * having no message.
 * @param {Object} c - The consequence.
 * @returns {string}
 */
function messageOf(c) {
    const top = typeof c.message === 'string' ? c.message : null;
    const nested = typeof paramsOf(c).message === 'string' ? paramsOf(c).message : null;
    const message = (top && top.length > 0 ? top : null) ?? (nested && nested.length > 0 ? nested : null);
    return message ?? '(no message declared)';
}
