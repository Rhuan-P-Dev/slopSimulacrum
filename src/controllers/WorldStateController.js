import DataLoader from '../utils/DataLoader.js';
import Logger from '../utils/Logger.js';
import WorldGraphBuilder from '../utils/WorldGraphBuilder.js';
import IdResolver from '../utils/IdResolver.js';

/**
 * WorldStateController — the world-state facade (thin root).
 *
 * FASE 5 (god-class refactoring): this class NO LONGER instantiates its own
 * sub-controllers. Every sub-controller is constructed by the composition root
 * (src/composition/WorldComposition.js — `buildWorldState()`), which builds them
 * in topological dependency order and hands them here via `deps`. This removes
 * the old constructor-ordering defect (BUG-100 root cause): previously the
 * facade passed `this` to each sub-controller BEFORE its own properties were
 * fully assigned, creating dependency cycles and partially-initialized access.
 *
 * Construction contract:
 *   - The constructor only STORES the injected sub-controllers and wires the
 *     internal observers/listeners between them. It never instantiates a
 *     sub-controller and never passes `this` to one.
 *   - Sub-controllers that legitimately depend on THIS facade receive it via a
 *     `setWorldStateController()` setter, called by the composition root AFTER
 *     this facade is fully constructed. See the JSDoc of each setter.
 *   - World initialization (`initializeWorld()`) and the initial capability
 *     scan are triggered by the composition root, not here, so that all facade
 *     references are in place before any code path that can trigger sub-controllers.
 *
 * The public method surface (64 methods) is unchanged and snapshot-guarded by
 * test/contract/worldStateController.contract.test.js.
 */
class WorldStateController {
    /**
     * @param {Object} deps - Fully-constructed sub-controllers (injected by the
     *   composition root). See the individual JSDoc for each named dependency.
     * @param {UniversalTickSystem|null} [deps.tickSystem] - The global tick system.
     * @param {ComponentStatsController} deps.statsController
     * @param {TraitsController} deps.traitsController
     * @param {InternalComponentController} deps.internalComponentController
     * @param {ComponentController} deps.componentController
     * @param {EntityController} deps.entityController
     * @param {RoomsController} deps.roomsController
     * @param {InventoryManager} deps.inventoryManager
     * @param {EquippedItemStatsController} deps.equippedItemStats
     * @param {ComponentCapabilityController} deps.componentCapabilityController
     * @param {ActionSelectController} deps.actionSelectController
     * @param {SynergyController} deps.synergyController
     * @param {ConsequenceHandlers} deps.consequenceHandlers
     * @param {ActionController} deps.actionController
     * @param {stateEntityController} deps.stateEntityController
     * @param {HoldingCostController} deps.holdingCostController
     */
    constructor(deps) {
        if (!deps || typeof deps !== 'object') {
            throw new Error(
                '[WorldStateController] Missing injected dependencies. ' +
                'Construct via buildWorldState() (src/composition/WorldComposition.js), ' +
                'not directly — the facade no longer self-instantiates its sub-controllers.'
            );
        }

        // --- Store the injected sub-controllers (named dependencies) -------------
        /** @private {UniversalTickSystem|null} */
        this.tickSystem = deps.tickSystem ?? null;
        this.statsController = deps.statsController;
        this.traitsController = deps.traitsController;
        this.internalComponentController = deps.internalComponentController;
        this.componentController = deps.componentController;
        this.entityController = deps.entityController;
        this.roomsController = deps.roomsController;
        this.inventoryManager = deps.inventoryManager;
        this.equippedItemStats = deps.equippedItemStats;
        this.componentCapabilityController = deps.componentCapabilityController;
        this.actionSelectController = deps.actionSelectController;
        this.synergyController = deps.synergyController;
        this.consequenceHandlers = deps.consequenceHandlers;
        this.actionController = deps.actionController;
        this.stateEntityController = deps.stateEntityController;
        this.holdingCostController = deps.holdingCostController;

        // --- Broadcast service (injected later via setBroadcastService()) --------
        /** @private {WorldStateBroadcastService|null} */
        this._broadcastService = null;

        // Map of sub-controllers for easy iteration/extension
        this.subControllers = {
            rooms: this.roomsController,
            entities: this.stateEntityController,
            components: this.componentController,
            internalComponents: this.internalComponentController,
            actions: this.actionController,
            capabilities: this.componentCapabilityController,
            synergy: this.synergyController,
            selections: this.actionSelectController,
            inventory: this.inventoryManager,
            holdingCost: this.holdingCostController,
            equippedItemStats: this.equippedItemStats
        };

        // --- Wire internal observers/listeners between sub-controllers -----------
        // NOTE: none of these callbacks dereference the facade's own state at
        // construction time; they run later (on spawn / on stat change), by which
        // point the composition root has injected the facade into every sub-controller.

        // Register spawn observer — applies the declarative initial spawns from
        // data/world.json to every spawned entity (data-driven replacement of the
        // former hardcoded spawn items).
        this.stateEntityController.registerSpawnObserver((entityId, entityData) => {
            this._applyInitialSpawns(entityId);
        });

        // Wire up stat change notifications from ComponentController to
        // ComponentCapabilityController — enables automatic capability
        // re-evaluation when component stats change (+ broadcast).
        this.componentController.registerStatChangeListener((componentId, traitId, statName, newValue, oldValue) => {
            this.componentCapabilityController.onStatChange(componentId, traitId, statName, newValue, oldValue);
            // Trigger broadcast if broadcastService is available
            if (this._broadcastService) {
                this._broadcastService.broadcast();
            }
        });

        // Initialize Internal Component Controller with the global tick system
        // (registers its tick job; the facade reference itself is injected by the
        // composition root via setWorldStateController() AFTER this constructor).
        this.internalComponentController.initialize();

        // Wire equippedItemStats stat change callback to trigger capability
        // re-evaluation. When an equipped item's stats change (e.g., sharpness
        // drain from cut), the capability cache re-scans with CURRENT stats, not
        // stale base stats.
        this.equippedItemStats.setStatChangeCallback((eqId, traitId, statName, newValue, oldValue) => {
            // Find which entity this item belongs to by scanning equipped items.
            // HoldingCostController.getEquippedItemsByEntity() returns: { [entityId]: { [eqId]: itemData } }
            const allEquipped = this.holdingCostController.getEquippedItemsByEntity();
            for (const [entityId, items] of Object.entries(allEquipped)) {
                if (items[eqId]) {
                    // Entity found — re-evaluate its capabilities with current stats
                    const state = this.getAll();
                    this.actionController.reEvaluateEntityCapabilities(state, entityId);
                    if (this._broadcastService) {
                        this._broadcastService.broadcast();
                    }
                    Logger.info(`[WorldStateController] Capability re-evaluated for entity "${entityId}" after ${traitId}.${statName} changed: ${oldValue} → ${newValue}`);
                    return;
                }
            }
        });
    }

    /**
     * Sets up initial world state, including default entities.
     */
    initializeWorld() {
        // Resolve the UUID for the start room to maintain spatial synchronization
        const startRoomId = this.roomsController.getUidByLogicalId('start_room');

        // Spawn the client entity (small ball droid) in the start room.
        // The spawn observer registered in the constructor applies the declarative
        // initial spawns from data/world.json, which fires for every spawned entity
        // including the initial client entity.
        const clientEntityId = this.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

        // Client-only initial spawn (not part of the generic world.json initialSpawns):
        // an extra knife on the droidHand so it is available for equip/cut from the start.
        if (clientEntityId) {
            const clientEntity = this.stateEntityController.getEntity(clientEntityId);
            const handComponent = clientEntity?.components?.find(c => c.type === 'droidHand')
                || clientEntity?.components?.find(c => c.type === 'droidArm');
            if (handComponent) {
                const result = this.addItemToEntity(clientEntityId, 'knife', handComponent.id);
                if (!result.success) {
                    Logger.warn(`[WorldStateController] Failed to add client-only knife to ${handComponent.type}: ${result.message}`);
                }
            } else {
                Logger.warn(`[WorldStateController] No droidHand/droidArm component found on client entity "${clientEntityId}" for knife.`);
            }
        }

        // Spawn the vault guardian droid in the Deep Vault
        const vaultRoomId = this.roomsController.getUidByLogicalId('far_right_room');
        this.stateEntityController.spawnEntity('smallBallDroid', vaultRoomId);
    }

    /**
     * Applies the declarative initial spawns from data/world.json to a spawned entity.
     * Generic replacement of the former hardcoded spawn methods (_spawnMetalBoxWithKnives,
     * _addKnifeToClientEntity, _addTestItemToClientEntity, _addT1WeaponToEntity): the exact
     * item composition is now declared in data/world.json (initialSpawns) and this method
     * only interprets it.
     *
     * Supported entry fields:
     * - { item, slot, children?: [{ item, count }] }: add `item` to a component resolved by
     *   `slot`, then add each child item `count` times inside the created container item.
     *   slot forms: "<type>" (first component of that type), "firstFit:<type>[,<type>...]"
     *   (first of the listed types with enough available volume).
     * - { item, slot, fallback?: "<type>" }: like above, plus a fallback component type tried
     *   when the primary slot has no capacity.
     * - { item, slot: "bestAvailable[:<preferredType>...]", ammo?: number }: add `item`
     *   to the first component (in component order) whose available volume is the highest
     *   among all fitting components; an optional "bestAvailable:hand" list of preferred
     *   types is tried first (first preferred type with enough capacity wins), mirroring
     *   the legacy "hand component first, then best available" weapon placement. Then
     *   load `ammo` knife projectile(s) into the item for weapons that fire stored items.
     *
     * @param {string} entityId - The entity ID to apply initial spawns to.
     * @param {Object} [spawnConfig] - Optional spawn config; defaults to data/world.json.
     * @returns {{ applied: number, failed: number }} Summary of applied/failed spawn entries.
     * @private
     */
    _applyInitialSpawns(entityId, spawnConfig) {
        let config = spawnConfig;
        if (!config) {
            config = DataLoader.loadJsonSafe('data/world.json', {});
        }

        const entries = config?.initialSpawns;
        if (!Array.isArray(entries) || entries.length === 0) {
            return { applied: 0, failed: 0 };
        }

        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity || !entity.components || !Array.isArray(entity.components)) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found or has no components for initial spawns.`);
            return { applied: 0, failed: entries.length };
        }

        let applied = 0;
        let failed = 0;

        for (const entry of entries) {
            try {
                const target = this._resolveInitialSpawnSlot(entity, entry);
                if (!target) {
                    Logger.warn(`[WorldStateController] Initial spawn "${entry.item}" has no valid slot ("${entry.slot}") on entity "${entityId}".`);
                    failed++;
                    continue;
                }

                const addResult = this.inventoryManager.addItem(entity, entry.item, target.component.id, {
                    componentController: this.componentController
                });
                if (!addResult.success) {
                    Logger.warn(`[WorldStateController] Initial spawn "${entry.item}" failed on ${target.component.type} (entity ${entityId}): ${addResult.message}`);
                    failed++;
                    continue;
                }

                // Container children (e.g., metalBox pre-filled with knives)
                if (Array.isArray(entry.children)) {
                    for (const child of entry.children) {
                        const count = Math.max(0, Number(child?.count) || 0);
                        for (let i = 0; i < count; i++) {
                            const childResult = this.inventoryManager.addItemToContainer(entity, addResult.item?.id, child.item);
                            if (!childResult.success) {
                                Logger.warn(`[WorldStateController] Initial spawn child "${child.item}" #${i + 1} into "${entry.item}" failed (entity ${entityId}): ${childResult.message}`);
                            }
                        }
                    }
                }

                // Weapon ammo (e.g., t1 pre-loaded with knife projectiles)
                if (typeof entry.ammo === 'number' && entry.ammo > 0) {
                    for (let i = 0; i < entry.ammo; i++) {
                        const ammoResult = this.inventoryManager.addItemToContainer(entity, addResult.item?.id, 'knife');
                        if (!ammoResult.success) {
                            Logger.warn(`[WorldStateController] Initial spawn ammo #${i + 1} into "${entry.item}" failed (entity ${entityId}): ${ammoResult.message}`);
                        }
                    }
                }

                applied++;
                Logger.info(`[WorldStateController] Initial spawn "${entry.item}" applied to ${target.component.type} (component: ${target.component.id}) on entity ${entityId}`);
            } catch (error) {
                Logger.error(`[WorldStateController] Error applying initial spawn "${entry?.item}" to entity "${entityId}": ${error.message}`);
                failed++;
            }
        }

        return { applied, failed };
    }

    /**
     * Resolves the target component for an initial-spawn entry (data/world.json).
     *
     * Slot forms:
     * - "<type>": the first component of that type.
     * - "firstFit:<type>[,<type>...]" in that order: the first component (in order) with
     *   enough available volume for the item's host footprint.
     * - "bestAvailable" / "bestAvailable:<preferredType>[,...]": the first listed
     *   preferred component type (substring match, e.g., "hand") with enough available
     *   volume; without a preference, the component with the highest available volume
     *   (first one wins ties).
     *
     * @param {Object} entity - The entity object.
     * @param {Object} entry - The initial spawn entry ({ item, slot, fallback? }).
     * @returns {{ component: Object }|null} The resolved component, or null if no slot matches.
     * @private
     */
    _resolveInitialSpawnSlot(entity, entry) {
        const itemDef = this.inventoryManager.getItemDefinitions()[entry.item];
        if (!itemDef) {
            Logger.warn(`[WorldStateController] Unknown item type "${entry.item}" in initial spawn config.`);
            return null;
        }
        // Items like T1 occupy their externalVolume footprint on the host component
        const hostFootprint = itemDef.externalVolume ?? itemDef.volume;

        const slot = entry.slot;
        if (typeof slot !== 'string' || slot === '') {
            return null;
        }

        const firstOfType = (type) => entity.components.find(c => c.type === type) || null;

        if (slot === 'bestAvailable' || slot.startsWith('bestAvailable:')) {
            // Optional preferred types (e.g., "bestAvailable:hand" → types containing "hand"):
            // the first preferred component with enough available volume wins, matching the
            // legacy hand-first weapon placement.
            let preferredTypes = [];
            if (slot.startsWith('bestAvailable:')) {
                preferredTypes = slot.slice('bestAvailable:'.length).split(',').map(t => t.trim()).filter(Boolean);
            }
            if (preferredTypes.length > 0) {
                for (const component of entity.components) {
                    const matchesPreference = preferredTypes.some(p => (component.type || '').toLowerCase().includes(p));
                    if (matchesPreference && this.inventoryManager.getAvailableVolume(entity, component.id) >= hostFootprint) {
                        return { component };
                    }
                }
            }
            // Fallback: the component with the highest available volume (first one wins ties,
            // identical to the legacy strict-greater selection).
            let bestComponent = null;
            let bestAvailableVolume = 0;
            for (const component of entity.components) {
                const availableVolume = this.inventoryManager.getAvailableVolume(entity, component.id);
                if (availableVolume >= hostFootprint && availableVolume > bestAvailableVolume) {
                    bestAvailableVolume = availableVolume;
                    bestComponent = component;
                }
            }
            return bestComponent ? { component: bestComponent } : null;
        }

        if (slot.startsWith('firstFit:')) {
            const types = slot.slice('firstFit:'.length).split(',').map(t => t.trim()).filter(Boolean);
            for (const type of types) {
                const candidate = firstOfType(type);
                if (candidate && this.inventoryManager.getAvailableVolume(entity, candidate.id) >= hostFootprint) {
                    return { component: candidate };
                }
            }
            return null;
        }

        // Plain type slot, with optional fallback type
        const primary = firstOfType(slot);
        if (primary && this.inventoryManager.getAvailableVolume(entity, primary.id) >= hostFootprint) {
            return { component: primary };
        }
        if (entry.fallback) {
            const fallback = firstOfType(entry.fallback);
            if (fallback && this.inventoryManager.getAvailableVolume(entity, fallback.id) >= hostFootprint) {
                return { component: fallback };
            }
        }
        return null;
    }

    /**
     * Aggregates state data from all registered sub-controllers.
     * This method serves as a unified "getState" for the entire world.
     * @returns {Object} The combined state of the world.
     */
    getAll() {
        const globalState = {};

        // Dynamically collect data from all sub-controllers that implement getAll()
        for (const [key, controller] of Object.entries(this.subControllers)) {
            if (typeof controller.getAll === 'function') {
                globalState[key] = controller.getAll();
            }
        }

        // Include dropped items in the global state for real-time broadcast
        const droppedItems = this.getDroppedItems();
        if (droppedItems && Object.keys(droppedItems).length > 0) {
            globalState.droppedItems = droppedItems;
        }

        return globalState;
    }

    // =========================================================================
    // PERSISTENCE — serialize() / restore() (FASE 3)
    // =========================================================================

    /**
     * Snapshot schema version. Bump when the snapshot format changes;
     * restore() rejects any other version with SCHEMA_VERSION_MISMATCH.
     */
    static get PERSISTENCE_SCHEMA_VERSION() {
        return 1;
    }

    /**
     * Serializes the COMPLETE mutable world state into a JSON-serializable
     * snapshot, for save/load, checkpoints, and test/debug snapshots.
     *
     * Coverage (every piece of mutable state a sub-controller owns — see the
     * "IMPL DECISION" note on restore() for the ownership map):
     *   - entities:  live entity instances (ids, components, spatial, status,
     *                items with full nesting via hostComponentId, internalComponents)
     *   - components: per-instance merged stats (ComponentStatsController)
     *   - inventory: InventoryManager._inventory index (mirrors entity.items,
     *                kept in sync so the manager's index matches on restore)
     *   - equipped:  HoldingCostController._equippedItems + _preEquipStats
     *                (pre-equip stats keep unequip-undo bookkeeping intact)
     *   - equippedItemStats: EquippedItemStatsController._itemStats
     *                        (mutable sharpness/durability per eqId)
     *   - internalComponents: InternalComponentController.internalComponents
     *                        (canonical store; entity.internalComponents mirrors it)
     *   - rooms:     dynamic room state (entities/objects lists) — the room
     *                structure itself (positions, connections, doorPositions)
     *                is static data from data/rooms.json and is intentionally
     *                NOT snapshotted
     *   - droppedItems: WorldStateController._droppedItems
     *   - selections: ActionSelectController._selectionRegistry (Map → array)
     *
     * Defensiveness: the snapshot is a JSON round-trip (same defensiveness
     * pattern the project uses for broadcasts — WorldStateBroadcastService
     * _transformForBroadcast does structuredClone; JSON.parse(JSON.stringify())
     * is equivalent for this pure data and additionally guarantees no live
     * references, Maps, or functions leak out).
     *
     * All IDs (ent-, comp-, item-, eq-, room UIDs, internal-component UIDs)
     * are PRESERVED in the snapshot — a restored world is identical to the
     * one that produced it (modulo serializedAtTick/serializedAt metadata).
     *
     * @returns {Object} JSON-serializable snapshot:
     *   { schemaVersion: number, serializedAtTick: number|null,
     *     serializedAt: number, state: { entities, components, inventory,
     *     equipped, preEquipStats, equippedItemStats, internalComponents,
     *     rooms, droppedItems, selections } }
     */
    serialize() {
        const snapshot = {
            schemaVersion: WorldStateController.PERSISTENCE_SCHEMA_VERSION,
            serializedAtTick: this.internalComponentController?.tickSystem?.currentTick ?? null,
            serializedAt: Date.now(),
            state: {
                // Entities (live instances; structuredClone keeps no live refs)
                entities: structuredClone(this.stateEntityController.entities),
                // Component instance stats (full merged stats per comp-* id)
                components: this.componentController.statsController.getAll(),
                // InventoryManager's per-entity item index
                inventory: structuredClone(this.inventoryManager._inventory),
                // Equipped items + pre-equip stat bookkeeping (undo data)
                equipped: structuredClone(this.holdingCostController._equippedItems),
                preEquipStats: structuredClone(this.holdingCostController._preEquipStats),
                // Mutable per-equipped-item stats (sharpness, durability, ...)
                equippedItemStats: this.equippedItemStats.getAll(),
                // Canonical internal-component store
                internalComponents: structuredClone(this.internalComponentController.internalComponents),
                // Dynamic room state only (structure comes from data/rooms.json)
                rooms: this.roomsController.getAll(),
                // Dropped items on the map
                droppedItems: this.getDroppedItems(),
                // Active component→action selection locks (Map serialized to array)
                selections: [...this.actionSelectController._selectionRegistry.entries()]
            }
        };

        // JSON round-trip: guarantees the result is a pure JSON-serializable
        // snapshot with zero references into the live world state.
        return JSON.parse(JSON.stringify(snapshot));
    }

    /**
     * Restores the complete world state from a snapshot produced by serialize().
     *
     * IMPL DECISION — option (a): per-sub-controller state injection.
     * Each state-owning sub-controller exposes a plain data store
     * (entities, componentStats, _inventory, _equippedItems/_preEquipStats,
     * _itemStats, internalComponents, rooms, _droppedItems, _selectionRegistry)
     * that has NO derived logic — the logic controllers (ActionController,
     * ComponentCapabilityController, SynergyController, ...) derive everything
     * on demand. Restoring therefore means:
     *   1. validate the payload (shape + schemaVersion),
     *   2. replace each owned store with a deep-cloned copy of the snapshot
     *      section (no live references shared with the caller),
     *   3. rebuild derived caches via the EXISTING public APIs:
     *        - stateEntityController._restoreFromSnapshot() re-syncs each
     *          entity's internalComponents mirror from the canonical internal
     *          store (run AFTER the internal store itself is restored, so the
     *          mirror matches the restored data). Spawn observers are NOT
     *          fired: the snapshot already contains the final entity state,
     *          and re-running the declarative initial-spawn path would
     *          double-add items.
     *        - actionController.scanAllCapabilities() rebuilds the capability
     *          cache from the restored state (fresh cache, same as constructor).
     *        - synergyController.clearCache() drops stale cached results.
     *
     * Why (a) over (b) (re-apply via public action APIs): re-applying would
     * re-run the spawn logic (which generates NEW ids for entities,
     * components, items — breaking id preservation, a round-trip requirement),
     * re-generate eqIds, and cannot reconstruct _preEquipStats or
     * selection locks at all. Direct store injection preserves every id and
     * bookkeeping field, and it is the same primitive the constructor itself
     * uses (fresh stores, then populate).
     *
     * Known limitation (documented): rooms.json door positions and the idMap
     * are structural/static; restore() replaces the dynamic room entries
     * (entities/objects) but keeps the constructor-built structure. Since
     * room structure is data-driven and immutable at runtime, this is safe
     * for the current game.
     *
     * NOTE: this is an explicit operator/test operation — it does NOT run on
     * a tick and does NOT broadcast (callers broadcast after a successful
     * restore, e.g. the /api/world/load route).
     *
     * @param {Object} payload - Snapshot as returned by serialize().
     * @returns {{ success: true } | { success: false, error: { code: string, message: string } }}
     */
    restore(payload) {
        // --- Validation -----------------------------------------------------
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return {
                success: false,
                error: { code: 'INVALID_PAYLOAD', message: 'restore() requires a snapshot object (result of serialize()).' }
            };
        }
        if (payload.schemaVersion !== WorldStateController.PERSISTENCE_SCHEMA_VERSION) {
            return {
                success: false,
                error: {
                    code: 'SCHEMA_VERSION_MISMATCH',
                    message: `Unsupported schemaVersion ${JSON.stringify(payload.schemaVersion)} — expected ${WorldStateController.PERSISTENCE_SCHEMA_VERSION}.`
                }
            };
        }
        const s = payload.state;
        if (!s || typeof s !== 'object') {
            return {
                success: false,
                error: { code: 'INVALID_PAYLOAD', message: 'Snapshot is missing the "state" section.' }
            };
        }
        for (const key of ['entities', 'components', 'inventory', 'equipped', 'preEquipStats', 'equippedItemStats', 'internalComponents', 'rooms', 'droppedItems', 'selections']) {
            if (!(key in s)) {
                return {
                    success: false,
                    error: { code: 'INVALID_PAYLOAD', message: `Snapshot "state" is missing required section "${key}".` }
                };
            }
        }

        try {
            // 1. Canonical internal-component store FIRST — the entity
            //    mirror re-sync in step 2 reads from this store, so the
            //    restored values must be in place before entities are restored.
            this.internalComponentController.internalComponents = structuredClone(s.internalComponents);

            // 2. Entities (re-syncs each entity's internalComponents mirror
            //    from the canonical store above — see stateEntityController)
            this.stateEntityController._restoreFromSnapshot(structuredClone(s.entities));

            // 3. Component instance stats (plain store replacement)
            this.componentController.statsController.componentStats = structuredClone(s.components);

            // 4. InventoryManager item index (entity.items already restored
            //    with the entities above; this re-syncs the manager's index)
            this.inventoryManager._inventory = structuredClone(s.inventory);

            // 5. Equipped items + pre-equip undo bookkeeping
            this.holdingCostController._equippedItems = structuredClone(s.equipped);
            this.holdingCostController._preEquipStats = structuredClone(s.preEquipStats);

            // 6. Mutable per-equipped-item stats
            this.equippedItemStats._itemStats = structuredClone(s.equippedItemStats);

            // 7. Dynamic room state (replace entries; keep constructor-built
            //    structure: idMap + doorPositions come from data/rooms.json)
            const restoredRooms = structuredClone(s.rooms);
            for (const roomId of Object.keys(this.roomsController.rooms)) {
                delete this.roomsController.rooms[roomId];
            }
            for (const [roomId, room] of Object.entries(restoredRooms)) {
                this.roomsController.rooms[roomId] = room;
            }

            // 8. Dropped items
            this._droppedItems = structuredClone(s.droppedItems);

            // 9. Selection locks (array → Map)
            const registry = new Map();
            for (const [componentId, selection] of (Array.isArray(s.selections) ? s.selections : [])) {
                if (typeof componentId === 'string' && selection && typeof selection === 'object') {
                    registry.set(componentId, { ...selection });
                }
            }
            this.actionSelectController._selectionRegistry = registry;

            // 10. Rebuild derived caches via existing public APIs
            this.actionController.scanAllCapabilities(this.getAll());
            if (this.synergyController?.clearCache) {
                this.synergyController.clearCache();
            }

            Logger.info(
                `[WorldStateController] World state restored from snapshot (schemaVersion ${WorldStateController.PERSISTENCE_SCHEMA_VERSION}, ` +
                `${Object.keys(this.stateEntityController.entities).length} entities, ${Object.keys(this._droppedItems).length} dropped items).`
            );
            return { success: true };
        } catch (error) {
            Logger.error(`[WorldStateController] restore() failed: ${error.message}`, { error: error.stack });
            return {
                success: false,
                error: { code: 'RESTORE_FAILED', message: `Failed to restore world state: ${error.message}` }
            };
        }
    }

    // =========================================================================
    // PUBLIC API WRAPPERS (for server.js access)
    // =========================================================================

    /**
     * Spawns an entity from a blueprint into a room.
     * @param {string} blueprintName - The blueprint to use.
     * @param {string} roomId - The room to spawn into.
     * @returns {string} The new entity ID.
     */
    spawnEntity(blueprintName, roomId) {
        return this.stateEntityController.spawnEntity(blueprintName, roomId);
    }

    /**
     * Despawns an entity and cleans up its capabilities.
     * @param {string} entityId - The entity to despawn.
     * @returns {boolean} True if successful.
     */
    despawnEntity(entityId) {
        return this.stateEntityController.despawnEntity(entityId);
    }

    /**
     * Moves an entity to a different room.
     * @param {string} entityId - The entity to move.
     * @param {string} targetRoomId - The destination room.
     * @param {Object} [options] - Optional parameters.
     * @param {string} [options.sourceDoor] - The door name the entity exited from in the source room.
     * @returns {boolean} True if successful.
     */
    moveEntity(entityId, targetRoomId, options = {}) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            return false;
        }

        let spawnSpatial = null;
        if (options.sourceDoor) {
            const sourceRoomId = entity.location;
            spawnSpatial = this.roomsController.getSpawnPositionForDoorTraversal(
                sourceRoomId,
                options.sourceDoor,
                targetRoomId
            );
        }

        const moveOptions = spawnSpatial ? { spatial: spawnSpatial } : {};
        return this.stateEntityController.moveEntity(entityId, targetRoomId, moveOptions);
    }

    /**
     * Resolves a logical room name to its UUID.
     * @param {string} logicalId - The logical room name.
     * @returns {string|null} The room UUID or null.
     */
    getRoomUidByLogicalId(logicalId) {
        return this.roomsController.getUidByLogicalId(logicalId);
    }

    /**
     * Retrieves an entity by its ID.
     * Provides a public API for accessing entity state instead of direct property access.
     * @param {string} entityId - The entity ID.
     * @returns {Object|null} The entity object, or null if not found.
     */
    getEntity(entityId) {
        return this.stateEntityController.getEntity(entityId);
    }

    /**
     * Retrieves component stats by component ID.
     * @param {string} componentId - The component ID.
     * @returns {Object|null} The component stats object, or null if not found.
     */
    getComponentStats(componentId) {
        return this.componentController.getComponentStats(componentId);
    }

    // =========================================================================
    // INTERNAL COMPONENT API (for internal components system)
    // =========================================================================

    /**
     * Adds an internal component to a host component.
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @param {string} internalComponentType - The internal component type to add.
     * @returns {Object|null} The created instance, or null if failed.
     */
    addInternalComponent(entityId, hostComponentId, internalComponentType) {
        return this.internalComponentController.addInternalComponent(entityId, hostComponentId, internalComponentType);
    }

    /**
     * Gets internal components for a specific host component.
     * Returns a defensive deep copy to prevent external mutation.
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @returns {Array} Deep copy of internal component instances for the host.
     */
    getInternalComponents(entityId, hostComponentId) {
        return this.internalComponentController.getInternalComponents(entityId, hostComponentId);
    }

    /**
     * Gets all internal components for an entity.
     * Returns a defensive deep copy to prevent external mutation.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Deep copy of all internal components for the entity.
     */
    getInternalComponentsForEntity(entityId) {
        return this.internalComponentController.getInternalComponentsForEntity(entityId);
    }

    /**
     * Removes an internal component from a host component.
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @param {string} internalComponentInstanceId - The internal component instance ID to remove.
     * @returns {boolean} True if removed successfully.
     */
    removeInternalComponent(entityId, hostComponentId, internalComponentInstanceId) {
        return this.internalComponentController.removeInternalComponent(entityId, hostComponentId, internalComponentInstanceId);
    }

    /**
     * Checks if a host component has a specific type of internal component.
     * @param {string} entityId - The entity ID.
     * @param {string} hostComponentId - The host component ID.
     * @param {string} internalComponentType - The internal component type to check.
     * @returns {boolean} True if the host has the specified internal component type.
     */
    hasInternalComponent(entityId, hostComponentId, internalComponentType) {
        return this.internalComponentController.hasInternalComponent(entityId, hostComponentId, internalComponentType);
    }

    /**
     * Cleans up all internal components for a specific entity.
     * Called when an entity is despawned.
     * @param {string} entityId - The entity ID to clean up.
     * @returns {boolean} True if cleanup was performed.
     */
    cleanupInternalComponents(entityId) {
        return this.internalComponentController.cleanupEntity(entityId);
    }

    // =========================================================================
    // SYNERGY PUBLIC API (for server.js access)
    // =========================================================================

    /**
     * Computes synergy for an action without executing it.
     * @param {string} actionName - The action name
     * @param {string} entityId - The entity executing the action
     * @param {Object} [context] - Optional context (e.g., synergyGroups for multi-entity)
     * @returns {Object} SynergyResult object
     */
    computeSynergy(actionName, entityId, context) {
        return this.synergyController.computeSynergy(actionName, entityId, context);
    }

    /**
     * Gets all actions that have synergy enabled.
     * @returns {string[]} Array of action names with synergy
     */
    getActionsWithSynergy() {
        return this.synergyController.getActionsWithSynergy();
    }

    /**
     * Gets synergy configuration for an action.
     * @param {string} actionName - The action name
     * @returns {Object} Synergy config object
     */
    getSynergyConfig(actionName) {
        return this.synergyController.getSynergyConfig(actionName);
    }

    // =========================================================================
    // ACTION DATA PREVIEW (for synergy preview system)
    // =========================================================================

    /**
     * Previews action data including resolved values and synergy for a given component selection.
     * Used by the enhanced synergy preview endpoint.
     * @param {string} actionName - The action name
     * @param {string} entityId - The entity executing the action
     * @param {Object} [context] - Optional context (providedComponentIds, etc.)
     * @returns {Object} Preview data with actionData, resolvedValues, and synergyResult
     */
    previewActionData(actionName, entityId, context) {
        return this.actionController.previewActionData(actionName, entityId, context);
    }

    // =========================================================================
    // ACTION API WRAPPERS (for server.js access)
    // =========================================================================

    /**
     * Returns actions relevant to a specific entity.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Action status for the entity.
     */
    getActionsForEntity(entityId) {
        const state = this.getAll();
        return this.actionController.getActionsForEntity(state, entityId);
    }

    /**
     * Returns all action capabilities across all entities.
     * @returns {Object} Action capabilities data.
     */
    getActionCapabilities() {
        const state = this.getAll();
        return this.actionController.getActionCapabilities(state);
    }

    /**
     * Executes an action on an entity.
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity executing the action.
     * @param {Object} [params] - Optional action parameters.
     * @returns {Object} Execution result.
     */
    executeAction(actionName, entityId, params) {
        return this.actionController.executeAction(actionName, entityId, params);
    }

    // =========================================================================
    // COMPONENT CAPABILITY API WRAPPERS (for server.js access)
    // =========================================================================

    /**
     * Returns the cached action capability data for all actions.
     * @returns {Object} Cached capabilities.
     */
    getCachedCapabilities() {
        return this.componentCapabilityController.getCachedCapabilities();
    }

    /**
     * Returns the best component for a specific action across all entities.
     * @param {string} actionName - The action name.
     * @returns {Object|null} Best component entry or null.
     */
    getBestComponentForAction(actionName) {
        return this.componentCapabilityController.getBestComponentForAction(actionName);
    }

    /**
     * Returns all capability entries for a specific entity across all actions.
     * @param {string} entityId - The entity ID.
     * @returns {Array} Capability entries array.
     */
    getCapabilitiesForEntity(entityId) {
        return this.componentCapabilityController.getCapabilitiesForEntity(entityId);
    }

    /**
     * Re-evaluates all action capabilities for a specific entity.
     * @param {string} entityId - The entity ID.
     * @returns {Array} Updated capability entries.
     */
    reEvaluateEntityCapabilities(entityId) {
        const state = this.getAll();
        return this.componentCapabilityController.reEvaluateEntityCapabilities(state, entityId);
    }

    // =========================================================================
    // ROOM API WRAPPERS (for server.js access)
    // =========================================================================

    /**
     * Returns all rooms.
     * @returns {Object} All rooms data.
     */
    getRooms() {
        return this.roomsController.getAll();
    }

    /**
     * Returns the world graph with resolved room names for all connections.
     * @returns {Object} World graph structure.
     */
    getWorldGraph() {
        const rooms = this.roomsController.getAll();
        const builder = new WorldGraphBuilder(rooms);
        return builder.build();
    }

    // =========================================================================
    // ACTION SELECTION API WRAPPERS (for server.js access)
    // =========================================================================

    /**
     * Expires all stale component selections.
     * Should be called before executing any action.
     * @returns {void}
     */
    expireStaleSelections() {
        this.actionSelectController.expireStaleSelections();
    }

    /**
     * Locks multiple components to a specific action (batch selection).
     * @param {string} actionName - The action name.
     * @param {string} entityId - The entity ID.
     * @param {Array} components - Array of {componentId, role} objects.
     * @returns {Object} Selection result.
     */
    registerSelections(actionName, entityId, components) {
        return this.actionSelectController.registerSelections(actionName, entityId, components);
    }

    /**
     * Locks a single component to a specific action.
     * @param {string} actionName - The action name.
     * @param {string} componentId - The component ID.
     * @param {string} entityId - The entity ID.
     * @param {string} role - The component role.
     * @returns {Object} Selection result.
     */
    registerSelection(actionName, componentId, entityId, role) {
        return this.actionSelectController.registerSelection(actionName, componentId, entityId, role);
    }

    /**
     * Releases (unlocks) a component selection.
     * @param {string} componentId - The component ID to release (can be comp-* or eq-*).
     * @param {string} [entityId] - Optional entity ID for resolving equipment IDs.
     * @returns {boolean} Whether the selection was released.
     */
    releaseSelection(componentId, entityId) {
        return this.actionSelectController.releaseSelection(componentId, entityId);
    }

    /**
     * Returns all current component selections for an entity.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Locked components data.
     */
    getLockedComponents(entityId) {
        return this.actionSelectController.getLockedComponents(entityId);
    }

    // =========================================================================
    // INVENTORY PUBLIC API (for server.js access)
    // =========================================================================

    /**
     * Gets the item type definitions (registry).
     * Returns a defensive deep copy.
     * @returns {Object} Item definitions.
     */
    getItemRegistry() {
        return this.inventoryManager.getItemDefinitions();
    }

    /**
     * Gets inventory items for an entity grouped by host component.
     * Returns a defensive deep copy.
     * @param {string} entityId - The entity ID.
     * @returns {Object} Item data grouped by component.
     */
    getEntityItems(entityId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for inventory query.`);
            return {};
        }
        return this.inventoryManager.getEntityItems(entity);
    }

    /**
     * Adds an item to an entity's inventory, attached to a specific component.
     * All items must be associated with a component — there is no general/unassigned inventory.
     * @param {string} entityId - The entity ID.
     * @param {string} itemType - The item type identifier.
     * @param {string} componentId - The component ID to attach the item to (required).
     * @returns {{ success: boolean, message?: string, item?: Object }}
     */
    addItemToEntity(entityId, itemType, componentId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for item addition.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.inventoryManager.addItem(entity, itemType, componentId, {
            componentController: this.componentController
        });

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Removes an item from an entity's inventory.
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID to remove.
     * @returns {{ success: boolean, message?: string }}
     */
    removeItemFromEntity(entityId, itemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for item removal.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.inventoryManager.removeItem(entity, itemId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Moves an item to a different component within an entity.
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID to move.
     * @param {string} targetComponentId - The target component ID.
     * @returns {{ success: boolean, message?: string }}
     */
    moveItemInEntity(entityId, itemId, targetComponentId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for item move.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.inventoryManager.moveItem(entity, itemId, targetComponentId, {
            componentController: this.componentController
        });

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    // =========================================================================
    // BROADCAST SERVICE INJECTION
    // =========================================================================

    /**
     * Injects the broadcast service for stat-change-driven broadcasts.
     * Called from server.js after WorldStateController is fully initialized.
     * @param {WorldStateBroadcastService} broadcastService - The broadcast service instance.
     */
    setBroadcastService(broadcastService) {
        this._broadcastService = broadcastService;
    }

    /**
     * Triggers an initial broadcast of world state after the broadcast service is injected.
     * Called from server.js after setBroadcastService() to sync initial state (including spawn items) to clients.
     * @returns {void}
     */
    triggerInitialBroadcast() {
        if (this._broadcastService) {
            this._broadcastService.broadcast();
            Logger.info('[WorldStateController] Initial broadcast triggered after broadcast service injection.');
        } else {
            Logger.warn('[WorldStateController] Broadcast service not available for initial broadcast.');
        }
    }

    // =========================================================================
    // HOLDING COST PUBLIC API (for server.js access)
    // =========================================================================

    /**
     * Equips an item on a component (applies holding cost debuffs, triggers capability re-evaluation).
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID being equipped.
     * @param {string} itemType - The item type (e.g., "knife").
     * @param {string} componentId - The component ID to equip on.
     * @returns {{ success: boolean, message?: string, error?: string }}
     */
    equipItem(entityId, itemId, itemType, componentId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for equip.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.holdingCostController.equipItem(entityId, itemId, itemType, componentId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Unequips an item from its component (reverses debuffs, triggers capability re-evaluation).
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID being unequipped.
     * @returns {{ success: boolean, message?: string, error?: string }}
     */
    unequipItem(entityId, itemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for unequip.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.holdingCostController.unequipItem(entityId, itemId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Transfers an equipped item from one component to another (hand swap).
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID being transferred.
     * @param {string} itemType - The item type.
     * @param {string} fromComponentId - The source component ID.
     * @param {string} toComponentId - The target component ID.
     * @returns {{ success: boolean, message?: string, error?: string }}
     */
    transferEquip(entityId, itemId, itemType, fromComponentId, toComponentId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for equip transfer.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.holdingCostController.transferEquip(entityId, itemId, itemType, fromComponentId, toComponentId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Gets all equipped items for an entity.
     * @param {string} entityId - The entity ID.
     * @returns {Array<{ itemId: string, itemType: string, componentId: string }>}
     */
    getEquippedItems(entityId) {
        return this.holdingCostController.getEquippedItems(entityId);
    }

    /**
     * Gets all equipped items across all entities.
     * Used by the capability controller to scan all equipped items for action resolution.
     * @returns {Array<{ entityId: string, itemId: string, itemType: string, componentId: string }>}
     */
    getAllEquippedItems() {
        const allEquipped = this.holdingCostController.getEquippedItemsByEntity();
        if (!allEquipped || typeof allEquipped !== 'object') return [];
        const allItems = [];
        for (const [entityId, items] of Object.entries(allEquipped)) {
            for (const [eqId, item] of Object.entries(items)) {
                allItems.push({
                    entityId,
                    eqId,
                    itemId: item.itemId,
                    itemType: item.itemType,
                    componentId: item.componentId
                });
            }
        }
        return allItems;
    }

    // =========================================================================
    // TYPED ID MIGRATION: GET EQUIPPED ITEM PUBLIC METHODS
    // =========================================================================

    /**
     * Gets a specific equipped item by its typed equipped-item ID.
     * TYPED ID MIGRATION: Uses eq- prefixed IDs (e.g., "eq-uuid") for equipped items.
     * @param {string} entityId - The entity ID.
     * @param {string} eqId - The typed equipped-item ID (must start with "eq-").
     * @returns {Object|null} The equipped item data object, or null if not found/invalid.
     */
    getEquippedItem(entityId, eqId) {
        // TYPED ID MIGRATION: Validate that eqId has the proper "eq-" prefix
        if (!this._validateEquippedId(eqId)) {
            Logger.warn(`[WorldStateController] Invalid equipped-item ID: "${eqId}" — must start with "eq-"`);
            return null;
        }

        const allEquipped = this.holdingCostController.getEquippedItemsByEntity();
        if (!allEquipped || typeof allEquipped !== 'object') return null;

        const entityItems = allEquipped[entityId];
        if (!entityItems || typeof entityItems !== 'object') return null;

        const item = entityItems[eqId];
        return item ? { ...item } : null;
    }

    /**
     * Gets a specific equipped item by its item ID (not typed eqId).
     * TYPED ID MIGRATION: Internal use only — prefers eqId for lookups.
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID to find.
     * @returns {Object|null} The equipped item data object, or null if not found.
     */
    getEquippedItemByItemId(entityId, itemId) {
        const allEquipped = this.holdingCostController.getEquippedItemsByEntity();
        if (!allEquipped || typeof allEquipped !== 'object') return null;

        const entityItems = allEquipped[entityId];
        if (!entityItems || typeof entityItems !== 'object') return null;

        for (const [eqId, item] of Object.entries(entityItems)) {
            if (item.itemId === itemId) {
                return { ...item };
            }
        }

        return null;
    }

    /**
     * Gets an equipped item for a specific component.
     * TYPED ID MIGRATION: Returns equipped item data keyed by eqId for the given component.
     * @param {string} entityId - The entity ID.
     * @param {string} componentId - The component ID to check.
     * @returns {Object|null} The equipped item data, or null if no item is equipped on this component.
     */
    getEquippedItemForComponent(entityId, componentId) {
        const allEquipped = this.holdingCostController.getEquippedItemsByEntity();
        if (!allEquipped || typeof allEquipped !== 'object') return null;

        const entityItems = allEquipped[entityId];
        if (!entityItems || typeof entityItems !== 'object') return null;

        for (const [eqId, item] of Object.entries(entityItems)) {
            if (item.componentId === componentId) {
                return { ...item };
            }
        }

        return null;
    }

    /**
     * Validates that an equipped-item ID has the proper "eq-" prefix.
     * TYPED ID MIGRATION: Internal validation helper for typed ID enforcement.
     * @param {string} eqId - The equipped-item ID to validate.
     * @returns {boolean} True if the ID has the proper "eq-" prefix.
     * @private
     */
    _validateEquippedId(eqId) {
        return IdResolver.isEquippedId(eqId);
    }

    /**
     * Gets the holding cost definitions registry.
     * @returns {Object} Holding cost definitions.
     */
    getHoldingCostRegistry() {
        return this.holdingCostController.getHoldingCostRegistry();
    }

    // =========================================================================
    // DROPPED ITEMS PUBLIC API
    // =========================================================================

    /**
     * Gets all dropped items in the world.
     * Returns a defensive deep copy to prevent external mutation.
     * @returns {Object<string, {id: string, itemType: string, itemId: string, x: number, y: number, ownerId: string}>} Dropped items map.
     */
    getDroppedItems() {
        // Initialize if not yet created
        if (!this._droppedItems) {
            this._droppedItems = {};
        }
        return structuredClone(this._droppedItems);
    }

    /**
     * Gets dropped items filtered by room ID.
     * Returns a defensive deep copy to prevent external mutation.
     * @param {string} roomId - The room ID to filter by.
     * @returns {Object<string, Object>} Dropped items map filtered by room.
     */
    getDroppedItemsByRoom(roomId) {
        if (!this._droppedItems) {
            return {};
        }
        const filtered = {};
        for (const [id, item] of Object.entries(this._droppedItems)) {
            if (item.roomId === roomId) {
                filtered[id] = item;
            }
        }
        return structuredClone(filtered);
    }

    /**
     * Sets all dropped items in the world.
     * @param {Object} droppedItems - The dropped items map.
     * @returns {void}
     */
    setDroppedItems(droppedItems) {
        this._droppedItems = droppedItems;

        if (this._broadcastService) {
            this._broadcastService.broadcast();
        }
    }

    /**
     * Removes a dropped item from the world.
     * @param {string} droppedItemId - The dropped item ID.
     * @returns {{ success: boolean, message?: string }}
     */
    removeDroppedItem(droppedItemId) {
        const droppedItems = this.getDroppedItems();
        if (!droppedItems[droppedItemId]) {
            Logger.warn(`[WorldStateController] Dropped item "${droppedItemId}" not found.`);
            return { success: false, message: `Dropped item "${droppedItemId}" not found.` };
        }

        delete droppedItems[droppedItemId];
        this.setDroppedItems(droppedItems);

        Logger.info(`[WorldStateController] Removed dropped item "${droppedItemId}".`);
        return { success: true };
    }

    /**
     * Picks up a dropped item from the map and adds it to an entity's inventory component.
     * This is the public API for the pick-up-item operation, delegating to the consequence handler system.
     *
     * @param {string} entityId - The entity picking up the item.
     * @param {string} droppedItemId - The ID of the dropped item on the map.
     * @param {string} componentId - The component ID to attach the item to.
     * @returns {{ success: boolean, message?: string, pickedUpItem?: object }}
     */
    executePickUpItem(entityId, droppedItemId, componentId) {
        // Delegate to the ConsequenceHandlers public dispatch() API (BUG-122:
        // no more 3-layer deep access through consequenceHandlers.handlers.pickUpItem).
        const result = this.actionController?.consequenceHandlers?.dispatch('pickUpItem', null, { entityId, droppedItemId, componentId }, { entityId });

        if (!result) {
            Logger.error('[WorldStateController] ConsequenceHandlers dispatch unavailable for pickUpItem.');
            return { success: false, message: 'PickUpItem handler not available.' };
        }

        return result;
    }

    /**
     * Retrieves a component by its instance ID, searching across all active entities.
     * Returns a defensive copy to prevent external mutation of internal state.
     *
     * @param {string} componentId - The component instance ID.
     * @returns {Object|null} The component object with `id`, `type`, and `entityId` fields, or null if not found.
     */
    getComponent(componentId) {
        const allEntities = this.stateEntityController.getAll();
        for (const [, entity] of Object.entries(allEntities)) {
            if (Array.isArray(entity.components)) {
                const component = entity.components.find(c => c.id === componentId);
                if (component) {
                    return { ...component, entityId: entity.id };
                }
            }
        }
        return null;
    }

    /**
     * Gets a specific item instance by ID from an entity's inventory.
     * Returns a defensive deep copy.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID to find.
     * @returns {Object|null} Deep clone of the item, or null if not found.
     */
    getItem(entityId, itemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) return null;
        return this.inventoryManager.getItem(entity, itemId);
    }

    // =========================================================================
    // NESTED INVENTORY PUBLIC API
    // =========================================================================

    /**
     * Adds an item to a container item within an entity's inventory.
     * @param {string} entityId - The entity ID.
     * @param {string} containerItemId - The container item ID.
     * @param {string} itemType - The item type to add.
     * @returns {{ success: boolean, message?: string, item?: Object }}
     */
    addItemToContainer(entityId, containerItemId, itemType) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for container add.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.inventoryManager.addItemToContainer(entity, containerItemId, itemType);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Removes an item from a container item within an entity's inventory.
     * @param {string} entityId - The entity ID.
     * @param {string} containerItemId - The container item ID.
     * @param {string} itemId - The item ID to remove.
     * @returns {{ success: boolean, message?: string }}
     */
    removeItemFromContainer(entityId, containerItemId, itemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for container remove.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.inventoryManager.removeItemFromContainer(entity, containerItemId, itemId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Moves an item from component level (or another container) into a container.
     * @param {string} entityId - The entity ID.
     * @param {string} containerItemId - The container item ID.
     * @param {string} itemId - The item ID to move into container.
     * @returns {{ success: boolean, message?: string }}
     */
    moveItemIntoContainer(entityId, containerItemId, itemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for container move-in.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.inventoryManager.moveItemIntoContainer(entity, containerItemId, itemId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Moves an item out of a container back to the component level.
     * @param {string} entityId - The entity ID.
     * @param {string} containerItemId - The container item ID.
     * @param {string} itemId - The item ID to move out of container.
     * @param {string} targetComponentId - The component to attach the item to.
     * @returns {{ success: boolean, message?: string }}
     */
    moveItemOutOfContainer(entityId, containerItemId, itemId, targetComponentId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for container move-out.`);
            return { success: false, message: `Entity "${entityId}" not found.` };
        }

        const result = this.inventoryManager.moveItemOutOfContainer(entity, containerItemId, itemId, targetComponentId);

        if (result.success && this._broadcastService) {
            this._broadcastService.broadcast();
        }

        return result;
    }

    /**
     * Gets direct children of a container item.
     * @param {string} entityId - The entity ID.
     * @param {string} containerItemId - The container item ID.
     * @returns {Array} Array of contained item instances.
     */
    getContainerItems(entityId, containerItemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[WorldStateController] Entity "${entityId}" not found for container items query.`);
            return [];
        }
        return this.inventoryManager.getContainerItems(entity, containerItemId);
    }

    // =========================================================================
    // ITEM STATS — COMPUTED STATS FOR A SPECIFIC ITEM
    // =========================================================================

    /**
     * Computes the full stats for a single item instance, combining:
     * - Base traits from inventoryItems.json (always shown)
     * - Dynamic equipped item stats (sharpness, durability current — shown when equipped)
     * - Holding cost requirements (shown when equipped, informational only)
     *
     * Note: Holding cost debuffs are applied to the COMPONENT's stats, not the item's.
     * They are shown as informational metadata, not subtracted from item stats.
     *
     * @param {string} entityId - The entity ID.
     * @param {string} itemId - The item ID.
     * @returns {Object|null} The combined stats object, or null if item not found.
     */
    getItemStats(entityId, itemId) {
        const entity = this.stateEntityController.getEntity(entityId);
        if (!entity) return null;

        const item = this.inventoryManager.getItem(entity, itemId);
        if (!item) return null;

        // 1. Build base stats from item traits (always present)
        const baseStats = {};
        const traitCategories = {}; // Track which trait categories have stats
        if (item.traits && typeof item.traits === 'object') {
            for (const [traitCategory, traitData] of Object.entries(item.traits)) {
                if (typeof traitData === 'object' && traitData !== null && !Array.isArray(traitData)) {
                    traitCategories[traitCategory] = true;
                    for (const [statName, statValue] of Object.entries(traitData)) {
                        if (typeof statValue === 'number') {
                            baseStats[statName] = statValue;
                        }
                    }
                }
            }
        }

        // 2. Check if equipped and get dynamic stats
        const isEquipped = this.holdingCostController.isItemEquipped(entityId, itemId);
        const dynamicStats = {};
        const dynamicStatCategories = {};

        if (isEquipped && this.equippedItemStats) {
            // FIX: Get eqId from itemId to properly look up equipped item stats
            const equippedItem = this.getEquippedItemByItemId(entityId, itemId);
            if (equippedItem && equippedItem.eqId) {
                const eqStats = this.equippedItemStats.getStats(equippedItem.eqId);
                if (eqStats) {
                    for (const [traitCategory, traitData] of Object.entries(eqStats)) {
                        if (typeof traitData === 'object' && traitData !== null && !Array.isArray(traitData)) {
                            dynamicStatCategories[traitCategory] = true;
                            for (const [statName, statValue] of Object.entries(traitData)) {
                                dynamicStats[statName] = statValue;
                            }
                        }
                    }
                }
            }
        }

        // 3. Get holding cost requirements if equipped (informational, NOT applied to item stats)
        const holdingCostRequirements = [];
        if (isEquipped) {
            const holdingCostDef = this.holdingCostController.getHoldingCostDefinition(item.type);
            if (holdingCostDef && holdingCostDef.holdingCost) {
                for (const costEntry of holdingCostDef.holdingCost) {
                    holdingCostRequirements.push({
                        trait: costEntry.trait,
                        stat: costEntry.stat,
                        value: costEntry.value
                    });
                }
            }
        }

        // 4. Build final result with metadata and separated sections
        const result = {
            _itemId: item.id,
            _type: item.type,
            _name: item.name || item.type,
            _isEquipped: isEquipped,
            _volume: item.volume,
            _baseStats: baseStats,
            _traitCategories: traitCategories
        };

        // Add dynamic stats when equipped
        if (isEquipped && Object.keys(dynamicStats).length > 0) {
            result._dynamicStats = dynamicStats;
            result._dynamicStatCategories = dynamicStatCategories;
        }

        // Add holding cost requirements when equipped
        if (isEquipped && holdingCostRequirements.length > 0) {
            result._holdingCostRequirements = holdingCostRequirements;
        }

        // Also flatten for easy display: base + dynamic merged
        const displayStats = { ...baseStats };
        for (const [statName, statValue] of Object.entries(dynamicStats)) {
            displayStats[statName] = statValue;
        }
        Object.assign(result, displayStats);

        return result;
    }

    /**
     * Finds all dropped items near a spatial coordinate.
     * @param {number} x - The X coordinate.
     * @param {number} y - The Y coordinate.
     * @param {number} radius - Search radius.
     * @returns {Array<{id: string, itemType: string, itemId: string, x: number, y: number, ownerId: string, distance: number}>}
     */
    findDroppedItemsNear(x, y, radius = 5) {
        const droppedItems = this.getDroppedItems();
        const nearby = [];

        for (const [id, item] of Object.entries(droppedItems)) {
            const dx = item.x - x;
            const dy = item.y - y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance <= radius) {
                nearby.push({ ...item, distance: Math.round(distance * 100) / 100 });
            }
        }

        return nearby;
    }

}

export default WorldStateController;