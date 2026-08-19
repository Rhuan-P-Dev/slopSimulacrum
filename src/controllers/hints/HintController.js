/**
 * HintController — Rule registry for generating actionable hint suggestions.
 *
 * A logic controller (no owned game data). Receives the facade via
 * setWorldStateController() and only ever reads through its public API.
 * Both consumers — the REST route and LlmContextController — call the same
 * getHints(), so "what counts as a good next move" has a single definition.
 *
 * Rule contract (canonical): each rule implements id, priority, canApply(context),
 * evaluate(context) → null | hint. registerRule validates typeof rule.evaluate
 * and rejects rules lacking it (with a warn log when the rule has an id).
 *
 * @module HintController
 */

import Logger from '../../utils/Logger.js';
import { ReachabilityRule } from './rules/ReachabilityRule.js';

class HintController {
    /**
     * @param {Object} deps
     * @param {Object} deps.actionRegistry - data/actions.json (loaded by the composition root).
     */
    constructor(deps = {}) {
        const { actionRegistry } = deps;
        this.actionRegistry = actionRegistry && typeof actionRegistry === 'object' ? actionRegistry : {};
        /** @type {WorldStateController|null} Injected post-construction. */
        this.worldStateController = null;

        // Rule registry — evaluated in ascending priority order.
        this._rules = [new ReachabilityRule()];
    }

    /**
     * Injects the world state facade (WorldStateController).
     * @param {import('../WorldStateController.js')} facade
     */
    setWorldStateController(facade) {
        this.worldStateController = facade;
    }

    /**
     * Registers an external rule into the hint engine.
     * Rules must implement evaluate(context) → null | hint.
     * Rules are sorted by priority (lower number = higher priority).
     * @param {Object} rule - Rule object with id, priority, evaluate method.
     */
    registerRule(rule) {
        if (rule && typeof rule.evaluate === 'function') {
            this._rules.push(rule);
            // Sort ascending by priority.
            this._rules.sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));
        } else if (rule?.id) {
            Logger.warn(`[HintController] registerRule: rule "${rule.id}" lacks evaluate() — rejected`);
        }
    }

    /**
     * Returns all applicable hints for an entity.
     *
     * Each rule's evaluate(context) is called in priority order; non-null results
     * are collected and returned as a nearest-first array (per spec §5.3).
     *
     * @param {string} entityId - Typed entity ID (ent-…).
     * @param {Object} [options]
     * @param {string} [options.targetId] - Optional specific target to hint about.
     * @returns {{ entityId: string, hints: Array }} Defensive copy; empty hints when none apply.
     */
    getHints(entityId, options = {}) {
        const facade = this.worldStateController;
        if (!facade) {
            return { entityId, hints: [] };
        }

        const player = facade.getEntity(entityId);
        if (!player) {
            return { entityId, hints: [] };
        }

        // Build the shared context object for all rules.
        const roomName = player.location || null;
        const rooms = facade.getRooms();
        const room = rooms && roomName ? rooms[roomName] : null;
        const droppedItems = facade.getDroppedItems() || {};
        const targetId = options.targetId || null;

        // Gather entities in the player's room (exclude self, exclude non-spatial).
        let entitiesInRoom = [];
        try {
            const allEntities = facade.stateEntityController?.getAll?.() || {};
            entitiesInRoom = Object.values(allEntities).filter(e => {
                if (e.id === entityId) return false; // exclude self
                if (e.location !== roomName) return false; // same room only
                if (!e.spatial || typeof e.spatial.x !== 'number' || typeof e.spatial.y !== 'number') return false; // must be spatial
                return true;
            });
        } catch (_) { /* ignore — best effort */ }

        // Gather per-component stats as a map of "trait.stat" → number.
        // Apply MAX across components (spec: maxStrength = max across components).
        const playerComponents = player.components || [];
        const playerStats = {};
        for (const comp of playerComponents) {
            const compId = comp.id || comp;
            const stats = facade.getComponentStats(compId);
            if (!stats) continue;
            for (const [traitName, traitData] of Object.entries(stats)) {
                if (typeof traitData !== 'object' || traitData === null) continue;
                for (const [statKey, statVal] of Object.entries(traitData)) {
                    if (typeof statVal === 'number') {
                        const key = `${traitName}.${statKey}`;
                        playerStats[key] = Math.max(playerStats[key] ?? 0, statVal);
                    }
                }
            }
        }

        const context = {
            player,
            room,                    // room definition object or null
            playerStats,
            droppedItems: Object.values(droppedItems).filter(item => item.roomId === roomName),
            entities: entitiesInRoom,  // entities in same room (excluding self)
            targetId,
            actionRegistry: this.actionRegistry
        };

        // Evaluate rules in priority order; collect non-null results.
        // Rules may return a single hint or an array of hints — flatten both cases.
        const hints = [];
        for (const rule of this._rules) {
            try {
                const result = rule.evaluate(context);
                if (result) {
                    if (Array.isArray(result)) {
                        hints.push(...result);
                    } else {
                        hints.push(result);
                    }
                }
            } catch (err) {
                Logger.warn(`[HintController] Rule ${rule.id} threw: ${err?.message || err}`);
            }
        }

        // Defensive copy per Project Rules §2.
        return { entityId, hints: JSON.parse(JSON.stringify(hints)) };
    }
}

export default HintController;
