/**
 * EnergyFlowController — the "blood system" of the component world.
 *
 * Every entity is exactly one flow network: all of its components are fully
 * interconnected (body-like). Each tick, every component sends a fixed
 * data-driven percentage of its current Physical.energy, divided equally among
 * all OTHER components of that entity; each component absorbs up to its
 * remaining capacity and overflow is lost for that tick (never re-routed).
 * Energy charged in one place (today, the M1 body's coal generator) therefore
 * circulates through the whole body and equalizes toward a uniform
 * distribution bounded by capacities.
 *
 * Logic controller (computation/coordination): it owns NO persistent world
 * data and never appears in the broadcast `subControllers` map (same exclusion
 * rule as WorldRulesController and the on-damage listener). It reads and writes
 * world state only through the facade's public surfaces, exactly like its
 * peers InternalComponentController and TurnSystemController:
 *   - live-entity enumeration via the entity store's public field,
 *   - stat reads via the facade's getComponentStats(),
 *   - SET writes via componentController.updateComponentStat(..., skipDamageEvent=true)
 *     (a flow drain is a physiological transfer, not damage — the shipped 5%
 *     onDamage chunk-drop rule must not see circulating droids shed chunks),
 *   - broadcast discipline via the facade's beginEnergyFlowTick() /
 *     endEnergyFlowTick(shouldBroadcast) scope pair (exactly one full-state
 *     broadcast per flow tick, and none when nothing moved).
 *
 * Dependency shape (constructor-based root, one-way flow, public API only):
 * constructed by the composition root with three named dependencies —
 * (1) tickSystem, (2) componentRegistry (data/components.json, used ONLY to
 * resolve the optional per-recipe `energyCapacity` bound — never stat values,
 * which the recipe model forbids), (3) worldRulesController (the flow reads the
 * validated rule via getRule('energyFlow'), never the file). The facade
 * reference is injected after construction via setWorldStateController() from
 * the composition root's post-construction wiring step — the identical
 * pattern both peer controllers use, and load-bearing: jobs run only after
 * the tick system starts (i.e. after wiring), so the facade is always
 * resolved before any callback dereferences it.
 *
 * Degradation contract (never crash, never spam): the `energyFlow` rule is
 * resolved ONCE at initialize() (the data files are loaded only at boot, so a
 * boot-time read is sufficient and cheaper than a per-tick read). When the
 * rule is inactive the job stays registered (stable id) and its callback
 * returns immediately — no stat work, no enumeration, no per-tick log line.
 * Per-tick failure isolation needs no new code: the tick system executes each
 * due job in its own try/catch, and this controller additionally wraps each
 * step in begin → work → finally close so the broadcast scope always closes
 * (a partially-written step then broadcasts exactly once with the partial
 * state, the correct representation of what actually happened).
 *
 * @module EnergyFlowController
 */

import Logger from '../../utils/Logger.js';
import { TickJob } from '../../utils/UniversalTickSystem.js';
import { TRAIT_GROUPS, STAT_NAMES } from '../../../shared/StatVocabulary.js';
import { ENERGY_FLOW_RULE } from '../worldRules/WorldRulesController.js';

/**
 * The no-op write epsilon (energy flow spec §2.4): a component is written only
 * when its clamped new value differs from its tick-start value by MORE than
 * this. Scale-relative: on the 0–100 energy scale 1e-9 is far above
 * accumulated floating-point error but below any visible change — what makes
 * "already equal" mean zero work (without it, per-pair share rounding would
 * write — and broadcast — every tick at the uniform point).
 * @type {number}
 */
const FLOW_NOOP_EPSILON = 1e-9;

/** The stable tick-job id (discoverable by id in tests). @type {string} */
const ENERGY_FLOW_JOB_ID = 'energy-flow';

/** The job runs every tick (locked: flow is a per-tick mechanic). @type {number} */
const ENERGY_FLOW_JOB_INTERVAL = 1;

/**
 * Execution order: strictly after `internal-components` (order 0, so coal-
 * generator charging lands in the tick-start read before flow redistributes
 * it) and strictly after `turn-system` (order 1, so round-start stat effects
 * settle before flow acts). Order 2 is the lowest integer after both.
 * @type {number}
 */
const ENERGY_FLOW_JOB_ORDER = 2;

class EnergyFlowController {
    /**
     * @param {UniversalTickSystem|null} tickSystem - The global tick system
     *   (for job registration; mirroring the IC and turn controllers).
     * @param {Object} componentRegistry - The already-loaded data/components.json
     *   object (one load, N readers). Used ONLY to resolve the optional
     *   per-recipe `energyCapacity` bound — never for stat values.
     * @param {import('../worldRules/WorldRulesController.js').default|null} worldRulesController
     *   - The layer-0 rules owner (read via getRule('energyFlow')).
     */
    constructor(tickSystem, componentRegistry, worldRulesController) {
        this.tickSystem = tickSystem;
        this.componentRegistry = componentRegistry || {};
        this.worldRulesController = worldRulesController;
        // Injected AFTER construction by the composition root (see module JSDoc).
        this.worldStateController = null;
        // Resolved once at initialize() (Decision 11: rules are static per world).
        this._rule = null;
        // Validated per-recipe energyCapacity overrides (type → number).
        this._capacityByType = {};
    }

    /**
     * Injects the facade reference (post-construction wiring step of the
     * composition root). Null-tolerant: hand-built test facades may omit it;
     * a tick then degrades to a silent no-op.
     * @param {import('../WorldStateController.js').default} worldStateController
     * @returns {void}
     */
    setWorldStateController(worldStateController) {
        this.worldStateController = worldStateController;
    }

    /**
     * Boot-time initialization, called from the facade constructor immediately
     * after the turn system's initialize() (identical lifecycle to both peers):
     *   (1) resolves the `energyFlow` rule config once via the rules
     *       controller's inspection API (inactive → the flow is fully off,
     *       the job still gets registered as a no-op callback);
     *   (2) fail-soft-validates the optional per-recipe `energyCapacity`
     *       fields **when the rule is active** (spec degradation table: the
     *       per-recipe warn is conditioned on 'rule active'; rule off → no
     *       validation, no warn);
     *   (3) registers the tick job and logs exactly ONE info line.
     * Side-effect-free until the tick system starts.
     * @returns {void}
     */
    initialize() {
        if (!this.tickSystem) {
            Logger.warn('[EnergyFlowController] No tickSystem provided. Energy flow will not run.');
            return;
        }

        // (1) Rule resolution — once, at boot. The rules controller returns a
        // defensive copy of the validated config, or null when the rule is
        // inactive (file missing/malformed, key absent, malformed config,
        // enabled: false, or sharePerTick: 0 — off by design).
        this._rule = this.worldRulesController
            ? this.worldRulesController.getRule(ENERGY_FLOW_RULE)
            : null;

        // (2) Fail-soft per-recipe capacity validation — ONLY when the rule is
        // active: the spec's degradation table conditions the per-recipe warn on
        // "rule active"; with the rule off no component ever resolves a capacity,
        // so a malformed field would warn about a feature that does nothing.
        this._capacityByType = this._rule ? this._validateRecipeCapacities() : {};

        // (3) Job registration. The job stays registered even when the rule is
        // inactive (stable id) — the callback then returns immediately.
        this.tickSystem.register(new TickJob(
            ENERGY_FLOW_JOB_ID,
            () => this.processFlowTick(),
            ENERGY_FLOW_JOB_INTERVAL,
            ENERGY_FLOW_JOB_ORDER
        ));

        if (this._rule) {
            Logger.info(
                `[EnergyFlowController] energy-flow active (sharePerTick=${this._rule.sharePerTick}, ` +
                `defaultEnergyCapacity=${this._rule.defaultEnergyCapacity}, ` +
                `recipe energyCapacity overrides=${Object.keys(this._capacityByType).length}; ` +
                `job id=${ENERGY_FLOW_JOB_ID}, interval=${ENERGY_FLOW_JOB_INTERVAL}, order=${ENERGY_FLOW_JOB_ORDER})`
            );
        } else {
            Logger.info(
                `[EnergyFlowController] energy-flow disabled at boot (the "${ENERGY_FLOW_RULE}" rule is inactive) — legacy behavior, no flow.`
            );
        }
    }

    /**
     * One flow step: the simultaneous read-all / compute / write-all pass over
     * every live entity. Each entity is one fully-interconnected network with
     * N ≥ 2 components (fewer → no-op, no division by zero possible); an
     * entity whose tick-start energy sum is 0 is skipped entirely (zero-energy
     * entities do no work). Sends are computed from tick-start values ONLY
     * (simultaneity: no component's write feeds another component's send in the
     * same tick), each send is divided equally among the other N−1 components,
     * and each component's new value is clamped to [0, its capacity] —
     * overflow is lost for the tick, never re-routed. A component is written
     * (SET, damage event suppressed) only when its clamped value meaningfully
     * differs from its tick-start value (the FLOW_NOOP_EPSILON no-op rule:
     * steady-state and zero-energy worlds perform zero writes and zero
     * broadcasts per tick).
     *
     * The whole step runs inside the facade's flow broadcast scope
     * (begin → work → finally close) so the scope ALWAYS closes, even on an
     * internal exception: a partially-written step then broadcasts exactly
     * once with the partial state. Failure isolation beyond that is the tick
     * system's per-job try/catch (this job can never take down the tick or
     * the other jobs).
     * @returns {void}
     */
    processFlowTick() {
        // Rule resolved once at boot: inactive → the callback returns
        // immediately (no enumeration, no writes, no per-tick log).
        if (!this._rule) return;
        const world = this.worldStateController;
        if (!world) return; // unwired (hand-built test facades) — silent no-op.

        const share = this._rule.sharePerTick;
        let anyWrite = false;
        world.beginEnergyFlowTick();
        try {
            const entityStore = world.stateEntityController;
            const allEntities = typeof entityStore?.getAll === 'function'
                ? Object.values(entityStore.getAll())
                : [];

            for (const entity of allEntities) {
                if (!entity || !Array.isArray(entity.components)) continue;
                const components = entity.components;
                // An entity with fewer than two components is a network that
                // cannot circulate: a no-op (no division by zero possible).
                if (components.length < 2) continue;

                // READ-ALL: tick-start energy of every component. A missing or
                // non-numeric stat reads as 0 (the read-equivalent of absent).
                const starts = new Array(components.length);
                let total = 0;
                for (let i = 0; i < components.length; i++) {
                    const start = this._readEnergy(world, components[i].id);
                    starts[i] = start;
                    total += start;
                }
                // A zero-energy entity does no work (spec: skip when the SUM of tick-start
                // energies is 0; every read is non-negative, so === 0 is exact). Note the
                // FLOW_NOOP_EPSILON below is a per-component DIFF guard, not an eligibility
                // threshold — do not merge the two.
                if (total === 0) continue;

                // COMPUTE (simultaneous step — tick-start values only): send(c) =
                // share × start(c), split equally among the other N−1 components, clamped
                // to [0, capacity] — overflow lost for the tick.
                const n = components.length;
                const nexts = this._computeEntityNextValues(starts, components, share);

                // WRITE-ALL: only where the clamped value meaningfully differs
                // from the tick-start value. SET semantics so unseeded
                // components absorb (the stat is created on first absorption);
                // skipDamageEvent=true so a physiological drain never reaches
                // the damage pipeline (the onDamage rule is source-agnostic and
                // would otherwise drop chunks on every circulated tick).
                for (let i = 0; i < n; i++) {
                    if (Math.abs(nexts[i] - starts[i]) <= FLOW_NOOP_EPSILON) continue;
                    world.componentController.updateComponentStat(
                        components[i].id,
                        TRAIT_GROUPS.PHYSICAL,
                        STAT_NAMES.ENERGY,
                        nexts[i],
                        true
                    );
                    anyWrite = true;
                }
            }
        } finally {
            // ALWAYS close the scope (even on an internal exception): one
            // full-state broadcast per flow tick, and only if something moved.
            world.endEnergyFlowTick(anyWrite);
        }
    }

    /**
     * Reads a component's tick-start Physical.energy through the facade's
     * public reader (defensive copy). A missing or non-numeric stat reads as 0.
     * @param {import('../WorldStateController.js').default} world - The facade.
     * @param {string} componentId - The component instance ID.
     * @returns {number} The tick-start energy (0 for absent/non-numeric).
     * @private
     */
    _readEnergy(world, componentId) {
        const stats = world.getComponentStats(componentId);
        const value = stats && stats[TRAIT_GROUPS.PHYSICAL]
            ? stats[TRAIT_GROUPS.PHYSICAL][STAT_NAMES.ENERGY]
            : undefined;
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    }

    /**
     * Computes every component's clamped next value for ONE entity from the
     * tick-start energies only (the simultaneous step, spec §2.2): send(c) =
     * share × start(c), split equally among the other N−1 components; each
     * next value clamped to [0, its capacity] — overflow is LOST for the tick,
     * never re-routed. Extracted from processFlowTick for readability; the
     * floating-point operation ORDER is bit-identical to the former inline code
     * (the contract suite pins exact values, e.g. 100 − share·100).
     * @param {number[]} starts - Tick-start energies, indexed per component (all ≥ 0).
     * @param {Array<{ type: string }>} components - The entity's components (capacity lookup by recipe type).
     * @param {number} share - The rule's sharePerTick (in (0, 1] when the rule is active).
     * @returns {number[]} The clamped next values, indexed per component.
     * @private
     */
    _computeEntityNextValues(starts, components, share) {
        const n = starts.length;
        const sends = new Array(n);
        for (let i = 0; i < n; i++) {
            sends[i] = share * starts[i];
        }
        const nexts = new Array(n);
        for (let o = 0; o < n; o++) {
            let inflow = 0;
            for (let c = 0; c < n; c++) {
                if (c === o) continue;
                inflow += sends[c] / (n - 1);
            }
            const raw = starts[o] + inflow - sends[o];
            const capacity = this._capacityFor(components[o].type);
            // Clamp to [0, capacity]: the lower bound is defensive (energy never
            // goes negative in this dynamic), the upper bound is the component's
            // capacity — overflow is LOST for this tick.
            nexts[o] = Math.min(Math.max(raw, 0), capacity);
        }
        return nexts;
    }

    /**
     * Resolves a component's capacity bound: the recipe's own
     * `energyCapacity` when declared (and validated at boot), else the rule's
     * `defaultEnergyCapacity`. Note the resolution is on the recipe's ABSENCE:
     * an explicit `energyCapacity: 0` is a VALID capacity ("this component
     * holds no energy"), not a fallback trigger.
     * @param {string} componentType - The component's recipe type.
     * @returns {number} The capacity bound for the component.
     * @private
     */
    _capacityFor(componentType) {
        const override = this._capacityByType[componentType];
        return override !== undefined ? override : this._rule.defaultEnergyCapacity;
    }

    /**
     * Fail-soft-validates the optional per-recipe `energyCapacity` fields in
     * the injected component registry (energy flow spec §4: present-but-
     * malformed → warn once per recipe and ignore the field, falling back to
     * the rule default — never a boot failure, matching the world-rules
     * degradation discipline). Absence everywhere → no log beyond the init
     * line. Unknown extra recipe fields are never touched: this method reads
     * only the optional bound, never stat values.
     * @returns {Object<string, number>} A map of recipe type → validated
     *   capacity for every recipe that declares a valid field.
     * @private
     */
    _validateRecipeCapacities() {
        const capacities = {};
        for (const [type, recipe] of Object.entries(this.componentRegistry)) {
            // Metadata keys (_comment) are not recipes (house convention).
            if (type.startsWith('_')) continue;
            if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) continue;
            if (recipe.energyCapacity === undefined) continue; // absence → default
            const value = recipe.energyCapacity;
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
                Logger.warn(
                    `[EnergyFlowController] Recipe "${type}": "energyCapacity" is malformed (${String(value)}) — field ignored, the world-rules default capacity applies.`
                );
                continue;
            }
            capacities[type] = value;
        }
        return capacities;
    }
}

export default EnergyFlowController;
