/**
 * SensitivePartConsequenceHandler — the `stimulateSensitivePart` consequence
 * (the "touch" action): raises the touched droid's whole-entity Pleasure.pleasure
 * attribute by the sensitivity value of the touched body part.
 *
 * A touch is a component-targeting action: the LLM targets a specific
 * component of a victim droid, and this handler validates that the component
 * is a sensitive part (the `sensitive` flag granted by the sensitiveNerve
 * organ — data/mods/core-internal-components/internalComponents.json) and that its part type
 * carries a sensitivity value in data/mods/core-sensitive-parts/sensitiveParts.json. The
 * touched droid's pleasure meter (data/mods/core-entity-attributes/entityAttributes.json) is
 * raised by that value and clamped into [0, max] by the facade. The toucher
 * gains nothing (agreed design: only the touched droid gains).
 *
 * Failures (never raise pleasure, never throw):
 *   - no world state / no targeted component (or unknown component id);
 *   - the target component's entity is missing or not active;
 *   - the part has no `sensitive` flag (a head, a hand, ...);
 *   - the part type has no sensitivity value declared (data gap);
 *   - the touched droid has no Pleasure.pleasure attribute (any non-human droid).
 *
 * The sensitivity values are static world data: loaded once at construction
 * (same pattern as the machine registry forwarded to the place/retrieve
 * handlers). All world access goes through the facade's public API.
 *
 * @module SensitivePartConsequenceHandler
 */
import Logger from '../../utils/Logger.js';
import { FLAG_NAMES } from '../../../shared/StatVocabulary.js';
import { REGISTRY_KINDS } from '../../../shared/RegistryKinds.js';

class SensitivePartConsequenceHandler {
    /**
     * @param {Object} controllers - The set of available controllers.
     * @param {WorldStateController} controllers.worldStateController - The root state controller (facade).
     */
    constructor(controllers) {
        this.worldStateController = controllers.worldStateController || null;

        /** @private {Object<string, number>|null} Derived per-part sensitivity table. */
        this._sensitivityByPartType = null;
        /** @private {number} RegistryStore version the cached table was derived from. */
        this._sensitivityVersion = -1;
        /** @private {Object|null} Facade instance the cached table was derived through. */
        this._sensitivitySource = null;
    }

    /**
     * Per-part sensitivity values (registry kind `sensitiveParts`), `_comment`
     * skipped — the table the touch outcome is computed from.
     *
     * Derived lazily and re-derived when the world definition swaps: the
     * `RegistryStore` version is the cache key, so a mod that retunes a
     * sensitivity takes effect on the next touch rather than at the next restart.
     * The facade itself is part of the key because it is injected after
     * construction, and an empty table built before injection must not stick.
     * @returns {Object<string, number>}
     * @private
     */
    _sensitivityTable() {
        const facade = this.worldStateController;
        const version = facade?.registryStore?.version() ?? 0;
        if (this._sensitivityByPartType
            && this._sensitivityVersion === version
            && this._sensitivitySource === facade) {
            return this._sensitivityByPartType;
        }
        const file = facade?.getRegistry?.(REGISTRY_KINDS.SENSITIVE_PARTS) ?? {};
        const table = {};
        for (const [partType, value] of Object.entries(file)) {
            if (partType === '_comment') continue;
            table[partType] = value;
        }
        this._sensitivityByPartType = table;
        this._sensitivityVersion = version;
        this._sensitivitySource = facade;
        return table;
    }

    /**
     * Injects (or refreshes) the world state facade after it is fully built.
     * @param {WorldStateController} worldStateController
     * @public
     */
    setWorldStateController(worldStateController) {
        if (worldStateController) {
            this.worldStateController = worldStateController;
        }
    }

    /**
     * Raises the touched droid's Pleasure.pleasure by the sensitivity of the
     * touched body-part component (validated: sensitive flag + declared
     * value + the droid owns the pleasure meter).
     *
     * @param {string} targetId - The resolved target component id.
     * @param {Object} params - Consequence parameters (unused: the value is data).
     * @param {Object} context - Action execution context (unused).
     * @returns {{ success: boolean, message: string, data: Object|null }}
     * @private
     */
    _handleStimulateSensitivePart(targetId) {
        const wsc = this.worldStateController;
        if (!wsc || !targetId) {
            return { success: false, message: 'Touch needs a targeted component.', data: null };
        }

        const component = wsc.getComponent(targetId);
        if (!component || !component.entityId) {
            return { success: false, message: `Touch failed - unknown component ${targetId}.`, data: null };
        }

        const entity = wsc.stateEntityController?.getEntity(component.entityId);
        if (!entity || entity.status !== 'active') {
            return { success: false, message: 'Touch failed - the target droid is not active.', data: null };
        }

        // The touched part must be a sensitive part: the sensitiveNerve organ
        // marks it with the `sensitive` flag (Physical.grantedFlags on the
        // component stats).
        if (!wsc.getComponentFlags(component.id).includes(FLAG_NAMES.SENSITIVE)) {
            return {
                success: false,
                message: `Touch failed - ${component.type} is not a sensitive part.`,
                data: { partType: component.type }
            };
        }

        const sensitivity = this._sensitivityTable()[component.type];
        if (typeof sensitivity !== 'number' || !Number.isFinite(sensitivity) || sensitivity <= 0) {
            return {
                success: false,
                message: `Touch failed - no sensitivity value declared for ${component.type}.`,
                data: { partType: component.type }
            };
        }

        // The touched droid must own the pleasure meter (the two human droids;
        // any other droid type has no Pleasure.pleasure attribute).
        if (!wsc.getEntityAttributeConfig(entity.id, 'Pleasure', 'pleasure')) {
            return { success: false, message: 'Touch failed - that droid has no pleasure meter.', data: null };
        }

        // Raise: clamped into [0, max] by the facade. broadcast:false — action
        // events are coalesced into the round's broadcast, like the per-turn drain.
        const applied = wsc.setEntityAttributeDelta(entity.id, 'Pleasure', 'pleasure', sensitivity, false);
        if (!applied) {
            return { success: false, message: 'Touch failed - could not update the pleasure attribute.', data: null };
        }

        const newPleasure = wsc.getEntityAttribute(entity.id, 'Pleasure', 'pleasure') ?? 0;
        Logger.info(
            `[SensitivePartConsequenceHandler] ${entity.id} touched at ${component.type} (+${sensitivity} pleasure -> ${newPleasure})`
        );
        return {
            success: true,
            message: `${component.type} touched: +${sensitivity} pleasure (now ${newPleasure}).`,
            data: { partType: component.type, sensitivity, newPleasure }
        };
    }
}

export default SensitivePartConsequenceHandler;
