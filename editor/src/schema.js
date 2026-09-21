/**
 * schema — Static knowledge of the slopSimulacrum action system + validation.
 *
 * WHY this exists:
 *   The editor is a separate tool that must let a human author *valid* actions
 *   without booting the whole world. It therefore carries a small, data-driven
 *   description of the action contract (consequence types, their params, valid
 *   targets, valid ranges) and a pure validator that mirrors how the game
 *   executes actions.
 *
 *   The consequence-type list below is the *editor's* mirror of the runtime
 *   handler map (ConsequenceHandlers._buildHandlerMap()). It is intentionally
 *   a data table, not an import of that controller — importing the controller
 *   would pull in the entire world graph, which is heavy and not needed to
 *   render a picker. When a new handler is added to the game, the list and
 *   param spec here should be updated in lockstep (both live in one place).
 *
 *   Range expressions are validated with the *game's own* shared RangeResolver
 *   (single source of truth for the grammar), not a re-implementation.
 *
 * @module schema
 */

import { TARGETING_TYPES } from '../../shared/ActionVocabulary.js';
import {
    TRAIT_GROUPS,
    STAT_NAMES,
    TRAIT_STAT_KEY_PATTERN,
} from '../../shared/StatVocabulary.js';
import { resolveRange } from '../../shared/RangeResolver.js';

// ============================================================================
// Static knowledge: valid consequence types and their param contracts.
// Mirrors ConsequenceHandlers._buildHandlerMap(). One place to keep in sync.
// ============================================================================

/** @type {string[]} The consequence types the engine dispatches. */
export const CONSEQUENCE_TYPES = [
    'deltaSpatial',
    'updateSpatial',
    'updateStat',
    'updateComponentStatDelta',
    'damageComponent',
    'dropMaterialChunk',
    'log',
    'dropItem',
    'pickUpItem',
    'consumeItemAndDamage',
    'triggerEvent',
];

/** @type {Object<string, {required:string[], optional:string[], desc:string}>} */
export const CONSEQUENCE_PARAM_SPECS = {
    deltaSpatial: {
        required: ['speed'],
        optional: ['x', 'y'],
        desc: "Move an entity along its movement axis. `speed` is the max distance this tick (resolved via `:Trait.stat` placeholders); `x`/`y` force a direction, otherwise movement aims at targetX/targetY if present.",
    },
    updateSpatial: {
        required: ['x', 'y'],
        optional: [],
        desc: 'Set an entity to an absolute (x, y) position in room space.',
    },
    updateStat: {
        required: ['trait', 'stat', 'value'],
        optional: [],
        desc: 'Set a stat to an *absolute* value (vs. `updateComponentStatDelta`, which adds an offset). Applied across all matching components when the target is an entity.',
    },
    updateComponentStatDelta: {
        required: ['trait', 'stat', 'value'],
        optional: [],
        desc: 'Add `value` (positive or negative) to a component\'s `trait.stat`. The `:Trait.stat` placeholder in `value` scales the offset per component.',
    },
    damageComponent: {
        required: ['channel', 'value'],
        optional: ['damageSource'],
        desc: 'Deal damage to a component\'s matter along a damage `channel` (cut, impact, wear, heat, electricity, corrosion). `value` is positive and resolved via placeholders. `damageSource` is a live path (e.g. `equippedItem.firstChild.volume`) used instead of `value` for that channel.',
    },
    dropMaterialChunk: {
        required: [],
        optional: [],
        desc: 'Drop a material chunk of the damaged target onto the map. Drop chance and volume are data-driven (material drop rates + world rules); the consequence itself only names the target.',
    },
    log: {
        required: [],
        optional: ['message', 'level'],
        desc: 'Log a human-readable message (supports `:placeholders`). `message`/`level` are optional (handler defaults to "No message provided" / info) and may live at the consequence top-level (the data/actions.json format) or inside `params`; the dispatcher merges them in before dispatch.',
    },
    dropItem: {
        required: ['entityId', 'itemId', 'itemType', 'targetX', 'targetY'],
        optional: [],
        desc: 'Drop an inventory item onto the map near a target point so others can pick it up. All params are `:placeholder` values resolved at execution time.',
    },
    pickUpItem: {
        required: [
            'sourceEntityId',
            'sourceItemId',
            'sourceComponentId',
            'targetEntityId',
            'targetComponentId',
        ],
        optional: [],
        desc: 'Pick up an item from another entity or the map into the acting entity\'s component. All params are placeholders resolved at execution.',
    },
    consumeItemAndDamage: {
        required: ['channel', 'value'],
        optional: ['damageSource'],
        desc: 'Consume a stored item (e.g. a projectile) and deal channel damage. `damageSource` points at the item\'s live value (e.g. `equippedItem.firstChild.volume`) used for the damage amount.',
    },
    triggerEvent: {
        required: ['eventType'],
        optional: ['data'],
        desc: 'Fire a named event for downstream handling; `data` is an arbitrary payload.',
    },
};

/** @type {string[]} Valid `target` values on a consequence (who an effect applies to). */
export const CONSEQUENCE_TARGETS = ['self', 'target', 'entity'];

/**
 * Free variables that the game resolves into `actionParams` at execution.
 * Used to distinguish "known action-param placeholders" from "bad stat
 * references" when validating. Anything not here and not a valid Trait.stat
 * is treated as a (permitted but) unknown action param.
 * @type {ReadonlySet<string>}
 */
export const KNOWN_ACTION_PARAMS = new Set([
    'entityId',
    'itemId',
    'itemType',
    'targetX',
    'targetY',
    'targetComponentId',
    'sourceEntityId',
    'sourceItemId',
    'sourceComponentId',
    'itemVolume',
]);

// ============================================================================
// Range validation — reuses the game's RangeResolver (grammar = single source).
// ============================================================================

/**
 * Build a synthetic stat map in which *every* possible `Trait.stat` placeholder
 * resolves to a finite number. This lets us use the real resolver to detect
 * *purely syntactic* failures (bad grammar, unbalanced parens, /0, trailing
 * junk) without any placeholder being "unknown" to the parser.
 * @returns {Object<string, number>}
 */
function buildSyntheticStatMap() {
    const map = {};
    for (const group of Object.values(TRAIT_GROUPS)) {
        for (const stat of Object.values(STAT_NAMES)) {
            map[`${group}.${stat}`] = 1;
        }
    }
    return map;
}

/**
 * Validate a range expression against the real RangeResolver grammar.
 * @param {number|string|null|undefined} expression
 * @returns {{ok:boolean, value?:number, placeholders:string[], knownPlaceholders:string[], unknownPlaceholders:string[], badStatRefs:string[], note:string}}
 */
export function validateRange(expression) {
    const empty = {
        ok: false, placeholders: [], knownPlaceholders: [], unknownPlaceholders: [], badStatRefs: [], note: '',
    };
    if (typeof expression === 'number') {
        return Number.isFinite(expression)
            ? { ok: true, value: expression, placeholders: [], knownPlaceholders: [], unknownPlaceholders: [], badStatRefs: [], note: '' }
            : { ...empty, note: 'range must be a finite number' };
    }
    if (expression === null || expression === undefined || typeof expression !== 'string') {
        return { ...empty, note: 'range must be a number or an expression string' };
    }
    const trimmed = expression.trim();
    if (trimmed === '') {
        return { ...empty, note: 'range cannot be empty' };
    }
    const placeholderRegex = /:[a-zA-Z0-9_.]+/g;
    const placeholders = [...new Set((trimmed.match(placeholderRegex) || []).map((m) => m.slice(1)))];
    const base = buildSyntheticStatMap();
    const synth = { ...base, ...Object.fromEntries(placeholders.map((p) => [p, 1])) };
    const result = resolveRange(trimmed, synth, NaN);
    const resolved = Number.isFinite(result);
    const badStatRefs = placeholders.filter((p) => TRAIT_STAT_KEY_PATTERN.test(p) && !(p in base));
    const knownPlaceholders = placeholders.filter((p) => p in base);
    const unknownPlaceholders = placeholders.filter((p) => !(p in base) && !badStatRefs.includes(p));
    const note =
        resolved && badStatRefs.length === 0
            ? ''
            : resolved
                ? `references unknown stat(s): ${badStatRefs.join(', ')}`
                : 'expression does not resolve (grammar, unbalanced parens, division by zero, or trailing junk)';
    return {
        ok: resolved && badStatRefs.length === 0,
        value: resolved ? result : undefined,
        placeholders,
        knownPlaceholders,
        unknownPlaceholders,
        badStatRefs,
        note,
    };
}

// ============================================================================
// Action + registry validation (pure, no I/O).
// ============================================================================

/**
 * Validate a single action definition.
 * @param {string} name - Action key.
 * @param {*} def - Action object from data/actions.json.
 * @returns {{valid:boolean, issues:Array<{field:string,message:string,type:'error'|'warning'}>}}
 */
export function validateAction(name, def) {
    const issues = [];

    if (!def || typeof def !== 'object' || Array.isArray(def)) {
        return { valid: false, issues: [{ field: '(action body)', message: 'Action body must be an object', type: 'error' }] };
    }

    // description
    if (typeof def.description !== 'string' || def.description.trim() === '') {
        issues.push({ field: 'description', message: 'must be a non-empty string', type: 'error' });
    }

    // targetingType
    const targetType = def.targetingType;
    if (typeof targetType !== 'string' || !Object.values(TARGETING_TYPES).includes(targetType)) {
        issues.push({ field: 'targetingType', message: `must be one of ${Object.values(TARGETING_TYPES).join(', ')} (got: ${String(targetType)})`, type: 'error' });
    }

    // range
    if (def.range !== undefined && def.range !== null) {
        const rr = validateRange(def.range);
        if (!rr.ok) {
            if (rr.placeholders.length === 0) {
                // No placeholder at all, yet it did not resolve → the expression is
                // genuinely malformed (grammar error, /0, trailing junk). A clear bug.
                issues.push({ field: 'range', message: `invalid range: ${rr.note}`, type: 'error' });
            } else {
                // Unresolvable because of a placeholder. The resolver still falls back
                // at runtime, so these are soft issues, not hard failures.
                if (rr.badStatRefs.length > 0) {
                    issues.push({ field: 'range', message: `references unknown stat(s): ${rr.badStatRefs.join(', ')} (range falls back at runtime)`, type: 'warning' });
                }
                if (rr.unknownPlaceholders.length > 0) {
                    issues.push({ field: 'range', message: `uses unknown action-param placeholder(s): ${rr.unknownPlaceholders.join(', ')} (allowed but not in shipped vocab)`, type: 'warning' });
                }
            }
        }
    }

    // requirements
    if (Array.isArray(def.requirements)) {
        def.requirements.forEach((req, i) => {
            if (!req || typeof req !== 'object' || Array.isArray(req)) {
                issues.push({ field: `requirements[${i}]`, message: 'must be an object { trait, stat, minValue }', type: 'error' });
                return;
            }
            if (typeof req.trait !== 'string' || !Object.values(TRAIT_GROUPS).includes(req.trait)) {
                issues.push({ field: `requirements[${i}].trait`, message: `must be one of ${Object.values(TRAIT_GROUPS).join(', ')}`, type: 'error' });
            }
            if (typeof req.stat !== 'string' || !Object.values(STAT_NAMES).includes(req.stat)) {
                issues.push({ field: `requirements[${i}].stat`, message: `must be a known stat (e.g. ${Object.values(STAT_NAMES).slice(0, 4).join(', ')}, …)`, type: 'error' });
            }
            if (req.minValue !== undefined && (typeof req.minValue !== 'number' || !Number.isFinite(req.minValue) || req.minValue < 0)) {
                issues.push({ field: `requirements[${i}].minValue`, message: 'must be a non-negative finite number', type: 'error' });
            }
        });
    }

    // consequences + failureConsequences (shared helper)
    for (const [field, arr] of [['consequences', def.consequences], ['failureConsequences', def.failureConsequences]]) {
        validateConsequences(name, field, arr, issues);
    }

    return { valid: issues.some((i) => i.type === 'error') ? false : true, issues };
}

/**
 * Validate one consequence list under a given field name.
 * @param {string} name
 * @param {string} field - 'consequences' or 'failureConsequences'
 * @param {*} arr
 * @param {Array} issues - pushed onto
 */
function validateConsequences(name, field, arr, issues) {
    if (arr === undefined || arr === null) return; // optional, allow absent
    if (!Array.isArray(arr)) {
        issues.push({ field, message: 'must be an array of consequences', type: 'error' });
        return;
    }
    arr.forEach((conseq, i) => {
        const loc = `${field}[${i}]`;
        if (!conseq || typeof conseq !== 'object' || Array.isArray(conseq)) {
            issues.push({ field: loc, message: 'must be an object { type, target, params? }', type: 'error' });
            return;
        }
        // type
        const type = conseq.type;
        if (!type || !CONSEQUENCE_TYPES.includes(type)) {
            issues.push({ field: `${loc}.type`, message: `must be a known consequence type (e.g. ${CONSEQUENCE_TYPES.slice(0, 4).join(', ')}, …)`, type: 'error' });
            return;
        }
        // target (mandatory per the dispatcher's contract)
        if (!conseq.target || !CONSEQUENCE_TARGETS.includes(conseq.target)) {
            issues.push({ field: `${loc}.target`, message: `must be one of ${CONSEQUENCE_TARGETS.join(', ')}` , type: 'error' });
        }
        // params
        // `log` consequences in data/actions.json store message/level at the consequence's
        // top level (no `params` object); the dispatcher merges them into params before
        // invoking the handler. Mirror that merge so we validate exactly what the handler sees.
        const spec = CONSEQUENCE_PARAM_SPECS[type];
        if (spec) {
            let params = conseq.params;
            if (type === 'log') {
                const top = {};
                if (conseq.message != null) top.message = conseq.message;
                if (conseq.level != null) top.level = conseq.level;
                params = { ...params, ...top };
            }
            if (params !== undefined) {
                if (typeof params !== 'object' || Array.isArray(params)) {
                    issues.push({ field: `${loc}.params`, message: 'must be an object', type: 'error' });
                } else {
                    for (const req of spec.required) {
                        if (!(req in params) || params[req] === undefined) {
                            issues.push({ field: `${loc}.params.${req}`, message: `${spec.required.includes('channel') || spec.required.includes('value') ? 'damage/channel requires value' : 'required param'}`, type: 'error' });
                        }
                    }
                    for (const key of Object.keys(params)) {
                        if (!spec.required.includes(key) && !spec.optional.includes(key)) {
                            issues.push({ field: `${loc}.params.${key}`, message: `unknown param for ${type} (expected ${spec.required.concat(spec.optional).join(', ')} or none)`, type: 'warning' });
                        }
                    }
                }
            } else if (spec.required.length > 0) {
                issues.push({ field: `${loc}`, message: `consequence type ${type} requires params: ${spec.required.join(', ')}`, type: 'error' });
            }
        }
    });
}

/**
 * Validate a full action registry (the whole data/actions.json object).
 * @param {*} registry
 * @returns {{valid:boolean, issues:Array<{action:string|null, field:string,message:string,type:'error'|'warning'}>, count:number}}
 */
export function validateRegistry(registry) {
    const issues = [];
    if (!registry || typeof registry !== 'object' || Array.isArray(registry) || Object.keys(registry).length === 0) {
        issues.push({ action: null, field: '(registry)', message: 'registry must be a non-empty object', type: 'error' });
        return { valid: false, issues, count: 0 };
    }
    let count = 0;
    for (const name of Object.keys(registry)) {
        const { valid, issues: actionIssues } = validateAction(name, registry[name]);
        count += 1;
        for (const it of actionIssues) {
            issues.push({ action: name, field: it.field, message: it.message, type: it.type });
        }
        // Cross-check: a self_target action with no consequences is likely a bug (optional hint).
        if (valid && registry[name].targetingType === 'self_target' && (!registry[name].consequences || registry[name].consequences.length === 0)) {
            issues.push({ action: name, field: 'consequences', message: 'self-targeted action has no success consequences', type: 'warning' });
        }
    }
    return { valid: !issues.some((i) => i.type === 'error'), issues, count };
}
