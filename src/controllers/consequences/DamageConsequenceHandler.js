/**
 * DamageConsequenceHandler — Routes damage to components through the six
 * DAMAGE_CHANNELS (cut, impact, wear, fire, electricity, corrosion).
 * Single Responsibility: Apply channel-based damage to specific target components.
 *
 * Extracted from ConsequenceHandlers to adhere to the Single Responsibility Principle.
 *
 * Channel model (spec D3):
 * - A damage consequence carries a `channel` (one of DAMAGE_CHANNELS) and a raw
 *   damage `value`. The target's existence (a 0–1 matter store) is drained by a
 *   channel-aware loss: the raw damage divided by the target's resistance to that
 *   channel (a 0–100 scale derived from its material composition). Higher
 *   resistance absorbs more, so the existence loss shrinks — a highly resistant
 *   material loses almost nothing to the same hit.
 * - Deplection conceptually begins at the least resistant material in the target's
 *   composition; the blended resistance (from propertyTraitMapping.derivedStats)
 *   is the single-source representation of that in the basic set.
 *
 * Target Resolution:
 * - 'self'    → Damages the source component that fulfilled the action's requirements.
 * - 'target'  → Damages the explicitly targeted component (from actionParams).
 * - 'entity'  → Damages ALL components of the target entity.
 *
 * Equipped Item Routing:
 * - When targetId is an equipped item (eqId), damage is applied to EquippedItemStatsController
 *   so that item existence drain (e.g., from cut action) is tracked independently.
 *
 * @module DamageConsequenceHandler
 */

import { DAMAGE_CHANNELS } from '../../../shared/StatVocabulary.js';
import IdResolver from '../../utils/IdResolver.js';
import { PUBLISHED_CHANNEL_LOSS_KEY } from '../../utils/Constants.js';
import { channelLossFromResistance } from '../../utils/channelLoss.js';

class DamageConsequenceHandler {
    /**
     * @param {Object} controllers - The set of available controllers.
     * @param {WorldStateController} controllers.worldStateController - The root state controller.
     * @param {EquippedItemStatsController} [controllers.equippedItemStats] - The equipped item stats manager (for equipped item damage routing).
     */
    constructor(controllers) {
       this.worldStateController = controllers.worldStateController;
       this.equippedItemStats = controllers.equippedItemStats || null;
       // Feature 1: the MaterialController owns the per-material damage-type
       // distributions (data/materialDamageTypes.json). Null-tolerant so the
       // feature degrades gracefully (declared channel keeps 100%) when absent.
       this.materialController = controllers.materialController || null;
   }

    /**
     * Applies damage to a target by draining its existence.
     *
     * When the consequence carries a `channel` (the new DAMAGE_CHANNELS model),
     * the damage is routed through that channel and converted to a channel-aware
     * existence loss using the target's resistance to the channel. Otherwise it
     * falls back to a legacy stat delta (back-compat for any action still using
     * an explicit trait/stat pair).
     *
     * @param {string} targetId - The resolved target ID (component or entity ID based on target type).
     * @param {Object} resolvedParams - Object containing channel and value (damage amount), or legacy trait/stat/value.
     * @param {Object} context - Context containing actionParams, fulfillingComponents, and target type info.
     * @returns {Object} { success: boolean, message: string, data: any }
     */
    _handleDamageComponent(targetId, resolvedParams, context) {
        const { channel, value } = resolvedParams;
        const targetType = context?.actionParams?.consequenceTarget || 'target';

        // Channel-based damage (the new DAMAGE_CHANNELS model). The context is
        // passed through so the attacker's per-material damage-type split (feature
        // 1) can be resolved; when unresolvable it degrades to the declared channel.
        if (channel) {
            return this._handleChannelDamage(targetId, channel, value, targetType, context);
        }

        // Legacy stat-delta path (back-compat).
        const { trait, stat } = resolvedParams;
        if (targetType === 'entity') {
            return this._damageEntityComponents(targetId, trait, stat, value);
        }
        if (!targetId) {
            return { success: false, message: 'No target specified', data: null };
        }
        if (this.equippedItemStats?.hasStats(targetId)) {
            const success = this.equippedItemStats.updateStatDelta(targetId, trait || 'Physical', stat || 'existence', value);
            return {
                success,
                message: success ? `Dealt ${Math.abs(value)} damage to ${targetId}` : `Failed to damage ${targetId}`,
                data: success ? { targetId, trait, stat, value } : null
            };
        }
        const componentStats = this.worldStateController.componentController.getComponentStats(targetId);
        if (!componentStats) {
            return { success: false, message: `Target "${targetId}" has no stats — cannot apply damage`, data: null };
        }
        const success = this.worldStateController.componentController.updateComponentStatDelta(targetId, trait, stat, value);
        return {
            success,
            message: success ? `Dealt ${Math.abs(value)} damage to ${targetId}` : `Failed to damage ${targetId}`,
            data: success ? { targetId, trait, stat, value } : null
        };
    }

    /**
     * Routes channel damage to a single component or equipped item. The
     * existence loss is computed from the target's resistance to the channel.
     *
     * Feature 1: the raw value is first sliced across channels by the ATTACKER's
     * blended material split (resolved from `context`); each slice then passes
     * through the unchanged per-channel resistance formula and the per-channel
     * losses sum into one existence delta. A null split (feature off / attacker
     * unresolvable) keeps the whole value on the declared channel — today's math.
     * @param {string} targetId - The target component (or equipped item) ID.
     * @param {string} channel - A DAMAGE_CHANNELS name (cut, impact, …).
     * @param {number} value - The raw damage amount (positive).
     * @param {string} targetType - 'self', 'target', or 'entity'.
     * @param {Object|null} context - The consequence dispatch context (used to resolve the attacker).
     * @returns {Object} { success, message, data }
     * @private
     */
    _handleChannelDamage(targetId, channel, value, targetType, context) {
        const split = this._resolveAttackerSplit(context, channel);
        if (targetType === 'entity') {
            return this._damageEntityComponentsByChannel(targetId, channel, value, split);
        }
        if (!targetId) {
            return { success: false, message: 'No target specified', data: null };
        }

        // Equipped item path: drain the item's stored existence.
        if (this.equippedItemStats?.hasStats(targetId)) {
            const priorExistence = this.equippedItemStats.getStats(targetId)?.Physical?.existence ?? 0;
            const loss = this._computeSplitLoss(this.equippedItemStats.getStats(targetId), channel, value, split);
            const appliedLoss = Math.min(Math.max(0, priorExistence), Math.max(0, loss));
            const success = this.equippedItemStats.updateStatDelta(targetId, 'Physical', 'existence', -loss);
            if (success) this._publishChannelLoss(context, { targetId, appliedLoss });
            return {
                success,
                message: success ? `Dealt ${round3(loss)} ${channel} damage to equipped item ${targetId}` : `Failed to damage ${targetId}`,
                data: success ? { targetId, channel, existenceLoss: loss } : null
            };
        }

        // Component path.
        const stats = this.worldStateController.componentController.getComponentStats(targetId);
        if (!stats) {
            return { success: false, message: `Target "${targetId}" has no stats — cannot apply damage`, data: null };
        }
        // Applied (clamped) loss: the existence delta that actually left the target —
        // the computed loss capped at what the target had (a nearly-gone target sheds
        // only what it held, never a negative or over-the-top value; spec D5).
        const priorExistence = stats?.Physical?.existence ?? 0;
        const loss = this._computeSplitLoss(stats, channel, value, split);
        const appliedLoss = Math.min(Math.max(0, priorExistence), Math.max(0, loss));
        const success = this.worldStateController.componentController.updateComponentStatDelta(targetId, 'Physical', 'existence', -loss);
        if (success) this._publishChannelLoss(context, { targetId, appliedLoss });
        return {
            success,
            message: success ? `Dealt ${round3(loss)} ${channel} damage to ${targetId}` : `Failed to damage ${targetId}`,
            data: success ? { targetId, channel, existenceLoss: loss } : null
        };
    }

    /**
     * Publishes the applied (clamped) channel loss into the dispatch context's action
     * params under the reserved key {@link PUBLISHED_CHANNEL_LOSS_KEY} (spec D5). The
     * dispatcher's `propagateParams` (true on the single-attacker path) carries it
     * forward to later consequences in the same pipeline (e.g. `dropMaterialChunk`);
     * on the multi-attacker path the dispatcher carries only this reserved key forward
     * (per-attacker isolated contexts — spec D11, revised), so each attacker's own
     * drop step consumes its own published loss and drops its own chunks. The drop
     * handler reads this as its only input — it never recomputes the split /
     * resistance / clamping. No-op when there is no context/actionParams to write to
     * (defensive; never throws).
     * @param {Object|null} context - The consequence dispatch context (handler context).
     * @param {ChannelLossPublication} entry - Target id + applied loss (see the type in Constants.js).
     * @private
     */
    _publishChannelLoss(context, entry) {
        if (context && typeof context === 'object' && typeof context.actionParams === 'object' && context.actionParams !== null) {
            context.actionParams[PUBLISHED_CHANNEL_LOSS_KEY] = entry;
        }
    }

    /**
     * Applies channel damage to every component of an entity that carries the
     * relevant resistance stat (the 0–1 existence store exists on all components).
     * @param {string} entityId - The target entity ID.
     * @param {string} channel - A DAMAGE_CHANNELS name.
     * @param {number} value - The raw damage amount.
     * @param {Object<string, number>|null} split - Feature 1 damage-type split (or null).
     * @returns {Object} { success, message, data }
     * @private
     */
    _damageEntityComponentsByChannel(entityId, channel, value, split) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) {
            return { success: false, message: `Entity "${entityId}" not found`, data: null };
        }

        let totalLoss = 0;
        let updatedCount = 0;
        for (const component of entity.components || []) {
            const stats = this.worldStateController.componentController.getComponentStats(component.id);
            if (!stats) continue;
            const loss = this._computeSplitLoss(stats, channel, value, split);
            const success = this.worldStateController.componentController.updateComponentStatDelta(component.id, 'Physical', 'existence', -loss);
            if (success) {
                totalLoss += loss;
                updatedCount++;
            }
        }

        return {
            success: true,
            message: `Dealt ${round3(totalLoss)} total ${channel} damage across ${updatedCount} component(s) of entity "${entityId}"`,
            data: { entityId, channel, value, updatedCount, totalLoss }
        };
    }

    /**
     * Computes the existence loss (a 0–1 fraction) from a raw damage amount and
     * the target's resistance to the channel. The resistance is read from the
     * target's Physical `<channel>_resistance` stat (a 0–100 value derived from
     * its material composition). Missing resistance defaults to 0 (fully
     * vulnerable).
     * @param {Object} stats - The target component's stats.
     * @param {string} channel - A DAMAGE_CHANNELS name.
     * @param {number} value - The raw damage amount (positive).
     * @returns {number} The existence loss (≥ 0).
     * @private
     */
    _computeChannelLoss(stats, channel, value) {
        // DAMAGE_CHANNELS is a constant-name → channel map (an object), so the
        // membership check runs against its values, not .includes() (a latent bug:
        // the object has no .includes, which made every channel-damage call throw
        // and be swallowed by the dispatcher's try/catch — i.e. channel damage
        // silently never applied). Fixed here because feature 1's split loss is
        // built directly on this per-channel formula.
        if (!Object.values(DAMAGE_CHANNELS).includes(channel)) return 0;
        const resistance = stats?.Physical?.[`${channel}_resistance`] ?? 0;
        return channelLossFromResistance(value, resistance);
    }

    /**
     * Computes the total existence loss for a channel-bearing attack, applying
     * feature 1's per-material damage-type split.
     *
     * When `split` is null (feature off or attacker unresolvable) this is EXACTLY
     * the legacy formula — the whole raw value goes through the declared channel's
     * resistance, so an absent damage-types file is bit-identical to pre-feature
     * combat (spec D9). When a split is present, the raw value is sliced per
     * channel by the attacker's blended material distribution and each slice passes
     * through the UNCHANGED per-channel resistance formula; the per-channel losses
     * sum to the single existence delta (the existing resistance math is untouched).
     * @param {Object} stats - The target's stats (component or equipped item).
     * @param {string} declaredChannel - The consequence's declared channel.
     * @param {number} value - The raw damage amount (positive).
     * @param {Object<string, number>|null} split - Channel → percentage map, or null.
     * @returns {number} The total existence loss (≥ 0).
     * @private
     */
    _computeSplitLoss(stats, declaredChannel, value, split) {
        if (!split) {
            return this._computeChannelLoss(stats, declaredChannel, value);
        }
        let totalLoss = 0;
        for (const [ch, pct] of Object.entries(split)) {
            if (typeof pct !== 'number' || pct <= 0) continue;
            totalLoss += this._computeChannelLoss(stats, ch, value * (pct / 100));
        }
        return totalLoss;
    }

    /**
     * Resolves the attacker's blended damage-type split for a damage consequence.
     * Returns null (no split) when the feature is off or the attacker cannot be
     * resolved to a material composition. The split math itself lives in the
     * MaterialController (pure material-data math).
     * @param {Object|null} context - The consequence dispatch context.
     * @param {string} declaredChannel - The consequence's declared channel (fallback).
     * @returns {Object<string, number>|null}
     * @private
     */
    _resolveAttackerSplit(context, declaredChannel) {
        if (!this.materialController) return null;
        const materials = this._resolveAttackerMaterials(context);
        if (!materials) return null;
        return this.materialController.getBlendedDamageTypeSplit(materials, declaredChannel);
    }

    /**
     * Resolves the attacker's material composition from the dispatch context.
     *
     * Resolution order (spec D4):
     *   1. `attackerComponentId` in the handler context (multi-attacker path) or in
     *      actionParams (a single-attacker call may carry it too).
     *   2. Otherwise, the first comp-/eq- ID among the fulfillingComponents values
     *      (the single-attacker path: e.g. the fist fulfilling Physical.strength for
     *      punch, or the equipped knife fulfilling Physical.sharpness for cut).
     *
     * An `eq-` ID maps to the item's OWN recipe materials, falling back to the host
     * component's materials when the item type declares none. A `comp-` ID maps to
     * the component TYPE's recipe materials via the component controller's existing
     * lookup (single source of truth — no second registry read). Unresolvable (no
     * typed ID, or a type with no materials) → null, which the caller treats as
     * "no split" (legacy behavior).
     *
     * @param {Object|null} context - The consequence dispatch context.
     * @returns {Array<{material: string, fraction: number}>|null}
     * @private
     */
    _resolveAttackerMaterials(context) {
        if (!context || !this.worldStateController) return null;

        let attackerId = context.attackerComponentId || context?.actionParams?.attackerComponentId || null;
        if (!attackerId && context.fulfillingComponents && typeof context.fulfillingComponents === 'object') {
            for (const id of Object.values(context.fulfillingComponents)) {
                if (id && (IdResolver.isCompId(id) || IdResolver.isEquippedId(id))) {
                    attackerId = id;
                    break;
                }
            }
        }
        if (!attackerId) return null;

        if (IdResolver.isEquippedId(attackerId)) {
            const equipped = this.worldStateController.getEquippedItem(context?.actionParams?.entityId, attackerId);
            if (!equipped) return null;
            if (equipped.itemType) {
                const itemMaterials = this._getItemMaterials(equipped.itemType);
                if (itemMaterials) return itemMaterials;
            }
            return equipped.componentId ? this._getComponentMaterials(equipped.componentId) : null;
        }
        return this._getComponentMaterials(attackerId);
    }

    /**
     * Maps a component ID to its TYPE's recipe materials via the component
     * controller's existing lookup. Returns null when the component or its type
     * declares no materials.
     * @param {string} componentId
     * @returns {Array<{material: string, fraction: number}>|null}
     * @private
     */
    _getComponentMaterials(componentId) {
        const comp = this.worldStateController.getComponent(componentId);
        if (!comp || !comp.type) return null;
        const byType = this.worldStateController.componentController.getComponentMaterialsByType();
        return byType[comp.type] || null;
    }

    /**
     * Reads an item TYPE's recipe materials from the inventory item registry.
     * @param {string} itemType
     * @returns {Array<{material: string, fraction: number}>|null}
     * @private
     */
    _getItemMaterials(itemType) {
        const itemDefs = this.worldStateController.inventoryManager?.getItemDefinitions?.();
        if (!itemDefs) return null;
        const def = itemDefs[itemType];
        return (def && Array.isArray(def.materials)) ? def.materials : null;
    }

    /**
     * Damages all components of an entity that have the specified trait (legacy
     * stat-delta path, kept for back-compat with actions using trait/stat).
     * @private
     */
    _damageEntityComponents(entityId, trait, stat, value) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) {
            return { success: false, message: `Entity "${entityId}" not found`, data: null };
        }

        let totalDamage = 0;
        let updatedCount = 0;

        for (const component of entity.components) {
            const stats = this.worldStateController.componentController.getComponentStats(component.id);
            if (stats && stats[trait] && stats[trait][stat] !== undefined) {
                const success = this.worldStateController.componentController.updateComponentStatDelta(component.id, trait, stat, value);
                if (success) {
                    totalDamage += Math.abs(value);
                    updatedCount++;
                }
            }
        }

        return {
            success: true,
            message: `Dealt ${totalDamage} total damage across ${updatedCount} component(s) of entity "${entityId}"`,
            data: { entityId, trait, stat, value, updatedCount, totalDamage }
        };
    }
}

function round3(n) {
    return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

export default DamageConsequenceHandler;
