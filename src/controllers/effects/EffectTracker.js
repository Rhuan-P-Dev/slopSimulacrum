/**
 * EffectTracker — Generic "durable effect" lifecycle for the action engine.
 *
 * This is the REUSABLE mechanism the player asked for (replace the grab-specific
 * debuff bookkeeping that lived in the turn system). Any consequence can now be
 * made "durable" by declaring a positive `expiresInRounds` field (on the consequence,
 * with an optional action-level fallback). The engine then:
 *
 *   1. On each execution, records the value WITHOUT this effect (the component's value
 *      just before the handler applies it) and the effect's own contribution (`delta`).
 *      On a re-execution of the SAME effect it first removes that effect's own
 *      contribution (a delta, not an absolute set) and re-applies it, so the value
 *      stays flat relative to whatever other effects also touch the stat.
 *   2. Registers an expiration round = (round of the latest execution) +
 *      expiresInRounds.
 *   3. At the end of every round (called by the turn system) reverts every effect
 *      whose expiration round has passed by undoing just that effect's own contribution
 *      (`delta`), which commutes with any other live effect on the same stat and
 *      never fires the damage pipeline (a restore is not a weakening).
 *
 * Only stat-mutating consequences are tracked (they are the restorable ones):
 *   - `updateComponentStatDelta` (a delta on one trait.stat of a component)
 *   - `updateStat` (a SET on one trait.stat of every component on an entity).
 * Log and item/damage consequences are not restorable and are never tracked.
 *
 * Persistence: in-memory only, on purpose. The effect bookkeeping is ephemeral and
 * is restored at expiration; a save/restore that lands *mid-effect* drops the record
 * (documented limitation, matching the prior grab-debuff behavior). The component's
 * stat is restored on a natural expiration, not by a snapshot.
 *
 * Wiring: the facade exposes this instance as `facade.effectTracker`. The
 * ConsequenceDispatcher calls `beforeApply()` before a durable consequence is
 * dispatched and `afterApply()` after the handler succeeds. The turn system calls
 * `setCurrentRound(round)` at round start and `expireEffects()` at round end.
 * Restore and renewal-reset writes opt out of the damage-event pipeline
 * (`skipDamageEvent`), since undoing an effect is not a real weakening.
 *
 * @module EffectTracker
 */

import Logger from '../../utils/Logger.js';

class EffectTracker {
    /**
     * The facade is NOT passed at construction (WorldComposition builds it after
     * this instance). It is injected post-construction via `setWorldStateController()`
     * (the pattern used by every other controller) and dereferenced lazily.
     */
    constructor() {
        this._facade = null;
        /** @private {number|null} The round whose resolution is in progress. Null until
         *   the turn system sets it, i.e. only inside an active resolution. */
        this._currentRound = null;
        /** @private {Object<string, {baseline, delta, expiresRound, trait, stat, componentId}>}
         *   Live effect records keyed by `${effectKey}::${componentId}`. `baseline` is
         *   the value without this effect at application time; `delta` is this effect's
         *   own contribution (applied value minus `baseline`), used to undo just this
         *   effect (commuting with other effects on the same stat). */
        this._effects = {};
    }

    // =========================================================================
    // DEPENDENCY INJECTION (post-construction)
    // =========================================================================

    /**
     * Injects the world state facade after it is fully built (the pattern used
     * by every other controller).
     * @param {WorldStateController} facade
     */
    setWorldStateController(worldStateController) {
        this._facade = worldStateController ?? null;
    }

    /**
     * Sets the round being resolved. Called by the turn system at the start of
     * each `_resolveRound`. Effects applied before this is called (e.g. a direct
     * API call) are still applied by the handler but are NOT tracked for
     * expiration (there is no "round" to expire into).
     * @param {number} round
     */
    setCurrentRound(round) {
        this._currentRound = (typeof round === 'number' && Number.isFinite(round)) ? round : null;
    }

    /** Current resolution round, or null when no round is active. */
    getCurrentRound() {
        return this._currentRound;
    }

    /**
     * Resolves the list of component IDs the effect will touch.
     * - 'entity'  -> every component of the entity that carries the trait.stat.
     * - 'target'/'self' -> the single resolved component (if it carries the trait.stat).
     * Returns only components that actually have a finite trait.stat value, because
     * the stat handler would otherwise be a no-op on them and tracking would be wrong.
     * @param {string|null} targetId
     * @param {'self'|'target'|'entity'} targetType
     * @param {string} trait
     * @param {string} stat
     * @returns {string[]}
     */
    resolveComponents(targetId, targetType, trait, stat) {
        const compController = this._facade?.componentController ?? null;
        if (!compController || targetId == null || !trait || !stat) return [];
        const comps = [];
        if (targetType === 'entity') {
            const entity = this._facade?.stateEntityController?.getEntity?.(targetId);
            (entity?.components ?? []).forEach((component) => {
                const id = component?.id ?? null;
                if (id != null && this._hasStat(compController, id, trait, stat)) {
                    comps.push(id);
                }
            });
        } else {
            // 'self' or 'target' -> the one resolved component.
            if (this._hasStat(compController, targetId, trait, stat)) {
                comps.push(targetId);
            }
        }
        return comps;
    }

    /**
     * Called BEFORE the handler applies a durable stat consequence.
     *
     * For a renewed effect (a record already exists for this effectKey+comp), the
     * existing effect's own contribution is removed (a delta, not an absolute set) so
     * the new application re-lands on the value WITHOUT this effect (flat, no
     * stacking, and without disturbing other effects on the same stat). For a fresh
     * effect, the current value is the value without this effect.
     *
     * Returns null when nothing is to register (no component carries the stat), or
     * an info object for `afterApply`.
     * @param {string} effectKey - Stable key (without the component suffix), e.g.
     *   `${actionName}::${type}::${trait}::${stat}`.
     * @param {string[]} components
     * @param {string} trait
     * @param {string} stat
     * @returns {{effectKey, components, trait, stat, baselineByComp}|null}
     */
    beforeApply(effectKey, components, trait, stat) {
        const compController = this._facade?.componentController ?? null;
        if (!compController || !effectKey || !trait || !stat || !Array.isArray(components) || components.length === 0) {
            return null;
        }
        const baselineByComp = {};
        const validComps = [];
        for (const compId of components) {
            const current = this._readStat(compController, compId, trait, stat);
            if (current == null || !Number.isFinite(current)) continue;
            const existing = this._effects[`${effectKey}::${compId}`];
            const reusable = existing != null && existing.trait === trait && existing.stat === stat;
            if (reusable) {
                // Renew: remove the existing effect's own contribution so the handler
                // re-lands on the value WITHOUT this effect (flat, and without
                // disturbing other effects on the same stat). Moving a component back
                // toward a higher value is not damage.
                const remove = (typeof existing.delta === 'number') ? -existing.delta : 0;
                compController.updateComponentStatDelta(compId, trait, stat, remove, true);
            }
            // Baseline = the value WITHOUT this effect (after any renewal removal).
            const withoutEffect = this._readStat(compController, compId, trait, stat);
            if (withoutEffect == null || !Number.isFinite(withoutEffect)) continue;
            baselineByComp[compId] = withoutEffect;
            validComps.push(compId);
        }
        if (validComps.length === 0) return null;
        return { effectKey, components: validComps, trait, stat, baselineByComp };
    }

    /**
     * Called AFTER the handler applied the durable stat consequence and succeeded.
     * Registers (or refreshes) the expiration for each affected component:
     *   expiresRound = currentRound + expiresInRounds. The component's post-apply value
     *   minus its recorded baseline (value without this effect) is stored as the effect's
     *   own contribution (`delta`) so expiration can undo just this effect.
     * No-op if no round is active (effects applied outside a turn are not tracked).
     * @param {string} effectKey
     * @param {string[]} components
     * @param {string} trait
     * @param {string} stat
     * @param {Object<string, number>} baselineByComp
     * @param {number} expiresInRounds - Positive integer.
     */
    afterApply(effectKey, components, trait, stat, baselineByComp, expiresInRounds) {
        if (!this._facade?.componentController || !effectKey || !trait || !stat) return;
        if (baselineByComp == null) return;
        if (this._currentRound == null) return; // no active round -> not tracked
        if (typeof expiresInRounds !== 'number' || !Number.isFinite(expiresInRounds) || expiresInRounds <= 0) return;
        const compController = this._facade.componentController;
        const compIds = Array.isArray(components) ? components : Object.keys(baselineByComp);
        for (const compId of compIds) {
            const baseline = baselineByComp[compId];
            if (baseline == null) continue;
            // The effect's own contribution at application time = post-apply value minus
            // the value without this effect. Stored so expiration can undo JUST this
            // effect (commuting with any other live effect) and so the restore/renewal
            // writes can opt out of the damage pipeline.
            const applied = this._readStat(compController, compId, trait, stat);
            const delta = (applied != null && Number.isFinite(applied) && Number.isFinite(baseline))
                ? (applied - baseline)
                : null;
            this._effects[`${effectKey}::${compId}`] = {
                baseline,
                delta,
                expiresRound: this._currentRound + expiresInRounds,
                trait,
                stat,
                componentId: compId
            };
        }
    }

    /**
     * Reverts every active effect whose `expiresRound <= currentRound`. Because a
     * renewed effect has `expiresRound = currentRound + expiresInRounds`
     * (> currentRound), it is NOT reverted in the round it is renewed — renewal is
     * fully captured by the refreshed `expiresRound`, so no extra "applied this
     * round" bookkeeping is required.
     * Runs synchronously at the end of a round, before the settled broadcast, so
     * clients see the restored values.
     */
    expireEffects() {
        if (this._currentRound == null) return;
        const keys = Object.keys(this._effects);
        for (const key of keys) {
            const entry = this._effects[key];
            if (entry == null) {
                delete this._effects[key];
                continue;
            }
            if (entry.expiresRound <= this._currentRound) {
                this._restore(entry);
                delete this._effects[key];
            }
        }
    }

    /** Returns a shallow copy of live effect records (observability/testing). */
    getActiveEffects() {
        return { ...this._effects };
    }

    /** Clears all tracked effects (testing / hard reset). */
    reset() {
        this._effects = {};
        this._currentRound = null;
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    /**
     * Reverts one expired effect by undoing just its own contribution. Restoring via
     * the contribution (a delta) — not an absolute baseline — commutes with any other
     * live effect on the same stat, and `skipDamageEvent` keeps the restore out of the
     * damage pipeline.
     */
    _restore(entry) {
        const compController = this._facade?.componentController ?? null;
        if (!compController) return;
        if (typeof entry.delta === 'number') {
            compController.updateComponentStatDelta(entry.componentId, entry.trait, entry.stat, -entry.delta, true);
        } else if (entry.baseline != null) {
            compController.updateComponentStat(entry.componentId, entry.trait, entry.stat, entry.baseline, true);
        }
        Logger.info(
            `[EffectTracker] Effect ${entry.trait}.${entry.stat} on component ${entry.componentId} expired - ` +
            (typeof entry.delta === 'number'
                ? `removed ${entry.delta} from ${entry.trait}.${entry.stat}`
                : `restored ${entry.trait}.${entry.stat} to ${entry.baseline}`)
        );
    }

    /** True when the component carries a finite `trait.stat` value. */
    _hasStat(compController, compId, trait, stat) {
        return this._readStat(compController, compId, trait, stat) != null &&
            Number.isFinite(this._readStat(compController, compId, trait, stat));
    }

    /** Reads a single stat value (null when the component has no such trait/stat). */
    _readStat(compController, compId, trait, stat) {
        const stats = compController?.getComponentStats?.(compId);
        return (stats && stats[trait]) ? stats[trait][stat] : null;
    }
}

export default EffectTracker;
