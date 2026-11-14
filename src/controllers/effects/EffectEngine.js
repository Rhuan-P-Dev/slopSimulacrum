/**
 * EffectEngine — the one writer of live effect state.
 *
 * WHAT THIS OWNS. Applying an effect to a target that exists right now, the live
 * instances that result, their per-round work, their expiry and their revert. It is
 * the single answer to "what is happening to this body", from any source: an action
 * consequence, a world law, an inborn body effect, the live operator console, or an
 * internal component. Nothing else keeps effect bookkeeping (`CHG-2` — a second
 * engine alongside this one is the failure mode this design exists to avoid).
 *
 * APPLY IS IMMEDIATE, THE ROUND IS THE CLOCK. Applying at round 7 with a duration of
 * 3 updates the world NOW and sets `expiresRound = 10`; the first `perRound` runs at
 * round 8, never in the round that applied it. There is deliberately no queued mode
 * and no mode parameter (`CR CHG-4`): a caller that wanted queueing wanted an action,
 * and the action pipeline already queues.
 *
 * IT NEVER MUTATES STATE ITSELF. Every operation is an adapter over the executor
 * that already performs it — the component stat choke point for stats, conditions
 * and flags (`ComponentController`), and `ConsequenceHandlers.dispatch` for damage,
 * chunks and spatial moves (`CR B-2`, one implementation per mutation). The engine
 * adds bookkeeping, not behaviour, which is what keeps a mod data-only and keeps
 * damage looking like damage wherever it comes from.
 *
 * REVERT IS BY CONTRIBUTION, NEVER BY ABSOLUTE VALUE. A recorded effect undoes its
 * OWN delta, so two live effects on one stat commute and an expiry cannot clobber a
 * neighbour — the exact bug `test/contract/durableEffects.contract.test.js` pins —
 * and every restore writes `skipDamageEvent: true`, because undoing a weakening is
 * not a new weakening (wiki/subMDs/data/material_damage_and_drop.md).
 *
 * WHAT `perRound` DOES NOT DO. Its operations are EVENTS IN A SEQUENCE and are never
 * reverted: rewinding three rounds of `-2` as a single `+6` would be healing nobody
 * asked for, and would rewind changes other effects made in between. Only the
 * apply-time `operations` list is revertible, and only the subset marked reversible
 * in `shared/EffectVocabulary.js`.
 *
 * IN-MEMORY, ON PURPOSE, AND LOUD ABOUT IT. Live instances are NOT part of the
 * snapshot (`wiki/decisions/effects-system.md`, decision D3): a save/restore landing
 * mid-effect keeps the applied values and drops the bookkeeping, so the effect stops
 * ticking and stops expiring. That is pinned by a test rather than left as a comment,
 * because a silent limitation is a bug with a fuse.
 *
 * WHAT THIS MODULE DOES NOT DO. No file I/O (`CR B-3`), no sockets (`CR B-1`), no
 * definition validation (`EffectsController` did it once, at the edge — `CR T-2`),
 * and no reading of request bodies. It never invents a component: an operation lands
 * on the parts the target actually has.
 *
 * @module src/controllers/effects/EffectEngine
 */

import Logger from '../../utils/Logger.js';
import { randomUUID } from 'node:crypto';
import {
    EFFECT_OPERATIONS,
    EFFECT_STACKING,
    EFFECT_TARGETS,
    isReversibleEffectOperation,
} from '../../../shared/EffectVocabulary.js';
import { validateEffectOperationParams } from './EffectOperationSpecs.js';

import {
    MAX_ACTIVE_EFFECTS_PER_TARGET,
    MAX_ACTIVE_EFFECTS_WORLDWIDE,
} from '../../utils/Constants.js';

/** Refusal codes, machine-readable for the operator route (`CR H-2`). */
export const EFFECT_ERROR = Object.freeze({
    UNKNOWN: 'EFFECT_UNKNOWN',
    TARGET_MISSING: 'EFFECT_TARGET_MISSING',
    LIMIT_REACHED: 'EFFECT_LIMIT_REACHED',
    BAD_PARAMS: 'EFFECT_PARAMS_INVALID',
});

class EffectEngine {
    /**
     * @param {Object} deps
     * @param {import('./EffectsController.js')} deps.effectsController - definition owner.
     * @param {Object|null} [deps.consequenceHandlers] - the executor seam for damage,
     *   chunk and spatial operations. Null-tolerant: those operations then report a
     *   refusal instead of pretending to have run.
     * @param {number} [deps.maxPerTarget]
     * @param {number} [deps.maxWorldwide]
     */
    constructor({ effectsController, consequenceHandlers = null,
        maxPerTarget = MAX_ACTIVE_EFFECTS_PER_TARGET,
        maxWorldwide = MAX_ACTIVE_EFFECTS_WORLDWIDE } = {}) {
        this.effectsController = effectsController ?? null;
        this.consequenceHandlers = consequenceHandlers ?? null;
        this.maxPerTarget = maxPerTarget;
        this.maxWorldwide = maxWorldwide;
        /** @type {Map<string, Object>} live instances by instanceId. */
        this._instances = new Map();
        /**
         * @type {Object.<string, Object>} INLINE durable deltas, keyed
         *   `${effectKey}::${componentId}`.
         *
         * The second KIND of live effect state, and the reason it lives here rather
         * than in a second engine: an action consequence may declare a durable stat
         * delta inline (`expiresInRounds` in actions.json) with no effect definition
         * behind it. That bookkeeping is the same problem - remember this effect's own
         * contribution, undo just that contribution when it expires - and one round
         * seam may not have two owners of it. `wiki/decisions/effects-system.md`.
         */
        this._inline = {};
        /** @type {number|null} the round being resolved, null when none is active. */
        this._currentRound = null;
        /** @private The facade, injected post-construction (the house pattern). */
        this._facade = null;
    }

    /** @param {Object} facade */
    setWorldStateController(facade) {
        this._facade = facade ?? null;
    }

    /** Round bookkeeping — the same seam the turn system already drives. */
    setCurrentRound(round) {
        this._currentRound = (typeof round === 'number' && Number.isFinite(round)) ? round : null;
    }

    getCurrentRound() {
        return this._currentRound;
    }

    // =========================================================================
    // APPLY
    // =========================================================================

    /**
     * Apply an effect to a target.
     *
     * @param {string} effectId - a definition the `EffectsController` validates.
     * @param {{ kind: 'entity'|'component', id: string }} target
     * @param {Object} [options]
     * @param {number} [options.rounds] - overrides the definition duration (the
     *   operator's lever). 0 means "until removed".
     * @param {string} [options.source] - who asked, for the log line only.
     * @returns {{ ok: boolean, instanceIds?: string[], error?: string, code?: string }}
     */
    apply(effectId, target, { rounds, source = 'unknown' } = {}) {
        const definition = this.effectsController?.getDefinition(effectId) ?? null;
        if (!definition) return refuse(EFFECT_ERROR.UNKNOWN, `no effect named "${effectId}" is defined`);
        if (!target || typeof target.id !== 'string' || target.id === '') {
            return refuse(EFFECT_ERROR.TARGET_MISSING, 'an effect needs a target');
        }
        if (!this._targetExists(target)) {
            return refuse(EFFECT_ERROR.TARGET_MISSING, `the target "${target.id}" is not in the world`);
        }

        const durationRounds = (typeof rounds === 'number' && Number.isFinite(rounds) && rounds >= 0)
            ? rounds
            : definition.durationRounds;

        const stackingDecision = this._resolveStacking(definition, target);
        const capacity = this._checkCapacity(target, definition, stackingDecision.replacedTargetId);
        if (!capacity.ok) return refuse(capacity.code, capacity.error);

        const instance = this._applyOperations(definition, target, durationRounds);
        if (!instance) {
            // Nothing in the definition could land on this target (no part carries the
            // field, for instance). Not an error the caller can act on beyond knowing it.
            return refuse(EFFECT_ERROR.TARGET_MISSING,
                `the effect "${effectId}" has nothing to act on at "${target.id}"`);
        }

        if (stackingDecision.replacedTargetId) this._instances.delete(stackingDecision.replacedTargetId);
        this._instances.set(instance.instanceId, instance);
        Logger.info(`[EffectEngine] ${effectId} applied to ${target.kind} ${target.id} `
            + `(instance ${instance.instanceId}, round ${this._currentRound ?? 'none'}`
            + `${instance.expiresRound === null ? ', no expiry' : `, expires round ${instance.expiresRound}`}) `
            + `by ${source}`);

        return { ok: true, instanceIds: [instance.instanceId] };
    }

    /**
     * Apply the definition's apply-time operations and build the instance record.
     * Contributions are collected ONLY here; `perRound` is never reverted (header).
     * @returns {Object|null} null when no operation landed on anything.
     * @private
     */
    _applyOperations(definition, target, durationRounds) {
        const contributions = [];
        const ctx = this._contextFor(target, definition);
        for (const operation of definition.operations) {
            const outcome = this._runOperation(operation, ctx, contributions);
            if (outcome.applied) ctx.touchedAnything = true;
        }
        if (!ctx.touchedAnything) return null;
        return {
            instanceId: `eff-${randomUUID()}`,
            effectId: definition.id,
            targetId: target.id,
            targetKind: target.kind,
            appliedRound: this._currentRound,
            // A duration of 0, or an application with no round active, means "until
            // something removes it" - the same reading the tracker always had.
            expiresRound: (durationRounds > 0 && this._currentRound !== null)
                ? this._currentRound + durationRounds
                : null,
            contributions,
        };
    }

    /**
     * The per-round step, driven by the turn system at the START of a round.
     * An instance ticks only in a round strictly after the one that applied it, and
     * only while it has not expired.
     * @param {number} round
     */
    onRoundStart(round) {
        if (typeof round !== 'number' || !Number.isFinite(round)) return;
        this.forgetGoneTargets();
        const ticking = [...this._instances.values()]
            .filter((instance) => instance.appliedRound === null || instance.appliedRound < round)
            .filter((instance) => instance.expiresRound === null || instance.expiresRound >= round);
        for (const instance of ticking) {
            const definition = this.effectsController?.getDefinition(instance.effectId);
            if (!definition || definition.perRound.length === 0) continue;
            const ctx = this._contextFor(
                { kind: instance.targetKind, id: instance.targetId }, definition);
            for (const operation of definition.perRound) {
                // Contributions of a per-round stream are discarded on purpose: they
                // are events, and events are not rewound.
                this._runOperation(operation, ctx, []);
            }
            Logger.debug(`[EffectEngine] ${instance.effectId} ticked on ${instance.targetId} at round ${round}`);
        }
    }

    /**
     * Revert and drop every instance whose expiry round has passed. Called by the turn
     * system at the END of a round, before the settled broadcast, so clients see the
     * restored values in the same update.
     */
    expireEffects() {
        if (this._currentRound === null) return;
        for (const instance of [...this._instances.values()]) {
            if (instance.expiresRound === null || instance.expiresRound > this._currentRound) continue;
            this._revert(instance);
            this._instances.delete(instance.instanceId);
            Logger.info(`[EffectEngine] effect ${instance.effectId} on ${instance.targetId} expired `
                + `at round ${this._currentRound} (instance ${instance.instanceId})`);
        }
        // The inline deltas expire on the same seam, with the same rule. A renewed
        // effect has expiresRound > currentRound, so it is never reverted in the round
        // it was renewed - that is what the pinned contract requires.
        for (const key of Object.keys(this._inline)) {
            const entry = this._inline[key];
            if (entry === null || entry === undefined) {
                delete this._inline[key];
                continue;
            }
            if (entry.expiresRound <= this._currentRound) {
                this._restoreInline(entry);
                delete this._inline[key];
            }
        }
    }

    // =========================================================================
    // REMOVE / OBSERVE
    // =========================================================================

    /**
     * Remove live instances, optionally reverting them.
     * @param {{instanceId?: string, effectId?: string, targetId?: string}} selector
     * @param {{revert?: boolean}} [options]
     * @returns {number} how many instances were removed
     */
    remove(selector = {}, { revert = true } = {}) {
        const matches = [...this._instances.values()].filter((instance) => {
            if (typeof selector.instanceId === 'string') return instance.instanceId === selector.instanceId;
            if (typeof selector.targetId === 'string' && instance.targetId !== selector.targetId) return false;
            if (typeof selector.effectId === 'string' && instance.effectId !== selector.effectId) return false;
            return true;
        });
        for (const instance of matches) {
            if (revert) this._revert(instance);
            this._instances.delete(instance.instanceId);
        }
        if (matches.length > 0) {
            Logger.info(`[EffectEngine] removed ${matches.length} effect instance(s) `
                + `(${matches.map((instance) => instance.effectId).join(', ')})`
                + `${revert ? ' (reverted)' : ''}`);
        }
        return matches.length;
    }

    /**
     * The live instances on one target — what the operator lists, and what the panel
     * shows. Copies only; the caller cannot edit engine state.
     * @param {{kind?: string, id: string}} target
     * @returns {Array<{instanceId: string, effectId: string, targetId: string, appliedRound: number|null, expiresRound: number|null, remainingRounds: number|null}>}
     */
    listActive(target) {
        return [...this._instances.values()]
            .filter((instance) => !target || instance.targetId === target.id)
            .map((instance) => ({
                instanceId: instance.instanceId,
                effectId: instance.effectId,
                targetId: instance.targetId,
                targetKind: instance.targetKind,
                appliedRound: instance.appliedRound,
                expiresRound: instance.expiresRound,
                remainingRounds: this._remainingRounds(instance),
            }));
    }

    /** Every live instance, keyed by instanceId (observability, tests). */
    getActiveEffects() {
        return Object.fromEntries([...this._instances.entries()].map(([id, instance]) => [id, {
            effectId: instance.effectId,
            targetId: instance.targetId,
            targetKind: instance.targetKind,
            appliedRound: instance.appliedRound,
            expiresRound: instance.expiresRound,
        }]));
    }

    /** How many instances a target carries. */
    countForTarget(targetId) {
        let count = 0;
        for (const instance of this._instances.values()) {
            if (instance.targetId === targetId) count++;
        }
        return count;
    }

    /**
     * Drop the instances whose target has left the world. Runs at the start of each
     * round, so an effect can never outlive the body it was applied to — a bookkeeping
     * record for a despawned droid is a leak with a name.
     */
    forgetGoneTargets() {
        for (const instance of [...this._instances.values()]) {
            if (this._targetExists({ kind: instance.targetKind, id: instance.targetId })) continue;
            // No revert: the thing the effect acted on is gone, and writing to it would
            // recreate state for an entity that no longer exists.
            this._instances.delete(instance.instanceId);
            Logger.debug(`[EffectEngine] dropped the effect record of ${instance.effectId} on `
                + `${instance.targetId}: the target is gone`);
        }
    }

    /** Clear everything (tests, hard reset). Reverts nothing by design. */
    reset() {
        this._instances.clear();
        this._inline = {};
        this._currentRound = null;
    }

    // =========================================================================
    // INLINE DURABLE DELTAS (the `expiresInRounds` consequence path)
    // =========================================================================
    //
    // Ported semantics, not reimplemented ones: this is the bookkeeping the
    // ConsequenceDispatcher has always driven for a stat consequence that declares a
    // duration, and `test/contract/durableEffects.contract.test.js` pins two of its
    // properties harder than any new code deserves - two live effects on one stat must
    // undo their OWN contributions, and a renewal must not revert in its own round.

    /**
     * The component ids an inline delta may land on: every component of the entity
     * carrying the named trait.stat, or the single targeted component when it carries
     * it. A component without a finite value there is skipped, because the tracker
     * could not compute a contribution for it.
     * @param {string} targetId
     * @param {string} targetKind - 'entity' | anything else means one component
     * @param {string} trait
     * @param {string} stat
     * @param {string[]} [components] - the owned set, resolved from the entity when omitted
     * @returns {string[]}
     */
    resolveComponents(targetId, targetKind, trait, stat, components = null) {
        const componentController = this._facade?.componentController ?? null;
        if (!componentController || !targetId) return [];
        const comps = [];
        if (targetKind === 'entity') {
            const entity = this._facade?.stateEntityController?.getEntity?.(targetId);
            const owned = Array.isArray(components) && components.length > 0
                ? components
                : (entity?.components ?? []).map((component) => component.id);
            for (const componentId of owned) {
                if (this._hasInlineStat(componentController, componentId, trait, stat)) comps.push(componentId);
            }
            return comps;
        }
        if (this._hasInlineStat(componentController, targetId, trait, stat)) comps.push(targetId);
        return comps;
    }

    /**
     * Called BEFORE the handler applies a durable stat consequence. A renewed effect
     * first has its OWN contribution removed, so the new application re-lands on the
     * value without this effect (flat, no stacking) without disturbing any other live
     * effect on the same stat.
     * @param {string} effectKey - stable key without the component suffix
     * @param {string[]} components
     * @param {string} trait
     * @param {string} stat
     * @returns {{effectKey: string, components: string[], trait: string, stat: string, baselineByComp: Object}|null}
     */
    beforeApply(effectKey, components, trait, stat) {
        const componentController = this._facade?.componentController ?? null;
        if (!componentController || !effectKey || !trait || !stat
            || !Array.isArray(components) || components.length === 0) {
            return null;
        }
        const baselineByComp = {};
        const validComps = [];
        for (const componentId of components) {
            const current = this._readInlineStat(componentController, componentId, trait, stat);
            if (current === null || !Number.isFinite(current)) continue;
            const existing = this._inline[`${effectKey}::${componentId}`];
            if (existing != null && existing.trait === trait && existing.stat === stat) {
                // Renewal: remove this effect's own contribution. Moving a component
                // back toward a higher value is not damage, so the damage event stays off.
                const remove = (typeof existing.delta === 'number') ? -existing.delta : 0;
                componentController.updateComponentStatDelta(componentId, trait, stat, remove, true);
            }
            const withoutEffect = this._readInlineStat(componentController, componentId, trait, stat);
            if (withoutEffect === null || !Number.isFinite(withoutEffect)) continue;
            baselineByComp[componentId] = withoutEffect;
            validComps.push(componentId);
        }
        if (validComps.length === 0) return null;
        return { effectKey, components: validComps, trait, stat, baselineByComp };
    }

    /**
     * Called AFTER the handler applied the consequence and succeeded: register (or
     * refresh) the expiration and this effect's own contribution.
     * No round active means not tracked - there is no clock to expire against.
     * @param {string} effectKey
     * @param {string[]} components
     * @param {string} trait
     * @param {string} stat
     * @param {Object<string, number>} baselineByComp
     * @param {number} expiresInRounds
     */
    afterApply(effectKey, components, trait, stat, baselineByComp, expiresInRounds) {
        if (!this._facade?.componentController || !effectKey || !trait || !stat) return;
        if (baselineByComp === null || baselineByComp === undefined) return;
        if (this._currentRound === null) return;
        if (typeof expiresInRounds !== 'number' || !Number.isFinite(expiresInRounds) || expiresInRounds <= 0) return;
        const componentController = this._facade.componentController;
        const componentIds = Array.isArray(components) ? components : Object.keys(baselineByComp);
        for (const componentId of componentIds) {
            const baseline = baselineByComp[componentId];
            if (baseline === null || baseline === undefined) continue;
            const applied = this._readInlineStat(componentController, componentId, trait, stat);
            const delta = (applied !== null && Number.isFinite(applied) && Number.isFinite(baseline))
                ? applied - baseline
                : null;
            // No finite contribution means no safe undo, and an effect we could not
            // undo must not be recorded.
            if (delta === null) continue;
            this._inline[`${effectKey}::${componentId}`] = {
                baseline,
                delta,
                expiresRound: this._currentRound + expiresInRounds,
                trait,
                stat,
                componentId,
            };
        }
    }

    /** The live inline durable deltas (observability, tests). */
    getInlineEffects() {
        return { ...this._inline };
    }

    /** @private */
    _hasInlineStat(componentController, componentId, trait, stat) {
        const value = this._readInlineStat(componentController, componentId, trait, stat);
        return value !== null && Number.isFinite(value);
    }

    /** @private */
    _readInlineStat(componentController, componentId, trait, stat) {
        const stats = componentController?.getComponentStats?.(componentId);
        return (stats && stats[trait]) ? stats[trait][stat] : null;
    }

    /**
     * Undo one expired inline delta by its own contribution - never an absolute write,
     * so it commutes with every other live effect on the stat, and `skipDamageEvent`
     * keeps the restore out of the damage pipeline.
     * @private
     */
    _restoreInline(entry) {
        const componentController = this._facade?.componentController ?? null;
        if (!componentController || typeof entry.delta !== 'number') return;
        componentController.updateComponentStatDelta(entry.componentId, entry.trait, entry.stat, -entry.delta, true);
        Logger.info(`[EffectEngine] inline effect ${entry.trait}.${entry.stat} on component ${entry.componentId} `
            + `expired - removed ${entry.delta}`);
    }

    // =========================================================================
    // STACKING + CAPACITY
    // =========================================================================

    /**
     * Decide what a repeat application does, and revert the instance it replaces.
     * Every branch is exercisable by a caller today; a mode that no caller could
     * reach would not be here (`CR CHG-1`).
     * @returns {{ replacedTargetId: string|null }} the instance this application takes
     *   the place of, after its contribution has been lifted. Null when nothing is
     *   displaced. 
     * @private
     */
    _resolveStacking(definition, target) {
        const existing = [...this._instances.values()]
            .filter((instance) => instance.effectId === definition.id && instance.targetId === target.id);
        if (existing.length === 0) return { kept: null, replacedTargetId: null };

        if (definition.stacking === EFFECT_STACKING.INDEPENDENT) {
            // Every application is its own instance, with its own expiry. Stacks are
            // bounded by the per-target and worldwide caps, not by this mode.
            return { replacedTargetId: null };
        }

        if (definition.stacking === EFFECT_STACKING.CAPPED) {
            const cap = definition.maxStacks ?? 1;
            if (existing.length < cap) return { replacedTargetId: null };
            // At the cap: the oldest gives its place to the new one, which is what a
            // cap means. Any other reading lets the definition's own bound be ignored.
            const oldest = existing.reduce((a, b) => ((a.appliedRound ?? 0) <= (b.appliedRound ?? 0) ? a : b));
            this._revert(oldest);
            return { replacedTargetId: oldest.instanceId };
        }

        // REFRESH (the shipped default, and the behaviour the grab debuff always had):
        // lift this effect's own contribution, re-apply at full strength.
        for (const instance of existing) {
            this._revert(instance);
            this._instances.delete(instance.instanceId);
        }
        return { replacedTargetId: null };
    }

    /**
     * The per-target and worldwide bounds (`CR A-7`). The slot freed by the instance
     * this application replaces counts as free.
     * @private
     */
    _checkCapacity(target, definition, replacedTargetId) {
        const freed = replacedTargetId ? 1 : 0;
        if (this.countForTarget(target.id) - freed >= this.maxPerTarget) {
            return { ok: false, code: EFFECT_ERROR.LIMIT_REACHED,
                error: `${target.id} already carries ${this.maxPerTarget} effect instances` };
        }
        if (this._instances.size - freed >= this.maxWorldwide) {
            return { ok: false, code: EFFECT_ERROR.LIMIT_REACHED,
                error: `the world already carries ${this.maxWorldwide} effect instances` };
        }
        return { ok: true };
    }

    // =========================================================================
    // OPERATIONS
    // =========================================================================

    /**
     * Run one operation. `contributions` collects what can be undone (apply-time
     * only; the per-round caller passes an empty array it throws away).
     * @private
     */
    _runOperation(operation, ctx, contributions) {
        const paramsErrors = validateEffectOperationParams(operation.op, operation.params);
        if (paramsErrors.length > 0) {
            // A definition that passed EffectsController cannot reach here; this is a
            // runtime param from a caller, reported as such (`CR E-1`).
            Logger.warn(`[EffectEngine] ${operation.op} refused: ${paramsErrors.join('; ')}`);
            return { applied: false, error: paramsErrors[0] };
        }
        const adapter = OPERATION_ADAPTERS[operation.op];
        if (!adapter) {
            // Passed validation, has no adapter: OUR bug, and loud on purpose
            // (`CR T-4`) — silently skipping would hide a vocabulary/table drift.
            throw new Error(`EffectEngine: the operation "${operation.op}" passed validation but has no adapter`);
        }
        return adapter.execute(this, ctx, operation.params, contributions);
    }

    /**
     * The per-operation view of the target: which components this effect acts on.
     * An entity target means the parts the body actually has — the engine never
     * invents one.
     * @private
     */
    _contextFor(target, definition) {
        const facade = this._facade;
        const entity = target.kind === EFFECT_TARGETS.ENTITY
            ? facade?.stateEntityController?.getEntity?.(target.id) ?? null
            : facade?.stateEntityController?.findEntityByComponent?.(target.id) ?? null;
        return {
            facade,
            target,
            definition,
            entity,
            entityId: target.kind === EFFECT_TARGETS.ENTITY ? target.id : (entity?.id ?? null),
            componentIds: this._componentsOf(target, entity),
            touchedAnything: false,
        };
    }

    /** @private every component of the entity, or the one targeted component. */
    _componentsOf(target, entity) {
        if (target.kind === EFFECT_TARGETS.COMPONENT) return [target.id];
        const components = entity?.components;
        return Array.isArray(components) ? components.map((component) => component.id) : [];
    }

    /** @private whether the engine may still write to this target at all. */
    _targetExists(target) {
        const facade = this._facade;
        if (!facade) return false;
        if (target.kind === EFFECT_TARGETS.COMPONENT) {
            return facade.getComponent?.(target.id) != null
                || facade.stateEntityController?.findEntityByComponent?.(target.id) != null;
        }
        return facade.stateEntityController?.getEntity?.(target.id) != null;
    }

    /**
     * Undo one instance, contributions in reverse order (the last write undone first).
     * Every write here opts out of the damage pipeline: a restore is not a weakening.
     * @private
     */
    _revert(instance) {
        const componentController = this._facade?.componentController ?? null;
        if (!componentController) return;
        for (const contribution of [...instance.contributions].reverse()) {
            if (!isReversibleEffectOperation(contribution.op)) continue;
            switch (contribution.kind) {
                case 'statDelta':
                    componentController.updateComponentStatDelta(
                        contribution.componentId, contribution.trait, contribution.stat,
                        -contribution.delta, true);
                    break;
                case 'statSet':
                    componentController.updateComponentStat(
                        contribution.componentId, contribution.trait, contribution.stat,
                        contribution.priorValue, true);
                    break;
                case 'conditionAdded':
                    if (!contribution.wasPresent) componentController.removeCondition(contribution.componentId, contribution.condition);
                    break;
                case 'conditionRemoved':
                    if (contribution.wasPresent) componentController.addCondition(contribution.componentId, contribution.condition);
                    break;
                case 'flagGranted':
                    if (!contribution.wasPresent) componentController.removeGrantedFlag(contribution.componentId, contribution.flag);
                    break;
                default:
                    // A contribution with no known kind is a writer bug: say so rather
                    // than leave the effect unreverted and quiet (`CR T-4`).
                    Logger.warn(`[EffectEngine] cannot revert a "${contribution.kind}" contribution of ${instance.effectId}`);
            }
        }
    }

    /** @private remaining rounds for a listing; null means "until removed". */
    _remainingRounds(instance) {
        if (instance.expiresRound === null || this._currentRound === null) return null;
        return Math.max(0, instance.expiresRound - this._currentRound);
    }

    /**
     * Run an operation through the consequence handler that already implements it.
     * The handler is reached through a dependency injected at composition, never by
     * walking `facade.actionController.consequenceHandlers` (`CR AP-5`).
     * @param {string} consequenceType
     * @param {Object} ctx
     * @param {Object} params
     * @returns {{ applied: boolean, error?: string }}
     * @private
     */
    _dispatchToHandlers(consequenceType, ctx, params) {
        if (!this.consequenceHandlers?.dispatch) {
            Logger.warn(`[EffectEngine] ${consequenceType} skipped: no consequence handler seam wired`);
            return { applied: false, error: 'no-consequence-seam' };
        }
        const targetId = ctx.target.kind === EFFECT_TARGETS.COMPONENT ? ctx.target.id : ctx.entityId;
        if (!targetId) return { applied: false, error: 'no-handler-target' };
        const result = this.consequenceHandlers.dispatch(consequenceType, targetId, params, {
            // An effect has no acting entity and no action in flight: the handlers see
            // an effect-scoped context, so nothing attributes the mutation to an actor
            // that does not exist.
            effectId: ctx.definition.id,
            actionName: ctx.definition.id,
            actionParams: { consequenceTarget: ctx.definition.target },
        });
        const applied = result?.success === true;
        ctx.touchedAnything = ctx.touchedAnything || applied;
        return { applied, error: applied ? undefined : (result?.message ?? result?.error ?? 'handler-refused') };
    }
}

// =============================================================================
// THE OPERATION ADAPTERS — one per op id, each delegating to the executor that
// already exists. This table is the whole of the engine's reach into the world.
// =============================================================================

/**
 * Resolve the components an operation lands on: every component carrying the named
 * trait.stat for a stat operation, every component for a condition or flag operation,
 * and the single target for a whole-body operation.
 */
function statComponents(engine, ctx, params) {
    const componentController = engine._facade?.componentController ?? null;
    if (!componentController) return [];
    return ctx.componentIds.filter((componentId) => {
        const stats = componentController.getComponentStats(componentId);
        return stats?.[params.trait]?.[params.stat] !== undefined
            && Number.isFinite(stats[params.trait][params.stat]);
    });
}

const OPERATION_ADAPTERS = Object.freeze({
    [EFFECT_OPERATIONS.STAT_DELTA]: Object.freeze({
        execute(engine, ctx, params, contributions) {
            const componentController = engine._facade?.componentController ?? null;
            if (!componentController) return { applied: false };
            const targets = statComponents(engine, ctx, params);
            for (const componentId of targets) {
                componentController.updateComponentStatDelta(componentId, params.trait, params.stat, params.value);
                contributions.push({ op: EFFECT_OPERATIONS.STAT_DELTA, kind: 'statDelta',
                    componentId, trait: params.trait, stat: params.stat, delta: params.value });
            }
            ctx.touchedAnything = ctx.touchedAnything || targets.length > 0;
            return { applied: targets.length > 0 };
        },
    }),
    [EFFECT_OPERATIONS.STAT_SET]: Object.freeze({
        execute(engine, ctx, params, contributions) {
            const componentController = engine._facade?.componentController ?? null;
            if (!componentController) return { applied: false };
            const targets = statComponents(engine, ctx, params);
            for (const componentId of targets) {
                const stats = componentController.getComponentStats(componentId);
                const priorValue = stats[params.trait][params.stat];
                componentController.updateComponentStat(componentId, params.trait, params.stat, params.value);
                contributions.push({ op: EFFECT_OPERATIONS.STAT_SET, kind: 'statSet',
                    componentId, trait: params.trait, stat: params.stat, priorValue, delta: params.value - priorValue });
            }
            ctx.touchedAnything = ctx.touchedAnything || targets.length > 0;
            return { applied: targets.length > 0 };
        },
    }),
    [EFFECT_OPERATIONS.ADD_CONDITION]: Object.freeze({
        execute(engine, ctx, params, contributions) {
            const componentController = engine._facade?.componentController ?? null;
            if (!componentController) return { applied: false };
            for (const componentId of ctx.componentIds) {
                const wasPresent = componentController.getComponentConditions(componentId).includes(params.condition);
                componentController.addCondition(componentId, params.condition);
                contributions.push({ op: EFFECT_OPERATIONS.ADD_CONDITION, kind: 'conditionAdded',
                    componentId, condition: params.condition, wasPresent });
            }
            ctx.touchedAnything = ctx.componentIds.length > 0;
            return { applied: ctx.componentIds.length > 0 };
        },
    }),
    [EFFECT_OPERATIONS.REMOVE_CONDITION]: Object.freeze({
        execute(engine, ctx, params, contributions) {
            const componentController = engine._facade?.componentController ?? null;
            if (!componentController) return { applied: false };
            for (const componentId of ctx.componentIds) {
                const wasPresent = componentController.getComponentConditions(componentId).includes(params.condition);
                componentController.removeCondition(componentId, params.condition);
                contributions.push({ op: EFFECT_OPERATIONS.REMOVE_CONDITION, kind: 'conditionRemoved',
                    componentId, condition: params.condition, wasPresent });
            }
            ctx.touchedAnything = ctx.componentIds.length > 0;
            return { applied: ctx.componentIds.length > 0 };
        },
    }),
    [EFFECT_OPERATIONS.GRANT_FLAG]: Object.freeze({
        execute(engine, ctx, params, contributions) {
            const componentController = engine._facade?.componentController ?? null;
            if (!componentController) return { applied: false };
            for (const componentId of ctx.componentIds) {
                const wasPresent = componentController.getComponentFlags(componentId).includes(params.flag);
                componentController.addGrantedFlag(componentId, params.flag);
                contributions.push({ op: EFFECT_OPERATIONS.GRANT_FLAG, kind: 'flagGranted',
                    componentId, flag: params.flag, wasPresent });
            }
            ctx.touchedAnything = ctx.componentIds.length > 0;
            return { applied: ctx.componentIds.length > 0 };
        },
    }),
    [EFFECT_OPERATIONS.DAMAGE_COMPONENT]: Object.freeze({
        execute(engine, ctx, params) {
            return engine._dispatchToHandlers('damageComponent', ctx, params);
        },
    }),
    [EFFECT_OPERATIONS.DAMAGE_RANDOM_COMPONENTS]: Object.freeze({
        execute(engine, ctx, params) {
            return engine._dispatchToHandlers('damageRandomComponents', ctx, params);
        },
    }),
    [EFFECT_OPERATIONS.DROP_MATERIAL_CHUNK]: Object.freeze({
        execute(engine, ctx, params) {
            return engine._dispatchToHandlers('dropMaterialChunk', ctx, params);
        },
    }),
    [EFFECT_OPERATIONS.MOVE_BY]: Object.freeze({
        execute(engine, ctx, params) {
            return engine._dispatchToHandlers('deltaSpatial', ctx, { x: params.dx, y: params.dy });
        },
    }),
    [EFFECT_OPERATIONS.MOVE_TO]: Object.freeze({
        execute(engine, ctx, params) {
            return engine._dispatchToHandlers('updateSpatial', ctx, { x: params.x, y: params.y });
        },
    }),
    [EFFECT_OPERATIONS.TRAVERSE_DOOR]: Object.freeze({
        execute(engine, ctx, params) {
            return engine._dispatchToHandlers('traverseDoor', ctx, { door: params.door, entityId: ctx.entityId });
        },
    }),
    [EFFECT_OPERATIONS.LOG]: Object.freeze({
        execute(engine, ctx, params) {
            const line = `[EffectEngine] ${ctx.definition.id}: ${params.message}`;
            if (params.level === 'warn') Logger.warn(line);
            else if (params.level === 'error') Logger.error(line);
            else Logger.info(line);
            ctx.touchedAnything = true;
            return { applied: true };
        },
    }),
    [EFFECT_OPERATIONS.EMIT_EVENT]: Object.freeze({
        execute(engine, ctx, params) {
            return engine._dispatchToHandlers('triggerEvent', ctx, { eventType: params.eventType });
        },
    }),
});

/** @private shape a refusal (`CR H-2`: the code, not a sentence). */
function refuse(code, error) {
    return { ok: false, code, error };
}

export default EffectEngine;
