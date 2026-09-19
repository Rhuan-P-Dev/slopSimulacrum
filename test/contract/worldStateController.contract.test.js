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
import DataLoader from '../../src/utils/DataLoader.js';

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

/**
 * Mirrors the data-driven spawn gate in WorldStateController._spawnNpcs():
 * an entry with an optional `envGate` names an environment variable that must
 * equal "true" (case-insensitive, trimmed) for the entry to spawn. A missing
 * or malformed envGate means "no gate" (the entry spawns). Malformed entries
 * (not objects) never spawn.
 * @param {Object} entry - A data/npcs.json registry entry (or anything).
 * @returns {boolean} Whether the entry spawns under the CURRENT process.env.
 */
function entrySpawnableInCurrentEnv(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const gateVar = typeof entry.envGate === 'string' ? entry.envGate.trim() : '';
    if (gateVar === '') return true; // no gate declared
    const gateValue = process.env[gateVar];
    return typeof gateValue === 'string' && gateValue.trim().toLowerCase() === 'true';
}

// =========================================================================
// Test setup
// =========================================================================

let wsc;
let firstEntityId;

beforeAll(() => {
    // Mirror src/server.js: create the tick system (do NOT start it) and build the
    // world via the composition root (FASE 5). buildWorldState() performs world init
    // + initial capability scan, exactly like the old constructor did.
    const tickSystem = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    ({ worldStateController: wsc } = buildWorldState(tickSystem));

    // Load the NPC registry from data/npcs.json so we can compute expected counts
    // data-driven (matching how WorldStateController._spawnNpcs() loads it).
    const rawRegistry = DataLoader.loadJsonSafe('data/npcs.json', {});
    const npcRegistry = rawRegistry && typeof rawRegistry === 'object' && !Array.isArray(rawRegistry)
        ? rawRegistry
        : {};
    const npcEntries = Object.entries(npcRegistry);
    const npcEntryCount = npcEntries.length;
    // Gate-aware expectation: _spawnNpcs() skips an entry whose optional envGate
    // names an env var that is not "true" (case-insensitive, trimmed) — e.g. the
    // env-gated killer LLM drone is skipped unless KILLER_LLM_DRONE_ENABLED=true.
    // The helper mirrors the production check, so the expected count matches
    // whatever the ambient test environment actually spawns (default OFF or a
    // gate-ON verification run).
    const spawnableNpcCount = npcEntries
        .filter(([, entry]) => entrySpawnableInCurrentEnv(entry))
        .length;

    // Stored for use in tests (1 test-spawned droid + the gate-aware spawnable
    // count + the raw registry for per-entry checks).
    wsc._npcTestData = { npcEntryCount, spawnableNpcCount, registry: npcRegistry };

    // Spawn a test droid (the default world has zero pre-spawned droids after
    // removing the client/vault guardian spawns). This gives the contract tests
    // an entity to exercise read-APIs against.
    const startRoomId = wsc.roomsController.getUidByLogicalId('start_room');
    const testEntityId = wsc.stateEntityController.spawnEntity('smallBallDroid', startRoomId);

    firstEntityId = testEntityId;
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
        // Added deliberately (energy_flow_spec.md §6.2): the flow-scoped
        // broadcast-scope pair. Not an accidental addition — the energy-flow
        // turn step opens/closes it exactly once per turn.
        'beginEnergyFlowTurn',
        'canEntityExecuteAction',
        'cleanupInternalComponents',
        'computeSynergy',
        'craftItems',
        'despawnEntity',
        // Added deliberately (energy_flow_spec.md §6.2): closes the flow
        // broadcast scope with at most one full-state broadcast.
        'endEnergyFlowTurn',
        'equipItem',
        'executeAction',
        'executePickUpItem',
        'expireStaleSelections',
        'findDroppedItemsNear',
        'getActionCapabilities',
        'getActionRegistry',
        'getActionsForEntity',
        'getActionsWithSynergy',
        'getAgentActionFeedback',
        'getAll',
        'getAllEquippedItems',
        'getBestComponentForAction',
        'getCachedCapabilities',
        'getCapabilitiesForEntity',
        'getComponent',
        'getComponentConditions',
        'getComponentFlags',
        'getComponentStats',
        'getContainerItems',
        'getCraftingRecipes',
        'getDroppedItems',
        'getDroppedItemsByRoom',
        'getEntities',
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
        // Added deliberately (knowledge_viewer_spec.md §4.2): the static knowledge
        // codex passthrough. Not an accidental addition — the route reads it via
        // the facade only (facade-only-dependency rule).
        'getKnowledge',
        'getLockedComponents',
        'getMaterialRegistry',
        'getRecentEvents',
        'getRoomChatMessages',
        'getRoomUidByLogicalId',
        'getRooms',
        'getSynergyConfig',
        'getWorldGraph',
        // Added deliberately (world_rules_spec.md): the world-rules registry
        // passthrough. Not an accidental addition — mirrors getKnowledge().
        'getWorldRules',
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
        'removeBrokenComponent',
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
            'barrier',
            'currentTick',
            'phase',
            'queues',
            'roundNumber',
        ]);
        expect(typeOf(state.turns.roundNumber)).toBe('number');
        expect(['planning', 'resolution']).toContain(state.turns.phase);
        expect(typeOf(state.turns.currentTick)).toBe('number');
        expect(typeOf(state.turns.actorOrder)).toBe('array');
        expect(typeOf(state.turns.queues)).toBe('object');
        expect(typeOf(state.turns.barrier)).toBe('object');
        for (const actor of state.turns.actorOrder) {
            expect(keysOf(actor)).toEqual(['entityId', 'initiative', 'name', 'queuedCount']);
            expect(typeOf(actor.entityId)).toBe('string');
            expect(typeOf(actor.initiative)).toBe('number');
            expect(typeOf(actor.name)).toBe('string');
            expect(typeOf(actor.queuedCount)).toBe('number');
        }
    });

    it('has an entities map with the test-spawned droid and a consistent per-entity shape', () => {
        const state = wsc.getAll();

        expect(typeOf(state.entities)).toBe('object');
        const ids = Object.keys(state.entities);
        // The beforeAll spawns exactly 1 smallBallDroid for testing + the NPCs
        // that the ambient environment allows to spawn: every entry in
        // data/npcs.json except those whose envGate variable is not "true"
        // (data-driven and gate-aware — e.g. the killer LLM drone is excluded
        // by default and included in a gate-ON run).
        const expectedNpcCount = wsc._npcTestData?.spawnableNpcCount ?? 0;
        expect(ids.length).toBe(1 + expectedNpcCount);

        for (const id of ids) {
            const entity = state.entities[id];
            expect(typeOf(entity)).toBe('object');

            // Exact per-entity key set (broadcast adds `equipped` later, not here).
            // Feature D: NPC entities (data/npcs.json) carry the extra spawn
            // fields (isNPC, name, npcConfig) — player droids keep the base shape
            // PLUS the `items` key: the spawn observer applies the data/world.json
            // initialSpawns loadout to the incarnated player (non-NPC
            // smallBallDroid), so it carries its items on a component. NPCs whose
            // registry entry declares initialItems ALSO carry the `items` key
            // (their loadout is placed on a component at spawn); NPCs without
            // initialItems do not. The world.json opt-out flag lives in the
            // in-memory _npcSpawnFlags set and must NEVER appear on the entity
            // record (audit: it used to leak into serialize() snapshots).
            const isNpc = entity.isNPC === true;
            const npcRegistryEntry = isNpc ? (wsc._npcTestData?.registry?.[entity.blueprint] ?? null) : null;
            const npcHasInitialItems = Boolean(
                npcRegistryEntry
                && Array.isArray(npcRegistryEntry.initialItems)
                && npcRegistryEntry.initialItems.length > 0
            );
            expect(entity).not.toHaveProperty('_skipInitialSpawns');
            expect(keysOf(entity)).toEqual(isNpc
                ? (npcHasInitialItems
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
                        'isNPC',
                        'location',
                        'name',
                        'npcConfig',
                        'spatial',
                        'status',
                    ])
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
                // AI system: entities with ai block — assert DATA-DRIVEN shape, not exact values.
                // Each spawned NPC with an `ai` block in the data has `npcConfig.ai` as an object
                // whose `behavior` is a non-empty string; if the data entry has `attackRange`,
                // the spawned `ai.attackRange` is a finite number > 0; if the data entry lacks
                // a valid `ai`, the spawned `npcConfig.ai` is null/absent.
                if (entity.npcConfig && entity.npcConfig.ai) {
                    expect(typeOf(entity.npcConfig.ai)).toBe('object');
                    expect(typeOf(entity.npcConfig.ai.behavior)).toBe('string');
                    expect(entity.npcConfig.ai.behavior.length).toBeGreaterThan(0);
                    // attackRange (if present in data) should be a finite positive number.
                    if (entity.npcConfig.ai.attackRange !== undefined) {
                        expect(Number.isFinite(entity.npcConfig.ai.attackRange)).toBeTruthy();
                        expect(entity.npcConfig.ai.attackRange).toBeGreaterThan(0);
                    }
                }
            }

            // Basic types.
            expect(typeOf(entity.id)).toBe('string');
            expect(typeOf(entity.blueprint)).toBe('string');
            expect(typeOf(entity.location)).toBe('string');
            expect(typeOf(entity.status)).toBe('string');
            // Entities with no initialItems (from data/world.json) have items key absent.
            // Entities with initial spawns DO have items after InventoryManager.addItem().
            if (entity.items) expect(typeOf(entity.items)).toBe('array');
            expect(typeOf(entity.internalComponents)).toBe('object');

            // spatial sub-structure: { x: number, y: number }
            expect(typeOf(entity.spatial)).toBe('object');
            expect(keysOf(entity.spatial)).toEqual(['x', 'y']);
            expect(typeOf(entity.spatial.x)).toBe('number');
            expect(typeOf(entity.spatial.y)).toBe('number');

            // components array: each entry { id, identifier, type, dependsOn } (strings).
            // §3.6.2: dependsOn is additive — array of parent instance ids (root = []).
            expect(typeOf(entity.components)).toBe('array');
            expect(entity.components.length).toBeGreaterThan(0);
            for (const comp of entity.components) {
                expect(keysOf(comp)).toEqual(['dependsOn', 'id', 'identifier', 'type']);
                expect(typeOf(comp.id)).toBe('string');
                expect(typeOf(comp.type)).toBe('string');
                expect(typeOf(comp.identifier)).toBe('string');
                expect(typeOf(comp.dependsOn)).toBe('array');
            }
        }
    });

    // Additional data-driven NPC shape assertions (robust to content changes).
    it('asserts the spawned NPC count matches the gate-aware data/npcs.json entries and spawned brains are preserved', () => {
        const state = wsc.getAll();
        const npcEntries = Object.values(state.entities).filter((e) => e.isNPC === true);
        // Gate-aware: only entries whose envGate (if any) is "true" in this
        // environment are expected to have spawned.
        const expectedNpcCount = wsc._npcTestData?.spawnableNpcCount ?? 0;
        expect(npcEntries.length).toBe(expectedNpcCount);

        // Guard: if a spawnable entry in the data declares a deterministic
        // brain (ai.behavior), at least one spawned NPC must expose it (catches
        // the whole block silently dropping). Entries without a brain (e.g. the
        // env-gated LLM drone) legitimately carry npcConfig.ai === null.
        const declaresBrain = (entry) =>
            entrySpawnableInCurrentEnv(entry)
            && entry.ai && typeof entry.ai.behavior === 'string' && entry.ai.behavior.length > 0;
        const registry = wsc._npcTestData?.registry;
        const registryEntries = registry && typeof registry === 'object' && !Array.isArray(registry)
            ? Object.values(registry)
            : [];
        if (registryEntries.some(declaresBrain)) {
            const npcsWithBehavior = npcEntries.filter((e) =>
                e.npcConfig?.ai?.behavior && typeof e.npcConfig.ai.behavior === 'string'
                    && e.npcConfig.ai.behavior.length > 0
            );
            expect(npcsWithBehavior.length).toBeGreaterThan(0);
        }
    });

    // =========================================================================
    // (c) New public methods — getEntities() / getActionRegistry()
    // =========================================================================

    describe('WorldStateController.getEntities()', () => {
        it('returns an object (entity map) with string-keyed entries', () => {
            const entities = wsc.getEntities();

            expect(typeOf(entities)).toBe('object');
            const ids = Object.keys(entities);
            expect(ids.length).toBeGreaterThan(0);

            for (const id of ids) {
                expect(typeOf(id)).toBe('string');
                const entity = entities[id];
                expect(typeOf(entity)).toBe('object');
                expect(typeOf(entity.id)).toBe('string');
            }
        });

        it('returns a deep clone (mutation does not affect internal state)', () => {
            const entities1 = wsc.getEntities();
            // Mutate the returned object.
            entities1['__muted'] = true;

            const entities2 = wsc.getEntities();
            expect(entities2).not.toHaveProperty('__muted');
        });
    });

    describe('WorldStateController.getActionRegistry()', () => {
        it('returns an object keyed by action name', () => {
            const registry = wsc.getActionRegistry();

            expect(typeOf(registry)).toBe('object');
            const names = Object.keys(registry);
            expect(names.length).toBeGreaterThan(0);

            for (const name of names) {
                expect(typeOf(name)).toBe('string');
                const action = registry[name];
                expect(typeOf(action)).toBe('object');
                // Each registered action has at least a `requirements` array.
                expect(Array.isArray(action.requirements)).toBeTruthy();
            }
        });

        it('returns a deep clone (mutation does not affect internal state)', () => {
            const registry1 = wsc.getActionRegistry();
            // Mutate the returned object.
            registry1['__muted'] = true;

            const registry2 = wsc.getActionRegistry();
            expect(registry2).not.toHaveProperty('__muted');
        });
    });

    it('has a components sub-structure with registry + instances + globalTraits', () => {
        const state = wsc.getAll();
        expect(keysOf(state.components)).toEqual(['globalTraits', 'instances', 'registry']);
        expect(typeOf(state.components.registry)).toBe('object');
        expect(typeOf(state.components.instances)).toBe('object');
        expect(typeOf(state.components.globalTraits)).toBe('object');

        // Each component instance is a trait → { stat: number } map. The B4
        // feature adds a small set of non-numeric fields to the Physical group
        // (derivedFlags / grantedFlags / conditions) — these are a distinct
        // category (flags & transient conditions), not numeric stats, so they
        // are excluded from the all-numeric check.
        const nonNumericStatFields = new Set(['derivedFlags', 'grantedFlags', 'conditions']);
        const instanceIds = Object.keys(state.components.instances);
        expect(instanceIds.length).toBeGreaterThan(0);
        for (const compId of instanceIds) {
            const stats = state.components.instances[compId];
            expect(typeOf(stats)).toBe('object');
            for (const traitId of Object.keys(stats)) {
                expect(typeOf(stats[traitId])).toBe('object');
                for (const statName of Object.keys(stats[traitId])) {
                    if (nonNumericStatFields.has(statName)) continue;
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
