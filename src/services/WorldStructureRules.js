/**
 * WorldStructureRules — the shape rules of the two world-structure registries that
 * may be authored: `rooms` and `worldObjects`.
 *
 * WHY THIS IS ITS OWN MODULE. The same two shapes are checked at three moments, and a
 * second copy of the rules would disagree with the first the week someone adds a field:
 *   - at **boot**, by `RoomsController`, which refuses to build a room it cannot read
 *     (`CR E-8` — fail fast, before the first request);
 *   - at **plan/apply**, by `CompositionClassifier`, which quarantines a definition of
 *     the candidate instead of installing a map the world cannot walk;
 *   - at **proposal**, by `WorldProposalValidator`, which runs that same classifier and
 *     answers the model with the world's own rule list (`wiki/decisions/system-authoring.md`).
 * One rule set, three callers. The wording of a room error is part of the boot contract
 * (`test/unit/RoomsController.test.js` byte-pins it), so the messages live here and
 * nowhere else.
 *
 * WHAT IT DOES NOT DO. It builds nothing (`RoomsController` owns the room record), it
 * reads nothing (`CR B-3`), it does not know whether a room is reachable, and it holds no
 * opinion about geometry — two rooms may overlap, that is the map author's business, not a
 * rule violation. `assert*` throws the first violation (`TypeError`, the boot style, which
 * `RoomsController` has always thrown); `*Errors` returns every violation, which is what a
 * model or an operator report needs (`CR E-1`: an expected failure answered as data).
 *
 * The optional context arguments (`knownLogicalIds`, `blueprints`, `rooms`) are the
 * candidate view. Boot does not have them — it is the definition, not a candidate against
 * a definition — so those cross-reference rules fire only where a candidate exists, and a
 * boot read behaves exactly as it did before this module existed.
 *
 * @module WorldStructureRules
 */

/** The room-level constrained fields, with the values each accepts (`P-1`: the shape is the contract). */
export const ROOM_FIELD_ENUMS = Object.freeze({
    ceiling: Object.freeze(['low', 'high', 'vaulted', 'open']),
    condition: Object.freeze(['pristine', 'worn', 'decaying', 'derelict']),
    power: Object.freeze(['live', 'flickering', 'dead'])
});

/** The constrained fields of a room's `atmosphere` block. */
export const ATMOSPHERE_ENUMS = Object.freeze({
    lightLevel: Object.freeze(['bright', 'dim', 'dark', 'flickering']),
    airQuality: Object.freeze(['clean', 'stale', 'smoky', 'toxic']),
    fog: Object.freeze(['none', 'hazy', 'thick'])
});

/** The legacy door edge names (`{ edge, offset }`), kept for backward compatibility. */
export const DOOR_EDGES = Object.freeze(['left', 'right', 'top', 'bottom']);

/**
 * True for the plain object shape (arrays and null are values, not containers).
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Rule errors for one door `position` — `{ x, y }` or the legacy `{ edge, offset }`.
 * @param {unknown} position
 * @param {string} roomId - the room being read, for the message
 * @param {string} doorName
 * @returns {Array<string>} every violation, in the order the checks run
 */
export function doorPositionErrors(position, roomId, doorName) {
    const errors = [];
    if (!isPlainObject(position)) {
        return [`Room '${roomId}' door '${doorName}' position must have either { x, y } or { edge, offset }`];
    }
    // Direct X/Y format (the preferred one).
    if (position.x !== undefined || position.y !== undefined) {
        if (typeof position.x !== 'number') {
            errors.push(`Room '${roomId}' door '${doorName}' position.x must be a number`);
        }
        if (typeof position.y !== 'number') {
            errors.push(`Room '${roomId}' door '${doorName}' position.y must be a number`);
        }
        return errors;
    }
    // Legacy edge/offset format.
    if (position.edge !== undefined || position.offset !== undefined) {
        if (!DOOR_EDGES.includes(position.edge)) {
            errors.push(`Room '${roomId}' door '${doorName}' has invalid edge '${position.edge}'`);
        }
        if (typeof position.offset !== 'number' || position.offset < 0 || position.offset > 1) {
            errors.push(`Room '${roomId}' door '${doorName}' offset must be a number between 0 and 1`);
        }
        return errors;
    }
    errors.push(`Room '${roomId}' door '${doorName}' position must have either { x, y } or { edge, offset }`);
    return errors;
}

/**
 * Rule errors for one room's `atmosphere` block. Absent is fine; the block is optional.
 * @param {string} logicalId
 * @param {unknown} atmosphere
 * @returns {Array<string>}
 */
export function atmosphereErrors(logicalId, atmosphere) {
    if (atmosphere == null) return [];
    if (!isPlainObject(atmosphere)) {
        return [`Room '${logicalId}' atmosphere must be an object`];
    }
    const errors = [];
    const check = (value, ok, message) => {
        if (value !== undefined && !ok) errors.push(`Room '${logicalId}' ${message}`);
    };
    check(atmosphere.temperature, typeof atmosphere.temperature === 'number' && Number.isFinite(atmosphere.temperature),
        'atmosphere.temperature must be a finite number');
    check(atmosphere.lightLevel, typeof atmosphere.lightLevel === 'string' && ATMOSPHERE_ENUMS.lightLevel.includes(atmosphere.lightLevel),
        `atmosphere.lightLevel must be one of ${ATMOSPHERE_ENUMS.lightLevel.join(', ')}`);
    check(atmosphere.lightColor, typeof atmosphere.lightColor === 'string', 'atmosphere.lightColor must be a string');
    check(atmosphere.humidity, typeof atmosphere.humidity === 'number' && Number.isFinite(atmosphere.humidity),
        'atmosphere.humidity must be a finite number');
    check(atmosphere.airQuality, typeof atmosphere.airQuality === 'string' && ATMOSPHERE_ENUMS.airQuality.includes(atmosphere.airQuality),
        `atmosphere.airQuality must be one of ${ATMOSPHERE_ENUMS.airQuality.join(', ')}`);
    check(atmosphere.fog, typeof atmosphere.fog === 'string' && ATMOSPHERE_ENUMS.fog.includes(atmosphere.fog),
        `atmosphere.fog must be one of ${ATMOSPHERE_ENUMS.fog.join(', ')}`);
    for (const [fieldName, value] of [['smell', atmosphere.smell], ['ambientSound', atmosphere.ambientSound]]) {
        check(value, typeof value === 'string', `atmosphere.${fieldName} must be a string`);
    }
    return errors;
}

/**
 * Rule errors for one room definition.
 *
 * The free-text environment fields (`surface`, `acoustic`, `lightSource`) accept any
 * non-empty string; `ceiling`, `condition` and `power` are constrained enums because the
 * prose layer maps them. `connections` is required and may be empty — a room with no door
 * is legal data, it is only unreachable (the runtime lever refuses that, `create_room`).
 *
 * @param {string} logicalId - the key the world reads
 * @param {unknown} def
 * @param {Object} [context]
 * @param {Array<string>|Set<string>|null} [context.knownLogicalIds] - every room key the
 *   candidate holds. When given, a connection to a room that is not in it is a violation;
 *   when absent (boot) the target is not cross-checked, exactly as before.
 * @returns {Array<string>} every violation, in the order the checks run
 */
export function roomDefinitionErrors(logicalId, def, { knownLogicalIds = null } = {}) {
    if (!isPlainObject(def)) {
        return [`Room '${logicalId}' must be an object`];
    }
    const errors = [];

    if (typeof def.name !== 'string' || def.name.trim() === '') {
        errors.push(`Room '${logicalId}' must have a non-empty name`);
    }
    for (const [fieldName, value] of [
        ['surface', def.surface],
        ['acoustic', def.acoustic],
        ['lightSource', def.lightSource]
    ]) {
        if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
            errors.push(`Room '${logicalId}' ${fieldName} must be a non-empty string when present`);
        }
    }
    for (const [fieldName, value, valid] of [
        ['ceiling', def.ceiling, ROOM_FIELD_ENUMS.ceiling],
        ['condition', def.condition, ROOM_FIELD_ENUMS.condition],
        ['power', def.power, ROOM_FIELD_ENUMS.power]
    ]) {
        if (value !== undefined && (typeof value !== 'string' || !valid.includes(value))) {
            errors.push(`Room '${logicalId}' ${fieldName} must be one of ${valid.join(', ')}`);
        }
    }

    if (!isPlainObject(def.connections)) {
        errors.push(`Room '${logicalId}' must have a connections object`);
    } else {
        for (const [door, connectionData] of Object.entries(def.connections)) {
            if (typeof door !== 'string' || door.trim() === '') {
                errors.push(`Room '${logicalId}' connection must have a non-empty door name`);
            }
            const target = typeof connectionData === 'string'
                ? connectionData
                : (isPlainObject(connectionData) ? connectionData.target : undefined);
            if (typeof connectionData === 'string') {
                if (connectionData.trim() === '') {
                    errors.push(`Room '${logicalId}' connection '${door}' must have a non-empty target`);
                }
            } else if (isPlainObject(connectionData)) {
                if (typeof connectionData.target !== 'string' || connectionData.target.trim() === '') {
                    errors.push(`Room '${logicalId}' connection '${door}' must have a non-empty string target`);
                }
                if (connectionData.position !== undefined) {
                    errors.push(...doorPositionErrors(connectionData.position, logicalId, door));
                }
            } else {
                errors.push(`Room '${logicalId}' connection '${door}' must be a string or object`);
            }
            // A target nobody can resolve is a door that leads nowhere. Only checked where
            // a candidate exists to check it against (`boot` reads the definition, not a
            // candidate of one, and has never rejected this).
            if (knownLogicalIds && typeof target === 'string' && target.trim() !== '') {
                const known = knownLogicalIds instanceof Set
                    ? knownLogicalIds.has(target)
                    : Array.from(knownLogicalIds).includes(target);
                if (!known) {
                    errors.push(`Room '${logicalId}' connection '${door}' targets unknown room '${target}'`);
                }
            }
        }
    }

    if (typeof def.x !== 'number' || typeof def.y !== 'number') {
        errors.push(`Room '${logicalId}' must have numeric x, y coordinates`);
    }
    if (typeof def.width !== 'number' || typeof def.height !== 'number') {
        errors.push(`Room '${logicalId}' must have numeric width, height`);
    }
    errors.push(...atmosphereErrors(logicalId, def.atmosphere));
    return errors;
}

/**
 * Rule errors for a whole `rooms` registry content, keyed by room.
 * @param {unknown} defs
 * @param {Object} [context] - see `roomDefinitionErrors`
 * @returns {Array<string>}
 */
export function roomDefinitionsErrors(defs, { knownLogicalIds = null } = {}) {
    if (!isPlainObject(defs)) return ['Room definitions must be an object'];
    const known = knownLogicalIds ?? Object.keys(defs);
    const errors = [];
    for (const [logicalId, def] of Object.entries(defs)) {
        errors.push(...roomDefinitionErrors(logicalId, def, { knownLogicalIds: known }));
    }
    return errors;
}

/**
 * Boot's fast fail: throw the first violation of a whole `rooms` content. `RoomsController`
 * has always refused to build on a definition it cannot read, with a `TypeError` naming the
 * room and the field (`CR E-8`).
 * @param {unknown} defs
 * @throws {TypeError} the first violation
 */
export function assertRoomDefinitions(defs) {
    const errors = roomDefinitionsErrors(defs);
    if (errors.length > 0) throw new TypeError(errors[0]);
}

/**
 * Rule errors for one `worldObjects` entry (a prop).
 *
 * A prop is a real entity built from a blueprint, materialised in a room
 * (`wiki/decisions/world-structure-authoring.md`). So its two references have to resolve:
 * the `blueprint` must be a blueprint of the definition, and the `room` must be a room key
 * of it. `position` is room-relative and optional — absent means the room centre.
 *
 * @param {string} key - the registry key of the prop
 * @param {unknown} def
 * @param {Object} [context]
 * @param {Object<string, any>|Array<string>|null} [context.blueprints] - the blueprint keys
 *   the candidate holds; absent means "cannot cross-check", not "no blueprints".
 * @param {Object<string, any>|Array<string>|null} [context.rooms] - the room keys it holds.
 * @returns {Array<string>}
 */
export function worldObjectDefinitionErrors(key, def, { blueprints = null, rooms = null } = {}) {
    if (!isPlainObject(def)) {
        return [`worldObjects '${key}' must be an object`];
    }
    const errors = [];
    const keysOf = (source) => (Array.isArray(source) ? source : Object.keys(source ?? {}));

    if (def.name !== undefined && typeof def.name !== 'string') {
        errors.push(`worldObjects '${key}' name must be a string when present`);
    }
    if (typeof def.blueprint !== 'string' || def.blueprint.trim() === '') {
        errors.push(`worldObjects '${key}' must name a blueprint`);
    } else if (blueprints && !keysOf(blueprints).includes(def.blueprint)) {
        errors.push(`worldObjects '${key}' targets unknown blueprint '${def.blueprint}'`);
    }
    if (def.room !== undefined) {
        if (typeof def.room !== 'string' || def.room.trim() === '') {
            errors.push(`worldObjects '${key}' room must be a non-empty string when present`);
        } else if (rooms && !keysOf(rooms).includes(def.room)) {
            errors.push(`worldObjects '${key}' targets unknown room '${def.room}'`);
        }
    }
    if (def.position !== undefined) {
        if (!isPlainObject(def.position)) {
            errors.push(`worldObjects '${key}' position must be an object { x, y }`);
        } else {
            for (const axis of ['x', 'y']) {
                if (def.position[axis] !== undefined
                    && (typeof def.position[axis] !== 'number' || !Number.isFinite(def.position[axis]))) {
                    errors.push(`worldObjects '${key}' position.${axis} must be a finite number`);
                }
            }
        }
    }
    return errors;
}
