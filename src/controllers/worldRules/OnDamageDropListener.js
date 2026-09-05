/**
 * OnDamageDropListener — the enforcement arm of the world-rules layer for the
 * `onDamage` event rule (data/world_rules.json).
 *
 * It is a FOCUSED ACTOR (not a state owner), the same shape as
 * MaterialChunkDropHandler: it reads component/entity/material state via the facade's
 * public API and writes self-describing ground records into droppedItems. It never
 * calls updateComponentStat*, so it cannot re-enter the damage hook or disturb the
 * in-flight stat update.
 *
 * Why it is a listener rather than a consequence: the onDamage law is
 * source-agnostic — it fires on ANY weakening of a component stat (a punch, an IC
 * corrosion tick, a holding-cost drain, a stat effect), not only on an action in
 * flight. The only place every such weakening funnels through is the component stat
 * choke point (ComponentController.updateComponentStat / updateComponentStatDelta),
 * so this listener subscribes to the new damage-listener list there (design §3.1/§3.3).
 *
 * The token it drops is the SAME kind of item the chunk system produces: a
 * self-describing `chunk_<material>` ground record built by the shared
 * materialChunkToken helpers (design §3.6), so no client/recipe changes are needed.
 *
 * @module OnDamageDropListener
 */

import Logger from '../../utils/Logger.js';
import { writeDroppedItem } from '../consequences/DropItemHandler.js';
import { sampleDiskPoint, DEFAULT_TRIGGER_RADIUS } from '../../utils/DiskSampler.js';
import { CHUNK_ITEM_TYPE_PREFIX } from '../../utils/Constants.js';
import { getDefinitionVolume } from '../../utils/definitionVolume.js';
import { computeChunkVolume, buildChunkItemDef } from '../../utils/materialChunkToken.js';
import { TRAIT_GROUPS, STAT_NAMES, EXISTENCE_GONE_AT } from '../../../shared/StatVocabulary.js';

class OnDamageDropListener {
    /**
     * @param {Object} [deps] - Named dependencies.
     * @param {MaterialController|null} [deps.materialController] - Owns the drop-rates
     *   registry + composition math. Null-tolerant: feature off → nominal floor tokens
     *   only (and those are skipped when the floor is 0).
     * @param {WorldRulesController|null} [deps.worldRulesController] - Owns the
     *   validated onDamage entries. Null-tolerant: unwired → the listener is a no-op.
     */
    constructor(deps = {}) {
        // The facade arrives post-construction via setWorldStateController (the same
        // setter pattern the consequence handlers use) — the listener must not be
        // constructed with a facade reference (composition ordering).
        this.worldStateController = null;
        this.materialController = deps.materialController || null;
        this.worldRulesController = deps.worldRulesController || null;
        /**
         * Public, DOCUMENTED test seam: the Bernoulli draw source. Production always
         * uses Math.random; tests may replace it with a deterministic function (e.g.
         * () => 0.01 to force success, () => 1 to force failure) to pin the new roll.
         * Never set this in production.
         * @public (test seam) — the underscore prefix is intentional legacy; this
         *   property is the documented cross-suite pin point (design §7.3/§7.5).
         * @type {() => number}
         */
        this._randomFn = Math.random;
    }

    /**
     * Injects the world-state facade (post-construction, from the composition root).
     * @param {WorldStateController} world - The facade.
     */
    setWorldStateController(world) {
        this.worldStateController = world;
    }

    /**
     * The damage-event listener body. Called (synchronously) from the component stat
     * choke point whenever a component stat weakens. Every step is null-tolerant: a
     * failed pre-condition returns silently (or with a single warn) and never throws,
     * never leaves a partial write (the batch is written once, at the end, only if
     * non-empty). See design §3.3 for the numbered steps.
     *
     * @param {string} componentId - The damaged component instance id.
     * @param {string} traitId - The trait group of the weakened stat.
     * @param {string} statName - The name of the weakened stat.
     * @param {number} oldValue - The stat value before the change.
     * @param {number} newValue - The stat value after the change.
     */
    handleDamage(componentId, traitId, statName, oldValue, newValue) {
        const world = this.worldStateController;
        if (!world) return;

        // Fast path: file degraded or rule absent costs one getter call and nothing
        // else. (getOnDamageRules() returns [] when unwired/degraded/empty.)
        const entries = this.worldRulesController?.getOnDamageRules() ?? [];
        if (!Array.isArray(entries) || entries.length === 0) return;

        // Resolve the component; a vanished / non-component target is a no-op.
        const comp = world.getComponent?.(componentId);
        if (!comp || !comp.type) return;

        // Total-loss skip (D10 mirror, design §3.5): when existence is driven to <= 0
        // the break/removal cascade already owns the total loss of that component, so
        // the hook is silent for lethal hits (there is no partial-matter source left).
        if (traitId === TRAIT_GROUPS.PHYSICAL && statName === STAT_NAMES.EXISTENCE
            && typeof newValue === 'number' && newValue <= EXISTENCE_GONE_AT) {
            return;
        }

        // Resolve once (shared by every entry).
        const entity = world.getEntity?.(comp.entityId);
        if (!entity) return;

        const byType = world.componentController?.getComponentMaterialsByType?.() || {};
        const materials = byType[comp.type];
        if (!Array.isArray(materials) || materials.length === 0) {
            Logger.warn(`[OnDamageDropListener] No composition for component type "${comp.type}" (${componentId}) — no token.`);
            return;
        }
        const recipeVolume = getDefinitionVolume(world.componentController?.getComponentDefinition?.(comp.type));
        const materialRegistry = world.getMaterialRegistry?.()?.materials || {};

        // damageAmount: the amount actually removed (clamped-loss semantics). Both
        // hook sites pass numeric values; re-validate defensively.
        if (typeof oldValue !== 'number' || typeof newValue !== 'number') return;
        const damageAmount = Math.min(Math.max(oldValue - newValue, 0), Math.max(0, oldValue));

        const minChunkVolume = this.materialController?.getMinChunkVolume() ?? 0;
        const room = entity.location || null;
        const cx = entity.spatial?.x ?? 0;
        const cy = entity.spatial?.y ?? 0;
        const isExistence = traitId === TRAIT_GROUPS.PHYSICAL && statName === STAT_NAMES.EXISTENCE;

        // Batched ground write (narrow-deps stub, the chunk handler's own pattern):
        // accumulate into a local batch and write once, at the end.
        const batch = {};
        const narrowDeps = {
            getDroppedItems: () => batch,
            setDroppedItems: (items) => { Object.assign(batch, items); }
        };
        const dropped = [];

        // Shared resolution context for the per-entry host_material token helper
        // (built once from the resolve-once locals above; the Bernoulli roll stays
        // in the loop below so entry independence is preserved).
        const ctx = {
            comp, materials, recipeVolume, damageAmount, minChunkVolume,
            isExistence, room, cx, cy, narrowDeps, materialRegistry
        };

        // Per entry, in array order — the independence loop: each entry is a separate
        // Bernoulli trial; a failure of one never short-circuits the others.
        for (const entry of entries) {
            if (!(this._randomFn() < entry.percentage)) continue;

            switch (entry.drop) {
                case 'host_material': {
                    const token = this._dropHostMaterialToken(ctx);
                    if (token) dropped.push(token);
                    break;
                }
                default:
                    // Unreachable if validation held (only known tokens are stored);
                    // defense in depth.
                    Logger.warn(`[OnDamageDropListener] Unknown drop token "${entry.drop}" — entry skipped.`);
                    break;
            }
        }

        if (dropped.length > 0) {
            world.setDroppedItems(batch);
            Logger.info(`[OnDamageDropListener] Dropped ${dropped.length} onDamage token(s) for ${componentId}: ${JSON.stringify(dropped)}`);
        }
    }

    /**
     * Writes one `host_material` token for a successfully-rolled entry into the
     * caller's batch. Resolves the largest-fraction (primary) material, computes
     * the token volume (D7 matter math for existence damage; the nominal floor
     * for non-existence stat damage), samples a ground point in the trigger disk,
     * and writes the self-describing chunk record (the shared materialChunkToken
     * mechanics — one item identity for all three drop streams).
     *
     * Skips (returns null, no write) when: the primary material cannot be
     * resolved (warns), a non-existence drop has a 0 floor (feature off), or the
     * disk sample fails.
     *
     * @param {Object} ctx - Shared resolution context built once by handleDamage
     *   (comp, materials, recipeVolume, damageAmount, minChunkVolume, isExistence,
     *   room, cx, cy, narrowDeps, materialRegistry).
     * @returns {{ itemType: string, volume: number }|null} The token written, or null when skipped.
     * @private
     */
    _dropHostMaterialToken(ctx) {
        const primary = this.materialController?.getPrimaryMaterial(ctx.materials) ?? null;
        if (!primary) {
            Logger.warn(`[OnDamageDropListener] Could not resolve primary material for "${ctx.comp.type}" — entry skipped.`);
            return null;
        }

        let volume;
        if (ctx.isExistence) {
            // Existence damage: D7 volume lever (total-loss already skipped upstream).
            const dropConfig = this.materialController?.getDropRate(primary.material) ?? null;
            volume = computeChunkVolume(dropConfig, ctx.damageAmount, primary.fraction, ctx.recipeVolume, ctx.minChunkVolume);
        } else {
            // Non-existence stat decrease: nominal floor-size chip; a 0 floor means
            // the feature is off → skip rather than write a 0-volume item.
            volume = ctx.minChunkVolume;
            if (volume <= 0) return null;
        }

        const point = sampleDiskPoint(ctx.cx, ctx.cy, DEFAULT_TRIGGER_RADIUS);
        if (!point) return null;
        const itemType = CHUNK_ITEM_TYPE_PREFIX + primary.material;
        const materialName = ctx.materialRegistry[primary.material]?.name || primary.material;
        const itemDef = buildChunkItemDef(materialName, volume);
        writeDroppedItem(ctx.narrowDeps, itemType, point.x, point.y, ctx.room, ctx.comp.entityId, itemDef, []);
        return { itemType, volume };
    }
}

export default OnDamageDropListener;
