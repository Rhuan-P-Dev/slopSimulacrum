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
     * @param {Object} registry - The internal component registry to validate.
     * @private
     */
    _validateRegistry(registry) {
        if (!registry || typeof registry !== 'object') {
            throw new TypeError('[InternalComponentController] Registry must be an object');
        }

        for (const [type, definition] of Object.entries(registry)) {
            // Validate volume
            if (!definition.volume || typeof definition.volume !== 'number') {
                Logger.warn(`[InternalComponentController] Internal component "${type}" missing valid volume property`);
            }

            // Validate tickInterval
            if (definition.tickInterval && typeof definition.tickInterval !== 'number') {
                Logger.warn(`[InternalComponentController] Internal component "${type}" has invalid tickInterval`);
            }

            // Validate tickEffects
            if (definition.tickEffects !== undefined) {
                if (!Array.isArray(definition.tickEffects)) {
                    Logger.warn(`[InternalComponentController] Internal component "${type}" tickEffects must be an array`);
                } else {
                    for (const effect of definition.tickEffects) {
                        if (!effect.targetTrait) {
                            Logger.warn(`[InternalComponentController] Internal component "${type}" effect missing targetTrait`);
                        }
                        if (!effect.targetStat) {
                            Logger.warn(`[InternalComponentController] Internal component "${type}" effect missing targetStat`);
                        }
                        if (!effect.effect) {
                            Logger.warn(`[InternalComponentController] Internal component "${type}" effect missing effect type`);
                        } else if (!['add', 'set', 'multiply'].includes(effect.effect)) {
                            Logger.warn(`[InternalComponentController] Internal component "${type}" has invalid effect type: ${effect.effect}`);
                        }
                        if (effect.amount === undefined || effect.amount === null) {
                            Logger.warn(`[InternalComponentController] Internal component "${type}" effect missing amount`);
                        }
                    }
                }
            }

            // Validate targetBlueprintTypes (optional — if present, must be an array)
            if (definition.targetBlueprintTypes !== undefined) {
                if (!Array.isArray(definition.targetBlueprintTypes)) {
                    Logger.warn(`[InternalComponentController] Internal component "${type}" targetBlueprintTypes must be an array`);
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
     *
     * @param {string} entityId - The entity ID.
     * @param {Array} components - Array of component objects with type, id, and optionally identifier.
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
            if (!compDef.autoInstallOnSpawn) continue;

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
            const installed = [];

            if (!this.internalComponents[entityId]) {
                this.internalComponents[entityId] = {};
            }

            for (const component of components) {
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
                    installedAt: Date.now()
                };

                this.internalComponents[entityId][component.id].push(instance);
                installed.push(instance);

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
     * Manually adds an internal component to a host component.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @param {string} internalComponentType - The internal component type to add.
     * @returns {Object|null} The created instance, or null if failed.
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

        const instanceId = generateUID();
        const instance = {
            id: instanceId,
            type: internalComponentType,
            hostComponentId: hostComponentId,
            installedAt: Date.now()
        };

        this.internalComponents[entityId][hostComponentId].push(instance);
        Logger.info(`[InternalComponentController] Added ${internalComponentType} to ${hostComponentId} of entity ${entityId}`);

        return instance;
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
                    if (!compDef || !compDef.tickEffects || !Array.isArray(compDef.tickEffects)) continue;

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
        let delta = 0;

        switch (effect.effect) {
            case 'add':
                delta = effect.amount;
                break;
            case 'set':
                delta = effect.amount - oldValue;
                break;
            case 'multiply':
                delta = oldValue * (effect.amount - 1);
                break;
            default:
                Logger.warn(`[InternalComponentController] Unknown tick effect type: ${effect.effect}`);
                return;
        }

        const newValue = oldValue + delta;

        this.worldStateController.componentController.updateComponentStatDelta(
            hostComponentId,
            effect.targetTrait,
            effect.targetStat,
            delta
        );

        Logger.info(
            `[InternalComponentController] Tick: ${internalComp.type} applied ${effect.effect} ${effect.targetStat}: ${oldValue} → ${newValue} (${delta >= 0 ? '+' : ''}${delta})`
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