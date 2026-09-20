/**
 * EntityEnergyController — the whole-entity energy-life system (wiki/entity_attributes).
 *
 * A per-turn (round-start) energy lifecycle for the world: every round it drains
 * each active entity's energy attribute by that attribute's `drainPerTurn` (a
 * per-attribute value carried on the entity's own declaration, seeded at spawn
 * from the blueprint's entry in data/entity_attributes.json). Then it runs the
 * life-or-death check: when the energy attribute hits 0 the host is ELIMINATED —
 * its carried contents spill to the floor and the entity is despawned, via the
 * facade's `eliminateEntityByEnergy` (which owns the spill + despawn atomically).
 *
 * Design:
 *  - Reads/writes ONLY through the world-state facade's public API
 *     (getEntityAttribute / getEntityAttributeConfig / setEntityAttributeDelta /
 *     eliminateEntityByEnergy). No raw state mutation, no component stats.
 *  - No persistent world state (the attribute itself IS the state). No tick
 *     system dependency: driven from the turn system's round-start hook, same
 *     lifecycle as its peers (internalComponentController.processTurnEffects,
 *     energyFlowController.processFlowTurn).
 *  - Drain is data-driven: each entity carries its own `drainPerTurn`. Entities
 *     without an energy attribute (no entry in the data file, or no
 *     Physical.energy) drain nothing — legacy entities are untouched.
 *  - Death check: after the drain, if the live energy value hits 0, the controller
 *     calls eliminateEntityByEnergy. Double-elimination is safe (the facade
 *     no-ops on absent/inactive entities).
 *
 * Construction: named deps only — no persistent world data. The already-ready
 * world-state controller (facade) is injected post-construction via
 * setWorldStateController().
 */
import Logger from '../../utils/Logger.js';

/**
 * @class EntityEnergyController
 */
class EntityEnergyController {
    constructor() {
        /** @private {WorldStateController|null} */
        this._worldStateController = null;
    }

    /**
     * Injects the already-ready world-state controller (facade).
     * @param {WorldStateController} worldStateController
     * @public
     */
    setWorldStateController(worldStateController) {
        if (worldStateController) {
            this._worldStateController = worldStateController;
        }
    }

    /**
     * Returns the per-turn drain for a specific entity/attribute. Reads from the
     * entity's own attributesConfig (seeded at spawn from the blueprint entry in
     * data/entity_attributes.json). Returns 0 when there is no attribute / no
     * drain declared.
     * @param {string} entityId
     * @param {string} traitId
     * @param {string} statName
     * @returns {number} the per-turn drain (0 when absent).
     * @private
     */
    _getDrainPerTurn(entityId, traitId, statName) {
        const config = this._worldStateController?.getEntityAttributeConfig(entityId, traitId, statName);
        if (!config) return 0;
        return Math.max(0, Number(config.drainPerTurn) || 0);
    }

    /**
     * Finds the "energy" attribute declaration of an entity (Physical.energy).
     * Returns { traitId, statName } when the entity has that attribute declared
     * (in attributesConfig), otherwise null.
     * @param {Object} entity
     * @returns {{ traitId: string, statName: string } | null}
     * @private
     */
    _findEnergyAttribute(entity) {
        const attrConfig = entity.attributesConfig;
        if (!attrConfig || !attrConfig.Physical || !attrConfig.Physical.energy) return null;
        return { traitId: 'Physical', statName: 'energy' };
    }

    /**
     * Runs one turn of the energy lifecycle: for each active entity, drains its
     * energy attribute by its per-turn drain, then eliminates the entity when
     * its energy hits 0 (spill + despawn).
     *
     * @param {number|string} round - The current round number (used for logging).
     * @returns {number} The number of entities eliminated this turn.
     * @public
     */
    processEnergyTurn(round) {
        const wsc = this._worldStateController;
        if (!wsc) return 0;
        const stateEntityController = wsc.stateEntityController;
        if (!stateEntityController) return 0;

        // Round 0 (and any non-positive round) is the world's first, bootstrap
        // round: the IC charge step (and the round hook itself) treats `r <= 0`
        // as a no-op, so the first *real* charge is round 5. Align the drain to
        // skip round 0 as well, so the first drain lands on round 1 with a live,
        // non-empty world (no lone round-0 drain ahead of any charge).
        const r = typeof round === 'number' && Number.isFinite(round) ? round : 0;
        if (r <= 0) return 0;

        let eliminatedCount = 0;
        let drainedCount = 0;

        // Snapshot the live entities; we despawn (remove) during the loop, so
        // the snapshot array is stable across the pass. A despawned entity is
        // skipped on re-lookup (stale object, status no longer active).
        const entities = Object.values(stateEntityController.entities || {});

        for (const entity of entities) {
            // Skip stale or already-despawned entries.
            const liveEntity = stateEntityController.getEntity(entity.id);
            if (!liveEntity || liveEntity !== entity) continue;
            if (liveEntity.status !== 'active') continue;

            const energyAttr = this._findEnergyAttribute(entity);
            if (!energyAttr) continue;

            const drainPerTurn = this._getDrainPerTurn(entity.id, energyAttr.traitId, energyAttr.statName);
            if (!drainPerTurn || drainPerTurn <= 0) continue;

            // Draining: clamped into [0, max] by setEntityAttributeDelta.
            // broadcast:false — this is a per-droid per-turn write; coalesce it
            // into the turn's single full-state broadcast (the drain mustn't
            // force a full emit per droid per turn).
            if (wsc.setEntityAttributeDelta(entity.id, energyAttr.traitId, energyAttr.statName, -drainPerTurn, false)) {
                drainedCount++;
            }

            // Death check: after the drain, if the live energy value hit 0,
            // eliminate the entity (spill + despawn).
            const liveEnergy = wsc.getEntityAttribute(entity.id, energyAttr.traitId, energyAttr.statName) ?? 0;
            if (liveEnergy <= 0) {
                // Double-elimination is safe: the facade no-ops on absent/inactive
                // entities (checked here and in eliminateEntityByEnergy).
                if (wsc.eliminateEntityByEnergy(entity.id)) {
                    eliminatedCount++;
                }
            }
        }

        if (drainedCount > 0 || eliminatedCount > 0) {
            Logger.info(`[EntityEnergyController] energy lifecycle: drained ${drainedCount} entity attribute(s), eliminated ${eliminatedCount} entity(ies) (round ${round})`);
        }
        return eliminatedCount;
    }

}

export default EntityEnergyController;
