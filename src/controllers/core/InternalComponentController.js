import { generateUID } from '../../utils/idGenerator.js';
import DataLoader from '../../utils/DataLoader.js';
import Logger from '../../utils/Logger.js';

/**
 * InternalComponentController handles the storage, management, and lifecycle
 * of internal components attached to host components on entities.
 *
 * Internal components (e.g., durability repair spheres) are nested within
 * host components and provide passive effects like repair over time.
 *
 * Per wiki/CORE.md: InternalComponentController is a State Controller (data store only),
 * following the State Ownership vs. Logic Coordination pattern — self-instantiating
 * without dependency injection.
 *
 * Storage format: { [entityId]: { [hostComponentId]: [internalComponentInstances] } }
 */
class InternalComponentController {
    /**
     * @param {Object} [internalComponentRegistry] - Pre-loaded internal component definitions.
     *   If not provided, loads from data/internalComponents.json.
     */
    constructor(internalComponentRegistry = null) {
        // Load registry from data file
        this.registry = internalComponentRegistry || DataLoader.loadJsonSafe('data/internalComponents.json', {});
        this._validateRegistry(this.registry);

        // State storage: { [entityId]: { [hostComponentId]: [internalComponentInstances] } }
        this.internalComponents = {};

        // Repair timer management: { [intervalId] } — single global interval
        this._repairInterval = null;

        Logger.info(`[InternalComponentController] Initialized with ${Object.keys(this.registry).length} internal component types`);
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
            if (!definition.volume || typeof definition.volume !== 'number') {
                Logger.warn(`[InternalComponentController] Internal component "${type}" missing valid volume property`);
            }
            if (!definition.repairInterval || typeof definition.repairInterval !== 'number') {
                Logger.warn(`[InternalComponentController] Internal component "${type}" missing valid repairInterval property`);
            }
            if (!definition.repairAmount || typeof definition.repairAmount !== 'number') {
                Logger.warn(`[InternalComponentController] Internal component "${type}" missing valid repairAmount property`);
            }
        }
    }

    /**
     * Auto-installs durabilityRepairSpheres on eligible components of a newly spawned entity.
     * Skips components in excludedComponentTypes and components with insufficient volume.
     *
     * @param {string} entityId - The entity ID.
     * @param {Array} components - Array of component objects with type and id.
     * @param {Object} [componentVolumeProvider] - Function to get component volume: (componentType) => number
     * @returns {Array} Array of installed internal component instances.
     */
    autoInstallOnEntitySpawn(entityId, components, componentVolumeProvider = null) {
        if (!this.registry['durabilityRepairSphere']) {
            Logger.warn('[InternalComponentController] durabilityRepairSphere not found in registry — skipping auto-install');
            return [];
        }

        const sphereDef = this.registry['durabilityRepairSphere'];
        const excludedTypes = sphereDef.excludedComponentTypes || [];
        const sphereVolume = sphereDef.volume;
        const installed = [];

        // Initialize entity entry if not exists
        if (!this.internalComponents[entityId]) {
            this.internalComponents[entityId] = {};
        }

        for (const component of components) {
            // Skip excluded component types (e.g., fingers)
            if (excludedTypes.includes(component.type)) {
                Logger.info(`[InternalComponentController] Skipping ${component.type} (${component.identifier}) — excluded from auto-install`);
                continue;
            }

            // Check volume capacity
            let hostVolume = 0;
            if (componentVolumeProvider) {
                hostVolume = componentVolumeProvider(component.type);
            } else {
                // Fallback: use registry volume defaults
                hostVolume = 10; // Default assumption for non-registered components
            }

            if (hostVolume < sphereVolume) {
                Logger.info(`[InternalComponentController] Skipping ${component.type} — volume ${hostVolume} < ${sphereVolume}`);
                continue;
            }

            // Check if already has an internal component of this type
            if (!this.internalComponents[entityId][component.id]) {
                this.internalComponents[entityId][component.id] = [];
            }

            // Create internal component instance
            const instanceId = generateUID();
            const instance = {
                id: instanceId,
                type: 'durabilityRepairSphere',
                hostComponentId: component.id,
                hostComponentType: component.type,
                hostComponentIdentifier: component.identifier,
                installedAt: Date.now()
            };

            this.internalComponents[entityId][component.id].push(instance);
            installed.push(instance);

            Logger.info(`[InternalComponentController] Auto-installed durabilityRepairSphere in ${component.type} (${component.identifier}) of entity ${entityId}`);
        }

        Logger.info(`[InternalComponentController] Installed ${installed.length} internal components on entity ${entityId}`);
        return installed;
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
    // REPAIR SYSTEM
    // =========================================================================

    /**
     * Starts the global repair tick system (5-second interval).
     * Each tick processes all durabilityRepairSpheres and heals their host components.
     */
    startRepairSystem() {
        if (this._repairInterval) {
            Logger.warn('[InternalComponentController] Repair system already running');
            return;
        }

        this._repairInterval = setInterval(() => {
            this._processRepairTick();
        }, 5000);

        Logger.info('[InternalComponentController] Repair system started (5s interval)');
    }

    /**
     * Stops the repair system and clears the interval.
     */
    stopRepairSystem() {
        if (this._repairInterval) {
            clearInterval(this._repairInterval);
            this._repairInterval = null;
            Logger.info('[InternalComponentController] Repair system stopped');
        }
    }

    /**
     * Called every 5 seconds: processes all repair spheres and heals host components.
     * Uses the centralized Logger for structured logging.
     *
     * @private
     */
    _processRepairTick() {
        let totalRepairs = 0;

        for (const [entityId, hostComponents] of Object.entries(this.internalComponents)) {
            for (const [hostComponentId, internalComponents] of Object.entries(hostComponents)) {
                for (const internalComp of internalComponents) {
                    if (internalComp.type !== 'durabilityRepairSphere') continue;

                    const sphereDef = this.registry['durabilityRepairSphere'];
                    if (!sphereDef) continue;

                    const repairAmount = sphereDef.repairAmount;

                    // Attempt to repair the host component
                    if (this.worldStateController) {
                        try {
                            const stats = this.worldStateController.getComponentStats(hostComponentId);
                            if (stats && stats.Physical && typeof stats.Physical.durability === 'number') {
                                const newDurability = stats.Physical.durability + repairAmount;
                                this.worldStateController.componentController.updateComponentStatDelta(
                                    hostComponentId,
                                    'Physical',
                                    'durability',
                                    repairAmount
                                );
                                totalRepairs++;
                                Logger.info(
                                    `[InternalComponentController] Repair tick: ${internalComp.type} healed ${internalComp.hostComponentType} (${hostComponentId}) +${repairAmount} durability → ${newDurability}`
                                );
                            }
                        } catch (error) {
                            Logger.error(`[InternalComponentController] Repair tick failed for ${hostComponentId}: ${error.message}`);
                        }
                    }
                }
            }
        }

        if (totalRepairs > 0) {
            // Sync internal components back to entity store so client receives them in broadcast
            this._syncToEntityStore();
            Logger.info(`[InternalComponentController] Repair tick complete: ${totalRepairs} repairs applied`);
        }
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
     * Sets the worldStateController reference for repair system access.
     * Called by WorldStateController during initialization.
     *
     * @param {any} worldStateController - The WorldStateController instance.
     */
    setWorldStateController(worldStateController) {
        this.worldStateController = worldStateController;
    }
}

export default InternalComponentController;