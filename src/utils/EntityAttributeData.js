/**
 * EntityAttributeData — loads and exposes the per-entity-type attribute seeds
 * (data/entity_attributes.json).
 *
 * Entity attributes are WHOLE-ENTITY stats, owned by the ENTITY (seeded from
 * the blueprint's entry at spawn) and distinct from per-component stats, which
 * live on component instances. Each entry is keyed in the flat "Group.stat"
 * wire form (identical to the organ-grant key form) and declares three things:
 *   - `value`        : the initial attribute value at spawn,
 *   - `max`          : the hard cap the value is clamped into (full-tank ceiling),
 *   - `drainPerTurn` : how much the per-turn energy step subtracts each turn (0 = none).
 *
 * getAttributes(blueprint) returns { "Group.stat": { value, max, drainPerTurn } }
 * or {} when the file is missing, malformed, or the blueprint has no entry.
 * "Missing data → nothing seeded" (legacy invariant) is honored by defaulting
 * an absent/empty file to {}.
 *
 * The file is read once and cached — it is immutable config, so no invalidation
 * is needed. Malformed entries (bad numbers, negative values) are dropped with
 * a warning rather than failing boot.
 */

import DataLoader from './DataLoader.js';
import Logger from './Logger.js';

/**
 * @type {Record<string, { value: number, max: number, drainPerTurn: number }> | null}
 */
let _cache = null;

/**
 * Returns the attribute declarations for one entity type (blueprint name).
 * @param {string|null|undefined} [blueprintName] - The blueprint/entity type name.
 * @returns {Object<string, { value: number, max: number, drainPerTurn: number }>}
 */
export function getAttributes(blueprintName) {
    if (typeof blueprintName !== 'string' || blueprintName === '') {
        return {};
    }
    const file = _loadFile();
    const rawEntries = (file.attributes && typeof file.attributes === 'object') ? file.attributes : null;
    const entry = rawEntries ? rawEntries[blueprintName] : null;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return {};
    }
    const out = {};
    for (const [keyDecl, decl] of Object.entries(entry)) {
        const parsed = _parseAttributeDecl(keyDecl, blueprintName, decl);
        if (parsed) {
            out[keyDecl] = parsed;
        }
    }
    return out;
}

/**
 * Reads data/entity_attributes.json once, caching the parse. Returns a plain
 * object (never the parsed `data/entity_attributes.json` reference is mutated
 * downstream: getAttributes deep-copies the per-decl shape it hands back).
 * @private
 */
function _loadFile() {
    if (_cache === null) {
        _cache = DataLoader.loadJsonSafe('data/entity_attributes.json', { attributes: {} });
    }
    return _cache;
}

/**
 * Validates one attribute declaration and returns a normalized { value, max,
 * drainPerTurn } object, or null when the declaration is malformed (logged and
 * dropped — a single bad attribute must not fail the whole spawn).
 * @private
 */
function _parseAttributeDecl(keyDecl, blueprintName, decl) {
    if (decl === null || typeof decl !== 'object' || Array.isArray(decl)) {
        Logger.warn(`[EntityAttributeData] Attribute "${keyDecl}" for blueprint "${blueprintName}" is not an object — dropped.`);
        return null;
    }
    const value = Number(decl.value);
    const max = Number(decl.max);
    const drainPerTurnRaw = decl.drainPerTurn === undefined ? 0 : Number(decl.drainPerTurn);
    if (!Number.isFinite(value) || value < 0 || !Number.isFinite(max) || max < 0 ||
        !Number.isFinite(drainPerTurnRaw) || drainPerTurnRaw < 0) {
        Logger.warn(`[EntityAttributeData] Attribute "${keyDecl}" for blueprint "${blueprintName}" has invalid numbers (${JSON.stringify(decl)}) — dropped.`);
        return null;
    }
    return {
        value,
        max,
        drainPerTurn: drainPerTurnRaw
    };
}

// Default export for convenience (import EntityAttributeData, { getAttributes }).
export default { getAttributes };
