/**
 * PersistenceLogic — FASE 7 (facade logic extraction — phase 2).
 *
 * The world-state persistence codec: `serialize()` captures the complete
 * mutable world state into a JSON-serializable snapshot; `restore()`
 * validates a snapshot and injects it into every state-owning sub-controller
 * (option (a) — per-sub-controller state injection, documented in
 * `restore()`'s JSDoc below).
 *
 * `PERSISTENCE_SCHEMA_VERSION` is the single source of truth for the
 * snapshot schema version; the facade re-exports it via its static getter
 * so the long-standing `WorldStateController.PERSISTENCE_SCHEMA_VERSION`
 * reference (routes/tests) keeps working.
 *
 * Extracted verbatim from WorldStateController (changes: `this.` became
 * `facade.`; the `WorldStateController.PERSISTENCE_SCHEMA_VERSION` static
 * reference became the module-level constant below). The facade keeps a
 * thin delegator method per extracted method so instance-level spies/mocks
 * and direct calls keep working. Narrow-deps rule (mirrors
 * consequences/DropItemHandler.js): `facade` is the WorldStateController
 * instance and each function only uses the members named in its JSDoc.
 */

import Logger from '../../utils/Logger.js';
import { DEFAULT_TURNS_SNAPSHOT } from '../core/TurnSystemController.js';

/**
 * Snapshot schema version. Bump when the snapshot format changes;
 * restore() rejects any other version with SCHEMA_VERSION_MISMATCH.
 *
 * v2 (Feature B): snapshot gains the "events" section (world event
 * ring buffer). v3 (two-phase barrier turns): the "turns" section
 * gains the "barrier" sub-state (roster, signaled, close info) plus
 * the stored phase. v1/v2 snapshots are rejected by restore() — the
 * strict versioning contract is documented in the persistence tests.
 */
const PERSISTENCE_SCHEMA_VERSION = 3;

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
 *                        (mutable sharpness/existence per eqId)
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
 *     rooms, droppedItems, selections, events, turns, roomChat } }
 */
function serialize(facade) {
    const snapshot = {
        schemaVersion: PERSISTENCE_SCHEMA_VERSION,
        serializedAtTick: facade.internalComponentController?.tickSystem?.currentTick ?? null,
        serializedAt: Date.now(),
        state: {
            // Entities (live instances; the spread in .map() creates new objects,
            // and the final JSON round-trip at the method bottom guarantees no
            // live references — so the intermediate structuredClone is redundant).
            // Defense-in-depth: strip the legacy boot-time flag
            // `_skipInitialSpawns` from any entity record so the snapshot
            // can never carry it (new spawns no longer inject it, but
            // records restored from older snapshots might).
            entities: Object.fromEntries(
                Object.entries(facade.stateEntityController.getAll())
                    .map(([entityId, entity]) => [entityId, {
                        ...entity,
                        _skipInitialSpawns: undefined
                    }])
            ),
            // Component instance stats (full merged stats per comp-* id)
            components: facade.componentController.statsController.getAll(),
            // InventoryManager's per-entity item index
            inventory: structuredClone(facade.inventoryManager._inventory),
            // Equipped items + pre-equip stat bookkeeping (undo data)
            equipped: structuredClone(facade.holdingCostController._equippedItems),
            preEquipStats: structuredClone(facade.holdingCostController._preEquipStats),
            // Mutable per-equipped-item stats (sharpness, existence, ...)
            equippedItemStats: facade.equippedItemStats.getAll(),
            // Canonical internal-component store
            internalComponents: structuredClone(facade.internalComponentController.internalComponents),
            // Dynamic room state only (structure comes from data/rooms.json)
            rooms: facade.roomsController.getAll(),
            // Dropped items on the map
            droppedItems: facade.getDroppedItems(),
            // Active component→action selection locks (Map serialized to array)
            selections: [...facade.actionSelectController._selectionRegistry.entries()],
            // World event ring buffer (Feature B, schema v2)
            events: facade.worldEventLogController.serialize(),
            // Turn system bookkeeping (Feature A, schema v3).
            // { roundNumber, phase, queues, resolvedRound, lastRound, barrier }
            // Fallback when no turn system is injected: DEFAULT_TURNS_SNAPSHOT
            // — the single shared definition (also used by _reset()), so the
            // fallback can never drift from the real serialize() shape.
            turns: facade.turnSystemController?.serialize() ?? DEFAULT_TURNS_SNAPSHOT,
            // Room chat store (Feature D backend, schema v2 — additive).
            // { [roomId]: [ { id, roomId, speakerName, speakerEntityId, text, tick, ts } ] }
            roomChat: facade.roomChatController?.serialize() ?? {}
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
function restore(facade, payload) {
    // --- Validation -----------------------------------------------------
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return {
            success: false,
            error: { code: 'INVALID_PAYLOAD', message: 'restore() requires a snapshot object (result of serialize()).' }
        };
    }
    if (payload.schemaVersion !== PERSISTENCE_SCHEMA_VERSION) {
        return {
            success: false,
            error: {
                code: 'SCHEMA_VERSION_MISMATCH',
                message: `Unsupported schemaVersion ${JSON.stringify(payload.schemaVersion)} — expected ${PERSISTENCE_SCHEMA_VERSION}.`
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
    for (const key of ['entities', 'components', 'inventory', 'equipped', 'preEquipStats', 'equippedItemStats', 'internalComponents', 'rooms', 'droppedItems', 'selections', 'events']) {
        if (!(key in s)) {
            return {
                success: false,
                error: { code: 'INVALID_PAYLOAD', message: `Snapshot "state" is missing required section "${key}".` }
            };
        }
    }
    // NOTE: "turns" (Feature A) and "roomChat" (Feature D) are intentionally
    // OMITTED from the required list above — a well-formed v3 snapshot may
    // lack either section (the turn bookkeeping simply resumes idle; the
    // phase is stored state, so an absent section means round 0 starts
    // lazily on the next onTick(); chat is ephemeral memory). Versioning
    // is strict at schema v3: the schemaVersion check above rejects every
    // other version outright.

    try {
        // 1. Canonical internal-component store FIRST — the entity
        //    mirror re-sync in step 2 reads from this store, so the
        //    restored values must be in place before entities are restored.
        facade.internalComponentController.internalComponents = structuredClone(s.internalComponents);

        // 2. Entities (re-syncs each entity's internalComponents mirror
        //    from the canonical store above — see stateEntityController).
        //    Legacy snapshots may still carry the boot-time
        //    `_skipInitialSpawns` flag on NPC records — strip it (it is
        //    never persisted by serialize() anymore); the opt-out of the
        //    declarative spawns keys off the persisted isNPC field.
        const restoredEntities = structuredClone(s.entities);
        for (const entity of Object.values(restoredEntities)) {
            delete entity._skipInitialSpawns;
        }
        facade.stateEntityController._restoreFromSnapshot(restoredEntities);

        // 3. Component instance stats (plain store replacement)
        facade.componentController.statsController.componentStats = structuredClone(s.components);

        // 4. InventoryManager item index (entity.items already restored
        //    with the entities above; this re-syncs the manager's index).
        //    Re-derive material traits for old-format snapshots that lack them.
        facade.inventoryManager._inventory = structuredClone(s.inventory);
        facade.inventoryManager.resyncItemTraits();

        // 5. Equipped items + pre-equip undo bookkeeping
        facade.holdingCostController._equippedItems = structuredClone(s.equipped);
        facade.holdingCostController._preEquipStats = structuredClone(s.preEquipStats);

        // 6. Mutable per-equipped-item stats
        facade.equippedItemStats._itemStats = structuredClone(s.equippedItemStats);

        // 7. Dynamic room state (replace entries; keep constructor-built
        //    structure: idMap + doorPositions come from data/rooms.json)
        const restoredRooms = structuredClone(s.rooms);
        for (const roomId of Object.keys(facade.roomsController.rooms)) {
            delete facade.roomsController.rooms[roomId];
        }
        for (const [roomId, room] of Object.entries(restoredRooms)) {
            facade.roomsController.rooms[roomId] = room;
        }

        // (World objects are ordinary entities now — isStatic entities
        //  restored in the entities step carry their own room/spatial, so
        //  no separate re-sync is required.)

        // 8. Dropped items
        facade._droppedItems = structuredClone(s.droppedItems);

        // 9. Selection locks (array → Map)
        const registry = new Map();
        for (const [componentId, selection] of (Array.isArray(s.selections) ? s.selections : [])) {
            if (typeof componentId === 'string' && selection && typeof selection === 'object') {
                registry.set(componentId, { ...selection });
            }
        }
        facade.actionSelectController._selectionRegistry = registry;

        // 10. World event ring buffer (Feature B)
        facade.worldEventLogController.restore(structuredClone(s.events));

        // 10b. Turn system bookkeeping (Feature A — optional section)
        if (s.turns && typeof s.turns === 'object') {
            facade.turnSystemController?.restore(structuredClone(s.turns));
        }

        // 10c. Room chat store (Feature D backend — optional section:
        //     early v2 snapshots predate it and are still accepted; chat
        //     is ephemeral memory, its absence simply means "empty")
        if (s.roomChat && typeof s.roomChat === 'object') {
            facade.roomChatController?.restore(structuredClone(s.roomChat));
        }

        // 11. Rebuild derived caches via existing public APIs
        facade.actionController.scanAllCapabilities(facade.getAll());
        if (facade.synergyController?.clearCache) {
            facade.synergyController.clearCache();
        }

        Logger.info(
            `[WorldStateController] World state restored from snapshot (schemaVersion ${PERSISTENCE_SCHEMA_VERSION}, ` +
            `${Object.keys(facade.stateEntityController.getAll()).length} entities, ${Object.keys(facade._droppedItems).length} dropped items).`
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

export { PERSISTENCE_SCHEMA_VERSION, serialize, restore };
