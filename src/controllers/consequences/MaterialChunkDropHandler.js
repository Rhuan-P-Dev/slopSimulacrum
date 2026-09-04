/**
 * MaterialChunkDropHandler — feature 2: sheds a "chunk" item per dropped material
 * when a punched component suffers channel damage.
 *
 * Single Responsibility: turn an *applied* (already-published) damage loss into one
 * or more dynamically-generated chunk items dropped on the ground. It never
 * recomputes the split, the resistance, or the clamping — its entire damage input is
 * the `lastChannelLoss` entry published by DamageConsequenceHandler (spec D5) plus the
 * target's own recipe. It is a pure actor on world state (a consequence), not a state
 * owner: it reads the target's composition/volume and writes self-describing ground
 * records through the shared writeDroppedItem helper (the same helper the break/spill
 * flow uses), so the client needs zero changes (spec D8).
 *
 * Focused-handler precedent: a class with named dependencies { worldStateController,
 * materialController }; the facade reference arrives post-construction via the
 * ConsequenceHandlers setWorldStateController propagation (mirrors DamageConsequenceHandler).
 *
 * @module MaterialChunkDropHandler
 */

import Logger from '../../utils/Logger.js';
import { writeDroppedItem } from './DropItemHandler.js';
import { sampleDiskPoint, DEFAULT_TRIGGER_RADIUS } from '../../utils/DiskSampler.js';
import { CHUNK_ITEM_TYPE_PREFIX, PUBLISHED_CHANNEL_LOSS_KEY } from '../../utils/Constants.js';
import { getDefinitionVolume } from '../../utils/definitionVolume.js';

class MaterialChunkDropHandler {
    /**
     * @param {Object} deps - Named dependencies.
     * @param {WorldStateController} deps.worldStateController - The facade (injected post-construction).
     * @param {MaterialController|null} deps.materialController - Owns the drop-rates registry
     *   (data/materialDropRates.json). Null-tolerant: feature off → no drops.
     */
    constructor(deps = {}) {
        this.worldStateController = deps.worldStateController || null;
        this.materialController = deps.materialController || null;
        this.worldRulesController = deps.worldRulesController || null;
    }

    /**
     * Handles the `dropMaterialChunk` consequence: after a successful punch, drop at most
     * one chunk per material whose independent roll succeeds, with volume per the D7 contract.
     *
     * On the multi-attacker path each attacker's dispatch context is isolated and carries
     * only that attacker's own published loss (spec D11, revised): two fists therefore
     * perform two independent rolls on two independent losses — never an aggregate.
     *
     * Zero-drop (but still successful) outcomes — all deliberate (spec D9/D10/D11):
     *   - no published loss / non-positive / target-mismatch (e.g. the punch's value
     *     resolved to zero, or the damage step failed to apply);
     *   - the feature is off (drop-rates file absent/empty) or the target declares no
     *     materials (nothing to chip from);
     *   - the target is gone (a lethal punch's break/removal cascade already ran inside the
     *     damage consequence) or is an equipped item / whole entity rather than a single
     *     component — there is no partial-matter source to chip from (D10);
     *   - a material with no drop-rates entry (equivalent to rate 0).
     *
     * @param {string} targetId - The resolved target (component) ID from the dispatcher.
     * @param {Object} params - Consequence params (unused; everything arrives via context).
     * @param {Object} context - The dispatch context (carries a {@link ChannelLossPublication}
     *   entry under {@link PUBLISHED_CHANNEL_LOSS_KEY}).
     * @returns {{ success: boolean, message?: string, data?: { droppedChunks: number, chunkVolumes: Object<string,number> } }}
     */
    _handleDropMaterialChunk(targetId, params, context) {
        const world = this.worldStateController;
        if (!world) {
            return { success: false, message: 'WorldStateController not available.' };
        }

        // 1. Read the published loss — the drop handler's only damage input (spec D5).
        // On the multi-attacker path this is the loss published by THIS attacker's own
        // damage step (per-attacker isolated context; spec D11, revised). Missing /
        // non-positive / target-mismatch → nothing to convert.
        const published = context?.actionParams?.[PUBLISHED_CHANNEL_LOSS_KEY];
        if (!published || typeof published !== 'object'
            || typeof published.appliedLoss !== 'number'
            || published.appliedLoss <= 0
            || published.targetId !== targetId) {
            return { success: true, message: 'No damage to convert into chunks.', data: { droppedChunks: 0, chunkVolumes: {} } };
        }
        const appliedLoss = published.appliedLoss;

        // No MaterialController → feature unavailable → no drops.
        if (!this.materialController) {
            return { success: true, message: 'Material chunk drop disabled.', data: { droppedChunks: 0, chunkVolumes: {} } };
        }

        // 2. Resolve the target component (spec D10: vanished → zero drops). A null result
        // also covers non-component targets (equipped item / entity), which never chip.
        const comp = world.getComponent(targetId);
        if (!comp || !comp.type) {
            return { success: true, message: 'Target has no material to chip from.', data: { droppedChunks: 0, chunkVolumes: {} } };
        }

        // Target entity — for the ground position, the room, and ownership.
        const entity = world.getEntity(comp.entityId);
        if (!entity) {
            return { success: true, message: 'Target entity not found.', data: { droppedChunks: 0, chunkVolumes: {} } };
        }

        // 3. The target's recipe: per-material fractions + total recipe volume (D7).
        const byType = world.componentController?.getComponentMaterialsByType?.() || {};
        const materials = byType[comp.type];
        if (!Array.isArray(materials) || materials.length === 0) {
            return { success: true, message: 'Target declares no materials.', data: { droppedChunks: 0, chunkVolumes: {} } };
        }
        const recipeVolume = getDefinitionVolume(world.componentController?.getComponentDefinition?.(comp.type));

        // 4. Per-material independent roll + volume (D7/D12), batched into one write.
        const minChunkVolume = this.materialController.getMinChunkVolume();
        const room = entity.location || null;
        const cx = entity.spatial?.x ?? 0;
        const cy = entity.spatial?.y ?? 0;
        // getMaterialRegistry() returns { materials, compositions }; the per-material
        // display names live under .materials.
        const materialRegistry = world.getMaterialRegistry?.()?.materials || {};

        const batchDroppedItems = world.getDroppedItems() || {};
        // Narrow-deps stub (the spill flow's own approach): writeDroppedItem only needs
        // getDroppedItems/setDroppedItems; we accumulate into a local batch and write once.
        const narrowDeps = {
            getDroppedItems: () => batchDroppedItems,
            setDroppedItems: (items) => { Object.assign(batchDroppedItems, items); }
        };

        let dropped = 0;
        const chunkVolumes = {};
        for (const mat of materials) {
            if (!mat || typeof mat !== 'object') continue;
            const { material, fraction } = mat;
            // Missing drop-rates entry → no drop for this material (D9). A null result
            // also means the feature is off, so this single check covers both.
            const dropConfig = this.materialController.getDropRate(material);
            if (!dropConfig || dropConfig.dropRate <= 0) continue;
            if (typeof fraction !== 'number' || fraction <= 0) continue;

            // Independent roll per material (D12). Math.random() ∈ [0,1): a dropRate of
            // 1.0 therefore always drops (deterministic for contract tests).
            if (!(Math.random() < dropConfig.dropRate)) continue;

            const lost = appliedLoss * fraction * recipeVolume;
            const chunkVolume = Math.max(minChunkVolume, dropConfig.chunkFraction * lost);
            const itemType = CHUNK_ITEM_TYPE_PREFIX + material;
            const materialName = materialRegistry[material]?.name || material;
            const point = sampleDiskPoint(cx, cy, DEFAULT_TRIGGER_RADIUS);
            if (!point) continue;

            const itemDef = {
                name: `${materialName} chunk`,
                description: `A chunk of ${materialName} chipped off a damaged component.`,
                volume: chunkVolume
            };
            writeDroppedItem(narrowDeps, itemType, point.x, point.y, room, comp.entityId, itemDef, []);
            dropped++;
            chunkVolumes[itemType] = chunkVolume;
        }

        // 5. Torn-material step (WR-2): a deterministic stream that drops a fixed
        //    percentage of the applied loss as torn material per composition fraction.
        //    Unlike the chunk stream (probabilistic, per-material levers), this is
        //    a "law of the world": same hit, same world, same tokens — always.
        //    It reuses the SAME dynamic chunk_<material> item mechanism, the SAME
        //    disk-sample placement, and is gated by the SAME minChunkVolume floor.
        //    Null-tolerant: if the world-rules controller is unwired or the rule is
        //    off (percent 0), this step is a no-op.
        let tornDropped = 0;
        const tornVolumes = {};
        const tornPercent = this.worldRulesController?.getDamageTornMaterialPercent() ?? 0;
        if (tornPercent > 0) {
            for (const mat of materials) {
                if (!mat || typeof mat !== 'object') continue;
                const { material, fraction } = mat;
                if (typeof fraction !== 'number' || fraction <= 0) continue;

                // WR-2: tornVolume_i = (percent/100) × appliedLoss × fraction_i × recipeVolume.
                const tornVolume = (tornPercent / 100) * appliedLoss * fraction * recipeVolume;

                // Gate (WR-2): drop nothing below the shared minChunkVolume floor.
                // This guarantees the rule never drops more matter than the declared
                // X% of the damage (a floor would, on micro-loss hits).
                if (tornVolume < minChunkVolume) continue;

                const itemType = CHUNK_ITEM_TYPE_PREFIX + material;
                const materialName = materialRegistry[material]?.name || material;
                const point = sampleDiskPoint(cx, cy, DEFAULT_TRIGGER_RADIUS);
                if (!point) continue;

                const itemDef = {
                    name: `${materialName} chunk`,
                    description: `A chunk of ${materialName} chipped off a damaged component.`,
                    volume: tornVolume
                };
                writeDroppedItem(narrowDeps, itemType, point.x, point.y, room, comp.entityId, itemDef, []);
                tornDropped++;
                tornVolumes[itemType] = tornVolume;
            }
        }

        const totalDropped = dropped + tornDropped;
        if (totalDropped > 0) {
            // One batched write per punch for both streams (mirrors the spill flow; spec D6).
            world.setDroppedItems(batchDroppedItems);
            Logger.info(`[MaterialChunkDropHandler] Dropped ${dropped} chunk(s) + ${tornDropped} torn from ${targetId} (applied loss ${round4(appliedLoss)}): chunks ${JSON.stringify(chunkVolumes)}, torn ${JSON.stringify(tornVolumes)}`);
        }
        return {
            success: true,
            message: `Dropped ${dropped} chunk(s), ${tornDropped} torn.`,
            data: { droppedChunks: dropped, chunkVolumes, tornDropped, tornVolumes }
        };
    }
}

function round4(n) {
    return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

export default MaterialChunkDropHandler;
