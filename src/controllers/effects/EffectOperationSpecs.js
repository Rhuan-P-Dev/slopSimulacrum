/**
 * EffectOperationSpecs — the parameter law of every effect operation, in ONE place.
 *
 * WHY A SEPARATE MODULE. Two readers must agree on what an operation's `params`
 * look like, and the repository's own precedent for that is a shared rules module
 * (`src/services/WorldStructureRules.js`, read by the plan, the proposal and boot
 * so all three say one thing):
 *   - `EffectsController` narrows every definition at the edge, before the world
 *     ever sees it (`CR T-1`, `CR T-2`);
 *   - `EffectEngine` narrows the params of a *runtime* application (the operator
 *     may pass an override, and an effect applied from code has not been through
 *     the registry).
 * Duplicating the law would let the two drift, and the drift is silent: a
 * definition the boot accepted and the engine misapplies.
 *
 * The law is deliberately SHALLOW. Each spec says which params exist, their type,
 * and whether they are required — it does not encode ranges, ownership or whether
 * the target actually carries the named trait. Those are per-application facts the
 * engine checks against the live world; a definition cannot state them.
 *
 * Unknown parameter keys are an ERROR, not a shrug. A definition carrying
 * `statDelta` with `{"traid": "Physical"}` would otherwise load, do nothing, and
 * cost an afternoon to find.
 *
 * WHAT THIS MODULE DOES NOT DO. It never performs an operation, never touches the
 * world, and never reads a registry — it is a table plus a checker. It has no Node
 * globals, so a test can exercise it directly.
 *
 * @module src/controllers/effects/EffectOperationSpecs
 */

import { EFFECT_OPERATIONS, isEffectOperation } from '../../../shared/EffectVocabulary.js';

/**
 * The value types a parameter may declare. Narrow on purpose: the parameter set of
 * every operation is small and scalar, and anything richer than these means the op
 * is carrying a sub-language (`CR SEC-4`).
 * @type {Object.<string, string>}
 */
const PARAM_TYPES = Object.freeze({
    STRING: 'string',
    NUMBER: 'number',
    INTEGER: 'integer',
    BOOLEAN: 'boolean',
});

/**
 * Shorthand for the required-scalar rows that make up most of the table.
 * @param {string} type
 * @returns {{type: string, required: true}}
 */
const req = (type) => Object.freeze({ type, required: true });
/** Shorthand for an optional scalar. */
const opt = (type) => Object.freeze({ type, required: false });

/**
 * One row per operation id: the params it accepts, and a one-line note naming the
 * executor it adapts so a reader of a definition can find the code that runs it.
 *
 * `value` is a finite NUMBER everywhere in this table, never a `:Trait.stat`
 * placeholder string. A placeholder is resolved by the consequence dispatcher
 * against the ACTING entity of an action in flight; an effect applied by the live
 * operator, by a world law or by an inborn body effect has no acting entity, so
 * the same string would mean a different thing per caller. Effects state numbers.
 *
 * @type {Object.<string, {params: Object.<string, {type: string, required: boolean}>, via: string}>}
 */
export const EFFECT_OPERATION_SPECS = Object.freeze({
    [EFFECT_OPERATIONS.STAT_DELTA]: {
        params: Object.freeze({ trait: req(PARAM_TYPES.STRING), stat: req(PARAM_TYPES.STRING), value: req(PARAM_TYPES.NUMBER) }),
        via: 'StatConsequenceHandler via ComponentController.updateComponentStatDelta (the stat choke point)',
    },
    [EFFECT_OPERATIONS.STAT_SET]: {
        params: Object.freeze({ trait: req(PARAM_TYPES.STRING), stat: req(PARAM_TYPES.STRING), value: req(PARAM_TYPES.NUMBER) }),
        via: 'ComponentController.updateComponentStat (the engine captures the prior value to undo it)',
    },
    [EFFECT_OPERATIONS.ADD_CONDITION]: {
        params: Object.freeze({ condition: req(PARAM_TYPES.STRING) }),
        via: 'ComponentController.addCondition (Physical.conditions, read by the LLM context)',
    },
    [EFFECT_OPERATIONS.REMOVE_CONDITION]: {
        params: Object.freeze({ condition: req(PARAM_TYPES.STRING) }),
        via: 'ComponentController.removeCondition',
    },
    [EFFECT_OPERATIONS.GRANT_FLAG]: {
        params: Object.freeze({ flag: req(PARAM_TYPES.STRING) }),
        via: 'ComponentController.addGrantedFlag (Physical.grantedFlags)',
    },
    [EFFECT_OPERATIONS.DAMAGE_COMPONENT]: {
        params: Object.freeze({ channel: req(PARAM_TYPES.STRING), value: req(PARAM_TYPES.NUMBER) }),
        via: 'DamageConsequenceHandler (the damage pipeline, per-material split included)',
    },
    [EFFECT_OPERATIONS.DAMAGE_RANDOM_COMPONENTS]: {
        params: Object.freeze({
            channel: req(PARAM_TYPES.STRING),
            value: req(PARAM_TYPES.NUMBER),
            count: req(PARAM_TYPES.INTEGER),
        }),
        via: 'DamageConsequenceHandler damageRandomComponents',
    },
    [EFFECT_OPERATIONS.DROP_MATERIAL_CHUNK]: {
        params: Object.freeze({}),
        via: 'MaterialChunkDropHandler (self-describing chunk_<material> ground token)',
    },
    [EFFECT_OPERATIONS.MOVE_BY]: {
        params: Object.freeze({ dx: req(PARAM_TYPES.NUMBER), dy: req(PARAM_TYPES.NUMBER) }),
        via: 'SpatialConsequenceHandler deltaSpatial, with NO aim: the effect states the vector, the action-in-flight target normalisation is not available',
    },
    [EFFECT_OPERATIONS.MOVE_TO]: {
        params: Object.freeze({ x: req(PARAM_TYPES.NUMBER), y: req(PARAM_TYPES.NUMBER) }),
        via: 'SpatialConsequenceHandler updateSpatial (absolute set)',
    },
    [EFFECT_OPERATIONS.TRAVERSE_DOOR]: {
        params: Object.freeze({ door: req(PARAM_TYPES.STRING) }),
        via: 'DoorTraversalHandler - the door is named and resolved against the entity CURRENT room at apply time, so the standing-at-the-door law still applies to an effect',
    },
    [EFFECT_OPERATIONS.ADD_COMPONENT]: {
        params: Object.freeze({
            componentType: req(PARAM_TYPES.STRING),
            slot: opt(PARAM_TYPES.STRING),
        }),
        via: 'the blueprint mount path (EntityController + capability re-evaluation); never a hand-appended component',
    },
    [EFFECT_OPERATIONS.REMOVE_COMPONENT]: {
        params: Object.freeze({}),
        via: 'StateEntityController.removeComponent plus the removal cascade it owns',
    },
    [EFFECT_OPERATIONS.LOG]: {
        params: Object.freeze({ message: req(PARAM_TYPES.STRING), level: opt(PARAM_TYPES.STRING) }),
        via: 'LogConsequenceHandler (never the acting entity sentence: an effect has no actor to attribute)',
    },
    [EFFECT_OPERATIONS.EMIT_EVENT]: {
        params: Object.freeze({ eventType: req(PARAM_TYPES.STRING) }),
        via: 'EventConsequenceHandler triggerEvent',
    },
});

/**
 * Validate one operation object: `{ op, params }`.
 *
 * @param {unknown} operation - the raw entry from a definition (`operations` / `perRound`).
 * @param {string} where - a phrase naming the list, used in the error text.
 * @returns {string[]} error messages; empty when the operation is well formed.
 */
export function validateEffectOperation(operation, where = 'operation') {
    const errors = [];
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
        return [`${where} must be an object naming an operation`];
    }
    const { op, params } = operation;
    if (!isEffectOperation(op)) {
        errors.push(`${where} names the operation "${String(op)}", which is not in shared/EffectVocabulary.js`);
        return errors;
    }
    const spec = EFFECT_OPERATION_SPECS[op];
    if (!spec) {
        // A vocabulary id with no spec is a code gap, not a data problem: the table
        // and the vocabulary are one commit (`CR T-4` names this fall-through).
        errors.push(`the operation "${op}" has no parameter spec in EffectOperationSpecs`);
        return errors;
    }
    if (params === undefined || params === null) {
        const required = Object.keys(spec.params);
        if (required.length > 0) errors.push(`the operation "${op}" requires params (${required.join(', ')})`);
        return errors;
    }
    if (typeof params !== 'object' || Array.isArray(params)) {
        errors.push(`the operation "${op}" has params of type ${typeof params}, expected an object`);
        return errors;
    }
    for (const [key, rule] of Object.entries(spec.params)) {
        const value = params[key];
        if (value === undefined || value === null) {
            if (rule.required) errors.push(`the operation "${op}" is missing the required param "${key}"`);
            continue;
        }
        const message = checkScalar(value, rule.type, `${op}.${key}`);
        if (message) errors.push(message);
    }
    for (const key of Object.keys(params)) {
        if (!(key in spec.params)) {
            errors.push(`the operation "${op}" has no param "${key}" (known: ${Object.keys(spec.params).join(', ') || 'none'})`);
        }
    }
    return errors;
}

/**
 * True when `op` is a declared operation with a spec. Used by the engine before it
 * looks for an adapter, so a spec-less id is reported as the code gap it is.
 * @param {unknown} op
 * @returns {boolean}
 */
export function hasOperationSpec(op) {
    return isEffectOperation(op) && Object.prototype.hasOwnProperty.call(EFFECT_OPERATION_SPECS, op);
}

/**
 * @param {unknown} value
 * @param {string} type - a PARAM_TYPES value
 * @param {string} label
 * @returns {string|null} an error message, or null when the value fits the type
 */
function checkScalar(value, type, label) {
    if (type === PARAM_TYPES.STRING) {
        return (typeof value === 'string' && value.trim() !== '')
            ? null
            : `${label} must be a non-empty string`;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${label} must be a finite number (got ${JSON.stringify(value)})`;
    }
    if (type === PARAM_TYPES.INTEGER && !Number.isInteger(value)) {
        return `${label} must be an integer (got ${value})`;
    }
    if (type === PARAM_TYPES.BOOLEAN && typeof value !== 'boolean') {
        // unreachable while NUMBER is checked first, kept so a BOOLEAN row cannot lie
        return `${label} must be a boolean`;
    }
    return null;
}
