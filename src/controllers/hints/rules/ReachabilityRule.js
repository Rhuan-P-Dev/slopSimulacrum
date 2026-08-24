/**
 * ReachabilityRule — Out-of-reach move hint.
 *
 * For a dropped item that is out of the entity's pickup range, computes a
 * suggested (x, y) position that gets the entity closer to the target, and
 * returns a hint with a Portuguese message template (v1).
 *
 * Rule contract: id, priority, canApply(context), evaluate(context) → null | hint.
 * Stats are pre-gathered by HintController using MAX across components.
 *
 * @module ReachabilityRule
 */

import { resolveRange } from '../../../../shared/RangeResolver.js';
import { DROP_BASE_RANGE, DROP_RANGE_MULTIPLIER } from '../../../utils/Constants.js';

/** Epsilon for sanity guard floating-point comparison. */
const CLAMP_EPSILON = 0.01;

/**
 * Clamp value to [min, max].
 * @param {number} val
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

/**
 * Format a number for display: whole numbers have no decimal; others get 1 decimal.
 * @param {number} n
 * @returns {string}
 */
function fmtCoord(n) {
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(1).replace(/\.0$/, '');
}

export class ReachabilityRule {
    /** Stable string key. */
    get id() {
        return 'reachability-move';
    }

    /** Lower priority evaluated first. */
    get priority() {
        return 10;
    }

    /**
     * Cheap boolean gate — called once per entity before expensive math.
     * @param {Object} context
     * @returns {boolean}
     */
    canApply(context) {
        const hasItems = context.droppedItems && context.droppedItems.length > 0;
        const hasEntities = context.entities && context.entities.length > 0;
        return !!(context.player && context.room && (hasItems || hasEntities));
    }

    /**
     * Evaluate and return a hint object, or null if no hint applies.
     * Returns the full hints array (nearest first) for multi-candidate scenarios;
     * HintController.getHints() collects results from all rules.
     * @param {Object} context
     * @returns {Object|null}
     */
    evaluate(context) {
        const { player, room, droppedItems, targetId, actionRegistry, playerStats } = context;
        if (!this.canApply(context)) return null;

        // Stats are pre-gathered by HintController using MAX across components.
        const maxStrength = playerStats['Physical.strength'] ?? 0;
        const maxMove = playerStats['Movement.move'] ?? 0;

        // If the entity has no movement capability, no hint.
        if (maxMove <= 0) return null;

        // Resolve reach (R) using the same chain as the client's _resolvePickupRange.
        const dropAction = actionRegistry && actionRegistry['dropItem'];
        const rangeExpression = dropAction?.range;
        const fallback = DROP_BASE_RANGE + maxStrength * DROP_RANGE_MULTIPLIER;

        let R;
        if (typeof rangeExpression === 'number') {
            // Numeric range expression — treat as fallback per the client chain.
            R = fallback;
        } else {
            R = resolveRange(rangeExpression, playerStats, fallback);
        }

        // Validate resolved reach.
        if (!isFinite(R) || R <= 0) return null;

        // Filter candidates: dropped items in the player's room + entities in the player's room.
        const itemCandidates = droppedItems.filter(item => item.roomId === (player.location || null));
        const entityCandidates = (context.entities || []).filter(e => e.roomId === undefined && e.location === (player.location || null));

        let candidates;
        if (targetId) {
            // If targetId matches an entity, use it.
            const targetEntity = entityCandidates.find(e => e.id === targetId);
            if (targetEntity) {
                candidates = [targetEntity];
            } else {
                const targetItem = itemCandidates.find(item => item.id === targetId);
                if (!targetItem) return null; // target not a valid candidate.
                candidates = [targetItem];
            }
        } else {
            candidates = [...itemCandidates, ...entityCandidates];
        }

        // For each candidate (items or entities), check reachability and compute suggested position.
        const hints = [];
        const px = player.spatial?.x || 0;
        const py = player.spatial?.y || 0;

        for (const cand of candidates) {
            // Items: { x, y }; Entities: { spatial: { x, y } }.
            const tx = (cand.spatial?.x ?? cand.x) || 0;
            const ty = (cand.spatial?.y ?? cand.y) || 0;
            const d = Math.sqrt((tx - px) ** 2 + (ty - py) ** 2);

            // Only hint if out of reach.
            if (d <= R) continue;

            // Step = min(maxMove, d) per spec §5.3 — ensures we don't overshoot
            // when target is within one move step but out of pickup range.
            const step = Math.min(maxMove, d);
            const sx = px + ((tx - px) / d) * step;
            const sy = py + ((ty - py) / d) * step;

            // Clamp to room bounds (room-centered coordinates).
            const halfW = room.width / 2;
            const halfH = room.height / 2;
            const clampedX = clamp(sx, -halfW, halfW);
            const clampedY = clamp(sy, -halfH, halfH);

            // Sanity guard: clamped point must strictly reduce distance.
            const newDist = Math.sqrt((tx - clampedX) ** 2 + (ty - clampedY) ** 2);
            if (newDist >= d || (Math.abs(clampedX - px) < CLAMP_EPSILON && Math.abs(clampedY - py) < CLAMP_EPSILON)) {
                continue; // Clamping removed all progress — skip this candidate.
            }

            const roundedX = Math.round(clampedX * 10) / 10;
            const roundedY = Math.round(clampedY * 10) / 10;
            const targetName = cand.name || cand.itemType || (cand.spatial ? 'entity' : 'item');
            const isEntity = cand.spatial !== undefined && cand.id !== undefined && cand.location !== undefined;

            hints.push({
                id: 'reachability-move',
                priority: 10,
                targetType: isEntity ? 'entity' : 'droppedItem',
                targetId: cand.id,
                targetName,
                suggestedPosition: { x: roundedX, y: roundedY },
                distance: Math.round(d * 10) / 10,
                range: Math.round(R * 10) / 10,
                message: `To move to entity ${targetName}, go to ${fmtCoord(roundedX)} and ${fmtCoord(roundedY)} \u2014 you can't reach it, but you get closer!`
            });
        }

        // Sort hints by distance ascending (nearest-first) per spec §5.3.
        hints.sort((a, b) => a.distance - b.distance);

        // Return the full hints array (nearest-first);
        // HintController.getHints() collects from all rules.
        return hints.length > 0 ? hints : null;
    }
}
