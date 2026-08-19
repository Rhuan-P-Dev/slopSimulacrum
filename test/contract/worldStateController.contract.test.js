/**
 * WorldStateController — PUBLIC API CONTRACT (regression-guard) tests.
 *
 * These are NOT unit tests of internal logic. They are contractual snapshots of
 * the god class's PUBLIC surface, intended to make sure future refactoring (e.g.,
 * the split of WorldStateController) does not silently change what the rest of the
 * codebase — and the client — can rely on:
 *
 *   (a) the exact SET of public methods on the instance, and
 *   (b) the SHAPE (top-level keys, basic types, per-sub-structure keys — not exact
 *       values, since IDs are generated) of the key return values:
 *         - getAll()
 *         - getActionsForEntity(entityId)
 *         - previewActionData(actionName, entityId)
 *
 * The controller is constructed the same minimal way as src/server.js (see step 2-3):
 * a UniversalTickSystem (not started) + new WorldStateController(tickSystem). We do
 * NOT start the tick loop and we do NOT wire the broadcast/LLM/socket layers, because
 * those are not needed for the read APIs under test and would leave open handles.
 *
 * @module test/contract/worldStateController.contract
 */

import { describe, it, expect, beforeAll } from 'vitest';
import WorldStateController from '../../src/controllers/WorldStateController.js';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

// =========================================================================
// Public-method extraction (mirrors the documented public surface)
// =========================================================================

/**
 * Collects the public method names of an instance: function-valued properties found
 * on the class prototype chain plus own function properties, excluding the
 * constructor and underscore-prefixed (private) members.
 *
 * @param {Object} instance - A constructed instance.
 * @param {Function} Ctor - The class constructor (for walking the prototype chain).
 * @returns {string[]} Sorted array of public method names.
 */
function getPublicMethods(instance, Ctor) {
    const names = new Set();

    let proto = Ctor.prototype;
    while (proto && proto !== Object.prototype) {
        for (const name of Object.getOwnPropertyNames(proto)) {
            const d = Object.getOwnPropertyDescriptor(proto, name);
            if (d && typeof d.value === 'function' && name !== 'constructor') {
                names.add(name);
            }
        }
        proto = Object.getPrototypeOf(proto);
    }

    for (const name of Object.getOwnPropertyNames(instance)) {
        const d = Object.getOwnPropertyDescriptor(instance, name);
        if (d && typeof d.value === 'function' && name !== 'constructor') {
            names.add(name);
        }
    }

    return [...names].filter((n) => !n.startsWith('_')).sort();
}

/**
 * Returns the sorted keys of an object (for shape assertions).
 * @param {Object|null|undefined} value
 * @returns {string[]}
 */
function keysOf(value) {
    if (value === null || typeof value !== 'object') return [];
    return Object.keys(value).sort();
}

/**
 * Returns the runtime "type" of a value in a stable, assertion-friendly form.
 * @param {*} value
 * @returns {string}
 */
function typeOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

// =========================================================================
// Test setup
// =========================================================================

let wsc;
let entityIds;
let firstEntityId;

beforeAll(() => {
    // Mirror src/server.js: create the tick system (do NOT start it) and build the
    // world via the composition root (FASE 5). buildWorldState() performs world init
    // + initial capability scan, exactly like the old constructor did.
    const tickSystem = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    ({ worldStateController: wsc } = buildWorldState(tickSystem));

    const state = wsc.getAll();
    entityIds = Object.keys(state.entities);
    firstEntityId = entityIds[0];
});

// =========================================================================
// (a) PUBLIC METHOD SURFACE — fixed snapshot
// =========================================================================

describe('WorldStateController public method surface', () => {
    // The contract: the exact set of public methods. If this changes, a refactor
    // added/removed/renamed a public method and this test must be updated on purpose.
    const EXPECTED_PUBLIC_METHODS = [
        'addInternalComponent',
        'addItemToContainer',
        'addItemToEntity',
        'cleanupInternalComponents',
        'computeSynergy',
        'despawnEntity',
        'equipItem',
        'executeAction',
        'executePickUpItem',
        'expireStaleSelections',
        'findDroppedItemsNear',
        'getActionCapabilities',
        'getActionsForEntity',
        'getActionsWithSynergy',
        'getAgentActionFeedback',
        'getAll',
        'getAllEquippedItems',
        'getBestComponentForAction',
        'getCachedCapabilities',
        'getCapabilitiesForEntity',
        'getComponent',
        'getComponentStats',
        'getContainerItems',
        'getDroppedItems',
        'getDroppedItemsByRoom',
        'getEntity',
        'getEntityItems',
        'getEquippedItem',
        'getEquippedItemByItemId',
        'getEquippedItemForComponent',
        'getEquippedItems',
        'getHoldingCostRegistry',
        'getInternalComponents',
        'getInternalComponentsForEntity',
        'getItem',
        'getItemRegistry',
        'getItemStats',
        'getLockedComponents',
        'getRecentEvents',
        'getRoomChatMessages',
        'getRoomUidByLogicalId',
        'getRooms',
        'getSynergyConfig',
        'getWorldGraph',
        'hasInternalComponent',
        'initializeWorld',
        'moveEntity',
        'moveItemInEntity',
        'moveItemIntoContainer',
        'moveItemOutOfContainer',
        'previewActionData',
        'reEvaluateEntityCapabilities',
        'registerSelection',
        'registerSelections',
        'releaseSelection',
        'removeDroppedItem',
        'removeInternalComponent',
        'removeItemFromContainer',
        'removeItemFromEntity',
        'restore',
        'sendRoomChat',
        'serialize',
        'setBroadcastService',
        'setDroppedItems',
        'spawnEntity',
        'transferEquip',
        'triggerInitialBroadcast',
        'unequipItem',
    ];

    it('exposes exactly the expected set of public methods', () => {
        expect(getPublicMethods(wsc, WorldStateController)).toEqual(EXPECTED_PUBLIC_METHODS);
    });

    it('has a stable public method count (guard against accidental additions)', () => {
        expect(getPublicMethods(wsc, WorldStateController)).toHaveLength(EXPECTED_PUBLIC_METHODS.length);
    });
});

// =========================================================================
// (b1) getAll() — SHAPE contract (keys + basic types + sub-structure keys)
// =========================================================================

describe('WorldStateController.getAll() shape', () => {
    it('returns an object with the exact top-level keys', () => {
        const state = wsc.getAll();
        expect(typeOf(state)).toBe('object');
        expect(keysOf(state)).toEqual([
            'components',
            'entities',
            'equippedItemStats',
            'holdingCost',
            'internalComponents',
            'rooms',
            'turns',
        ]);
    });

    it('has a turns sub-structure (Feature A) with the spec shape', () => {
        const state = wsc.getAll();
        expect(typeOf(state.turns)).toBe('object');
        expect(keysOf(state.turns)).toEqual([
            'actorOrder',
            'currentTick',
            'phase',
            'planningDeadlineTick',
            'queues',
            'roundNumber',
        ]);
        expect(typeOf(state.turns.roundNumber)).toBe('number');
        expect(['planning', 'resolution']).toContain(state.turns.phase);
        expect(typeOf(state.turns.currentTick)).toBe('number');
        expect(typeOf(state.turns.planningDeadlineTick)).toBe('number');
        expect(typeOf(state.turns.actorOrder)).toBe('array');
        expect(typeOf(state.turns.queues)).toBe('object');
        for (const actor of state.turns.actorOrder) {
            expect(keysOf(actor)).toEqual(['entityId', 'initiative', 'name', 'queuedCount']);
            expect(typeOf(actor.entityId)).toBe('string');
            expect(typeOf(actor.initiative)).toBe('number');
            expect(typeOf(actor.name)).toBe('string');
            expect(typeOf(actor.queuedCount)).toBe('number');
        }
    });

    it('has a non-empty entities map with a consistent per-entity shape', () => {
        const state = wsc.getAll();

        expect(typeOf(state.entities)).toBe('object');
        const ids = Object.keys(state.entities);
        expect(ids.length).toBeGreaterThanOrEqual(1);

        for (const id of ids) {
            const entity = state.entities[id];
            expect(typeOf(entity)).toBe('object');

            // Exact per-entity key set (broadcast adds `equipped` later, not here).
            // Feature D: NPC entities (data/npcs.json) carry the extra spawn
            // fields (isNPC, name, npcConfig) — player droids keep the base
            // shape. The world.json opt-out flag lives in the in-memory
            // _npcSpawnFlags set and must NEVER appear on the entity record
            // (audit: it used to leak into serialize() snapshots).
            const isNpc = entity.isNPC === true;
            expect(entity).not.toHaveProperty('_skipInitialSpawns');
            expect(keysOf(entity)).toEqual(isNpc
                ? [
                    'blueprint',
                    'components',
                    'id',
                    'internalComponents',
                    'isNPC',
                    'location',
                    'name',
                    'npcConfig',
                    'spatial',
                    'status',
                ]
                : [
                    'blueprint',
                    'components',
                    'id',
                    'internalComponents',
                    'items',
                    'location',
                    'spatial',
                    'status',
                ]);
            if (isNpc) {
                expect(typeOf(entity.name)).toBe('string');
                expect(typeOf(entity.npcConfig)).toBe('object');
            }

            // Basic types.
            expect(typeOf(entity.id)).toBe('string');
            expect(typeOf(entity.blueprint)).toBe('string');
            expect(typeOf(entity.location)).toBe('string');
            expect(typeOf(entity.status)).toBe('string');
            // NPC entities (llmKillerDroid) have no initialItems → items key absent.
            // Player droids DO have items after InventoryManager.addItem().
            if (entity.items) expect(typeOf(entity.items)).toBe('array');
            expect(typeOf(entity.internalComponents)).toBe('object');

            // spatial sub-structure: { x: number, y: number }
            expect(typeOf(entity.spatial)).toBe('object');
            expect(keysOf(entity.spatial)).toEqual(['x', 'y']);
            expect(typeOf(entity.spatial.x)).toBe('number');
            expect(typeOf(entity.spatial.y)).toBe('number');

            // components array: each entry { id, identifier, type } (strings).
            expect(typeOf(entity.components)).toBe('array');
            expect(entity.components.length).toBeGreaterThan(0);
            for (const comp of entity.components) {
                expect(keysOf(comp)).toEqual(['id', 'identifier', 'type']);
                expect(typeOf(comp.id)).toBe('string');
                expect(typeOf(comp.type)).toBe('string');
                expect(typeOf(comp.identifier)).toBe('string');
            }
        }
    });

    it('has a components sub-structure with registry + instances + globalTraits', () => {
        const state = wsc.getAll();
        expect(keysOf(state.components)).toEqual(['globalTraits', 'instances', 'registry']);
        expect(typeOf(state.components.registry)).toBe('object');
        expect(typeOf(state.components.instances)).toBe('object');
        expect(typeOf(state.components.globalTraits)).toBe('object');

        // Each component instance is a trait → { stat: number } map.
        const instanceIds = Object.keys(state.components.instances);
        expect(instanceIds.length).toBeGreaterThan(0);
        for (const compId of instanceIds) {
            const stats = state.components.instances[compId];
            expect(typeOf(stats)).toBe('object');
            for (const traitId of Object.keys(stats)) {
                expect(typeOf(stats[traitId])).toBe('object');
                for (const statName of Object.keys(stats[traitId])) {
                    expect(typeOf(stats[traitId][statName])).toBe('number');
                }
            }
        }
    });

    it('has rooms, internalComponents, holdingCost and equippedItemStats sub-shapes', () => {
        const state = wsc.getAll();

        // rooms: { [roomId]: room } where room has a stable key set.
        expect(typeOf(state.rooms)).toBe('object');
        const roomIds = Object.keys(state.rooms);
        expect(roomIds.length).toBeGreaterThan(0);
        for (const roomId of roomIds) {
            expect(keysOf(state.rooms[roomId])).toEqual([
                'connections',
                'description',
                'entities',
                'height',
                'id',
                'name',
                'objects',
                'width',
                'x',
                'y',
            ]);
        }

        // internalComponents: { [entityId]: { [componentId]: [ {..} ] } }
        expect(typeOf(state.internalComponents)).toBe('object');
        for (const eid of Object.keys(state.internalComponents)) {
            expect(typeOf(state.internalComponents[eid])).toBe('object');
        }

        // holdingCost: { _equippedItems: { [entityId]: { [eqId]: item } } }
        expect(keysOf(state.holdingCost)).toEqual(['_equippedItems']);
        expect(typeOf(state.holdingCost._equippedItems)).toBe('object');

        // equippedItemStats: { [eqId]: stats }
        expect(typeOf(state.equippedItemStats)).toBe('object');
    });
});

// =========================================================================
// (b2) getActionsForEntity(entityId) — SHAPE contract
// =========================================================================

describe('WorldStateController.getActionsForEntity() shape', () => {
    it('returns one entry per registered action, each with capability arrays', () => {
        const actions = wsc.getActionsForEntity(firstEntityId);
        expect(typeOf(actions)).toBe('object');

        // Every registered action must be present (can or cannot execute).
        const actionNames = keysOf(actions);
        expect(actionNames).toEqual([
            'cut',
            'dash',
            'droid punch',
            'dropItem',
            'move',
            'pickUpItem',
            'selfHeal',
            'shootT1',
        ]);

        for (const name of actionNames) {
            const entry = actions[name];
            expect(typeOf(entry)).toBe('object');
            expect(typeOf(entry.canExecute)).toBe('array');
            expect(typeOf(entry.cannotExecute)).toBe('array');
            expect(typeOf(entry.requirements)).toBe('array');
        }

        // At least one action must be executable by the entity (move is guaranteed).
        expect(typeOf(actions.move.canExecute)).toBe('array');
        expect(actions.move.canExecute.length).toBeGreaterThan(0);
    });

    it('has a consistent capability-entry shape for executable components', () => {
        const actions = wsc.getActionsForEntity(firstEntityId);
        const entry = actions.move.canExecute[0];
        expect(keysOf(entry)).toEqual([
            '_entityId',
            '_resolvedRole',
            'componentId',
            'componentIdentifier',
            'componentType',
            'entityId',
            'fulfillingComponents',
            'requirementValues',
            'requirementsStatus',
            'score',
        ]);
        expect(typeOf(entry.entityId)).toBe('string');
        expect(typeOf(entry.componentId)).toBe('string');
        expect(typeOf(entry.componentType)).toBe('string');
        expect(typeOf(entry.score)).toBe('number');
        expect(typeOf(entry.requirementValues)).toBe('object');
        expect(typeOf(entry.fulfillingComponents)).toBe('object');
        expect(typeOf(entry.requirementsStatus)).toBe('array');
    });
});

// =========================================================================
// (b3) previewActionData(actionName, entityId) — SHAPE contract
// =========================================================================

describe('WorldStateController.previewActionData() shape', () => {
    for (const actionName of ['droid punch', 'move']) {
        it(`returns a preview object for "${actionName}"`, () => {
            const preview = wsc.previewActionData(actionName, firstEntityId, {});

            expect(typeOf(preview)).toBe('object');
            expect(preview).not.toBeNull();
            expect(keysOf(preview)).toEqual(['actionData', 'resolvedValues', 'synergyResult']);

            // actionData echoes the registry definition plus a _name.
            expect(typeOf(preview.actionData)).toBe('object');
            expect(preview.actionData._name).toBe(actionName);
            expect(typeOf(preview.actionData.requirements)).toBe('array');
            expect(typeOf(preview.actionData.consequences)).toBe('array');

            // resolvedValues is a per-consequence-type map (object).
            expect(typeOf(preview.resolvedValues)).toBe('object');

            // Both "droid punch" and "move" have synergy enabled, so a result is present.
            expect(typeOf(preview.synergyResult)).toBe('object');
            expect(preview.synergyResult).not.toBeNull();
            expect(keysOf(preview.synergyResult)).toEqual([
                'actionName',
                'capKey',
                'capped',
                'contributingComponents',
                'summary',
                'synergyMultiplier',
            ]);
            expect(typeOf(preview.synergyResult.contributingComponents)).toBe('array');
            expect(typeOf(preview.synergyResult.synergyMultiplier)).toBe('number');
        });
    }
});
