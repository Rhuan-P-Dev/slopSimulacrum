/**
 * InternalComponentController
 * Manages the lifecycle, installation, and tick-based effects of internal components.
 * Integrates with the UniversalTickSystem for deterministic simulation updates.
 */

import Logger from '../../utils/Logger.js';
import DataLoader from '../../utils/DataLoader.js';
import { TickJob } from '../../utils/UniversalTickSystem.js';
import { generateUID } from '../../utils/idGenerator.js';
import { DEFAULT_HOST_VOLUME_FALLBACK } from '../../utils/Constants.js';
import { channelLossFromResistance } from '../../utils/channelLoss.js';
import { EXISTENCE_GONE_AT, TRAIT_GROUPS, STAT_NAMES, DAMAGE_CHANNELS } from '../../../shared/StatVocabulary.js';

// Internal components fire their overTime effects on the unified tick system.
// The job runs every tick (interval 1); each effect then checks its own
// `intervalTicks` against the absolute tick counter, so an effect fires exactly
// on the ticks that are multiples of its interval. Running the job every tick
// lets effects with different intervals (e.g. 5 and 10) share a single channel.
const IC_TICK_JOB_INTERVAL = 1;

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
        this._validateComponentDeclarations();

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

        // Register the overTime job. It runs every tick (interval 1); each
        // effect checks its own intervalTicks against the absolute tick counter.
        // Order 0 = highest priority so stat effects land before other jobs.
        this.tickSystem.register(new TickJob(
            'internal-components',
            () => this._processTick(),
            IC_TICK_JOB_INTERVAL, // interval in ticks
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

            // Validate the unified overTime channel: a structurally valid array
            // of effect definitions (restoreExistence / emitChannelDamage), each
            // with a positive intervalTicks cadence.
            if (definition.overTime !== undefined) {
                if (!Array.isArray(definition.overTime)) {
                    throw new TypeError(`[InternalComponentController] Internal component "${type}" overTime must be an array`);
                }
                for (const effect of definition.overTime) {
                    if (!effect.type || !['restoreExistence', 'emitChannelDamage'].includes(effect.type)) {
                        throw new TypeError(`[InternalComponentController] Internal component "${type}" overTime has invalid type: ${effect.type}`);
                    }
                    if (typeof effect.intervalTicks !== 'number' || effect.intervalTicks <= 0) {
                        throw new TypeError(`[InternalComponentController] Internal component "${type}" overTime effect "${effect.type}" needs a positive intervalTicks`);
                    }
                    if (effect.type === 'restoreExistence' && (typeof effect.existenceGainPerInterval !== 'number' || effect.existenceGainPerInterval <= 0)) {
                        throw new TypeError(`[InternalComponentController] Internal component "${type}" restoreExistence needs a positive existenceGainPerInterval`);
                    }
                    if (effect.type === 'emitChannelDamage') {
                        if (!effect.channel || !Object.values(DAMAGE_CHANNELS).includes(effect.channel)) {
                            throw new TypeError(`[InternalComponentController] Internal component "${type}" emitChannelDamage needs a valid channel: ${effect.channel}`);
                        }
                        if (typeof effect.damagePerInterval !== 'number' || effect.damagePerInterval <= 0) {
                            throw new TypeError(`[InternalComponentController] Internal component "${type}" emitChannelDamage needs a positive damagePerInterval`);
                        }
                    }
                }
            }

            // Validate the organ's static grants (function stats) and grantsFlags.
            if (definition.grants !== undefined) {
                if (typeof definition.grants !== 'object' || Array.isArray(definition.grants)) {
                    throw new TypeError(`[InternalComponentController] Internal component "${type}" grants must be an object`);
                }
                for (const [key, value] of Object.entries(definition.grants)) {
                    if (typeof value !== 'number') {
                        throw new TypeError(`[InternalComponentController] Internal component "${type}" grant "${key}" must be a number`);
                    }
                }
            }
            if (definition.grantsFlags !== undefined && !Array.isArray(definition.grantsFlags)) {
                throw new TypeError(`[InternalComponentController] Internal component "${type}" grantsFlags must be an array`);
            }

            // hostComponentType / hostSlot are optional auto-install filters.
            if (definition.hostComponentType !== undefined && typeof definition.hostComponentType !== 'string') {
                throw new TypeError(`[InternalComponentController] Internal component "${type}" hostComponentType must be a string`);
            }
            if (definition.hostSlot !== undefined && typeof definition.hostSlot !== 'string') {
                throw new TypeError(`[InternalComponentController] Internal component "${type}" hostSlot must be a string`);
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
     * Returns the organ declaration of the given type in a component type's
     * `internalComponents` list (the component's own data-driven organ list
     * from data/components.json). A declaration is either a plain type string
     * (the organ type's default grants apply) or an object
     * `{ type, grants? }` whose `grants` override the organ type's defaults
     * for that recipe's instances (e.g. a stronger strengthCore on a
     * heavy-lifting rolling ball).
     * @param {string} componentType - The component type (e.g., "droidRollingBall").
     * @param {string} icType - The internal component type (e.g., "strengthCore").
     * @returns {string|Object|null} The declaration entry, or null when the
     *   controller is not wired, the recipe is unknown, or the organ is not
     *   declared (fail closed — the organ is not installed).
     * @private
     */
    _getDeclaration(componentType, icType) {
        const registry = this.worldStateController?.componentController?.componentRegistry;
        const def = registry?.[componentType];
        if (!Array.isArray(def?.internalComponents)) return null;
        return def.internalComponents.find((entry) =>
            (typeof entry === 'string' ? entry : entry?.type) === icType
        ) ?? null;
    }

    /**
     * Checks whether an internal component type is declared on a component
     * type's `internalComponents` list, in either entry form (string or
     * `{ type, grants }` object).
     * @param {string} componentType - The component type (e.g., "droidHand").
     * @param {string} icType - The internal component type (e.g., "strengthCore").
     * @returns {boolean}
     * @private
     */
    _isDeclaredOnComponentType(componentType, icType) {
        return this._getDeclaration(componentType, icType) !== null;
    }

    /**
     * Extracts the per-instance grants override from a declaration entry: the
     * `grants` object of an object-form entry, or null for a string entry
     * (the organ type's default grants apply).
     * @param {string|Object|null} declaration - A declaration entry from
     *   `_getDeclaration`.
     * @returns {Object|null} The override map, or null.
     * @private
     */
    _declarationOverrides(declaration) {
        if (declaration && typeof declaration === 'object' && !Array.isArray(declaration)
            && typeof declaration.grants === 'object' && declaration.grants !== null) {
            return declaration.grants;
        }
        return null;
    }

    /**
     * Validates every component recipe's `internalComponents` declaration
     * entries at construction (fail-fast, same philosophy as the registry
     * validation): each entry must be an organ type string known to this
     * registry, or an object with a known string `type` and — when present —
     * a `grants` object whose values are numbers.
     * @private
     */
    _validateComponentDeclarations() {
        for (const [componentType, def] of Object.entries(this.componentDefinitions || {})) {
            if (typeof def !== 'object' || def === null) continue;
            if (def.internalComponents === undefined) continue;
            if (!Array.isArray(def.internalComponents)) {
                throw new TypeError(`[InternalComponentController] Component "${componentType}" has a non-array "internalComponents" declaration.`);
            }
            for (const entry of def.internalComponents) {
                if (typeof entry === 'string') {
                    if (!this.registry[entry]) {
                        throw new TypeError(`[InternalComponentController] Component "${componentType}" declares unknown organ type "${entry}".`);
                    }
                    continue;
                }
                if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                    throw new TypeError(`[InternalComponentController] Component "${componentType}" has a non-object "internalComponents" entry.`);
                }
                if (typeof entry.type !== 'string' || entry.type.length === 0) {
                    throw new TypeError(`[InternalComponentController] Component "${componentType}" has an "internalComponents" entry with a missing or non-string "type".`);
                }
                if (!this.registry[entry.type]) {
                    throw new TypeError(`[InternalComponentController] Component "${componentType}" declares unknown organ type "${entry.type}".`);
                }
                if (entry.grants !== undefined) {
                    if (typeof entry.grants !== 'object' || entry.grants === null || Array.isArray(entry.grants)) {
                        throw new TypeError(`[InternalComponentController] Component "${componentType}" organ "${entry.type}" has a non-object "grants" override.`);
                    }
                    for (const [key, value] of Object.entries(entry.grants)) {
                        if (typeof value !== 'number') {
                            throw new TypeError(`[InternalComponentController] Component "${componentType}" organ "${entry.type}" grant override "${key}" must be a number (got ${typeof value}).`);
                        }
                    }
                }
            }
        }
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
                const declaration = this._getDeclaration(component.type, compType);

                // Per-component gate + host filters. Two installation modes:
                //  - Auto-install ICs (autoInstallOnSpawn): land only where the
                //    IC's own hostComponentType / hostSlot constraints allow.
                //  - Explicit ICs (declared in the component's `internalComponents`
                //    recipe): land on exactly the component types that declare
                //    them — the recipe is the source of truth, so the IC's
                //    hostComponentType default does not veto an explicit
                //    declaration (e.g. moveCore declared on a rolling ball).
                if (compDef.autoInstallOnSpawn) {
                    if (hostComponentType && component.type !== hostComponentType) continue;
                    if (hostSlot) {
                        const parentIdentifier = this._resolveParentIdentifier(component, components);
                        if (parentIdentifier !== hostSlot) continue;
                    }
                } else if (declaration === null) {
                    continue;
                }

                // Skip excluded component types (e.g., fingers)
                if (excludedTypes.includes(component.type)) {
                    Logger.info(`[InternalComponentController] Skipping ${component.type} — excluded from ${compType} auto-install`);
                    continue;
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
                // An object-form declaration on the host recipe may override
                // those grants for this recipe's instances.
                this._applyGrants(component.id, compDef, this._declarationOverrides(declaration));

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
        // effective, matching the auto-install path. A host recipe may also
        // override those grants for its own instances (object-form
        // declaration), so the manual path honors the same semantics as the
        // spawn-time path.
        const hostType = this._resolveHostComponentType(entityId, hostComponentId);
        const declaration = hostType ? this._getDeclaration(hostType, internalComponentType) : null;
        this._applyGrants(hostComponentId, compDef, this._declarationOverrides(declaration));

        Logger.info(`[InternalComponentController] Added ${internalComponentType} to ${hostComponentId} of entity ${entityId}`);

        return structuredClone(instance);
    }

    /**
     * Resolves the type of a component instance on an entity through the
     * facade (this controller never owns component instances); null when the
     * facade is not wired or the component is not found.
     * @param {string} entityId - The entity ID.
     * @param {string} componentId - The component instance ID.
     * @returns {string|null} The component type, or null.
     * @private
     */
    _resolveHostComponentType(entityId, componentId) {
        const entity = this.worldStateController?.getEntity?.(entityId);
        return entity?.components?.find((c) => c.id === componentId)?.type ?? null;
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
     * @param {Object|null} [instanceOverrides=null] - Per-instance grants
     *   override taken from the host recipe's object-form declaration
     *   (`{ type, grants }`); a key present here replaces that key's
     *   type-default value, all other keys keep the type defaults.
     * @private
     */
    _applyGrants(hostComponentId, compDef, instanceOverrides = null) {
        if (!this.worldStateController) return;
        const grants = compDef.grants;
        if (grants && typeof grants === 'object') {
            for (const [key, value] of Object.entries(grants)) {
                if (typeof value !== 'number') continue;
                const effective = (instanceOverrides && typeof instanceOverrides[key] === 'number')
                    ? instanceOverrides[key]
                    : value;
                const dot = key.indexOf('.');
                if (dot === -1) continue;
                const traitId = key.slice(0, dot);
                const statName = key.slice(dot + 1);
                this.worldStateController.componentController.updateComponentStat(
                    hostComponentId, traitId, statName, effective
                );
            }
        }
        // Organ-granted flags (e.g. corrosiveGland → corrosive) are stored on the
        // host component, distinct from stat-derived flags (flammable/conductive).
        if (Array.isArray(compDef.grantsFlags)) {
            for (const flag of compDef.grantsFlags) {
                this.worldStateController.componentController.addGrantedFlag(hostComponentId, flag);
            }
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
    // UNIFIED OVERTIME PROCESSING (single channel for all overTime effects)
    // =========================================================================

    /**
     * Called every tick by the unified tick system. This is the SINGLE channel
     * for all internal-component overTime effects (the old turn-driven and
     * tick-driven channels have been unified here). For each installed instance
     * that is not broken and whose host is not broken, each `overTime` effect
     * fires when the absolute tick counter is a positive multiple of the
     * effect's `intervalTicks`. Supported effect types: `restoreExistence`
     * (the organ repairs the host, closing the salvage→existence loop) and
     * `emitChannelDamage` (the organ radiates a damage channel to components in
     * range).
     *
     * @private
     */
    _processTick() {
        const currentTick = this.tickSystem?.currentTick ?? 0;
        let totalEffects = 0;
        let anyChanged = false;

        for (const [entityId, hostComponents] of Object.entries(this.internalComponents)) {
            for (const [hostComponentId, internalComponents] of Object.entries(hostComponents)) {
                for (const internalComp of internalComponents) {
                    const compDef = this.registry[internalComp.type];
                    if (!compDef || !Array.isArray(compDef.overTime) || compDef.overTime.length === 0) continue;
                    // A broken instance (or a broken host) stops all overTime effects.
                    if (internalComp.broken || this._hostIsBroken(hostComponentId)) continue;

                    for (const effect of compDef.overTime) {
                        if (typeof effect.intervalTicks !== 'number' || effect.intervalTicks <= 0) continue;
                        // Fire only on ticks that are positive multiples of the interval.
                        if (currentTick <= 0 || currentTick % effect.intervalTicks !== 0) continue;
                        try {
                            const changed = this._applyOverTimeEffect(entityId, internalComp, compDef, effect, hostComponentId);
                            if (changed) {
                                totalEffects++;
                                anyChanged = true;
                            }
                        } catch (error) {
                            Logger.error(`[InternalComponentController] overTime effect failed for ${hostComponentId} (${internalComp.type}): ${error.message}`);
                        }
                    }
                }
            }
        }

        if (anyChanged) {
            // Sync internal components back to the entity store so clients see updates.
            this._syncToEntityStore();
            Logger.info(`[InternalComponentController] overTime complete: ${totalEffects} effects applied`);
        }
    }

    /**
     * Applies a single overTime effect to the host component (or, for
     * emitChannelDamage, to components in range). Dispatches on the effect's
     * `type` field. Returns true when a world-state change was made (so the
     * caller can decide whether to sync to the entity store).
     *
     * @param {string} entityId - The host entity ID.
     * @param {Object} internalComp - The internal component instance.
     * @param {Object} compDef - The component type definition from the registry.
     * @param {Object} effect - The overTime effect definition.
     * @param {string} hostComponentId - The host component instance ID.
     * @returns {boolean} True when the effect changed world state.
     * @private
     */
    _applyOverTimeEffect(entityId, internalComp, compDef, effect, hostComponentId) {
        if (!this.worldStateController) return false;

        switch (effect.type) {
            case 'restoreExistence':
                return this._applyRestoreExistence(effect, hostComponentId);
            case 'emitChannelDamage':
                return this._applyEmitChannelDamage(entityId, effect, hostComponentId);
            default:
                Logger.warn(`[InternalComponentController] Unknown overTime effect type: ${effect.type}`);
                return false;
        }
    }

    /**
     * `restoreExistence`: the organ repairs the host component by restoring a
     * fixed amount of existence every interval, closing the salvage→existence
     * loop (salvage is the raw-matter item that the repair consumes; its
     * consumption is a Phase-2 detail, the existence restoration is the core).
     * The restoration is clamped by the facade's existence store (max 1).
     *
     * @param {Object} effect - The restoreExistence effect definition.
     * @param {string} hostComponentId - The host component instance ID.
     * @returns {boolean} True when existence was restored.
     * @private
     */
    _applyRestoreExistence(effect, hostComponentId) {
        if (!this.worldStateController) return false;
        const gain = typeof effect.existenceGainPerInterval === 'number' ? effect.existenceGainPerInterval : 0;
        if (gain <= 0) return false;
        // Read current existence; skip when the host is already whole.
        const stats = this.worldStateController.getComponentStats(hostComponentId);
        const current = stats?.[TRAIT_GROUPS.PHYSICAL]?.[STAT_NAMES.EXISTENCE] ?? 0;
        if (current >= 1) return false;
        this.worldStateController.componentController.updateComponentStatDelta(
            hostComponentId, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, gain
        );
        Logger.info(`[InternalComponentController] overTime(restoreExistence): +${gain} existence on ${hostComponentId}`);
        return true;
    }

    /**
     * `emitChannelDamage`: the organ radiates a damage channel (e.g. corrosion)
     * to other components within range of the host. Each target's existence is
     * reduced by a channel-aware loss (damage divided by the target's resistance
     * to that channel, on a 0–100 resistance scale) — the same model the
     * DamageConsequenceHandler uses for action damage.
     *
     * @param {string} entityId - The host entity ID.
     * @param {Object} effect - The emitChannelDamage effect definition.
     * @param {string} hostComponentId - The host component instance ID.
     * @returns {boolean} True when at least one target was damaged.
     * @private
     */
    _applyEmitChannelDamage(entityId, effect, hostComponentId) {
        if (!this.worldStateController) return false;
        const damage = typeof effect.damagePerInterval === 'number' ? effect.damagePerInterval : 0;
        if (damage <= 0) return false;

        const hostEntity = this.worldStateController.stateEntityController.getEntity(entityId);
        if (!hostEntity) return false;
        const hostPos = hostEntity.spatial?.position;
        if (!hostPos) return false;
        const range = typeof effect.range === 'number' ? effect.range : 0;
        const resistanceStat = this._channelResistanceStat(effect.channel);

        let damaged = 0;
        const allEntities = this.worldStateController.stateEntityController.getAll ? this.worldStateController.stateEntityController.getAll() : [];
        for (const other of allEntities) {
            if (!other || other.id === entityId) continue;
            const otherPos = other.spatial?.position;
            if (!otherPos) continue;
            const dx = otherPos.x - hostPos.x;
            const dy = otherPos.y - hostPos.y;
            const dist = Math.hypot(dx, dy);
            if (range > 0 && dist > range) continue;

            // Apply the channel-aware loss to the other entity's first usable component.
            const targetComp = this._firstComponentId(other);
            if (!targetComp) continue;
            const targetStats = this.worldStateController.getComponentStats(targetComp);
            const resistance = targetStats?.[TRAIT_GROUPS.PHYSICAL]?.[resistanceStat] ?? 0;
            const loss = this._computeChannelLoss(damage, resistance);
            if (loss <= 0) continue;
            this.worldStateController.componentController.updateComponentStatDelta(
                targetComp, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, -loss
            );
            damaged++;
        }

        if (damaged > 0) {
            Logger.info(`[InternalComponentController] overTime(emitChannelDamage): ${effect.channel} damaged ${damaged} target(s) near ${hostComponentId}`);
        }
        return damaged > 0;
    }

    /**
     * Maps a damage channel name to the corresponding resistance stat name
     * (e.g. "corrosion" → "corrosion_resistance") in the Physical trait group.
     * @param {string} channel - A DAMAGE_CHANNELS name.
     * @returns {string} The resistance stat name.
     * @private
     */
    _channelResistanceStat(channel) {
        return `${channel}_resistance`;
    }

    /**
     * Computes the existence loss (a 0–1 fraction) from a raw damage amount and
     * a channel resistance (0–100). Delegates to the shared channelLossFromResistance
     * helper — the same single-source ratio the DamageConsequenceHandler uses — so the
     * base absorption constant lives in exactly one place. No channel-validity guard
     * here: the IC's channel is validated upstream at effect declaration (_validateRegistry).
     * @param {number} damage - The raw damage amount.
     * @param {number} resistance - The target's resistance to the channel (0–100).
     * @returns {number} The existence loss (≥ 0).
     * @private
     */
    _computeChannelLoss(damage, resistance) {
        return channelLossFromResistance(damage, resistance);
    }

    /**
     * Returns the first component instance ID of an entity, or null. Used to
     * target a single component when a multi-component entity is a damage
     * target (the basic set's damage model applies to one component).
     * @param {Object} entity - The entity object.
     * @returns {string|null}
     * @private
     */
    _firstComponentId(entity) {
        const comps = entity?.components;
        if (Array.isArray(comps) && comps.length > 0) return comps[0].id;
        if (comps && typeof comps === 'object') {
            const keys = Object.keys(comps);
            if (keys.length > 0) return keys[0];
        }
        return null;
    }

    /**
     * A host is broken when its existence has dropped to the gone threshold.
     * Broken hosts stop driving their organs' overTime effects (and the
     * component:broke cascade removes the organs separately).
     * @param {string} hostComponentId - The host component instance ID.
     * @returns {boolean} True when the host's existence is at/below the gone threshold.
     * @private
     */
    _hostIsBroken(hostComponentId) {
        if (!this.worldStateController) return false;
        const stats = this.worldStateController.getComponentStats(hostComponentId);
        const existence = stats?.[TRAIT_GROUPS.PHYSICAL]?.[STAT_NAMES.EXISTENCE];
        return typeof existence === 'number' && existence <= EXISTENCE_GONE_AT;
    }

    // =========================================================================
    // INSTANCE STAT POOL (self-existence for organs that carry one)
    // =========================================================================

    /**
     * Builds a defensive copy of a type's traits to use as an instance's own
     * stat pool. In the recipe model organs carry no stat traits of their own
     * (their capabilities are static grants applied to the host), so this
     * returns an empty object for the current registry; it is kept so an organ
     * that declares a self-pool still gets one and `adjustInstanceStat`
     * degrades to a no-op instead of throwing.
     * @param {Object} compDef - The registry definition of the component type.
     * @returns {Object} Deep copy of compDef.traits ({} if absent).
     * @private
     */
    _buildInstanceStats(compDef) {
        return compDef && compDef.traits ? structuredClone(compDef.traits) : {};
    }

    /**
     * Legacy no-op retained so the composition-root turn-start hook (wired
     * before the overTime unification) stays a safe call. All overTime effects
     * now run on the unified tick channel (`_processTick`), so this method
     * intentionally does nothing.
     * @returns {void}
     */
    processTurnEffects() {
        // no-op: overTime is driven by the unified tick channel (_processTick).
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
