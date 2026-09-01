/**
 * InternalComponentController
 * Manages the lifecycle, installation, and tick-based effects of internal components.
 * Integrates with the UniversalTickSystem for deterministic simulation updates.
 */

import Logger from '../../utils/Logger.js';
import DataLoader from '../../utils/DataLoader.js';
import { TickJob } from '../../utils/UniversalTickSystem.js';
import { generateUID } from '../../utils/idGenerator.js';
import { IC_BASE_TICK_INTERVAL, DEFAULT_HOST_VOLUME_FALLBACK } from '../../utils/Constants.js';

class InternalComponentController {
    /**
     * @param {Object} [internalComponentRegistry] - Pre-loaded internal component definitions.
     *   If not provided, loads from data/internalComponents.json.
     * @param {UniversalTickSystem} [tickSystem] - The global tick system instance.
     */
    constructor(internalComponentRegistry = null, tickSystem = null) {
        // Load registry from data file
        this.registry = internalComponentRegistry || DataLoader.loadJsonSafe('data/internalComponents.json', {});
        this._validateRegistry(this.registry);

        // Load component definitions for trait checking
        this.componentDefinitions = DataLoader.loadJsonSafe('data/components.json', {});

        // State storage: { [entityId]: { [hostComponentId]: [internalComponentInstances] } }
        this.internalComponents = {};

        // Reference to the global tick system
        this.tickSystem = tickSystem;

        Logger.info(`[InternalComponentController] Initialized with ${Object.keys(this.registry).length} internal component types`);
    }

    /**
     * Initializes the controller with the global tick system.
     * Registers the unified tick job to process internal component effects.
     */
    initialize() {
        if (!this.tickSystem) {
            Logger.warn('[InternalComponentController] No tickSystem provided. Internal component effects will not run.');
            return;
        }

        // Register a job that runs every tick (Order 0 = Highest Priority)
        this.tickSystem.register(new TickJob(
            'internal-components',
            () => this._processTick(),
            IC_BASE_TICK_INTERVAL, // interval in ticks
            0  // Order: 0 (Highest Priority)
        ));

        Logger.info('[InternalComponentController] Registered with UniversalTickSystem');
    }

    /**
     * Validates the internal component registry structure.
     * Structurally invalid entries (missing required fields, unknown effect
     * vocabulary, wrong types) throw TypeError so corrupted data never enters
     * the internal state; optional/soft conditions are surfaced via warn.
     * @param {Object} registry - The internal component registry to validate.
     * @private
     */
    _validateRegistry(registry) {
        if (!registry || typeof registry !== 'object') {
            throw new TypeError('[InternalComponentController] Registry must be an object');
        }

        for (const [type, definition] of Object.entries(registry)) {
            if (type.startsWith('_')) continue; // metadata keys (_comment) are not IC types
            // Validate volume
            if (!definition.volume || typeof definition.volume !== 'number') {
                Logger.warn(`[InternalComponentController] Internal component "${type}" missing valid volume property`);
            }

            // Validate tickInterval
            if (definition.tickInterval && typeof definition.tickInterval !== 'number') {
                Logger.warn(`[InternalComponentController] Internal component "${type}" has invalid tickInterval`);
            }

            // Validate turn-driven channel (parallel to the tick channel): when a
            // type opts into turn-driven effects it MUST declare a structurally
            // valid turnEffects array; the tick cadence fields are intentionally
            // not required for these types.
            if (definition.turnDriven === true) {
                if (!Array.isArray(definition.turnEffects) || definition.turnEffects.length === 0) {
                    throw new TypeError(`[InternalComponentController] Internal component "${type}" is turnDriven but has no turnEffects`);
                }
                this._validateTurnEffects(type, definition.turnEffects);
                // hostComponentType / hostSlot are optional auto-install filters;
                // validate their shape when present.
                if (definition.hostComponentType !== undefined && typeof definition.hostComponentType !== 'string') {
                    throw new TypeError(`[InternalComponentController] Internal component "${type}" hostComponentType must be a string`);
                }
                if (definition.hostSlot !== undefined && typeof definition.hostSlot !== 'string') {
                    throw new TypeError(`[InternalComponentController] Internal component "${type}" hostSlot must be a string`);
                }
            } else if (!definition.turnEffects && (!definition.tickEffects || !Array.isArray(definition.tickEffects) || definition.tickEffects.length === 0)) {
                // A type that declares neither channel is a passive no-op — surface it.
                Logger.warn(`[InternalComponentController] Internal component "${type}" declares neither turnEffects nor tickEffects (passive no-op)`);
            }

            // Validate tickEffects
            if (definition.tickEffects !== undefined) {
                if (!Array.isArray(definition.tickEffects)) {
                    throw new TypeError(`[InternalComponentController] Internal component "${type}" tickEffects must be an array`);
                } else {
                    for (const effect of definition.tickEffects) {
                        if (!effect.targetTrait) {
                            throw new TypeError(`[InternalComponentController] Internal component "${type}" tick effect missing targetTrait`);
                        }
                        if (!effect.targetStat) {
                            throw new TypeError(`[InternalComponentController] Internal component "${type}" tick effect missing targetStat`);
                        }
                        if (!effect.effect) {
                            throw new TypeError(`[InternalComponentController] Internal component "${type}" tick effect missing effect type`);
                        } else if (!['add', 'set', 'multiply'].includes(effect.effect)) {
                            throw new TypeError(`[InternalComponentController] Internal component "${type}" has invalid tick effect type: ${effect.effect}`);
                        }
                        if (effect.amount === undefined || effect.amount === null || typeof effect.amount !== 'number') {
                            throw new TypeError(`[InternalComponentController] Internal component "${type}" tick effect amount must be a number`);
                        }
                    }
                }
            }

            // Validate targetBlueprintTypes (optional — if present, must be an array)
            if (definition.targetBlueprintTypes !== undefined) {
                if (!Array.isArray(definition.targetBlueprintTypes)) {
                    throw new TypeError(`[InternalComponentController] Internal component "${type}" targetBlueprintTypes must be an array`);
                }
            }
        }
    }

    /**
     * Validates each turn effect entry. Reuses the add/set/multiply effect
     * vocabulary and adds the `target` field (self | host) that distinguishes
     * whether the effect applies to the instance's own stat pool or to the
     * host component's stat. Structurally invalid entries (missing
     * targetTrait/targetStat, unknown effect, non-numeric amount, unknown
     * target) throw TypeError so corrupted data never enters the state.
     * @param {string} type - The internal component type (for log context).
     * @param {Array} turnEffects - The turnEffects array to validate.
     * @private
     */
    _validateTurnEffects(type, turnEffects) {
        for (const effect of turnEffects) {
            if (!effect.targetTrait) {
                throw new TypeError(`[InternalComponentController] Internal component "${type}" turnEffect missing targetTrait`);
            }
            if (!effect.targetStat) {
                throw new TypeError(`[InternalComponentController] Internal component "${type}" turnEffect missing targetStat`);
            }
            if (!effect.effect || !['add', 'set', 'multiply'].includes(effect.effect)) {
                throw new TypeError(`[InternalComponentController] Internal component "${type}" turnEffect has invalid effect type: ${effect.effect}`);
            }
            if (effect.amount === undefined || effect.amount === null || typeof effect.amount !== 'number') {
                throw new TypeError(`[InternalComponentController] Internal component "${type}" turnEffect amount must be a number`);
            }
            if (!['self', 'host'].includes(effect.target)) {
                throw new TypeError(`[InternalComponentController] Internal component "${type}" turnEffect target must be "self" or "host": ${effect.target}`);
            }
        }
    }

    /**
     * Checks whether an internal component type is declared on a component
     * type's `internalComponents` list (the component's own data-driven organ
     * list from data/components.json).
     * @param {string} componentType - The component type (e.g., "droidHand").
     * @param {string} icType - The internal component type (e.g., "strengthCore").
     * @returns {boolean}
     * @private
     */
    _isDeclaredOnComponentType(componentType, icType) {
        const registry = this.worldStateController?.componentController?.componentRegistry;
        const def = registry?.[componentType];
        return Array.isArray(def?.internalComponents) && def.internalComponents.includes(icType);
    }

    /**
     * Auto-installs eligible internal components on a newly spawned entity.
     * Processes all registry entries with autoInstallOnSpawn: true, filtering by:
     * - excludedComponentTypes (skip certain host component types)
     * - targetBlueprintTypes (only install on matching entity blueprints)
     * - volume capacity (skip components with insufficient volume)
     * - hostComponentType + hostSlot (constrain installation to a specific limb)
     *
     * `hostSlot` matches the host component's PARENT component's identifier, not
     * the host's own identifier. The parent is resolved via the host's `dependsOn`
     * field (which carries the parent instance id, set by the blueprint expander).
     * This matters because a nested component's own identifier is remapped with a
     * `default_` prefix (e.g. the left hand carries `default_left`, while its
     * parent arm carries `left`), so matching the host's own identifier would
     * never resolve. Matching the parent arm's identifier targets the limb the
     * data file actually names.
     *
     * @param {string} entityId - The entity ID.
     * @param {Array} components - Array of component objects with type, id, identifier, and optionally dependsOn (parent instance ids).
     * @param {string|null} [entityType] - The blueprint type of the entity (e.g., 'smallBallDroid').
     * @param {Object} [componentVolumeProvider] - Function to get component volume: (componentType) => number
     * @returns {Object} Map of { [internalComponentType]: [installedInstances] }
     */
    autoInstallOnEntitySpawn(entityId, components, entityType = null, componentVolumeProvider = null) {
        // Initialize entity entry if not exists
        if (!this.internalComponents[entityId]) {
            this.internalComponents[entityId] = {};
        }

        const allInstalled = {};

        // Process each registered internal component type
        for (const [compType, compDef] of Object.entries(this.registry)) {
            // An IC installs on spawn if it auto-installs OR is declared on at
            // least one component type's `internalComponents` list (data-driven
            // organs — see _isDeclaredOnComponentType).
            const declaredAnywhere = components.some(c => this._isDeclaredOnComponentType(c.type, compType));
            if (!compDef.autoInstallOnSpawn && !declaredAnywhere) continue;

            // Filter by targetBlueprintTypes
            if (compDef.targetBlueprintTypes && Array.isArray(compDef.targetBlueprintTypes)) {
                if (!compDef.targetBlueprintTypes.includes(entityType)) {
                    Logger.info(`[InternalComponentController] Skipping ${compType} — entity type "${entityType}" not in targetBlueprintTypes`);
                    continue;
                }
            }

            const excludedTypes = compDef.excludedComponentTypes || [];
            const volume = compDef.volume;
            const requiredTraits = compDef.requiredTraits || null;
            // Host-constraint filters: restrict installation to a specific
            // component type (hostComponentType) and, optionally, to the limb
            // whose PARENT arm identifier matches (hostSlot). See the method
            // JSDoc for why the parent arm (not the host itself) is matched.
            const hostComponentType = compDef.hostComponentType || null;
            const hostSlot = compDef.hostSlot || null;
            const installed = [];

            if (!this.internalComponents[entityId]) {
                this.internalComponents[entityId] = {};
            }

            for (const component of components) {
                // Per-component gate: a non-auto-install IC only lands on a
                // component whose type declares it in `internalComponents`.
                if (!compDef.autoInstallOnSpawn && !this._isDeclaredOnComponentType(component.type, compType)) {
                    continue;
                }

                // Skip excluded component types (e.g., fingers)
                if (excludedTypes.includes(component.type)) {
                    Logger.info(`[InternalComponentController] Skipping ${component.type} — excluded from ${compType} auto-install`);
                    continue;
                }

                // Host-type filter: the component must be of the declared type.
                if (hostComponentType && component.type !== hostComponentType) {
                    continue;
                }

                // Host-slot filter: match the PARENT arm's identifier, resolved
                // via the host's dependsOn field (see JSDoc above). The host's
                // own identifier is remapped with a `default_` prefix by the
                // blueprint expander, so it is deliberately NOT compared here.
                if (hostSlot) {
                    const parentIdentifier = this._resolveParentIdentifier(component, components);
                    if (parentIdentifier !== hostSlot) {
                        continue;
                    }
                }

                // Check required traits on this component type
                if (requiredTraits && !this._checkRequiredTraits(component.type, requiredTraits)) {
                    Logger.info(`[InternalComponentController] Skipping ${component.type} — missing required traits for ${compType} auto-install`);
                    continue;
                }

                // Check volume capacity
                let hostVolume = 0;
                if (componentVolumeProvider) {
                    hostVolume = componentVolumeProvider(component.type);
                } else {
                    // Fallback: use default assumption
                    hostVolume = DEFAULT_HOST_VOLUME_FALLBACK;
                }

                if (hostVolume < volume) {
                    Logger.info(`[InternalComponentController] Skipping ${component.type} — volume ${hostVolume} < ${volume} for ${compType}`);
                    continue;
                }

                // Initialize host component array if not exists
                if (!this.internalComponents[entityId][component.id]) {
                    this.internalComponents[entityId][component.id] = [];
                }

                // Skip if already has an internal component of this type on this host
                const existing = this.internalComponents[entityId][component.id];
                if (existing.some(ic => ic.type === compType)) {
                    Logger.info(`[InternalComponentController] ${component.type} already has ${compType} — skipping`);
                    continue;
                }

                // Create internal component instance
                const instanceId = generateUID();
                const instance = {
                    id: instanceId,
                    type: compType,
                    hostComponentId: component.id,
                    hostComponentType: component.type,
                    hostComponentIdentifier: component.identifier,
                    installedAt: Date.now(),
                    // The instance's own stat pool (deep copy of the type's traits),
                    // used by `target: "self"` turn effects when a type has a
                    // self-existence pool. The strengthCore type drains the HOST
                    // hand's existence instead, so this pool is static for it.
                    instanceStats: this._buildInstanceStats(compDef),
                    // Broken flag: set true when the instance's self-existence pool
                    // reaches 0 (via a self drain or adjustInstanceStat); the
                    // instance stops applying effects once broken.
                    broken: false
                };

                this.internalComponents[entityId][component.id].push(instance);
                installed.push(instance);

                // The organ's static grants become the host's function stats
                // (set, non-additive) — the recipe-model source of capability.
                this._applyGrants(component.id, compDef);

                Logger.info(`[InternalComponentController] Auto-installed ${compType} in ${component.type} (${component.identifier}) of entity ${entityId}`);
            }

            if (installed.length > 0) {
                allInstalled[compType] = installed;
            }
        }

        const totalInstalled = Object.values(allInstalled).reduce((sum, arr) => sum + arr.length, 0);
        Logger.info(`[InternalComponentController] Installed ${totalInstalled} internal components on entity ${entityId}`);
        return allInstalled;
    }

    /**
     * Resolves the parent component's identifier for a given component, using
     * the component's `dependsOn` field (an array of parent instance ids).
     * Returns null when the component has no parent or the parent is not in
     * the provided component list (e.g. a manually-constructed component list
     * without parent ids). The first dependsOn entry is used (components have
     * at most one parent in the current blueprint model).
     * @param {Object} component - The component whose parent identifier is needed.
     * @param {Array} components - The full component list for the entity.
     * @returns {string|null} The parent component's identifier, or null.
     * @private
     */
    _resolveParentIdentifier(component, components) {
        const dependsOn = component.dependsOn;
        if (!Array.isArray(dependsOn) || dependsOn.length === 0) return null;
        const parentId = dependsOn[0];
        const parent = components.find(c => c.id === parentId);
        return parent ? parent.identifier : null;
    }

    /**
     * Manually adds an internal component to a host component.
     * Returns a defensive deep copy of the created instance so callers never
     * hold a live reference into the controller's internal state.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @param {string} internalComponentType - The internal component type to add.
     * @returns {Object|null} A deep copy of the created instance, or null if failed.
     */
    addInternalComponent(entityId, hostComponentId, internalComponentType) {
        if (!this.registry[internalComponentType]) {
            Logger.error(`[InternalComponentController] Unknown internal component type: ${internalComponentType}`);
            return null;
        }

        if (!this.internalComponents[entityId]) {
            this.internalComponents[entityId] = {};
        }

        if (!this.internalComponents[entityId][hostComponentId]) {
            this.internalComponents[entityId][hostComponentId] = [];
        }

        const compDef = this.registry[internalComponentType];
        const instanceId = generateUID();
        const instance = {
            id: instanceId,
            type: internalComponentType,
            hostComponentId: hostComponentId,
            installedAt: Date.now(),
            // Same instance shape as auto-install: own stat pool + broken flag.
            // The pool backs `target: "self"` effects; host-targeting types keep it static.
            instanceStats: this._buildInstanceStats(compDef),
            broken: false
        };

        this.internalComponents[entityId][hostComponentId].push(instance);

        // The organ's static grants become the host's function stats (set,
        // non-additive) — applied here so a manually added organ is immediately
        // effective, matching the auto-install path.
        this._applyGrants(hostComponentId, compDef);

        Logger.info(`[InternalComponentController] Added ${internalComponentType} to ${hostComponentId} of entity ${entityId}`);

        return structuredClone(instance);
    }

    /**
     * Applies an organ type's static `grants` to the host component's function
     * stats as an absolute SET (non-additive / "maintained"). In the recipe
     * model a component's function stats (strength, move, fine_controls,
     * think_level) come from the organs it carries — the removed traits.json
     * molds no longer seed them, so a component is only capable because it
     * carries an organ that grants the capability. A SET is idempotent:
     * installing (or re-installing) the same organ keeps the host at the
     * granted value instead of stacking it (the turnDrivenIC contract's
     * "maintained at 50, never 100" invariant).
     *
     * Grants are keyed in the flat "Group.stat" wire form (e.g.
     * "Physical.strength": 50) and split into the (trait, stat) pair the
     * componentController setter expects. Only numeric grants are applied;
     * `grantsFlags` (a Phase 3b concern) is intentionally ignored here.
     *
     * @param {string} hostComponentId - The host component instance ID.
     * @param {Object} compDef - The organ type definition (its `grants` map).
     * @private
     */
    _applyGrants(hostComponentId, compDef) {
        if (!this.worldStateController) return;
        const grants = compDef.grants;
        if (!grants || typeof grants !== 'object') return;
        for (const [key, value] of Object.entries(grants)) {
            if (typeof value !== 'number') continue;
            const dot = key.indexOf('.');
            if (dot === -1) continue;
            const traitId = key.slice(0, dot);
            const statName = key.slice(dot + 1);
            this.worldStateController.componentController.updateComponentStat(
                hostComponentId, traitId, statName, value
            );
        }
    }


    /**
     * Adjusts a stat on an internal component instance's OWN stat pool by a
     * delta. This is the public facade for driving the instance's self-existence
     * (or other self stats) without reaching into internalComponents internals.
     * Returns a defensive deep copy of the updated instance, or null if the
     * instance or stat is not found.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @param {string} instanceId - The internal component instance ID.
     * @param {string} trait - The trait name (e.g. 'Physical').
     * @param {string} stat - The stat name (e.g. 'existence').
     * @param {number} delta - The delta to apply (negative to drain).
     * @returns {Object|null} A deep copy of the updated instance, or null.
     */
    adjustInstanceStat(entityId, hostComponentId, instanceId, trait, stat, delta) {
        const instances = this.internalComponents[entityId]?.[hostComponentId];
        if (!instances) return null;
        const instance = instances.find(ic => ic.id === instanceId);
        if (!instance) return null;
        const pool = instance.instanceStats;
        if (!pool || !pool[trait] || typeof pool[trait][stat] !== 'number') return null;
        pool[trait][stat] += delta;
        if (pool[trait].existence !== undefined && pool[trait].existence <= 0) {
            pool[trait].existence = 0;
            instance.broken = true;
        }
        return structuredClone(instance);
    }


    /**
     * Removes an internal component from a host component.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @param {string} internalComponentInstanceId - The internal component instance ID to remove.
     * @returns {boolean} True if removed successfully.
     */
    removeInternalComponent(entityId, hostComponentId, internalComponentInstanceId) {
        if (!this.internalComponents[entityId] || !this.internalComponents[entityId][hostComponentId]) {
            return false;
        }

        const index = this.internalComponents[entityId][hostComponentId].findIndex(
            ic => ic.id === internalComponentInstanceId
        );

        if (index === -1) {
            return false;
        }

        const removed = this.internalComponents[entityId][hostComponentId].splice(index, 1);
        Logger.info(`[InternalComponentController] Removed ${removed[0]?.type} from ${hostComponentId} of entity ${entityId}`);

        // Clean up empty arrays
        if (this.internalComponents[entityId][hostComponentId].length === 0) {
            delete this.internalComponents[entityId][hostComponentId];
        }

        return true;
    }

    /**
     * Gets internal components for a specific host component.
     * Returns a defensive deep copy to prevent external mutation of internal state.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @returns {Array} Deep copy of internal component instances for the host.
     */
    getInternalComponents(entityId, hostComponentId) {
        if (!this.internalComponents[entityId] || !this.internalComponents[entityId][hostComponentId]) {
            return [];
        }
        return structuredClone(this.internalComponents[entityId][hostComponentId]);
    }

    /**
     * Gets all internal components for an entity.
     * Returns a defensive deep copy to prevent external mutation of internal state.
     *
     * @param {string} entityId - The entity ID.
     * @returns {Object} Deep copy of all internal components for the entity.
     */
    getInternalComponentsForEntity(entityId) {
        if (!this.internalComponents[entityId]) {
            return {};
        }
        return structuredClone(this.internalComponents[entityId]);
    }

    /**
     * Checks if a host component has a specific type of internal component.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @param {string} internalComponentType - The internal component type to check.
     * @returns {boolean} True if the host has the specified internal component type.
     */
    hasInternalComponent(entityId, hostComponentId, internalComponentType) {
        const components = this.getInternalComponents(entityId, hostComponentId);
        return components.some(ic => ic.type === internalComponentType);
    }

    /**
     * Returns a deep copy of all internal components.
     * @returns {Object} Deep clone of internalComponents.
     */
    getAll() {
        return structuredClone(this.internalComponents);
    }

    /**
     * Cleans up internal component data for a specific entity.
     * Called when an entity is despawned.
     *
     * @param {string} entityId - The entity ID to clean up.
     * @returns {boolean} True if cleanup was performed.
     */
    cleanupEntity(entityId) {
        if (!this.internalComponents[entityId]) {
            return false;
        }
        delete this.internalComponents[entityId];
        Logger.info(`[InternalComponentController] Cleaned up internal components for entity ${entityId}`);
        return true;
    }

    // =========================================================================
    // UNIFIED TICK PROCESSING
    // =========================================================================

    /**
     * Called every tick: processes all internal component effects
     * based on their tickInterval from the registry definition.
     *
     * @private
     */
    _processTick() {
        // We use Date.now() to calculate "logical seconds" for tickInterval alignment
        // This ensures that a component with tickInterval=2 fires every 2 logical seconds
        // regardless of the tick rate (e.g., 60 ticks/sec).
        const currentLogicalSecond = Math.floor(Date.now() / 1000);
        let totalEffects = 0;

        for (const [entityId, hostComponents] of Object.entries(this.internalComponents)) {
            for (const [hostComponentId, internalComponents] of Object.entries(hostComponents)) {
                for (const internalComp of internalComponents) {
                    const compDef = this.registry[internalComp.type];
                    // Turn-driven types are driven by the round-start hook, NOT the
                    // tick channel — skip them here so they are never double-applied.
                    if (!compDef || compDef.turnDriven) continue;
                    if (!compDef.tickEffects || !Array.isArray(compDef.tickEffects)) continue;

                    // Check if this tick interval has arrived (Logical Second % Interval == 0)
                    if (currentLogicalSecond % compDef.tickInterval !== 0) continue;

                    // Apply each tick effect defined for this component type
                    for (const effect of compDef.tickEffects) {
                        try {
                            this._applyTickEffect(internalComp, compDef, effect, hostComponentId);
                            totalEffects++;
                        } catch (error) {
                            Logger.error(`[InternalComponentController] Tick effect failed for ${hostComponentId} (${internalComp.type}): ${error.message}`);
                        }
                    }
                }
            }
        }

        if (totalEffects > 0) {
            // Sync internal components back to entity store so client receives them in broadcast
            this._syncToEntityStore();
            Logger.info(`[InternalComponentController] Unified tick complete: ${totalEffects} effects applied`);
        }
    }

    /**
     * Applies a single tick effect to a host component.
     * Supports "add", "set", and "multiply" effect types.
     * `add` and `multiply` are applied atomically via the facade's
     * updateComponentStatDelta / updateComponentStatRelative methods (the
     * old value is read inside the facade, not here), so the read-then-write
     * cannot race with a concurrent stat change.
     *
     * @param {Object} internalComp - The internal component instance.
     * @param {Object} compDef - The component type definition from registry.
     * @param {Object} effect - The effect definition (targetTrait, targetStat, effect, amount).
     * @param {string} hostComponentId - The host component instance ID.
     * @private
     */
    _applyTickEffect(internalComp, compDef, effect, hostComponentId) {
        if (!this.worldStateController) return;

        const stats = this.worldStateController.getComponentStats(hostComponentId);
        if (!stats || !stats[effect.targetTrait] || typeof stats[effect.targetTrait][effect.targetStat] !== 'number') {
            return; // Stat doesn't exist or isn't a number — skip
        }

        const oldValue = stats[effect.targetTrait][effect.targetStat];

        switch (effect.effect) {
            case 'add': {
                const delta = effect.amount;
                this.worldStateController.componentController.updateComponentStatDelta(
                    hostComponentId, effect.targetTrait, effect.targetStat, delta
                );
                Logger.info(
                    `[InternalComponentController] Tick: ${internalComp.type} applied ${effect.effect} ${effect.targetStat}: ${oldValue} → ${oldValue + delta} (${delta >= 0 ? '+' : ''}${delta})`
                );
                break;
            }
            case 'set': {
                // Absolute set: overwrite to the declared value. updateComponentStat
                // reads the old value inside the facade for the change notification.
                this.worldStateController.componentController.updateComponentStat(
                    hostComponentId, effect.targetTrait, effect.targetStat, effect.amount
                );
                Logger.info(
                    `[InternalComponentController] Tick: ${internalComp.type} applied ${effect.effect} ${effect.targetStat}: ${oldValue} → ${effect.amount}`
                );
                break;
            }
            case 'multiply': {
                // Atomic relative op: the facade reads the old value and applies
                // old * (factor - 1) in one call, so no read-then-write race.
                this.worldStateController.componentController.updateComponentStatRelative(
                    hostComponentId, effect.targetTrait, effect.targetStat, effect.amount
                );
                Logger.info(
                    `[InternalComponentController] Tick: ${internalComp.type} applied ${effect.effect} ${effect.targetStat} by ${effect.amount}`
                );
                break;
            }
            default:
                Logger.warn(`[InternalComponentController] Unknown tick effect type: ${effect.effect}`);
                return;
        }
    }

    // =========================================================================
    // TURN-DRIVEN EFFECTS (round-start driven, parallel to the tick channel)
    // =========================================================================

    /**
     * Builds a defensive copy of a type's traits to use as an instance's own
     * stat pool. The pool is what `target: "self"` turn effects mutate
     * (e.g. existence drain). Returns an empty object when the type declares
     * no traits, so self-effects degrade to a no-op instead of throwing.
     * @param {Object} compDef - The registry definition of the component type.
     * @returns {Object} Deep copy of compDef.traits ({} if absent).
     * @private
     */
    _buildInstanceStats(compDef) {
        return compDef && compDef.traits ? structuredClone(compDef.traits) : {};
    }

    /**
     * Processes turn-driven internal component effects. Invoked ONCE PER ROUND
     * by the turn system via the turn-start hook (see TurnSystemController).
     * For each installed instance whose type is turnDriven and not broken, the
     * type's turnEffects are applied: `target: "self"` mutates the instance's
     * own stat pool (and marks it broken when existence hits 0), while
     * `target: "host"` mutates the host component's stat via the world-state
     * facade's public stat API. The instance store is synced to the entity
     * mirror so clients see the updated existence/broken state.
     *
     * Public API: called by the composition-root-wired turn-start hook, never
     * by a sub-controller reaching into this controller's internals.
     * @returns {void}
     */
    processTurnEffects() {
        if (!this.worldStateController) return;

        let applied = 0;
        for (const [entityId, hostComponents] of Object.entries(this.internalComponents)) {
            for (const [hostComponentId, internalComponents] of Object.entries(hostComponents)) {
                for (const internalComp of internalComponents) {
                    const compDef = this.registry[internalComp.type];
                    // Only turnDriven types run on this channel (tick-driven
                    // types are skipped, and they are excluded from _processTick).
                    if (!compDef || !compDef.turnDriven || !Array.isArray(compDef.turnEffects)) continue;

                    // A broken instance (its self-existence pool exhausted, or the
                    // host hand's existence driven to 0 via the drain effect) stops
                    // applying effects entirely — inert until re-installed/removed.
                    if (internalComp.broken) continue;

                    let instanceBrokeThisTurn = false;
                    for (const effect of compDef.turnEffects) {
                        try {
                            const brokeNow = this._applyTurnEffect(internalComp, compDef, effect, hostComponentId);
                            if (brokeNow) {
                                instanceBrokeThisTurn = true;
                                break; // stop applying further effects this turn
                            }
                            applied++;
                        } catch (error) {
                            Logger.error(`[InternalComponentController] Turn effect failed for ${hostComponentId} (${internalComp.type}): ${error.message}`);
                        }
                    }
                    if (instanceBrokeThisTurn) {
                        Logger.info(`[InternalComponentController] ${internalComp.type} on ${hostComponentId} broke (existence exhausted) — effects stop applying.`);
                    }
                }
            }
        }

        if (applied > 0) {
            this._syncToEntityStore();
            Logger.info(`[InternalComponentController] Turn effects complete: ${applied} effects applied`);
        }
    }

    /**
     * Applies a single turn effect to either the instance's own stat pool
     * (`target: "self"`) or the host component's stat (`target: "host"`).
     *
     * `set` is the "maintained" semantic: it overwrites the value rather than
     * adding, so a maintained bonus does not stack across turns.
     *
     * A `host`-targeted existence drain that drives the host hand's existence
     * to 0 breaks the instance: the component is destroyed with its host limb,
     * so the caller stops applying further effects this turn.
     *
     * @param {Object} internalComp - The internal component instance.
     * @param {Object} compDef - The component type definition from registry.
     * @param {Object} effect - The turn effect definition (targetTrait, targetStat, effect, amount, target).
     * @param {string} hostComponentId - The host component instance ID.
     * @returns {boolean} true when this effect broke the instance (self existence pool reached 0, or a host existence drain drove the host hand to 0); the caller stops applying further effects.
     * @private
     */
    _applyTurnEffect(internalComp, compDef, effect, hostComponentId) {
        if (effect.target === 'self') {
            return this._applySelfTurnEffect(internalComp, effect);
        }
        // target === 'host': apply to the host component's stat.
        //
        // NOTE on breakage: a host-targeted existence drain does NOT break the
        // IC instance here. The host hand's own `component:broke` cascade
        // (TriggerController → BrokenComponentRemovalHandler → removeBrokenComponent)
        // already handles the IC cleanup when the hand's existence hits 0 —
        // the facade's orchestrator removes the IC from the broken host
        // (WorldStateController.removeBrokenComponent, §3.6.4). Breaking the
        // IC instance here as well would double-handle the same condition and
        // risk a race with the cascade. The IC's `broken` flag is therefore
        // driven ONLY by its own self-existence pool (via a `self` drain or
        // `adjustInstanceStat`), keeping a single owner for each break condition.
        this._applyHostTurnEffect(internalComp, effect, hostComponentId);
        return false;
    }

    /**
     * Applies a turn effect to the instance's OWN stat pool. Mutates
     * instanceStats in place (the controller owns this state). When the
     * affected self-existence hits 0, the instance is marked broken and the
     * method returns true so the caller halts further effects.
     * @param {Object} internalComp - The internal component instance.
     * @param {Object} effect - The turn effect (target: "self").
     * @returns {boolean} true when the instance just broke.
     * @private
     */
    _applySelfTurnEffect(internalComp, effect) {
        const pool = internalComp.instanceStats;
        if (!pool || !pool[effect.targetTrait] || typeof pool[effect.targetTrait][effect.targetStat] !== 'number') {
            return false; // no such self stat — skip
        }
        const oldValue = pool[effect.targetTrait][effect.targetStat];
        let newValue;
        switch (effect.effect) {
            case 'add':
                newValue = oldValue + effect.amount;
                break;
            case 'set':
                newValue = effect.amount;
                break;
            case 'multiply':
                newValue = oldValue * effect.amount;
                break;
            default:
                Logger.warn(`[InternalComponentController] Unknown turn effect type: ${effect.effect}`);
                return false;
        }
        pool[effect.targetTrait][effect.targetStat] = newValue;

        Logger.info(
            `[InternalComponentController] Turn(self): ${internalComp.type} applied ${effect.effect} ${effect.targetStat}: ${oldValue} → ${newValue}`
        );

        // Break check: only existence is "health" for an instance.
        if (effect.targetStat === 'existence' && newValue <= 0) {
            pool[effect.targetTrait].existence = 0; // clamp to 0 (no negatives)
            internalComp.broken = true;
            return true;
        }
        return false;
    }

    /**
     * Applies a turn effect to the HOST component's stat via the facade's
     * public stat API. All three effect types are applied atomically through
     * facade methods that read the old value internally, so the read-then-write
     * cannot race with a concurrent stat change:
     * - `add` → updateComponentStatDelta
     * - `set` → updateComponentStat (absolute overwrite, the maintained semantic)
     * - `multiply` → updateComponentStatRelative (old * (factor - 1))
     * The caller checks the resulting existence to decide whether the drain
     * broke the instance (see `_applyTurnEffect`).
     * @param {Object} internalComp - The internal component instance.
     * @param {Object} effect - The turn effect (target: "host").
     * @param {string} hostComponentId - The host component instance ID.
     * @private
     */
    _applyHostTurnEffect(internalComp, effect, hostComponentId) {
        const stats = this.worldStateController.getComponentStats(hostComponentId);
        if (!stats || !stats[effect.targetTrait] || typeof stats[effect.targetTrait][effect.targetStat] !== 'number') {
            return; // host lacks the stat — skip
        }
        const oldValue = stats[effect.targetTrait][effect.targetStat];

        switch (effect.effect) {
            case 'add':
                this.worldStateController.componentController.updateComponentStatDelta(
                    hostComponentId, effect.targetTrait, effect.targetStat, effect.amount
                );
                break;
            case 'set':
                // Maintained: overwrite to the declared value (non-additive).
                this.worldStateController.componentController.updateComponentStat(
                    hostComponentId, effect.targetTrait, effect.targetStat, effect.amount
                );
                break;
            case 'multiply':
                // Atomic relative op: the facade reads the old value and applies
                // old * (factor - 1) in one call, so no read-then-write race.
                this.worldStateController.componentController.updateComponentStatRelative(
                    hostComponentId, effect.targetTrait, effect.targetStat, effect.amount
                );
                break;
            default:
                Logger.warn(`[InternalComponentController] Unknown turn effect type: ${effect.effect}`);
                return;
        }

        Logger.info(
            `[InternalComponentController] Turn(host): ${internalComp.type} applied ${effect.effect} ${effect.targetStat} on ${hostComponentId}`
        );
    }

    /**
     * Syncs internal components from this.controller storage back to the entity store.
     * Ensures the client receives updated internal component data in world-state broadcasts.
     *
     * @private
     */
      _syncToEntityStore() {
        if (!this.worldStateController) return;

        for (const [entityId, hostComponents] of Object.entries(this.internalComponents)) {
            const entity = this.worldStateController.stateEntityController.getEntity(entityId);
            if (entity) {
                entity.internalComponents = structuredClone(hostComponents);
            }
        }
    }

    /**
     * Sets the worldStateController reference for tick system access.
     * Called by WorldStateController during initialization.
     *
     * @param {any} worldStateController - The WorldStateController instance.
     */
    setWorldStateController(worldStateController) {
        this.worldStateController = worldStateController;
    }

    // =========================================================================
    // REQUIRED TRAITS CHECKING
    // =========================================================================

    /**
     * Checks if a component type has all the required traits for an internal component.
     * Reads trait definitions from data/components.json and verifies each required
     * trait has the stat with a value >= minValue.
     *
     * @param {string} componentType - The component type to check.
     * @param {Object} requiredTraits - Required traits configuration: { [traitName]: { [statName]: { minValue: number } } }
     * @returns {boolean} True if the component has all required traits with sufficient values.
     * @private
     */
    _checkRequiredTraits(componentType, requiredTraits) {
        const compDef = this.componentDefinitions[componentType];
        if (!compDef || !compDef.traits) {
            Logger.info(`[InternalComponentController] Component "${componentType}" has no trait definitions — required traits check fails`);
            return false;
        }

        for (const [traitName, statRequirements] of Object.entries(requiredTraits)) {
            const traitData = compDef.traits[traitName];
            if (!traitData) {
                Logger.info(`[InternalComponentController] Component "${componentType}" missing required trait "${traitName}"`);
                return false;
            }

            for (const [statName, { minValue }] of Object.entries(statRequirements)) {
                const statValue = traitData[statName];
                if (statValue === undefined || statValue === null || typeof statValue !== 'number') {
                    Logger.info(`[InternalComponentController] Component "${componentType}" trait "${traitName}" missing required stat "${statName}"`);
                    return false;
                }
                if (statValue < minValue) {
                    Logger.info(`[InternalComponentController] Component "${componentType}" trait "${traitName}" stat "${statName}" value ${statValue} < required ${minValue}`);
                    return false;
                }
            }
        }

        return true;
    }
}

export default InternalComponentController;
