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

// The base absorption capacity on the 0–100 resistance scale. A channel with
// resistance R drains the target's existence by damage / (RESISTANCE_SCALE + R),
// so resistance 0 → damage/100 and resistance 100 → damage/200.
const RESISTANCE_SCALE = 100;

class DamageConsequenceHandler {
    /**
     * @param {Object} controllers - The set of available controllers.
     * @param {WorldStateController} controllers.worldStateController - The root state controller.
     * @param {EquippedItemStatsController} [controllers.equippedItemStats] - The equipped item stats manager (for equipped item damage routing).
     */
    constructor(controllers) {
        this.worldStateController = controllers.worldStateController;
        this.equippedItemStats = controllers.equippedItemStats || null;
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

        // Channel-based damage (the new DAMAGE_CHANNELS model).
        if (channel) {
            return this._handleChannelDamage(targetId, channel, value, targetType);
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
     * @param {string} targetId - The target component (or equipped item) ID.
     * @param {string} channel - A DAMAGE_CHANNELS name (cut, impact, …).
     * @param {number} value - The raw damage amount (positive).
     * @param {string} targetType - 'self', 'target', or 'entity'.
     * @returns {Object} { success, message, data }
     * @private
     */
    _handleChannelDamage(targetId, channel, value, targetType) {
        if (targetType === 'entity') {
            return this._damageEntityComponentsByChannel(targetId, channel, value);
        }
        if (!targetId) {
            return { success: false, message: 'No target specified', data: null };
        }

        // Equipped item path: drain the item's stored existence.
        if (this.equippedItemStats?.hasStats(targetId)) {
            const loss = this._computeChannelLoss(this.equippedItemStats.getStats(targetId), channel, value);
            const success = this.equippedItemStats.updateStatDelta(targetId, 'Physical', 'existence', -loss);
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
        const loss = this._computeChannelLoss(stats, channel, value);
        const success = this.worldStateController.componentController.updateComponentStatDelta(targetId, 'Physical', 'existence', -loss);
        return {
            success,
            message: success ? `Dealt ${round3(loss)} ${channel} damage to ${targetId}` : `Failed to damage ${targetId}`,
            data: success ? { targetId, channel, existenceLoss: loss } : null
        };
    }

    /**
     * Applies channel damage to every component of an entity that carries the
     * relevant resistance stat (the 0–1 existence store exists on all components).
     * @param {string} entityId - The target entity ID.
     * @param {string} channel - A DAMAGE_CHANNELS name.
     * @param {number} value - The raw damage amount.
     * @returns {Object} { success, message, data }
     * @private
     */
    _damageEntityComponentsByChannel(entityId, channel, value) {
        const entity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!entity) {
            return { success: false, message: `Entity "${entityId}" not found`, data: null };
        }

        let totalLoss = 0;
        let updatedCount = 0;
        for (const component of entity.components || []) {
            const stats = this.worldStateController.componentController.getComponentStats(component.id);
            if (!stats) continue;
            const loss = this._computeChannelLoss(stats, channel, value);
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
        if (!DAMAGE_CHANNELS.includes(channel)) return 0;
        const resistance = stats?.Physical?.[`${channel}_resistance`] ?? 0;
        return Math.max(0, value) / (RESISTANCE_SCALE + Math.max(0, resistance));
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
