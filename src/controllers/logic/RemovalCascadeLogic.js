/**
 * RemovalCascadeLogic — FASE 6 (facade logic extraction).
 *
 * The component:broke removal funnel: (a) spill content to the floor
 * (batched writeDroppedItem + disk sampling), (a½) dependency cascade
 * (pre-order DFS with shared visited-set, forced breaks re-enter the funnel),
 * (b) unequip + remove the instance, (c) cleanup (stats, internal components,
 * capability re-evaluation, selections, orphaned equipped items) — then the
 * root-exit entity elimination check. Re-entrancy state (counter, visited set,
 * affected-entity set) lives on the facade instance so the whole chain
 * shares it. Also the energy-death path: spill everything an entity carries
 * before despawn (nothing is carried past death).
 *
 * Extracted verbatim from WorldStateController (only change: `this.` became
 * `facade.` and the methods became plain functions). Cross-cluster calls keep
 * going through the facade instance (facade._spillContent, facade.despawnEntity,
 * ...) so instance-level spies/mocks (vi.spyOn in
 * test/unit/WorldStateController.entityElimination.test.js) still intercept
 * them. The facade keeps a thin delegator method per extracted method.
 * Narrow-deps rule (mirrors consequences/DropItemHandler.js): `facade` is the
 * WorldStateController instance and each function only uses the members named
 * in its JSDoc.
 */

import Logger from '../../utils/Logger.js';
import { buildReverseIndex } from '../../utils/ComponentDependents.js';
import { sampleDiskPoint, DEFAULT_TRIGGER_RADIUS } from '../../utils/DiskSampler.js';
import { writeDroppedItem } from '../consequences/DropItemHandler.js';
import { TRAIT_GROUPS, STAT_NAMES, EXISTENCE_GONE_AT } from '../../../shared/StatVocabulary.js';

/**
 * Facade orchestrator for complete broken component/item removal.
 * Order (a)→(a½)→(b)→(c).
 * Re-entrancy counter for single broadcast.
 *
 * @param {Object} payload - Payload of the component:broke event.
 */


function removeBrokenComponentCascade(facade, payload) {
    const { entityId, componentId, kind } = payload;

    // Increment re-entrancy counter
    facade._cascadeReentrancyCount++;
    // Initialize shared visited-set + affected-entity set at root call
    if (facade._cascadeReentrancyCount === 1) {
        facade._cascadeVisitedSet = new Set();
        facade._cascadeAffectedEntityIds = new Set();
    }
    // Track every entity touched by this cascade chain (root or re-entry) so
    // the root-exit elimination check covers all affected entities, not just
    // the outermost call's entity (cross-entity cascade robustness — M3).
    facade._cascadeAffectedEntityIds.add(entityId);
    try {
        // Look up the entity
        const entity = facade.stateEntityController.getEntity(entityId);
        if (!entity) {
            Logger.warn(`[removeBrokenComponent] Entity "${entityId}" not found — skipping removal.`);
            return;
        }

        // === (a) Spill: drain content from component/container ===
        try {
            facade._spillContent(entity, payload);
        } catch (error) {
            Logger.error(`[removeBrokenComponent] Phase (a) _spillContent failed for component ${componentId} of entity ${entityId}: ${error.message}`, { payload });
            // Continue to next phase — a failed spill must not block removal or cleanup
        }

        // === (a½) Dependency cascade ===
        if (kind === 'component') {
            try {
                facade._cascadeDependents(entity, componentId);
            } catch (error) {
                Logger.error(`[removeBrokenComponent] Phase (a½) _cascadeDependents failed for component ${componentId} of entity ${entityId}: ${error.message}`, { payload });
                // Continue to next phase — a failed cascade must not block removal or cleanup
            }
        }

        // === (b) Desequip + remove instance — UNGUARDED (primary path) ===
        facade._removeComponentOrItem(entity, payload);

        // === (c) Cleanup ===
        try {
            facade._cleanupAfterRemoval(entity, payload);
        } catch (error) {
            Logger.error(`[removeBrokenComponent] Phase (c) _cleanupAfterRemoval failed for component ${componentId} of entity ${entityId}: ${error.message}`, { payload });
            // Continue — cleanup failure must not block the result
        }
    } finally {
        // Decrement counter — broadcast only occurs when it reaches 0
        facade._cascadeReentrancyCount--;
        // Clear visited-set + affected-entity set on exit from root chain
        if (facade._cascadeReentrancyCount === 0) {
            // Entity-level elimination: after the full root cascade
            // completes (re-entrancy count returns to 0), check every entity
            // affected during this cascade chain. This handles cross-entity
            // cascades where a break on entity A forces a break on entity B.
            const affectedIds = facade._cascadeAffectedEntityIds;
            if (affectedIds && affectedIds.size > 1) {
                Logger.warn(`[removeBrokenComponent] Cross-entity cascade detected — affected entities: [${[...affectedIds].join(', ')}]. Each entity will receive the elimination check.`);
            }
            for (const affectedId of affectedIds) {
                facade._maybeEliminateEntity(affectedId);
            }
            facade._cascadeVisitedSet = null;
            facade._cascadeAffectedEntityIds = null;
        }
    }
}

/**
 * Phase (a): spill of content from destroyed component/container.
 * @private
 */


function spillContent(facade, entity, payload) {
    const { componentId, kind, position, roomId, entityId } = payload;
    let hostId = componentId;
    if (kind === 'equipped-item') {
        // For equipped items, the host is the itemId from the payload (container)
        hostId = payload.itemId || componentId;
    }

    // Get items stored in the destroyed host
    const inventory = facade.inventoryManager.getEntityItems(entity);
    const items = inventory[hostId] || [];

    if (items.length === 0) return;

    // Fetch item registry for definitions
    const itemRegistry = facade.getItemRegistry();

    // PHASE 9: batch — accumulate items in local map and write once (avoids read-modify-write O(n))
    const batchDroppedItems = facade.getDroppedItems() || {};

    for (const item of items) {
        // Item isolation (failure logged + continues)
        try {
            // Snapshot of grandchildren — use public wrapper
            let nestedItems = [];
            try {
                nestedItems = facade.inventoryManager.collectNestedItems(entity, item.id);
            } catch (error) {
                Logger.error(`[removeBrokenComponent] Error collecting nested items for ${item.id}: ${error.message}`);
            }

            // Disk sampling with radius DEFAULT_TRIGGER_RADIUS, center position, no clamp
            // No-magic-numbers rule: use shared constant from DiskSampler for spill radius
            // Defensively skip null results (should never happen with DEFAULT_TRIGGER_RADIUS=5)
            const point = sampleDiskPoint(position.x, position.y, DEFAULT_TRIGGER_RADIUS);
            if (point === null) {
                Logger.warn(`[removeBrokenComponent] sampleDiskPoint returned null for item ${item.id}; skipping spill.`);
                continue;
            }

            // Look up item definition (use passed itemDef to avoid re-fetch)
            const itemDef = itemRegistry[item.type] || itemRegistry[item.itemType] || {};

            // Accumulate in local batch map
            // writeDroppedItem receives a narrow-deps stub (not the full facade), implementing only:
            //   getDroppedItems()  → returns the dropped-items map
            //   setDroppedItems(items) → merges `items` into the map via Object.assign (batch accumulation)
            // The handler must not assume other WorldStateController methods exist on this dependency.
            writeDroppedItem(
                {
                    getDroppedItems: () => batchDroppedItems,
                    setDroppedItems: (items) => { Object.assign(batchDroppedItems, items); }
                },
                item.type || item.itemType,
                point.x,
                point.y,
                roomId,
                entityId,
                itemDef,
                nestedItems
            );

            Logger.info(`[removeBrokenComponent] Spilled item ${item.id} (${item.type}) from broken ${kind}.`);
        } catch (error) {
            Logger.error(`[removeBrokenComponent] Error spilling item ${item.id}: ${error.message}`);
            // Skip this item, continue with cascade (isolation per item)
        }
    }

    // Write once at the end (batch write)
    facade.setDroppedItems(batchDroppedItems);

    // Remove all items from entity inventory — isolation per item
    for (const item of items) {
        try {
            facade.inventoryManager.removeItem(entity, item.id);
        } catch (error) {
            Logger.error(`[removeBrokenComponent] Error removing item ${item.id} from inventory: ${error.message}`);
        }
    }
}

/**
 * Phase (a½): dependency cascade (visited-set prevents loops).
 * Pre-order DFS with visited-set.
 * @private
 */


function cascadeDependents(facade, entity, originId) {
    const components = entity.components || [];
    const reverseIndex = buildReverseIndex(components);
    // Use shared visited-set across recursive cascade (visited-set prevents loops)
    const visited = facade._cascadeVisitedSet || new Set([originId]);
    const queue = [originId];

    Logger.debug(`[removeBrokenComponent] _cascadeDependents starting for origin ${originId}, components count: ${components.length}`);
    
    // Log reverse index for debugging (trace → debug)
    for (const [parentId, children] of reverseIndex) {
        if (children.length > 0) {
            Logger.debug(`[removeBrokenComponent] Reverse index: ${parentId} → [${children.join(', ')}]`);
        }
    }

    while (queue.length > 0) {
        const curId = queue.shift();
        Logger.info(`[removeBrokenComponent] Processing from queue: ${curId}`);
        
        // origin is skipped (already broke — it was the event that started the cascade)
        if (curId === originId) {
            // Add origin's children to queue to continue cascade
            const children = reverseIndex.get(curId) || [];
            Logger.info(`[removeBrokenComponent] Origin ${originId} has ${children.length} children: [${children.join(', ')}]`);
            for (const childId of children) {
                if (!visited.has(childId)) {
                    visited.add(childId);
                    queue.push(childId);
                    Logger.info(`[removeBrokenComponent] Enqueued child ${childId}`);
                } else {
                    Logger.info(`[removeBrokenComponent] Child ${childId} already visited, skipping`);
                }
            }
            continue;
        }

        // Liveness on pop: id already removed?
        const comp = components.find(c => c.id === curId);
        if (!comp) {
            Logger.warn(`[removeBrokenComponent] Component ${curId} not found in entity.components (may have been removed)`);
            continue;
        }

        // Check if it still has existence stats
        const stats = facade.statsController.getStats(curId);
        if (!stats || !stats[TRAIT_GROUPS.PHYSICAL] || stats[TRAIT_GROUPS.PHYSICAL][STAT_NAMES.EXISTENCE] === undefined) {
            Logger.warn(`[removeBrokenComponent] Dependent ${curId} has no existence stat — skipping.`);
            continue;
        }

        const dur = stats[TRAIT_GROUPS.PHYSICAL][STAT_NAMES.EXISTENCE];
        Logger.info(`[removeBrokenComponent] Component ${curId} has existence ${dur}`);

        if (dur <= EXISTENCE_GONE_AT) {
            // Defensive — direct removal WITHOUT event (already broken)
            Logger.warn(`[removeBrokenComponent] Dependent ${curId} already broken (dur=${dur}) — direct removal without event.`);
            facade._forceDirectRemoval(curId, entity);
            continue;
        }

        // Force break: write 0 to existing mutator → re-enters the funnel
        Logger.info(`[removeBrokenComponent] Forcing break of dependent ${curId} (dur=${dur} → 0).`);
        facade.componentController.updateComponentStat(curId, TRAIT_GROUPS.PHYSICAL, STAT_NAMES.EXISTENCE, EXISTENCE_GONE_AT);
        
        // Add this dependent's children to queue to continue cascade
        const children = reverseIndex.get(curId) || [];
        Logger.info(`[removeBrokenComponent] Dependent ${curId} has ${children.length} children: [${children.join(', ')}]`);
        for (const childId of children) {
            if (!visited.has(childId)) {
                visited.add(childId);
                queue.push(childId);
                Logger.info(`[removeBrokenComponent] Enqueued child ${childId}`);
            } else {
                Logger.info(`[removeBrokenComponent] Child ${childId} already visited, skipping`);
            }
        }
    }
    
    Logger.info(`[removeBrokenComponent] _cascadeDependents finished. Visited: [${[...visited].join(', ')}]`);
}

/**
 * Direct removal WITHOUT event (for dependents already ≤ 0).
 * @private
 */


function forceDirectRemoval(facade, compId, entity) {
    try {
        // Spill content
        facade._spillContent(entity, { componentId: compId, kind: 'component', position: entity.spatial, roomId: entity.location });
        // Unequip + remove
        const payload = { componentId: compId, kind: 'component', entityId: entity.id };
        facade._removeComponentOrItem(entity, payload);
        // Cleanup
        facade._cleanupAfterRemoval(entity, payload);
    } catch (error) {
        Logger.error(`[removeBrokenComponent] Error in _forceDirectRemoval for ${compId}: ${error.message}`);
    }
}

/**
 * Entity-level elimination check.
 *
 * Re-reads the live entity via the public API and, if its component array
 * is missing or empty, despawns it to prevent a "ghost" record from
 * lingering in world state. This is the single choke-point where an
 * entity is truly removed after a damage cascade strips all its components.
 *
 * Why isolated in try/catch (L3): a throw here must not poison the whole
 * cascade chain or mask the real phase in handler-level logs. If despawn
 * fails, the entity may remain (logged, not silent) but the cascade
 * completes — graceful degradation.
 *
 * Re-entrancy invariant: this method is called ONLY from the root-exit
 * finally block of removeBrokenComponent (when _cascadeReentrancyCount
 * returns to 0), so it never re-enters the cascade funnel.
 *
 * @private
 * @param {string} entityId - The entity to check for elimination.
 */


function maybeEliminateEntity(facade, entityId) {
    try {
        const liveEntity = facade.stateEntityController.getEntity(entityId);
        if (liveEntity && (!liveEntity.components || liveEntity.components.length === 0)) {
            Logger.info(`[removeBrokenComponent] Entity ${entityId} has zero components after cascade — despawning (entity elimination).`);
            facade.despawnEntity(entityId);
        }
    } catch (error) {
        Logger.error(`[removeBrokenComponent] entity elimination failed for ${entityId}: ${error.message}`, { entityId });
        // Do NOT re-throw: a despawn failure must not abort the cascade
        // unwind or mask the original break event in handler-level logs.
        // The entity may remain in world state (logged above) — the
        // system degrades gracefully rather than crashing mid-cascade.
    }
}

/**
 * Phase (b): unequip + remove instance.
 * @private
 */


function removeComponentOrItem(facade, entity, payload) {
    const { componentId, kind, eqId, itemId } = payload;

    if (kind === 'equipped-item') {
        // Desequip (restores holding cost on host)
        if (eqId) {
            facade.holdingCostController.unequipItem(entity.id, eqId);
        }
        // Remove item instance from inventory — use payload.itemId (not eqId)
        const removeId = itemId || eqId;
        if (removeId) {
            facade.inventoryManager.removeItem(entity, removeId);
        }
    } else {
        // removeComponent via stateEntityController (replacement by filter)
        facade.stateEntityController.removeComponent(entity.id, componentId);
    }
}

/**
 * Phase (c): cleanup — stats, internal components, selection, capabilities,
 * + equipped items hosted on the broken host (component path) or the
 * unequipped item's tracking/stats (equipped-item path).
 * @private
 */


function cleanupAfterRemoval(facade, entity, payload) {
    const { componentId, kind, eqId } = payload;

    if (kind === 'component') {
        // (3) removeStats
        facade.statsController.removeStats(componentId);

        // (4) Clean up internal components of host (the broken component is the host)
        // InternalComponentController.removeInternalComponent(entityId, hostComponentId, internalCompId)
        // But here we want to clean ALL internals of this component — iterate
        const internalComps = facade.internalComponentController.getInternalComponents(entity.id, componentId);
        for (const ic of internalComps) {
            facade.internalComponentController.removeInternalComponent(entity.id, componentId, ic.id);
        }

        // Resync entity's internalComponents snapshot with the authoritative source
        // from InternalComponentController — prevents stale ids after cascade removal
        const liveEntity = facade.getEntity(entity.id);
        if (liveEntity) {
            liveEntity.internalComponents = facade.internalComponentController.getInternalComponentsForEntity(entity.id);
        }

        // (5) removeEntityFromCache + reEvaluateEntityCapabilities
        // Narrowed: build a minimal state with only the affected entity —
        // reEvaluateEntityCapabilities reads state.entities[entityId] and then
        // fetches component stats directly from the controller, so a full-world
        // getAll() is unnecessary here.
        if (facade.actionController) {
            facade.actionController.removeEntityFromCache(entity.id);
            const liveEntity = facade.getEntity(entity.id);
            const narrowState = liveEntity ? { entities: { [liveEntity.id]: liveEntity } } : { entities: {} };
            facade.actionController.reEvaluateEntityCapabilities(narrowState, entity.id);
        }

        // (6) releaseSelection of the component
        facade.actionSelectController.releaseSelection(componentId);

        // (7) Remove equipped items hosted on this broken component.
        // When a host component is destroyed, any items equipped on it become
        // orphaned — their tracking and stats would linger referencing a dead host.
        // Mirrors the equipped-item cleanup path (kind === 'equipped-item').
        const equippedOnHost = facade.holdingCostController.getEquippedItems(entity.id)
            .filter(eq => eq.componentId === componentId);
        for (const eq of equippedOnHost) {
            try {
                facade.holdingCostController.cleanupEquippedItem(entity.id, eq.eqId);
                if (eq.itemId) {
                    facade.inventoryManager.removeItem(entity, eq.itemId);
                }
                facade.equippedItemStats.removeStats(eq.eqId);
                facade.actionSelectController.releaseSelection(eq.eqId);
                Logger.info(`[removeBrokenComponent] Removed equipped item ${eq.itemId} (${eq.itemType}) from broken host ${componentId}.`);
            } catch (error) {
                Logger.error(`[removeBrokenComponent] Error removing equipped item ${eq.itemId} from broken host ${componentId}: ${error.message}`);
            }
        }
    } else if (kind === 'equipped-item') {
        // (3') cleanupEquippedItem wrapper from HoldingCostController
        facade.holdingCostController.cleanupEquippedItem(entity.id, eqId);

        // (5') re-evaluate capabilities — ONLY of host entity (not all)
        // Narrowed: same minimal-state approach as the component path above.
        if (facade.actionController) {
            const liveEntity = facade.getEntity(entity.id);
            const narrowState = liveEntity ? { entities: { [liveEntity.id]: liveEntity } } : { entities: {} };
            facade.actionController.reEvaluateEntityCapabilities(narrowState, entity.id);
        }

        // (6') release selection for eqId
        facade.actionSelectController.releaseSelection(eqId);
    }
}

/**
 * Spills the live contents of an entity to the floor (drop handler) and
 * removes them from its inventory. This is the death path for an
 * energy-exhausted entity: nothing is carried past death. Batched — reads
 * the current dropped-items map, accumulates each spilled item via the
 * narrow-deps stub pattern (see removeBrokenComponent), writes once, then
 * clears the inventory.
 * @private
 */


function spillAllEntityItems(facade, entityId) {
    try {
        const entity = facade.stateEntityController.getEntity(entityId);
        if (!entity) return;
        // Entities carry the room as a STRING `location` and the 2D coords
        // as a `spatial` object (see component-broke reference at getEquippedItems callback). Read them the same way.
        const position = entity.spatial && typeof entity.spatial === 'object' ? entity.spatial : { x: 0, y: 0 };
        const roomId = entity.location ?? null;
        const itemRegistry = typeof facade.getItemRegistry === 'function' ? facade.getItemRegistry() : {};
        const batchItems = facade.getDroppedItems() || {};

        // Snapshot the live carried items (entity.items mirrors _inventory[entityId]).
        const items = (entity.items || []);
        const seenItemIds = new Set();
        const uniqueItems = [];
        for (const item of items) {
            if (!item || typeof item !== 'object' || !item.id) continue;
            if (seenItemIds.has(item.id)) continue;
            seenItemIds.add(item.id);
            uniqueItems.push(item);
        }

        for (const item of uniqueItems) {
            try {
                const point = sampleDiskPoint(position.x, position.y, DEFAULT_TRIGGER_RADIUS) || position;
                const itemDef = itemRegistry[item.type] || itemRegistry[item.itemType] || {};
                // Accumulate in local batch map and write once (avoids
                // read-modify-write O(n) on the droppedItems map).
                writeDroppedItem(
                    {
                        getDroppedItems: () => batchItems,
                        setDroppedItems: (droppedItems) => { Object.assign(batchItems, droppedItems); }
                    },
                    item.type || item.itemType || item.name || 'unknown',
                    point.x,
                    point.y,
                    roomId,
                    entity.id,
                    itemDef
                );
                // Remove from the entity inventory (cascade + _inventory map).
                facade.inventoryManager.removeItem(entity, item.id);
            } catch (error) {
                Logger.error(`[WorldStateController] Failed to spill item ${item.id} on energy death: ${error.message}`, {
                    itemId: item.id,
                    error: error.message
                });
            }
        }

        // Batch write (single broadcast) of all newly dropped items.
        if (batchItems && Object.keys(batchItems).length > 0) {
            facade.setDroppedItems(batchItems);
        }
    } catch (error) {
        Logger.error(`[WorldStateController] Failed to spill contents for entity ${entityId} on energy death: ${error.message}`, {
            entityId: entityId,
            error: error.message
        });
    }
}


export { removeBrokenComponentCascade, spillContent, cascadeDependents, forceDirectRemoval, maybeEliminateEntity, removeComponentOrItem, cleanupAfterRemoval, spillAllEntityItems };
