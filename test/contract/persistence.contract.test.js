/**
 * CONTRACT TEST — WorldStateController persistence (FASE 3)
 *
 * Guarantees for serialize()/restore():
 *   1. serialize() returns a pure, JSON-serializable snapshot with the
 *      required envelope (schemaVersion, serializedAtTick) and covers the
 *      complete mutable world state (entities, components, inventory,
 *      equipped, internal components, rooms, dropped items, selections).
 *   2. The snapshot is DEFENSIVE: mutating it after serialize() never
 *      touches the live world state (no live references leak out).
 *   3. ROUND-TRIP: serialize() → restore() on a FRESH instance →
 *      serialize() yields an identical "state" section. All dynamic IDs
 *      (ent-, comp-, item-, eq-) are preserved — no ID regeneration.
 *   4. restore() validates its payload:
 *        - schemaVersion !== 2 → { success: false, error.code: 'SCHEMA_VERSION_MISMATCH' }
 *        - missing sections / malformed payload → { success: false, error.code: 'INVALID_PAYLOAD' }
 *   5. The snapshot reflects REAL simulation mutations (stats via actions,
 *      inventory/equipped via equip, spatial via move), i.e. restore()
 *      reproduces a mid-simulation world, not just the initial state.
 *
 * Note: the tick system is NOT started (tests run the simulation manually
 * via public action APIs), so serializedAtTick stays null and the two
 * snapshots compare identical (same serializedAtTick on both sides).
 */

import { describe, it, expect } from 'vitest';
import WorldStateController from '../../src/controllers/WorldStateController.js';
import { buildWorldState } from '../../src/composition/WorldComposition.js';

/**
 * Creates a fully constructed WorldStateController and spawns a test droid.
 * The default world has no pre-spawned droids (players are incarnated via
 * socket connection). A smallBallDroid is spawned into start_room so the
 * persistence tests have an entity with declarative initial spawns from
 * data/world.json.
 * FASE 5: built via the composition root (buildWorldState) — the facade
 * no longer self-instantiates its sub-controllers.
 * @returns {WorldStateController}
 */
function createWorld() {
    const { worldStateController: world } = buildWorldState(null);
    // Spawn a test droid into start_room (the default world has zero droids).
    const startRoomId = world.roomsController.getUidByLogicalId('start_room');
    world.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
    return world;
}

/**
 * Applies a realistic mid-simulation mutation profile through PUBLIC
 * action/state APIs only (no direct private store access):
 *   - 'selfHeal' ×2 on the droidHead component   → component stats mutate
 *   - equip 'knife' on the left droidHand        → equipped + preEquipStats + debuffs
 *   - 'move' (spatial, target far away)          → entity.spatial mutates
 *
 * @param {WorldStateController} world
 * @param {Object} handles - Mutable bag with the discovered IDs (for assertions).
 * @returns {void}
 */
function applyMutations(world, handles) {
    // Find the test-spawned entity (not an NPC — data/npcs.json spawns Rogue Droid).
    const allEntities = Object.values(world.stateEntityController.entities);
    const entity = allEntities.find(e => e.isNPC !== true) || allEntities[0];
    handles.entityId = entity.id;

    const head = entity.components.find(c => c.type === 'droidHead');
    expect(head, 'client entity must have a droidHead component').toBeTruthy();
    handles.headComponentId = head.id;

    const hand = entity.components.find(c => c.type === 'droidHand');
    expect(hand, 'client entity must have a droidHand component').toBeTruthy();
    handles.handComponentId = hand.id;

    // 1. Component stats mutation via the public action API (selfHeal:
    //    Physical.durability +10 per execution, target 'self' pinned to the head).
    const beforeDurability = world.getComponentStats(head.id).Physical.durability;
    const heal1 = world.actionController.executeAction('selfHeal', entity.id, { targetComponentId: head.id });
    const heal2 = world.actionController.executeAction('selfHeal', entity.id, { targetComponentId: head.id });
    expect(heal1.success, `selfHeal #1 should succeed: ${JSON.stringify(heal1.error)}`).toBe(true);
    expect(heal2.success, `selfHeal #2 should succeed: ${JSON.stringify(heal2.error)}`).toBe(true);
    const afterDurability = world.getComponentStats(head.id).Physical.durability;
    expect(afterDurability).toBe(beforeDurability + 20);

    // 2. Inventory + equipped mutation via the public state API.
    //    Find a knife item on the hand (data/world.json spawns one on droidHand,
    //    plus the client-only knife from initializeWorld()).
    const handItems = world.getEntityItems(entity.id);
    const knives = (handItems[hand.id] || []).filter(item => item.type === 'knife');
    expect(knives.length, 'a knife item must be in the hand component inventory').toBeGreaterThan(0);
    handles.knifeItemId = knives[0].id;

    const equipResult = world.equipItem(entity.id, knives[0].id, 'knife', hand.id);
    expect(equipResult.success, `equipping knife should succeed: ${JSON.stringify(equipResult)}`).toBe(true);
    const equipped = world.getEquippedItems(entity.id);
    expect(equipped, 'equipped items list should exist').toBeTruthy();
    expect(equipped.some(eq => eq.itemId === knives[0].id), 'knife should be listed as equipped').toBe(true);

    // 3. Spatial mutation via the public action API (move toward a far
    //    point: movement is capped at the Movement.move speed, so the
    //    resulting coordinates are deterministic for a given world state).
    const beforeSpatial = { ...world.getEntity(entity.id).spatial };
    const moveResult = world.actionController.executeAction('move', entity.id, { targetX: 1000, targetY: 1000 });
    expect(moveResult.success, `move should succeed: ${JSON.stringify(moveResult.error)}`).toBe(true);
    const afterSpatial = { ...world.getEntity(entity.id).spatial };
    expect(afterSpatial).not.toEqual(beforeSpatial);
    handles.spatial = { before: beforeSpatial, after: afterSpatial };
}

/**
 * Collects every dynamic ID present in a snapshot's state section, so the
 * round-trip test can assert ID preservation (not ID regeneration).
 * @param {Object} stateSection - snapshot.state
 * @returns {Object} { entities, components, items, equipped }
 */
function collectIds(stateSection) {
    const items = new Set();
    const collectItemsFrom = (item) => {
        if (!item || typeof item !== 'object') return;
        if (item.id) items.add(item.id);
        for (const child of item.children || []) collectItemsFrom(child);
    };
    for (const entity of Object.values(stateSection.entities)) {
        // entity.items is a flat array of items; nesting lives in item.children
        for (const item of entity.items || []) collectItemsFrom(item);
    }
    return {
        entities: Object.keys(stateSection.entities),
        components: Object.keys(stateSection.components),
        items: [...items],
        equipped: Object.keys(stateSection.equippedItemStats),
        droppedItems: Object.keys(stateSection.droppedItems)
    };
}

describe('WorldStateController persistence (serialize/restore)', () => {
    it('serialize() returns a complete, JSON-serializable snapshot envelope', () => {
        const world = createWorld();
        const snapshot = world.serialize();

        // Envelope
        expect(snapshot.schemaVersion).toBe(2);
        // No tickSystem is running in tests → serializedAtTick is null
        // (it carries tickSystem.currentTick when a tick system is provided)
        expect(snapshot.serializedAtTick === null || typeof snapshot.serializedAtTick === 'number').toBe(true);
        expect(typeof snapshot.serializedAt).toBe('number');
        expect(snapshot.state).toBeTypeOf('object');

        // Full state coverage: every mutable sub-controller section is present
        const state = snapshot.state;
        for (const key of ['entities', 'components', 'inventory', 'equipped', 'preEquipStats', 'equippedItemStats', 'internalComponents', 'rooms', 'droppedItems', 'selections', 'events', 'turns']) {
            expect(state, `snapshot.state must include "${key}"`).toHaveProperty(key);
        }

        // The test-spawned world must have at least 1 entity (the droid we spawned):
        expect(Object.keys(state.entities).length).toBeGreaterThanOrEqual(1);
        expect(Object.keys(state.components).length).toBeGreaterThan(0);
        // Inventory items (incl. nested container children) survived serialization.
        // Nesting is flat + reference-based: a child item's hostComponentId points
        // at its parent (a component id OR a container item id) — no children array.
        const allItems = Object.values(state.inventory).flatMap(inv => Object.values(inv));
        expect(allItems.length).toBeGreaterThan(0);
        const itemIds = new Set(allItems.map(item => item.id));
        const componentIds = new Set(Object.values(state.entities).flatMap(e => e.components.map(c => c.id)));
        const nestedInContainer = allItems.filter(item => itemIds.has(item.hostComponentId));
        expect(nestedInContainer.length, 'nested container children (metalBox→knives) must survive serialization').toBeGreaterThan(0);
        const nestedKnife = nestedInContainer.find(item => item.type === 'knife');
        expect(nestedKnife, 'a knife nested inside a container must survive serialization').toBeTruthy();
        expect(componentIds.size).toBeGreaterThan(0);
        // Rooms are present (dynamic section of the structure)
        expect(Object.keys(state.rooms).length).toBeGreaterThanOrEqual(3);

        // Feature B: the world event ring buffer is a serialized array
        // (empty at spawn — events are recorded as actions execute)
        expect(Array.isArray(state.events)).toBe(true);

        // Feature A: the turn system bookkeeping section (schema v2, additive).
        expect(state.turns).toEqual(expect.objectContaining({
            roundNumber: expect.any(Number),
            phase: expect.any(String),
            queues: expect.any(Object),
            resolvedRound: expect.any(Number),
            lastRound: expect.any(Number)
        }));

        // Pure JSON-serializability: a JSON round-trip changes nothing
        const roundTripped = JSON.parse(JSON.stringify(snapshot));
        expect(roundTripped).toEqual(snapshot);
    });

    it('serialize() is defensive: mutating the snapshot never touches the live world state', () => {
        const world = createWorld();
        const snapshot = world.serialize();
        const liveEntityId = Object.keys(world.stateEntityController.entities)[0];
        const liveBefore = JSON.stringify(world.stateEntityController.entities[liveEntityId]);

        // Aggressively mutate the snapshot
        snapshot.state.entities[liveEntityId].spatial.x = 999999;
        snapshot.state.entities[liveEntityId].status = 'zombified';
        snapshot.state.components[Object.keys(snapshot.state.components)[0]].Physical.durability = -1;
        snapshot.state.droppedItems['injected-item'] = { id: 'injected-item' };

        // Live state must be untouched
        expect(JSON.stringify(world.stateEntityController.entities[liveEntityId])).toBe(liveBefore);
        expect(world.stateEntityController.entities[liveEntityId].status).toBe('active');
        expect(world.getDroppedItems()).not.toHaveProperty('injected-item');
    });

    it('round-trips: serialize → restore on a NEW instance → serialize yields an identical state (IDs preserved)', () => {
        const worldA = createWorld();
        const handles = {};
        applyMutations(worldA, handles);

        const snapshotA = worldA.serialize();
        const idsA = collectIds(snapshotA.state);

        // Restore into a FRESH controller instance
        const worldB = createWorld();
        const result = worldB.restore(snapshotA);
        expect(result).toEqual({ success: true });

        // B's world state must now equal A's (via the public read APIs)
        const entityB = worldB.getEntity(handles.entityId);
        expect(entityB, 'restored instance must contain the same entity ID').toBeTruthy();
        expect(entityB.spatial).toEqual(handles.spatial.after);
        expect(worldB.getComponentStats(handles.headComponentId).Physical.durability)
            .toBe(worldA.getComponentStats(handles.headComponentId).Physical.durability);
        const equippedB = worldB.getEquippedItems(handles.entityId) || [];
        expect(equippedB.some(eq => eq.itemId === handles.knifeItemId), 'restored instance must keep the equipped knife').toBe(true);
        // Internal-component mirror re-synced from the canonical store
        const mirrorB = entityB.internalComponents || {};
        const mirrorA = worldA.getEntity(handles.entityId).internalComponents || {};
        expect(Object.keys(mirrorB)).toEqual(Object.keys(mirrorA));

        // Second serialization on the restored instance: state sections identical
        const snapshotB = worldB.serialize();
        expect(snapshotB.state).toEqual(snapshotA.state);

        // ALL dynamic IDs preserved (no regeneration on restore)
        const idsB = collectIds(snapshotB.state);
        expect(idsB.entities.sort()).toEqual(idsA.entities.sort());
        expect(idsB.components.sort()).toEqual(idsA.components.sort());
        expect(idsB.items.sort()).toEqual(idsA.items.sort());
        expect(idsB.equipped.sort()).toEqual(idsA.equipped.sort());
        expect(idsB.droppedItems.sort()).toEqual(idsA.droppedItems.sort());

        // Envelope metadata (timestamps) may differ between serializations —
        // the guarantee is on the state content and the schema version.
        expect(snapshotB.schemaVersion).toBe(snapshotA.schemaVersion);
        expect(snapshotB.serializedAtTick).toBe(snapshotA.serializedAtTick);
    });

    it('restore() rejects a schemaVersion mismatch with SCHEMA_VERSION_MISMATCH', () => {
        const world = createWorld();
        const snapshot = world.serialize();

        const bad = JSON.parse(JSON.stringify(snapshot));
        bad.schemaVersion = 999;
        const result = world.restore(bad);

        expect(result.success).toBe(false);
        expect(result.error).toMatchObject({ code: 'SCHEMA_VERSION_MISMATCH' });
        expect(typeof result.error.message).toBe('string');
        expect(result.error.message).toContain('999');
    });

    it('restore() rejects malformed payloads with INVALID_PAYLOAD (without touching the live state)', () => {
        const world = createWorld();
        const liveBefore = JSON.stringify(world.getAll());

        expect(world.restore(null)).toMatchObject({ success: false, error: { code: 'INVALID_PAYLOAD' } });
        // {} has no schemaVersion → treated as version mismatch (undefined !== 2)
        expect(world.restore({})).toMatchObject({ success: false, error: { code: 'SCHEMA_VERSION_MISMATCH' } });
        // v1 snapshots are rejected: strict versioning (spec §4.5)
        expect(world.restore({ schemaVersion: 1 })).toMatchObject({ success: false, error: { code: 'SCHEMA_VERSION_MISMATCH' } });
        // Version ok, but the "state" section is missing
        expect(world.restore({ schemaVersion: 2 })).toMatchObject({ success: false, error: { code: 'INVALID_PAYLOAD' } });

        // A valid snapshot missing one required state section
        const broken = world.serialize();
        delete broken.state.droppedItems;
        expect(world.restore(broken)).toMatchObject({ success: false, error: { code: 'INVALID_PAYLOAD' } });

        // Live state untouched by all the failed restores
        expect(JSON.stringify(world.getAll())).toBe(liveBefore);
    });
});
