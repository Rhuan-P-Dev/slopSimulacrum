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
import fs from 'node:fs';
import path from 'node:path';
import { readCharaCard } from '../../src/utils/PngCharaReader.js';

// Card image extensions accepted by WorldStateController._readCardFiles().
const CARD_IMAGE_EXTS = new Set(['.png', '.webp', '.jpg', '.jpeg', '.jpe', '.bmp', '.gif', '.apng']);

/**
 * Counts the card files in `data/cards/` that would actually spawn as M1 LLM
 * NPCs — mirroring WorldStateController._readCardFiles() + _spawnSingleCard()
 * (accepted image extensions, dotfiles ignored, embedded payload must yield a
 * non-empty name). This is the test-side twin of `CARD_CARD_COUNT` so contract
 * expectations stay data-driven (gate/dir aware) instead of hard-coded.
 */
function countSpawnableCards() {
    const dir = path.resolve('data/cards');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 0;
    let count = 0;
    for (const f of fs.readdirSync(dir)) {
        if (f.startsWith('.')) continue;
        const ext = path.extname(f).toLowerCase();
        if (!CARD_IMAGE_EXTS.has(ext)) continue;
        const res = readCharaCard(path.join(dir, f));
        if (res.success && typeof res.card?.name === 'string' && res.card.name.trim() !== '') count += 1;
    }
    return count;
}


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
 * @param {Object} entry - A data/entities/npcs.json registry entry (or anything).
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

    // Load the NPC registry from data/entities/npcs.json so we can compute expected counts
    // data-driven (matching how WorldStateController._spawnNpcs() loads it).
    const rawRegistry = DataLoader.loadJsonSafe('data/entities/npcs.json', {});
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

    // World objects (static props) from data/world/worldObjects.json — counted the
    // same data-driven way _spawnStaticProps() materializes them (one isStatic
    // entity per non-underscore entry whose blueprint resolves). Mirrors
    // production so the expected entity total tracks whatever the data file
    // actually declares (see wiki/subMDs/systems/world_objects.md).
    const rawProps = DataLoader.loadJsonSafe('data/world/worldObjects.json', {});
    const rawBlueprints = DataLoader.loadJsonSafe('data/entities/blueprints.json', {});
    const staticPropCount = Object.entries(rawProps || {})
        .filter(([k, p]) => !k.startsWith('_') && p && typeof p.blueprint === 'string' && rawBlueprints[p.blueprint])
        .length;

    // Card count: every accepted image in data/cards/ whose embedded payload
    // yields a non-empty name (the test-side twin of WorldStateController.
    // _readCardFiles() + _spawnSingleCard()). Default runs have one card.
    const cardCount = countSpawnableCards();

    // Stored for use in tests (1 test-spawned droid + the gate-aware spawnable
    // count + the static-prop count + the card count + the raw registry for per-entry checks).
    wsc._npcTestData = { npcEntryCount, spawnableNpcCount, staticPropCount, cardCount, registry: npcRegistry };

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
 // Added deliberately (wiki/subMDs/systems/energy_flow.md): the flow-scoped
        // broadcast-scope pair. Not an accidental addition — the energy-flow
        // turn step opens/closes it exactly once per turn.
        'beginEnergyFlowTurn',
        'canEntityExecuteAction',
        'cleanupInternalComponents',
        'computeSynergy',
        'craftItems',
        'despawnEntity',
 // Added deliberately (wiki/subMDs/systems/energy_flow.md): closes the flow
        // broadcast scope with at most one full-state broadcast.
        // Added deliberately (entity_attributes): whole-entity energy-life
        // elimination — spills the entity's contents to the floor and
        // despawns it when its energy attribute hits 0.
        'eliminateEntityByEnergy',
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
        // Added deliberately (entity_attributes): whole-entity attribute
        // accessors. The entity (not a component) owns these; they are read
        // and mutated through the facade only (facade-only-dependency rule).
        'getEntityAttribute',
        'getEntityAttributeConfig',
        'getEntityAttributeDeclarations',
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
 // Added deliberately (wiki/subMDs/frontend/knowledge_viewer.md): the static knowledge
        // codex passthrough. Not an accidental addition — the route reads it via
        // the facade only (facade-only-dependency rule).
        'getKnowledge',
        'getLockedComponents',
        'getMaterialRegistry',
 // Added deliberately (wiki/subMDs/frontend/object_viewer.md): the object
        // inspection payload (inventory + stats + production summary) behind
        // GET /world-objects/:entityId. Not an accidental addition — the
        // route reads it via the facade only (facade-only-dependency rule).
        'getObjectInspectData',
        'getRecentEvents',
        'getRoomChatMessages',
        'getRoomUidByLogicalId',
        'getRooms',
        'getSynergyConfig',
        'getWorldGraph',
 // Added deliberately (wiki/subMDs/data/world_rules.md): the world-rules registry
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
        // Added deliberately (entity_attributes): clamp-bounded mutation of a
        // whole-entity attribute (charge or drain). Mirrors the per-component
        // updateComponentStatDelta facade API.
        'setEntityAttributeDelta',
        'spawnEntity',
        // Added deliberately (object viewer): cross-entity item transfer
        // (world object → another entity's component), the facade
        // counterpart of moveItemInEntity (wiki object_viewer.md §7).
        'takeItemFromEntity',
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
        // the ambient environment allows to spawn: every data/entities/npcs.json entry
        // whose envGate var is "true" (gate-aware — e.g. the killer LLM drone
        // is excluded by default, included in a gate-ON run) PLUS the cards
        // that data/cards/ yields (data-driven via countSpawnableCards).
        const expectedNpcCount = wsc._npcTestData?.spawnableNpcCount ?? 0;
        // + the static world objects (props) materialized by _spawnStaticProps:
        // they are real entities (isStatic) but never actors, so they count
        // toward the entity total but not the turn roster.
        const expectedPropCount = wsc._npcTestData?.staticPropCount ?? 0;
        const cardCount = wsc._npcTestData?.cardCount ?? 0;
        expect(ids.length).toBe(1 + expectedNpcCount + expectedPropCount + cardCount);

        for (const id of ids) {
            const entity = state.entities[id];
            expect(typeOf(entity)).toBe('object');
            const isStaticProp = entity.isStatic === true;

            // Exact per-entity key set (broadcast adds `equipped` later, not here).
            // Feature D: NPC entities carry the extra spawn fields (isNPC, name,
            // npcConfig). Three distinct shapes exist:
            //   (1) player droids (non-NPC smallBallDroid) keep the base shape
            //       PLUS `items` (world.json initialSpawns loadout on a component).
            //   (2) registry NPCs (data/entities/npcs.json): base NPC shape, PLUS `items`
            //       only when the registry entry declares initialItems.
            //   (3) card NPCs (data/cards/): they are m1Droid, which (a) seeds an
            //       energy attribute -> `attributes` + `attributesConfig`, and (b)
            //       always spawns with a per-card loadout -> `items`.
            const isNpc = entity.isNPC === true;
            // A static world object (prop) is neither an NPC nor a player
            // droid: it carries the base shape PLUS isStatic + name (its
            // display name) and NO items key (the spawn observer opts static
            // props out of the world.json loadout before the items slot is ever
            // created, so a prop never carries an inventory).
            if (isStaticProp) {
                // No `items` key: the spawn observer opts static props out of
                // the world.json loadout BEFORE the items slot is ever created,
                // so a prop never carries an inventory.
                expect(keysOf(entity)).toEqual([
                    'blueprint',
                    'components',
                    'id',
                    'internalComponents',
                    'isStatic',
                    'location',
                    'name',
                    'spatial',
                    'status',
                ]);
                expect(entity.isStatic).toBe(true);
                expect(typeOf(entity.name)).toBe('string');
                expect(entity).not.toHaveProperty('items');
                continue;
            }
            // Cards are exactly the m1Droid NPCs (the registry has no m1Droid
            // entry); they are the only spawned entities carrying both a loadout
            // and the m1Droid energy attribute.
            const isCard = isNpc && entity.blueprint === 'm1Droid';
            const npcRegistryEntry = isNpc ? (wsc._npcTestData?.registry?.[entity.blueprint] ?? null) : null;
            const npcHasInitialItems = Boolean(
                npcRegistryEntry
                && Array.isArray(npcRegistryEntry.initialItems)
                && npcRegistryEntry.initialItems.length > 0
            );
            expect(entity).not.toHaveProperty('_skipInitialSpawns');
            // Sorted key sets (keysOf() returns Object.keys(value).sort()).
            const NPC_BASE = [
                'blueprint', 'components', 'id', 'internalComponents', 'isNPC',
                'location', 'name', 'npcConfig', 'spatial', 'status',
            ];
            const NPC_WITH_ITEMS = [...NPC_BASE, 'items'].sort();
            const CARD_SHAPE = [...NPC_BASE, 'attributes', 'attributesConfig', 'items'].sort();
            expect(keysOf(entity)).toEqual(isCard
                ? CARD_SHAPE
                : isNpc
                    ? (npcHasInitialItems ? NPC_WITH_ITEMS : NPC_BASE)
                    : ['blueprint', 'components', 'id', 'internalComponents', 'items', 'location', 'spatial', 'status']);
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
            // Entities with no initialItems (from data/world/world.json) have items key absent.
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
    it('asserts the spawned NPC count matches the gate-aware registry + card counts and spawned brains are preserved', () => {
        const state = wsc.getAll();
        const npcEntries = Object.values(state.entities).filter((e) => e.isNPC === true);
        // Gate-aware: registry entries whose envGate (if any) is "true" spawn,
        // PLUS the data/cards/ cards (they are also isNPC LLM entities). Both
        // counts are data-driven (gate- and dir-aware).
        const expectedNpcCount = wsc._npcTestData?.spawnableNpcCount ?? 0;
        const cardCount = wsc._npcTestData?.cardCount ?? 0;
        expect(npcEntries.length).toBe(expectedNpcCount + cardCount);

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
            'hand shotgun',
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

// =========================================================================
// moveItemInEntity() — target-component membership guard
//
// The Object Viewer's click-to-move picker (wiki/subMDs/frontend/object_viewer.md,
// §7) and the inventory UI POST to the same endpoint. The picker only ever
// offers the object's own components, but a hand-crafted request may carry any
// well-formed id: such a target must be rejected up front instead of stranding
// the item under a host no component view can reach. The guard fires before the
// item lookup, and the tests below are self-cleaning (one knife added to the
// knife generator and removed again), so the shared world ends as it started.
// =========================================================================

describe('WorldStateController.moveItemInEntity() membership guard', () => {
    const BOGUS_COMP = 'comp-00000000-1111-2222-3333-444444444444';

    function findKnifeGenerator() {
        const entities = wsc.getEntities();
        for (const e of Object.values(entities)) {
            if (e && e.name === 'Knife Generator'
                && Array.isArray(e.components) && e.components.length > 0) {
                return e;
            }
        }
        return null;
    }

    it('rejects a well-formed but non-member target (before the item lookup)', () => {
        const gen = findKnifeGenerator();
        expect(gen, 'the knife generator is a static prop of the built world').not.toBeNull();

        // No item involved: the guard must fire before the item lookup, so a
        // nonexistent item id still yields the membership message — never a
        // dangling-host write.
        const result = wsc.moveItemInEntity(gen.id, 'item-does-not-exist', BOGUS_COMP);
        expect(result.success).toBe(false);
        expect(result.message).toBe(`Component ${BOGUS_COMP} is not part of entity ${gen.id}.`);
    });

    it('accepts a member target and rejects a non-member one without mutating the host', () => {
        const gen = findKnifeGenerator();
        expect(gen, 'the knife generator is a static prop of the built world').not.toBeNull();
        const comp = gen.components[0];

        const added = wsc.addItemToEntity(gen.id, 'knife', comp.id);
        expect(added.success, added.message).toBe(true);
        const knifeId = added.item.id;
        try {
            // The boot storage is empty, so the move onto the member component
            // has room and must succeed (the pre-existing capacity logic, reached
            // past the new guard).
            const moved = wsc.moveItemInEntity(gen.id, knifeId, comp.id);
            expect(moved.success, moved.message).toBe(true);

            // The same item, non-member target: rejected with the guard message
            // and the live host untouched.
            const rejected = wsc.moveItemInEntity(gen.id, knifeId, BOGUS_COMP);
            expect(rejected.success).toBe(false);
            expect(rejected.message).toBe(`Component ${BOGUS_COMP} is not part of entity ${gen.id}.`);
            const live = Object.values(wsc.getEntityItems(gen.id)).flat();
            expect(live.find(i => i.id === knifeId).hostComponentId).toBe(comp.id);
        } finally {
            wsc.removeItemFromEntity(gen.id, knifeId);
        }
    });

    it('leaves the knife generator exactly as the built world started it', () => {
        const gen = findKnifeGenerator();
        expect(gen, 'the knife generator is a static prop of the built world').not.toBeNull();
        expect(Object.values(wsc.getEntityItems(gen.id)).flat(), 'no residue from the add/move/remove above')
            .toEqual([]);
    });
});

// =========================================================================
// takeItemFromEntity() — cross-entity transfer (object → entity component)
//
// The Object Viewer's take picker (wiki/subMDs/frontend/object_viewer.md,
// §7) POSTs to /inventory/:entityId/take/:itemId with { targetEntityId,
// targetComponentId }: the item instance moves from the inspected world
// object to the chosen component of another entity (the player's droid).
// The facade method is the single source of the guard order: target
// membership first, then the manager's own transfer validation
// (capacity, subtree, same-entity). Tests are self-cleaning where the
// shared world is mutated (knives removed in finally; the extra test
// droid spawned here is harmless — every earlier count-sensitive test in
// this file has already run, and the world is discarded with the process).
// =========================================================================

describe('WorldStateController.takeItemFromEntity()', () => {
    function findKnifeGenerator() {
        const entities = wsc.getEntities();
        for (const e of Object.values(entities)) {
            if (e && e.name === 'Knife Generator'
                && Array.isArray(e.components) && e.components.length > 0) {
                return e;
            }
        }
        return null;
    }

    function spawnTestDroid() {
        const startRoomId = wsc.roomsController.getUidByLogicalId('start_room');
        return wsc.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
    }

    it('moves the same knife instance into the droid component and fires the world broadcast', () => {
        const gen = findKnifeGenerator();
        expect(gen, 'the knife generator is a static prop of the built world').not.toBeNull();
        const genComp = gen.components[0];

        const droidId = spawnTestDroid();
        const droid = wsc.stateEntityController.getEntity(droidId);
        const droidComp = droid.components.find(c => c.type === 'centralBall');
        expect(droidComp, 'the spawned droid has a centralBall').not.toBeNull();

        const added = wsc.addItemToEntity(gen.id, 'knife', genComp.id);
        expect(added.success, added.message).toBe(true);
        const knifeId = added.item.id;

        // Spy the broadcast service for the duration of the call (the
        // facade must fire the world-state broadcast after a successful
        // transfer so every client — including this one — re-fetches).
        const realBroadcast = wsc._broadcastService;
        const calls = [];
        wsc._broadcastService = {
            ...realBroadcast,
            broadcast: (...args) => { calls.push(args); }
        };
        try {
            const result = wsc.takeItemFromEntity(gen.id, knifeId, droidId, droidComp.id);
            expect(result.success, result.message).toBe(true);
        } finally {
            wsc._broadcastService = realBroadcast;
        }

        // Same instance on the droid (id preserved), source empty.
        const droidAfter = wsc.stateEntityController.getEntity(droidId);
        expect(droidAfter.items.map(i => i.id)).toContain(knifeId);
        expect(droidAfter.items.find(i => i.id === knifeId).hostComponentId).toBe(droidComp.id);
        expect(Object.values(wsc.getEntityItems(gen.id)).flat().map(i => i.id)).not.toContain(knifeId);

        // Exactly one world-state broadcast (the whole-state fan-out).
        expect(calls).toHaveLength(1);

        wsc.removeItemFromEntity(droidId, knifeId);
    });

    it('rejects a target component that is not part of the target entity', () => {
        const gen = findKnifeGenerator();
        const droidId = spawnTestDroid();

        const added = wsc.addItemToEntity(gen.id, 'knife', gen.components[0].id);
        expect(added.success, added.message).toBe(true);
        try {
            // The generator's own component: a well-formed id belonging to
            // a DIFFERENT entity — the guard fires before any mutation.
            const result = wsc.takeItemFromEntity(gen.id, added.item.id, droidId, gen.components[0].id);
            expect(result.success).toBe(false);
            expect(result.message).toBe(`Component "${gen.components[0].id}" is not part of entity "${droidId}".`);
            // Source untouched; the droid gained nothing (it may carry its own
            // starter kit — only the attempted knife must be absent).
            expect(Object.values(wsc.getEntityItems(gen.id)).flat().some(i => i.id === added.item.id)).toBe(true);
            expect(wsc.stateEntityController.getEntity(droidId).items.map(i => i.id)).not.toContain(added.item.id);
        } finally {
            wsc.removeItemFromEntity(gen.id, added.item.id);
        }
    });

    it('rejects an unknown target entity', () => {
        const gen = findKnifeGenerator();
        const added = wsc.addItemToEntity(gen.id, 'knife', gen.components[0].id);
        expect(added.success, added.message).toBe(true);
        try {
            const result = wsc.takeItemFromEntity(gen.id, added.item.id, 'no-such-droid', 'any-comp');
            expect(result.success).toBe(false);
            expect(result.message).toBe('Entity "no-such-droid" not found.');
            expect(Object.values(wsc.getEntityItems(gen.id)).flat().some(i => i.id === added.item.id)).toBe(true);
        } finally {
            wsc.removeItemFromEntity(gen.id, added.item.id);
        }
    });

    it('rejects when the target component lacks volume (definition seam; source untouched)', () => {
        const gen = findKnifeGenerator();
        const droidId = spawnTestDroid();
        const droid = wsc.stateEntityController.getEntity(droidId);
        const droidComp = droid.components.find(c => c.type === 'centralBall');

        // The centralBall definition carries only form.volume (the readout
        // source); the manager's transfer check reads traits.Physical.volume,
        // which is undefined for it (→ unbounded). A test-only seam gives the
        // definition a bounded traits volume set at the droid's current used
        // volume, so any further transfer must be rejected.
        const used = droid.items
            .filter(i => i.hostComponentId === droidComp.id)
            .reduce((s, i) => s + (i.hostVolume ?? i.volume ?? 0), 0);
        expect(used, 'the spawned droid carries its starter kit on the centralBall').toBeGreaterThan(0);
        const mgr = wsc.inventoryManager;
        const realDef = mgr._componentDefinitions.centralBall;
        mgr._componentDefinitions.centralBall = { traits: { Physical: { volume: used } } };

        const added = wsc.addItemToEntity(gen.id, 'knife', gen.components[0].id);
        expect(added.success, added.message).toBe(true);
        try {
            const result = wsc.takeItemFromEntity(gen.id, added.item.id, droidId, droidComp.id);
            expect(result.success).toBe(false);
            expect(result.message).toMatch(/does not have enough volume/);
            // The knife stays in the generator; the droid keeps exactly its starter kit.
            expect(Object.values(wsc.getEntityItems(gen.id)).flat().some(i => i.id === added.item.id)).toBe(true);
            expect(wsc.stateEntityController.getEntity(droidId).items.map(i => i.id))
                .toEqual(droid.items.map(i => i.id));
        } finally {
            wsc.removeItemFromEntity(gen.id, added.item.id);
            mgr._componentDefinitions.centralBall = realDef;
        }
    });

    it('lists the droid (with live capacity) in the inspect payload takeOptions', () => {
        const gen = findKnifeGenerator();
        const droidId = spawnTestDroid();

        const payload = wsc.getObjectInspectData(gen.id);
        expect(payload.takeOptions, 'takeOptions is part of the inspect envelope').toBeInstanceOf(Array);
        const mine = payload.takeOptions.find(o => o.id === droidId);
        expect(mine, 'the spawned droid is a take destination').not.toBeNull();
        const ball = mine.components.find(c => c.type === 'centralBall');
        expect(ball, 'the droid centralBall is offered').not.toBeNull();
        expect(ball.capacity, 'centralBall form.volume from data/components.json (the readout source)').toBe(10);
        // Used tracks the droid's live items (spawned droids carry a starter
        // kit, so this is not zero).
        const live = wsc.stateEntityController.getEntity(droidId);
        const expectedUsed = live.items
            .filter(i => i.hostComponentId === ball.id)
            .reduce((s, i) => s + (i.hostVolume ?? i.volume ?? 0), 0);
        expect(ball.used).toBe(expectedUsed);
        // Static props are never offered as take destinations.
        expect(payload.takeOptions.find(o => o.id === gen.id), 'static props excluded').toBeUndefined();
    });
});

// =========================================================================
// Object-interact range gate (wiki/subMDs/frontend/object_viewer.md §7–8)
//
// The Object Viewer's two mutations (move / take) are reach-gated: an
// acting entity must be within OBJECT_INTERACT_RANGE of the object being
// manipulated. The gate is lenient by design — a missing actor (legacy
// route callers) or missing spatial data passes through; a known-but-far
// actor and an unknown actor id are rejected. Tests are self-cleaning
// (spatial restored in finally; the extra test droids and knives are
// harmless — the shared world is discarded with the process).
// =========================================================================

describe('WorldStateController object-interact range gate', () => {
    function findKnifeGenerator() {
        for (const e of Object.values(wsc.getEntities())) {
            if (e && e.name === 'Knife Generator') return e;
        }
        return null;
    }

    function spawnTestDroid() {
        const startRoomId = wsc.roomsController.getUidByLogicalId('start_room');
        return wsc.stateEntityController.spawnEntity('smallBallDroid', startRoomId);
    }

    it('gates a take by the actor distance to the source object', () => {
        const gen = findKnifeGenerator();
        expect(gen, 'the knife generator is a static prop of the built world').not.toBeNull();
        expect(gen.spatial && typeof gen.spatial.x === 'number', 'the generator has spatial data').toBe(true);

        const droidId = spawnTestDroid();
        const droid = wsc.stateEntityController.getEntity(droidId);
        const droidComp = droid.components.find(c => c.type === 'centralBall');
        const added = wsc.addItemToEntity(gen.id, 'knife', gen.components[0].id);
        expect(added.success, added.message).toBe(true);
        const knifeId = added.item.id;

        const origSpatial = droid.spatial;
        try {
            // 200 units from the generator → out of reach.
            droid.spatial = { x: gen.spatial.x + 200, y: gen.spatial.y };
            const far = wsc.takeItemFromEntity(gen.id, knifeId, droidId, droidComp.id, droidId);
            expect(far.success).toBe(false);
            expect(far.message).toMatch(/out of reach/);
            // The knife is untouched on the generator.
            expect(Object.values(wsc.getEntityItems(gen.id)).flat().some(i => i.id === knifeId)).toBe(true);
            expect(droid.items.map(i => i.id)).not.toContain(knifeId);

            // 10 units from the generator → in reach.
            droid.spatial = { x: gen.spatial.x + 10, y: gen.spatial.y };
            const near = wsc.takeItemFromEntity(gen.id, knifeId, droidId, droidComp.id, droidId);
            expect(near.success, near.message).toBe(true);
            expect(droid.items.map(i => i.id)).toContain(knifeId);
        } finally {
            droid.spatial = origSpatial;
        }
    });

    it('gates an in-entity move by the actor distance to the object', () => {
        const gen = findKnifeGenerator();
        const droidId = spawnTestDroid();
        const droid = wsc.stateEntityController.getEntity(droidId);
        const genComp = gen.components[0];
        const added = wsc.addItemToEntity(gen.id, 'knife', genComp.id);
        expect(added.success, added.message).toBe(true);
        const knifeId = added.item.id;

        const origSpatial = droid.spatial;
        try {
            // Far: the gate fires before the manager — the rejection is a
            // range message, not a manager message.
            droid.spatial = { x: gen.spatial.x + 200, y: gen.spatial.y };
            const far = wsc.moveItemInEntity(gen.id, knifeId, genComp.id, droidId);
            expect(far.success).toBe(false);
            expect(far.message).toMatch(/out of reach/);

            // Near: the gate no longer blocks — whatever the manager then
            // decides is manager territory, not range territory (a success
            // carries no message; assert the message is not a range one).
            droid.spatial = { x: gen.spatial.x, y: gen.spatial.y };
            const near = wsc.moveItemInEntity(gen.id, knifeId, genComp.id, droidId);
            expect(near.message || '').not.toMatch(/out of reach/);
        } finally {
            droid.spatial = origSpatial;
        }
    });

    it('rejects an unknown actor id, and passes through for legacy callers and spatial-less actors', () => {
        const gen = findKnifeGenerator();
        const droidId = spawnTestDroid();
        const droid = wsc.stateEntityController.getEntity(droidId);
        const droidComp = droid.components.find(c => c.type === 'centralBall');
        const added = wsc.addItemToEntity(gen.id, 'knife', gen.components[0].id);
        expect(added.success, added.message).toBe(true);
        const knifeId = added.item.id;

        // A hand-crafted request naming a nonexistent actor cannot dodge
        // the gate (unknown ids are rejected, not treated as "no actor").
        const bad = wsc.takeItemFromEntity(gen.id, knifeId, droidId, droidComp.id, 'ent-does-not-exist');
        expect(bad.success).toBe(false);
        expect(bad.message).toMatch(/not found/);

        // No actor at all → the legacy behavior of these routes (no gate),
        // so pre-feature clients of the move endpoint keep working.
        const legacy = wsc.takeItemFromEntity(gen.id, knifeId, droidId, droidComp.id);
        expect(legacy.success, legacy.message).toBe(true);
    });
});
