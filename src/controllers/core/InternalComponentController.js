/**
 * InternalComponentController
 * Manages the lifecycle, installation, and over-time effects of internal components.
 * overTime effects run on the per-turn channel: the turn system's round-start hook
 * drives processTurnEffects(round) once per round (the old per-tick job is retired).
 */

import Logger from '../../utils/Logger.js';
import DataLoader from '../../utils/DataLoader.js';
import { generateUID } from '../../utils/idGenerator.js';
import { DEFAULT_HOST_VOLUME_FALLBACK } from '../../utils/Constants.js';
import { channelLossFromResistance } from '../../utils/channelLoss.js';
import { EXISTENCE_GONE_AT, TRAIT_GROUPS, STAT_NAMES, DAMAGE_CHANNELS } from '../../../shared/StatVocabulary.js';

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

        // Transient (never persisted) dry-transition markers for the
        // consumeFuelGenerateStat effect: keys are "entityId:hostComponentId"
        // once a fuel-exhaustion log has fired, so a droid sitting at zero
        // fuel logs once instead of every interval. Kept outside the IC
        // instances on purpose — the effect state must not change the
        // persisted instance shape.
        this._fuelExhaustionLogged = new Map();

        // Reference to the global tick system
        this.tickSystem = tickSystem;

        Logger.info(`[InternalComponentController] Initialized with ${Object.keys(this.registry).length} internal component types`);
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
            // of effect definitions (restoreExistence / emitChannelDamage /
            // consumeFuelGenerateStat), each with a positive intervalTurns cadence.
            if (definition.overTime !== undefined) {
                if (!Array.isArray(definition.overTime)) {
                    throw new TypeError(`[InternalComponentController] Internal component "${type}" overTime must be an array`);
                }
                for (const effect of definition.overTime) {
                    if (!effect.type || !['restoreExistence', 'emitChannelDamage', 'consumeFuelGenerateStat'].includes(effect.type)) {
                        throw new TypeError(`[InternalComponentController] Internal component "${type}" overTime has invalid type: ${effect.type}`);
                    }
                    if (typeof effect.intervalTurns !== 'number' || effect.intervalTurns <= 0) {
                        throw new TypeError(`[InternalComponentController] Internal component "${type}" overTime effect "${effect.type}" needs a positive intervalTurns`);
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
                    if (effect.type === 'consumeFuelGenerateStat') {
                        if (typeof effect.fuelItem !== 'string' || effect.fuelItem.trim() === '') {
                            throw new TypeError(`[InternalComponentController] Internal component "${type}" consumeFuelGenerateStat needs a non-empty fuelItem string`);
                        }
                        if (!Number.isInteger(effect.fuelConsumedPerInterval) || effect.fuelConsumedPerInterval <= 0) {
                            throw new TypeError(`[InternalComponentController] Internal component "${type}" consumeFuelGenerateStat needs a positive integer fuelConsumedPerInterval`);
                        }
                        const targetStat = effect.targetStat;
                        const dot = typeof targetStat === 'string' ? targetStat.indexOf('.') : -1;
                        const statGroup = dot > 0 ? targetStat.slice(0, dot) : '';
                        if (dot === -1 || !Object.values(TRAIT_GROUPS).includes(statGroup)) {
                            throw new TypeError(`[InternalComponentController] Internal component "${type}" consumeFuelGenerateStat needs a targetStat in "Group.stat" wire form: ${targetStat}`);
                        }
                        if (typeof effect.energyGainPerInterval !== 'number' || effect.energyGainPerInterval <= 0) {
                            throw new TypeError(`[InternalComponentController] Internal component "${type}" consumeFuelGenerateStat needs a positive energyGainPerInterval`);
                        }
                        if (typeof effect.energyCapacity !== 'number' || effect.energyCapacity <= 0) {
                            throw new TypeError(`[InternalComponentController] Internal component "${type}" consumeFuelGenerateStat needs a positive energyCapacity`);
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
     * Merges an organ type's static `grants` with the per-instance override map
     * (from the host recipe's object-form declaration) into the *effective* grants
     * this specific organ instance applies on its host. A key present in the
     * override replaces the type default for that key; all other keys keep the
     * type defaults. Returns a fresh plain object (empty object when the type
     * grants nothing). This mirrors exactly what `_applyGrants` writes to the
     * host, so it is the runtime grant — recorded on the instance so the viewer
     * can display it without re-reading the component recipe.
     * @param {Object} compDef - The organ type definition (its `grants` map).
     * @param {Object|null} [instanceOverrides=null] - Per-instance grants
     *   override from the host recipe's object-form declaration.
     * @returns {Object} Effective grants map (keyed in "Group.stat" wire form).
     * @private
     */
    _getEffectiveGrants(compDef, instanceOverrides = null) {
        const base = compDef?.grants;
        if (!base || typeof base !== 'object' || Array.isArray(base)) return {};
        const effective = {};
        for (const [key, value] of Object.entries(base)) {
            if (typeof value !== 'number') continue;
            const overridden = (instanceOverrides && typeof instanceOverrides[key] === 'number')
                ? instanceOverrides[key]
                : value;
            effective[key] = overridden;
        }
        return effective;
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
                const instanceOverrides = this._declarationOverrides(declaration);

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
                let hostVolume;
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
                    // The grants this specific organ instance applies on its host:
                    // the type default merged with any per-instance recipe override
                    // (object-form declaration). Recorded here so the viewer shows
                    // exactly the runtime grant (e.g. 120 on a rolling ball) — no
                    // re-read of the component recipe at enrichment time.
                    grants: this._getEffectiveGrants(compDef, instanceOverrides),
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
                this._applyGrants(component.id, compDef, instanceOverrides);

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

        // Resolve the host recipe declaration so the recorded grants match what
        // _applyGrants below sets on the host — the manual path honors the same
        // recipe-level override semantics as the spawn path. The grants are
        // recorded on the instance so the viewer shows the runtime grant, with
        // no re-read of the component recipe at enrichment time.
        const hostType = this._resolveHostComponentType(entityId, hostComponentId);
        const declaration = hostType ? this._getDeclaration(hostType, internalComponentType) : null;
        const instanceOverrides = this._declarationOverrides(declaration);
        instance.grants = this._getEffectiveGrants(compDef, instanceOverrides);
        this._applyGrants(hostComponentId, compDef, instanceOverrides);

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
     * Called when an entity is despawned; also drops the transient
     * `_fuelExhaustionLogged` dry-transition markers for this entity, so a
     * respawned droid re-logs its first fuel exhaustion as a fresh transition
     * instead of inheriting the removed entity's "already logged" state.
     *
     * @param {string} entityId - The entity ID to clean up.
     * @returns {boolean} True if cleanup was performed; false when the entity
     *   had no internal components (and therefore no markers to sweep).
     */
    cleanupEntity(entityId) {
        if (!this.internalComponents[entityId]) {
            return false;
        }

        delete this.internalComponents[entityId];
        // Drop the transient dry-transition markers for this entity so a
        // re-spawned entity re-logs its first exhaustion (fresh transition).
        for (const key of this._fuelExhaustionLogged.keys()) {
            if (key.startsWith(`${entityId}:`)) {
                this._fuelExhaustionLogged.delete(key);
            }
        }
        Logger.info(`[InternalComponentController] Cleaned up internal components for entity ${entityId}`);
        return true;
    }
    // =========================================================================
    // PER-TURN OVERTIME PROCESSING (single channel for all overTime effects)
    // =========================================================================

    /**
     * The single per-turn channel for ALL internal-component overTime effects,
     * invoked once per round at ROUND START (via the turn system's turn-start
     * hook) with the round number that just started. For each installed
     * instance that is not broken and whose host is not broken, each `overTime`
     * effect fires when the round number is a positive multiple of the effect's
     * `intervalTurns` (the global round gate — no per-instance state, so a v3
     * save stays valid). Supported effect types: `restoreExistence` (the organ
     * repairs the host, closing the salvage→existence loop),
     * `emitChannelDamage` (the organ radiates a damage channel to components in
     * range) and `consumeFuelGenerateStat` (the organ burns carried fuel items
     * to charge a host resource stat, degrading gracefully on runout).
     *
     * Defensive contract: a non-numeric or non-positive `round` fires no
     * effects and never throws (zero-arg / malformed wiring stays a safe no-op).
     *
     * @param {number} [round] - The round number that just started (from the hook).
     * @returns {void}
     */
    processTurnEffects(round) {
        // Defensive: a missing/non-numeric or non-positive round fires nothing.
        const r = typeof round === 'number' && Number.isFinite(round) ? round : 0;
        if (r <= 0) return;
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
                        if (typeof effect.intervalTurns !== 'number' || effect.intervalTurns <= 0) continue;
                        // Fire only when the round is a positive multiple of the interval.
                        if (r % effect.intervalTurns !== 0) continue;
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
            case 'consumeFuelGenerateStat':
                return this._applyConsumeFuelGenerateStat(entityId, effect, hostComponentId);
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
     * `consumeFuelGenerateStat`: the fuel → energy loop. Every interval the
     * organ reads the host ENTITY's current charge on `targetStat` (a whole-entity attribute) and then, in
     * priority order: (1) a full battery (charge ≥ the entity attribute's `max`) skips
     * without burning fuel — coal is never burned for a full tank; (2) with
     * fewer than `fuelConsumedPerInterval` units of `fuelItem` aboard, it
     * degrades gracefully — nothing is consumed, nothing is charged, and the
     * exhaustion is logged ONCE on the dry transition (the transient
     * `_fuelExhaustionLogged` map marks that it already happened, so a droid
     * sitting at zero fuel does not spam the log every interval); (3)
     * otherwise it consumes whole fuel units through the facade's public
     * removal API and charges the host entity's attribute by
     * `min(energyGainPerInterval, entityAttribute.max − current)` — clamped at the
     * margin, so the last burn can waste partial energy rather than stall the
     * final tick of a charge.
     *
     * Whole units only: energy stays an exact multiple of the per-fuel gain
     * for the life of the droid, keeping the "1 fuel = N energy" balance lever
     * exact and testable. Cadence, gain and fuel-need come from the effect
     * definition (data/internalComponents.json); the charging CEILING is the
     * entity attribute's `max` (data/entity_attributes.json) — the single
     * source of truth, enforced by setEntityAttributeDelta on every write.
     *
     * Invariant: the fuel snapshot (getEntityItems) and the removals
     * (removeItemFromEntity) share the `entity.items` source within one
     * synchronous tick, so a mid-loop removal failure is a desync, not a
     * normal path. When it happens the burn aborts BEFORE any charge — no
     * partial charge on a partial removal — and deliberately does not roll
     * back, because re-adding the removed fuel would re-derive its footprint
     * from the current definitions. With the shipped data
     * (fuelConsumedPerInterval: 1) the failure is unreachable: the snapshot
     * already proved the fuel is aboard.
     *
     * @param {string} entityId - The host entity ID.
     * @param {Object} effect - The consumeFuelGenerateStat effect definition.
     * @param {string} hostComponentId - The host component instance ID.
     * @returns {boolean} True when fuel was consumed and the stat charged.
     * @private
     */
    _applyConsumeFuelGenerateStat(entityId, effect, hostComponentId) {
        const wsc = this.worldStateController;
        if (!wsc) return false;

        const gain = typeof effect.energyGainPerInterval === 'number' ? effect.energyGainPerInterval : 0;
        const fuelNeeded = Number.isInteger(effect.fuelConsumedPerInterval) && effect.fuelConsumedPerInterval > 0
            ? effect.fuelConsumedPerInterval
            : 0;
        if (gain <= 0 || fuelNeeded <= 0) return false;

        // The target stat is declared in the flat "Group.stat" wire form
        // (identical to the grants key form) — split it for the (trait, stat)
        // setter the componentController exposes.
        const dot = (typeof effect.targetStat === 'string' ? effect.targetStat : '').indexOf('.');
        if (dot === -1) return false;
        const traitId = effect.targetStat.slice(0, dot);
        const statName = effect.targetStat.slice(dot + 1);

        // Rule 0 — single source of truth for the ceiling: the whole-entity
        // energy cap is the entity attribute's `max` (data/entity_attributes.json),
        // NOT the organ's `energyCapacity` (data/internalComponents.json). The
        // two files must not silently diverge — the attribute `max` is what
        // setEntityAttributeDelta enforces on every write, so it is the true
        // ceiling. If the entity carries no such attribute declaration (the data
        // file is missing/empty for this blueprint), the generator has nothing
        // to charge: burn no fuel (a silent coal drain with no effect, no
        // charge and no death). `energyCapacity` remains only a boot-time
        // config validation (positive) elsewhere in this controller.
        const attrConfig = wsc.getEntityAttributeConfig(entityId, traitId, statName);
        if (!attrConfig || typeof attrConfig.max !== 'number' || !Number.isFinite(attrConfig.max) || attrConfig.max <= 0) {
            return false;
        }
        const capacity = attrConfig.max;

        // Rule 1 — full battery: never burn fuel for a full tank. The
        // "current" is the host ENTITY's live attribute value (whole-entity
        // energy), read through the facade's attribute API.
        const current = wsc.getEntityAttribute(entityId, traitId, statName) ?? 0;
        if (current >= capacity) return false;

        // Rule 2 — fuel search across the entity's items (public facade only;
        // items are matched by their registry type, e.g. "coal").
        const itemsByHost = wsc.getEntityItems(entityId);
        const fuelItems = [];
        for (const items of Object.values(itemsByHost)) {
            for (const item of items) {
                if (item?.type === effect.fuelItem) fuelItems.push(item);
            }
            if (fuelItems.length >= fuelNeeded) break;
        }

        // Not enough fuel: consume nothing, charge nothing, log once on the
        // transition into the dry state.
        if (fuelItems.length < fuelNeeded) {
            const dryKey = `${entityId}:${hostComponentId}`;
            if (!this._fuelExhaustionLogged.has(dryKey)) {
                this._fuelExhaustionLogged.set(dryKey, true);
                Logger.warn(`[InternalComponentController] overTime(consumeFuelGenerateStat): fuel "${effect.fuelItem}" exhausted on ${hostComponentId} — generator idles (energy ${current}/${capacity})`);
            }
            return false;
        }

        // Rule 3 — burn: consume whole fuel units first; the charge only
        // happens when the fuel was actually spent.
        for (const item of fuelItems.slice(0, fuelNeeded)) {
            const result = wsc.removeItemFromEntity(entityId, item.id);
            if (!result.success) {
                Logger.warn(`[InternalComponentController] overTime(consumeFuelGenerateStat): failed to remove fuel item ${item.id} from ${entityId}: ${result.message}`);
                return false;
            }
        }
        this._fuelExhaustionLogged.delete(`${entityId}:${hostComponentId}`);

        // Charge the host ENTITY's attribute, clamped at the capacity margin
        // (setEntityAttributeDelta also clamps into [0, max]; the explicit
        // clamp here keeps the waste-partial-energy semantics of the last burn).
        const charge = Math.min(gain, capacity - current);
        // Round-start attribute writes are coalesced into the turn's single
        // full-state broadcast; suppressing this avoids a redundant full emit
        // per cadence round.
        wsc.setEntityAttributeDelta(entityId, traitId, statName, charge, false);
        Logger.info(`[InternalComponentController] overTime(consumeFuelGenerateStat): consumed ${fuelNeeded} ${effect.fuelItem}, +${charge} ${traitId}.${statName} on entity ${entityId} (generator ${hostComponentId})`);
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
        const hostPos = hostEntity.spatial;
        if (!hostPos) return false;
        const range = typeof effect.range === 'number' ? effect.range : 0;
        const resistanceStat = this._channelResistanceStat(effect.channel);

        let damaged = 0;
        // getAll() returns a deep clone of the entity STORE (a plain object keyed
        // by entity id), not an array — iterate its values.
        const entityStore = this.worldStateController.stateEntityController;
        const allEntities = typeof entityStore?.getAll === 'function' ? Object.values(entityStore.getAll()) : [];
        for (const other of allEntities) {
            if (!other || other.id === entityId) continue;
            // Range is in room-relative coordinates (room center = origin): never
            // damage across room boundaries with local coordinates.
            if (other.location !== hostEntity.location) continue;
            const otherPos = other.spatial;
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
