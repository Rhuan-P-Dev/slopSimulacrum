/**
 * WorldOperatorService — the live-world engine behind the System's "operator console".
 *
 * WHAT THIS IS. All of the Server intents (`propose_action`) the System tab can offer:
 * reading the *running* world (entities, components, organs, items, rooms) and *mutating*
 * it — set a component's `Physical.existence`, drop an organ, put an item in a pocket,
 * spawn/despawn an entity, execute a verb, place/retrieve a machine, start/stop the world.
 *
 * It now reaches the map too. `create_room` adds a room to the running world and opens the
 * door to an existing one; `spawn_world_object` places a prop. Both are **memory only** —
 * the restart builds the map from the packages, so the way to keep a room is to author it
 * (`propose_mod`, kind `rooms`). Neither moves, renames or removes anything that already
 * exists: an installed room's uid is what every entity `location` holds
 * (`wiki/decisions/world-structure-authoring.md`).
 *
 * WHY A SEPARATE MODULE. `WorldAuthoringController` is the LLM chat + the *definition*
 * authoring flow (`propose_mod` -> mod package -> `POST /mods/apply` at the round boundary).
 * This module is the *live-state* half: it never talks to the LLM (`B-2`), never touches
 * the disk (`B-3`), and never swaps definitions. It reads and mutates through the injected
 * `WorldStateController` (in-memory world state) and the `RegistryStore` (live
 * definitions). That keeps every call unit-testable without a provider or a filesystem.
 *
 * THE TRUST CONTRACT (`SEC-4`, `T-1`/`T-2`). The model proposes an `operation` (a server
 * enum) plus free-form `params`. *This* service normalises + type-checks `params`
 * (`T-2`), then resolves ids and verifies the references exist against the *live* world
 * and *live* definitions before the action is accepted. At execute time the same
 * checks run **again** (`T-1`) because the world may have moved between propose and
 * execute. A failed action is reported and the rest of the plan still runs.
 *
 * One facet: every operation maps to a facade public method or to an existing handler
 * (`handlePlaceMachine` / `handleRetrieveMachine`) that the routes already use — the
 * console never reaches into a sub-controller (`AP-5`). The facade has grown deliberately
 * and each addition is pinned in `test/contract/worldStateController.contract.test.js`:
 * `setComponentStat` was the one stat-setter this console needed
 * (`wiki/decisions/system-live-operator.md`), and `createRoom` / `spawnWorldObject` /
 * `getRoomLogicalId` came with the live map
 * (`wiki/decisions/world-structure-authoring.md`).
 *
 * @module WorldOperatorService
 */

import { TRAIT_GROUPS, STAT_NAMES } from '../../shared/StatVocabulary.js';
import { handlePlaceMachine } from '../controllers/core/PlaceMachineHandler.js';
import { handleRetrieveMachine } from '../controllers/core/RetrieveMachineHandler.js';
import { roomDefinitionErrors } from './WorldStructureRules.js';

/**
 * @typedef {Object} OperationSpec
 * @property {string} desc - one sentence for the model (and the tool log).
 * @property {string[]} params - every key this operation accepts.
 * @property {string[]} required - the subset that must be present.
 * @property {Object<string,string>} types - key -> 'string'|'number'|'object'|'boolean'
 *   for the value when present.
 * @property {Function} validate - (params, svc) -> errors[] (entity/component/definition/
 *   stat existence checks on top of the static `params` check).
 * @property {Function} execute - (params, svc) -> result (throws on failure; the service
 *   catches and reports).
 * @property {Function} summary - (params) -> the one-line text the UI card prints.
 */

/** The frozen operation registry. Add an operation here and it is offered to the model. */
const OPERATIONS = Object.freeze({
    spawn_entity: {
        desc: 'Spawn a new entity from a blueprint into a room.',
        params: ['blueprintName', 'roomId'],
        required: ['blueprintName', 'roomId'],
        types: { blueprintName: 'string', roomId: 'string' },
        validate: (p, s) => {
            const errs = [];
            s._requireDefinition('blueprints', p.blueprintName, errs);
            s._requireNonNullRoom(p.roomId, errs);
            return errs;
        },
        execute: (p, s) => s.wsc.spawnEntity(p.blueprintName, p.roomId),
        summary: (p) => `spawn entity blueprint "${p.blueprintName}" into room "${p.roomId}"`
    },
    spawn_world_object: {
        desc: 'Place a prop (a static world object) in a room now: a real entity built from a blueprint, tagged isStatic — it is targetable and breakable, but never plans. Memory only: to keep it across a restart, author a "worldObjects" package instead.',
        params: ['blueprint', 'roomId', 'name', 'position'],
        required: ['blueprint', 'roomId'],
        types: { blueprint: 'string', roomId: 'string', name: 'string', position: 'object' },
        validate: (p, s) => {
            const errs = [];
            s._requireDefinition('blueprints', p.blueprint, errs);
            s._requireRoom(p.roomId, errs);
            if (p.position !== undefined && p.position !== null) {
                const bad = ['x', 'y'].filter((axis) => p.position?.[axis] !== undefined
                    && (typeof p.position[axis] !== 'number' || !Number.isFinite(p.position[axis])));
                if (bad.length > 0) errs.push(`position.${bad.join(', ')} must be a finite number (room-relative; absent means the room centre).`);
            }
            return errs;
        },
        execute: (p, s) => s.wsc.spawnWorldObject({
            blueprint: p.blueprint,
            roomId: s._resolveRoomId(p.roomId),
            name: p.name ?? null,
            position: p.position ?? null
        }),
        summary: (p) => `place prop "${p.name ?? p.blueprint}" (blueprint ${p.blueprint}) in room ${p.roomId}`
    },
    despawn_entity: {
        desc: 'Remove an entity from the world (and spill/despawn its contents).',
        params: ['entityId'],
        required: ['entityId'],
        types: { entityId: 'string' },
        validate: (p, s) => s._requireNonNullEntity(p.entityId),
        execute: (p, s) => s.wsc.despawnEntity(p.entityId),
        summary: (p) => `despawn entity ${p.entityId}`
    },
    move_entity: {
        desc: 'Move an entity to a different room.',
        params: ['entityId', 'targetRoomId'],
        required: ['entityId', 'targetRoomId'],
        types: { entityId: 'string', targetRoomId: 'string' },
        validate: (p, s) => {
            const errs = [];
            s._requireNonNullEntity(p.entityId, errs);
            s._requireNonNullRoom(p.targetRoomId, errs);
            return errs;
        },
        execute: (p, s) => s.wsc.moveEntity(p.entityId, p.targetRoomId),
        summary: (p) => `move entity ${p.entityId} to room "${p.targetRoomId}"`
    },
    create_room: {
        desc: 'Add a NEW room to the running map and open a door to an existing one (both ways, so nothing is stranded). definition is one room exactly as the "rooms" registry shapes it (name, x, y, width, height, atmosphere, surface, acoustic, lightSource, ceiling, condition, power). Memory only: to keep the room across a restart, author the same definition into a "rooms" package. An existing room is never moved, renamed or resized.',
        params: ['logicalId', 'definition', 'connectFrom'],
        required: ['logicalId', 'definition', 'connectFrom'],
        types: { logicalId: 'string', definition: 'object', connectFrom: 'object' },
        validate: (p, s) => s._checkRoomCreation(p),
        execute: (p, s) => s.wsc.createRoom({
            logicalId: p.logicalId,
            definition: p.definition,
            connectFrom: s._normalizedConnectFrom(p.connectFrom)
        }),
        summary: (p) => `create room "${p.logicalId}" (${p.definition?.name ?? 'no name'}), connected through "${p.connectFrom?.door ?? '?'}" of ${p.connectFrom?.roomId ?? '?'}`
    },
    set_entity_stat: {
        desc: 'Set an entity-level stat (e.g. Pleasure.pleasure) to an absolute value. The entity is the owner, not a component.',
        params: ['entityId', 'traitId', 'statName', 'value'],
        required: ['entityId', 'traitId', 'statName', 'value'],
        types: { entityId: 'string', traitId: 'string', statName: 'string', value: 'number' },
        validate: (p, s) => {
            const errs = [];
            s._requireNonNullEntity(p.entityId, errs);
            if (errs.length) return errs;
            if (!s._knownTraitGroup(p.traitId)) errs.push(`Unknown trait group "${p.traitId}". Use: ${Object.values(TRAIT_GROUPS).join(', ')}.`);
            if (errs.length) return errs;
            // Whole-entity stats are exactly the ones declared per blueprint in
            // data/mods/core-entity-attributes/entityAttributes.json (flat
            // "Group.stat" keys, e.g. Pleasure.pleasure). Component stats —
            // Physical.existence, Movement.move, ... — live on component instances;
            // they belong to `set_component_stat`, which takes a component id. Pointing
            // this lever at a component stat must be refused here: wsc.
            // setEntityAttributeDelta is a silent no-op for undeclared stats (returns
            // false, nothing mutates), which would otherwise let an Execute report a
            // fake "applied".
            const decls = s._entityAttributeDeclarations(s.wsc.getEntity(p.entityId)?.blueprint);
            if (!decls || !Object.hasOwn(decls, `${p.traitId}.${p.statName}`)) {
                errs.push(`No entity attribute "${p.traitId}.${p.statName}" for this entity. `
                    + `Known: ${Object.keys(decls || {}).join(', ') || 'none'}. `
                    + `For component stats, use set_component_stat with a component id.`);
            }
            return errs;
        },
        execute: (p, s) => {
            const entity = s.wsc.getEntity(p.entityId);
            if (!entity) throw new Error(`Entity "${p.entityId}" is gone.`);
            const current = s.wsc.getEntityAttribute(p.entityId, p.traitId, p.statName);
            const delta = (typeof current === 'number' && Number.isFinite(current)) ? p.value - current : p.value;
            return s.wsc.setEntityAttributeDelta(p.entityId, p.traitId, p.statName, delta);
        },
        summary: (p) => `set entity ${p.entityId} ${p.traitId}.${p.statName} -> ${p.value}`
    },
    set_component_stat: {
        desc: 'Set a component stat to an absolute value — e.g. Physical.existence -> 0 makes the matter "gone". Use a component id from inspect_entity.',
        params: ['entityId', 'componentId', 'traitGroup', 'statName', 'value'],
        required: ['entityId', 'componentId', 'traitGroup', 'statName', 'value'],
        types: { entityId: 'string', componentId: 'string', traitGroup: 'string', statName: 'string', value: 'number' },
        validate: (p, s) => {
            const errs = [];
            s._requireNonNullEntity(p.entityId, errs);
            if (errs.length) return errs;
            s._requireComponent(p.entityId, p.componentId, errs);
            if (errs.length) return errs;
            if (!s._knownTraitGroup(p.traitGroup)) errs.push(`Unknown trait group "${p.traitGroup}". Use: ${Object.values(TRAIT_GROUPS).join(', ')}.`);
            if (errs.length) return errs;
            if (!s._knownStatName(p.statName)) errs.push(`Unknown stat "${p.statName}". Use: ${Object.values(STAT_NAMES).join(', ')}.`);
            if (errs.length) return errs;
            // A component owns only the stats its organs/recipe grant it (stats are
            // seeded at spawn from organs/recipe, not by the operator). A bare SET
            // via componentController.updateComponentStat would otherwise create a
            // "ghost" stat (setStats deep-merges and creates the group), which the
            // range layer and client then read as a real value — the trap "set
            // Physical.move / Physical.strength and the client shows something it never
            // saw". Gate upstream: require the component to own the stat, both at
            // proposal time and again at execution re-validation.
            if (!s._componentOwnsStat(p.entityId, p.componentId, p.traitGroup, p.statName)) {
                errs.push(`Component ${p.componentId} does not own ${p.traitGroup}.${p.statName}; `
                    + `component stats come from organs/recipe, not free text. Inspect the entity first.`);
            }
            return errs;
        },
        execute: (p, s) => s.wsc.setComponentStat(p.entityId, p.componentId, p.traitGroup, p.statName, p.value),
        summary: (p) => `set component ${p.componentId} (entity ${p.entityId}) ${p.traitGroup}.${p.statName} -> ${p.value}`
    },
    remove_component: {
        desc: 'Fully destroy a component: spill its contents, cascade dependents, remove it, and clean up. If it is the last matter, the entity may eliminate. (set_component_stat -> 0 leaves it "gone" in place; this removes it.)',
        params: ['entityId', 'componentId'],
        required: ['entityId', 'componentId'],
        types: { entityId: 'string', componentId: 'string' },
        validate: (p, s) => {
            const errs = [];
            s._requireNonNullEntity(p.entityId, errs);
            if (errs.length) return errs;
            s._requireComponent(p.entityId, p.componentId, errs);
            return errs;
        },
        execute: (p, s) => s.wsc.removeBrokenComponent({ entityId: p.entityId, componentId: p.componentId, kind: 'component' }),
        summary: (p) => `remove component ${p.componentId} from entity ${p.entityId} (spill + cascade + cleanup)`
    },
    add_organ: {
        desc: 'Add an internal component (organ) to a host component. Use a registered internalComponent type.',
        params: ['entityId', 'hostComponentId', 'internalComponentType'],
        required: ['entityId', 'hostComponentId', 'internalComponentType'],
        types: { entityId: 'string', hostComponentId: 'string', internalComponentType: 'string' },
        validate: (p, s) => {
            const errs = [];
            s._requireNonNullEntity(p.entityId, errs);
            if (errs.length) return errs;
            s._requireComponent(p.entityId, p.hostComponentId, errs);
            if (errs.length) return errs;
            s._requireDefinition('internalComponents', p.internalComponentType, errs);
            return errs;
        },
        execute: (p, s) => s.wsc.addInternalComponent(p.entityId, p.hostComponentId, p.internalComponentType),
        summary: (p) => `add organ "${p.internalComponentType}" to component ${p.hostComponentId} of entity ${p.entityId}`
    },
    remove_organ: {
        desc: 'Remove an internal component (organ) from a host component.',
        params: ['entityId', 'hostComponentId', 'internalComponentId'],
        required: ['entityId', 'hostComponentId', 'internalComponentId'],
        types: { entityId: 'string', hostComponentId: 'string', internalComponentId: 'string' },
        validate: (p, s) => {
            const errs = [];
            s._requireNonNullEntity(p.entityId, errs);
            if (errs.length) return errs;
            s._requireComponent(p.entityId, p.hostComponentId, errs);
            return errs;
        },
        execute: (p, s) => s.wsc.removeInternalComponent(p.entityId, p.hostComponentId, p.internalComponentId),
        summary: (p) => `remove organ ${p.internalComponentId} from component ${p.hostComponentId} of entity ${p.entityId}`
    },
    add_item: {
        desc: 'Give an entity an item (a registered itemType). Put it in a component/pocket if `targetComponentId` is given.',
        params: ['entityId', 'itemType', 'targetComponentId'],
        required: ['entityId', 'itemType'],
        types: { entityId: 'string', itemType: 'string', targetComponentId: 'string' },
        validate: (p, s) => {
            const errs = [];
            s._requireNonNullEntity(p.entityId, errs);
            if (errs.length) return errs;
            s._requireDefinition('inventoryItems', p.itemType, errs);
            if (p.targetComponentId) s._requireComponent(p.entityId, p.targetComponentId, errs);
            return errs;
        },
        execute: (p, s) => s.wsc.addItemToEntity(p.entityId, p.itemType, p.targetComponentId),
        summary: (p) => `give item "${p.itemType}" to entity ${p.entityId}` + (p.targetComponentId ? ` into component ${p.targetComponentId}` : '')
    },
    remove_item: {
        desc: 'Remove an item by its id from an entity.',
        params: ['entityId', 'itemId'],
        required: ['entityId', 'itemId'],
        types: { entityId: 'string', itemId: 'string' },
        validate: (p, s) => {
            const errs = [];
            s._requireNonNullEntity(p.entityId, errs);
            if (errs.length) return errs;
            if (!s._entityHasItem(p.entityId, p.itemId)) errs.push(`Entity ${p.entityId} does not hold item "${p.itemId}". Use inspect_entity.`);
            return errs;
        },
        execute: (p, s) => s.wsc.removeItemFromEntity(p.entityId, p.itemId),
        summary: (p) => `remove item ${p.itemId} from entity ${p.entityId}`
    },
    move_item: {
        desc: 'Move an item within one entity to a different component/pocket.',
        params: ['entityId', 'itemId', 'targetComponentId'],
        required: ['entityId', 'itemId', 'targetComponentId'],
        types: { entityId: 'string', itemId: 'string', targetComponentId: 'string' },
        validate: (p, s) => {
            const errs = [];
            s._requireNonNullEntity(p.entityId, errs);
            if (errs.length) return errs;
            if (!s._entityHasItem(p.entityId, p.itemId)) errs.push(`Entity ${p.entityId} does not hold item "${p.itemId}".`);
            if (errs.length) return errs;
            s._requireComponent(p.entityId, p.targetComponentId, errs);
            return errs;
        },
        execute: (p, s) => s.wsc.moveItemInEntity(p.entityId, p.itemId, p.targetComponentId, p.entityId),
        summary: (p) => `move item ${p.itemId} within entity ${p.entityId} to component ${p.targetComponentId}`
    },
    transfer_item: {
        desc: 'Move an item from one entity to another.',
        params: ['fromEntityId', 'itemId', 'toEntityId', 'toComponentId'],
        required: ['fromEntityId', 'itemId', 'toEntityId'],
        types: { fromEntityId: 'string', itemId: 'string', toEntityId: 'string', toComponentId: 'string' },
        validate: (p, s) => {
            const errs = [];
            s._requireNonNullEntity(p.fromEntityId, errs);
            s._requireNonNullEntity(p.toEntityId, errs);
            if (errs.length) return errs;
            if (!s._entityHasItem(p.fromEntityId, p.itemId)) errs.push(`Entity ${p.fromEntityId} does not hold item "${p.itemId}".`);
            if (errs.length) return errs;
            if (p.toComponentId) s._requireComponent(p.toEntityId, p.toComponentId, errs);
            return errs;
        },
        execute: (p, s) => s.wsc.takeItemFromEntity(p.fromEntityId, p.itemId, p.toEntityId, p.toComponentId, p.fromEntityId),
        summary: (p) => `transfer item ${p.itemId} from ${p.fromEntityId} to ${p.toEntityId}`
    },
    equip_item: {
        desc: 'Equip an item onto a component (the world resolves the component).',
        params: ['entityId', 'itemId'],
        required: ['entityId', 'itemId'],
        types: { entityId: 'string', itemId: 'string' },
        validate: (p, s) => {
            const errs = [];
            s._requireNonNullEntity(p.entityId, errs);
            if (errs.length) return errs;
            if (!s._entityHasItem(p.entityId, p.itemId)) errs.push(`Entity ${p.entityId} does not hold item "${p.itemId}".`);
            return errs;
        },
        execute: (p, s) => s.wsc.equipItem(p.entityId, p.itemId, p.itemId, null),
        summary: (p) => `equip item ${p.itemId} on entity ${p.entityId}`
    },
    unequip_item: {
        desc: 'Unequip an item from an entity.',
        params: ['entityId', 'itemId'],
        required: ['entityId', 'itemId'],
        types: { entityId: 'string', itemId: 'string' },
        validate: (p, s) => {
            const errs = [];
            s._requireNonNullEntity(p.entityId, errs);
            if (errs.length) return errs;
            if (!s._entityHasItem(p.entityId, p.itemId)) errs.push(`Entity ${p.entityId} does not hold item "${p.itemId}".`);
            return errs;
        },
        execute: (p, s) => s.wsc.unequipItem(p.entityId, p.itemId),
        summary: (p) => `unequip item ${p.itemId} from entity ${p.entityId}`
    },
    wear_item: {
        desc: 'Wear an item on a component (e.g. a garment).',
        params: ['entityId', 'itemId', 'componentId'],
        required: ['entityId', 'itemId'],
        types: { entityId: 'string', itemId: 'string', componentId: 'string' },
        validate: (p, s) => {
            const errs = [];
            s._requireNonNullEntity(p.entityId, errs);
            if (errs.length) return errs;
            if (!s._entityHasItem(p.entityId, p.itemId)) errs.push(`Entity ${p.entityId} does not hold item "${p.itemId}".`);
            if (p.componentId) s._requireComponent(p.entityId, p.componentId, errs);
            return errs;
        },
        execute: (p, s) => s.wsc.wearItem(p.entityId, p.itemId, p.componentId),
        summary: (p) => `wear item ${p.itemId} on entity ${p.entityId}` + (p.componentId ? ` on component ${p.componentId}` : '')
    },
    craft_item: {
        desc: 'Run a crafting recipe on an entity (the recipe id comes from /crafting/recipes).',
        params: ['entityId', 'recipeId', 'componentId'],
        required: ['entityId', 'recipeId'],
        types: { entityId: 'string', recipeId: 'string', componentId: 'string' },
        validate: (p, s) => {
            const errs = [];
            s._requireNonNullEntity(p.entityId, errs);
            if (errs.length) return errs;
            s._requireDefinition('crafting', p.recipeId, errs);
            if (p.componentId) s._requireComponent(p.entityId, p.componentId, errs);
            return errs;
        },
        execute: (p, s) => s.wsc.craftItems(p.entityId, p.recipeId, p.componentId, []),
        summary: (p) => `craft recipe "${p.recipeId}" on entity ${p.entityId}`
    },
    execute_action: {
        desc: 'Execute a verb (action) by an entity, e.g. damage a component or move. `params` are the action\'s own arguments.',
        params: ['entityId', 'actionName', 'params'],
        required: ['entityId', 'actionName'],
        types: { entityId: 'string', actionName: 'string', params: 'object' },
        validate: (p, s) => {
            const errs = [];
            s._requireNonNullEntity(p.entityId, errs);
            if (errs.length) return errs;
            s._requireDefinition('actions', p.actionName, errs);
            return errs;
        },
        execute: (p, s) => s.wsc.executeAction(p.actionName, p.entityId, p.params ?? {}),
        summary: (p) => `execute action "${p.actionName}" by entity ${p.entityId}`
    },
    place_machine: {
        desc: 'Materialise a carried machine item as a world entity at a position in the holder\'s room (the item is consumed).',
        params: ['entityId', 'itemId', 'itemType', 'targetX', 'targetY'],
        required: ['entityId'],
        types: { entityId: 'string', itemId: 'string', itemType: 'string', targetX: 'number', targetY: 'number' },
        validate: (p, s) => {
            const errs = [];
            s._requireNonNullEntity(p.entityId, errs);
            if (errs.length) return errs;
            if (!p.itemId && !p.itemType) errs.push('Give the machine item by id or by type.');
            return errs;
        },
        execute: (p, s) => handlePlaceMachine({ worldStateController: s.wsc, machineRegistry: s.wsc.machineRegistry }, p),
        summary: (p) => `place machine (item ${p.itemId || p.itemType || '?'}) held by entity ${p.entityId}`
    },
    retrieve_machine: {
        desc: 'Retrieve a placed machine back into a holder\'s inventory (its stored contents spill first).',
        params: ['entityId', 'targetEntityId', 'machineType'],
        required: ['entityId'],
        types: { entityId: 'string', targetEntityId: 'string', machineType: 'string' },
        validate: (p, s) => {
            const errs = [];
            s._requireNonNullEntity(p.entityId, errs);
            if (errs.length) return errs;
            if (!p.targetEntityId && !p.machineType) errs.push('Give the machine by its world entity id or by type.');
            return errs;
        },
        execute: (p, s) => handleRetrieveMachine({ worldStateController: s.wsc, machineRegistry: s.wsc.machineRegistry }, p),
        summary: (p) => `retrieve machine ${p.targetEntityId || p.machineType || '?'} into entity ${p.entityId}`
    },
    start_world: {
        desc: 'Start the world (turns, energy flow, effects).',
        params: [],
        required: [],
        types: {},
        validate: () => [],
        execute: (p, s) => s.wsc.startWorld(),
        summary: () => 'start the world'
    },
    stop_world: {
        desc: 'Stop the world (freeze turns, energy flow, effects).',
        params: [],
        required: [],
        types: {},
        validate: () => [],
        execute: (p, s) => s.wsc.stopWorld(),
        summary: () => 'stop the world'
    },
    recreate_world: {
        desc: 'Recreate the whole world (respawn from the definition, wiping the current run).',
        params: [],
        required: [],
        types: {},
        validate: () => [],
        execute: (p, s) => s.wsc.recreateWorld(),
        summary: () => 'recreate the world'
    }
});

/** The operation names, in order — the menu the model is told to pick from. */
export const OPERATION_NAMES = Object.keys(OPERATIONS);

export class WorldOperatorService {
    constructor({ worldStateController, registryStore }) {
        if (!worldStateController) throw new TypeError('WorldOperatorService: worldStateController is required');
        this.wsc = worldStateController;
        this.registryStore = registryStore ?? null;
        this.operations = OPERATIONS;
    }

    // =========================================================================
    // Reads (bounded, for the model)
    // =========================================================================

    listEntities() {
        const entities = this.wsc.getEntities() || {};
        const list = [];
        for (const [id, e] of Object.entries(entities)) {
            if (e && typeof e === 'object') {
                list.push({ id, name: e.name ?? null, blueprint: e.blueprint ?? null, location: e.location ?? null, isStatic: e.isStatic === true });
            }
        }
        return { count: list.length, entities: list };
    }

    inspectEntity(entityId) {
        const entity = this.wsc.getEntity(entityId) || null;
        if (!entity) return null;
        const components = (entity.components ?? []).map((c) => this._componentView(c));
        const organs = this.wsc.getInternalComponentsForEntity(entityId) ?? {};
        const items = this._itemsView(this.wsc.getEntityItems(entityId) ?? {}, this.wsc.getEquippedItems(entityId) ?? []);
        return {
            id: entity.id,
            name: entity.name ?? null,
            blueprint: entity.blueprint ?? null,
            location: entity.location ?? null,
            spatial: entity.spatial ?? null,
            isStatic: entity.isStatic === true,
            isMachine: entity.isMachine === true,
            machineType: entity.machineType ?? null,
            components,
            organs,
            items
        };
    }

    /**
     * The live rooms, with **both** vocabularies a room has: `id` (the uid the world runs
     * on, what an entity's `location` holds) and `logicalId` (the key the `rooms` registry
     * reads, and what a room authored in a package is written under). A model that has only
     * seen one of them will cite the other, so the two are printed together.
     */
    listRooms() {
        const rooms = this.wsc.getRooms() || {};
        const list = [];
        for (const [id, r] of Object.entries(rooms)) {
            if (r && typeof r === 'object') {
                list.push({
                    id,
                    logicalId: this.wsc.getRoomLogicalId?.(id) ?? null,
                    name: r.name ?? null,
                    width: r.width ?? null,
                    height: r.height ?? null,
                    doors: Object.keys(r.connections ?? {})
                });
            }
        }
        return { count: list.length, rooms: list };
    }

    _componentView(c) {
        if (!c || typeof c !== 'object') return { id: c ?? null, type: null, stats: {}, existence: null };
        const stats = this.wsc.getComponentStats(c.id) ?? {};
        return {
            id: c.id ?? null,
            type: c.type ?? null,
            stats,
            existence: stats?.Physical?.existence ?? null
        };
    }

    _itemsView(containerMap, equipped) {
        const items = [];
        for (const [container, list] of Object.entries(containerMap ?? {})) {
            for (const it of list ?? []) {
                if (it && typeof it === 'object') {
                    items.push({ id: it.id ?? null, type: it.type ?? it.itemType ?? null, container });
                }
            }
        }
        for (const eq of equipped ?? []) {
            if (eq && typeof eq === 'object') {
                items.push({ id: eq.itemId ?? null, type: eq.itemType ?? null, container: 'equipped', onComponent: eq.componentId ?? null });
            }
        }
        return items;
    }

    // =========================================================================
    // Action planning + execution
    // =========================================================================

    /**
     * Validate one proposed action (static param check + live existence check).
     * @param {string} operation
     * @param {Object|null} rawParams
     * @returns {{ ok: boolean, intent?: {operation, params, summary}, errors?: string[] }}
     */
    validateAction(operation, rawParams) {
        const spec = this.operations[operation];
        if (!spec) {
            return {
                ok: false,
                errors: [`Unknown operation "${operation}". Allowed: ${Object.keys(this.operations).join(', ')}.`]
            };
        }
        const params = this._normalizeParams(spec, rawParams);
        const staticErrors = this._checkParams(spec, params);
        if (staticErrors.length > 0) return { ok: false, errors: staticErrors };
        const liveErrors = spec.validate(params, this);
        if (liveErrors.length > 0) return { ok: false, errors: [...liveErrors] };
        return {
            ok: true,
            intent: {
                operation,
                params,
                summary: spec.summary(params)
            }
        };
    }

    /**
     * Execute a plan of actions in order, re-validating each against the *current*
     * world. One result per action; a failure does not stop the rest.
     * @param {Array<{operation, params, summary, id?>>} actions
     * @returns {{ executed: number, results: Array<{operation, summary, status, error?, result?}> }}
     */
    executeActions(actions) {
        const results = (actions ?? []).map((action) => this._executeAction(action));
        return { executed: results.length, results };
    }

    _executeAction(action) {
        const summary = action?.summary ?? action?.operation ?? 'unknown action';
        try {
            const spec = this.operations[action?.operation];
            if (!spec) throw new Error(`Unknown operation "${action?.operation}".`);
            const params = this._normalizeParams(spec, action?.params);
            const errors = [...this._checkParams(spec, params), ...(spec.validate(params, this) ?? [])];
            if (errors.length > 0) {
                return { operation: action?.operation, summary, status: 'error', error: errors.join('; ') };
            }
            const outcome = spec.execute(params, this);
            // A live op can be *refused or a no-op* without throwing: the stat setters
            // return `false` (already-at-value / clamped back to bounds) and the
            // action/item/machine layer returns `{ success: false, message|error }`.
            // `status: 'ok'` must mean "the world actually changed" — never "we asked".
            const rejected = (outcome === false)
                || ((outcome && typeof outcome === 'object') && (outcome.success === false));
            if (rejected) {
                const detail = (outcome && typeof outcome === 'object')
                    && (typeof outcome.message === 'string' || typeof outcome.error === 'string')
                    ? (outcome.message ?? outcome.error)
                    : 'Operation was refused or had no effect.';
                return { operation: action?.operation, summary, status: 'error', error: detail };
            }
            return { operation: action?.operation, summary, status: 'ok', result: outcome };
        } catch (error) {
            const message = (error && typeof error.message === 'string') ? error.message : String(error);
            return { operation: action?.operation, summary, status: 'error', error: message };
        }
    }

    // =========================================================================
    // Param normalisation + checks
    // =========================================================================

    _normalizeParams(spec, rawParams) {
        const raw = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)) ? rawParams : {};
        const out = {};
        for (const key of spec.params) {
            const v = raw[key];
            out[key] = (key === 'params' && v !== undefined && typeof v !== 'object') ? {} : v;
        }
        return out;
    }

    _checkParams(spec, params) {
        const errs = [];
        const allParams = spec.params ?? [];
        const required = spec.required ?? [];
        const types = spec.types ?? {};
        for (const key of required) {
            const v = params[key];
            if (v === undefined || v === null) { errs.push(`"${key}" is required.`); continue; }
            const t = types[key] ?? 'string';
            if (!this._isType(t, v)) { errs.push(`"${key}" must be a ${t}.`); }
        }
        for (const key of allParams) {
            if (required.includes(key)) continue;
            const v = params[key];
            if (v === undefined || v === null) continue;
            const t = types[key] ?? 'string';
            if (!this._isType(t, v)) { errs.push(`"${key}" must be a ${t} when present.`); }
        }
        return errs;
    }

    _isType(type, value) {
        if (type === 'string') return typeof value === 'string' && value.trim().length > 0;
        if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
        if (type === 'boolean') return typeof value === 'boolean';
        if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
        return true;
    }

    // =========================================================================
    // Live existence helpers (push onto an `errs` array)
    // =========================================================================

    /**
     * Whether one component instance actually carries `traitGroup.statName` in its
     * live stats (organs/recipe-granted at spawn; ghosts never count). Reads the
     * live world through the facade's public surface.
     * @private
     * @returns {boolean}
     */
    _componentOwnsStat(entityId, componentId, traitGroup, statName) {
        const entities = this.wsc.getEntities?.() ?? {};
        const entity = entities[entityId] ?? null;
        if (!entity) return false;
        const components = Array.isArray(entity.components) ? entity.components : [];
        const comp = components.find((c) => c && typeof c === 'object' && c.id === componentId);
        if (!comp) return false;
        const instances = this.wsc.getAll?.()?.components?.instances ?? {};
        const stats = instances[comp.id] ?? null;
        const group = stats?.[traitGroup];
        return group && typeof group[statName] === 'number';
    }

    _requireNonNullEntity(entityId, errs) {
        if (typeof entityId !== 'string' || entityId.trim().length === 0) return;
        const entity = this.wsc.getEntity?.(entityId) ?? null;
        if (!entity) errs.push(`No entity "${entityId}". Call list_entities.`);
    }

    _requireNonNullRoom(roomId, errs) {
        if (typeof roomId !== 'string' || roomId.trim().length === 0) return;
        const rooms = Object.keys(this.wsc.getRooms() ?? {});
        if (!rooms.includes(roomId)) errs.push(`No room "${roomId}". Call list_rooms.`);
    }

    /**
     * Resolve a room named EITHER way the world has for it: a room uid (what `getRooms()`
     * is keyed by, what an entity's `location` holds) or the logical key of the definition
     * (`start_room`, what a `rooms` package and a `worldObjects` entry name). Null when it
     * resolves to nothing.
     * @private
     * @param {unknown} room
     * @returns {string|null} the room uid
     */
    _resolveRoomId(room) {
        if (typeof room !== 'string' || room.trim() === '') return null;
        if (this.wsc.getRooms?.()?.[room]) return room;
        return this.wsc.getRoomUidByLogicalId?.(room) ?? null;
    }

    /**
     * A room reference must resolve, by uid or by logical key. The message names both
     * vocabularies, because the model has seen both (`list_rooms` shows them side by side).
     * @private
     * @param {unknown} room
     * @param {Array<string>} errs
     */
    _requireRoom(room, errs) {
        if (typeof room !== 'string' || room.trim().length === 0) {
            errs.push('A room is required (the room id from list_rooms, or its key in the "rooms" registry).');
            return;
        }
        if (!this._resolveRoomId(room)) errs.push(`No room "${room}". Call list_rooms (id or logicalId).`);
    }

    /**
     * The checks one `create_room` has to pass before it goes on the table: the definition
     * is a room the map can be built from (the boot rules, `WorldStructureRules` — a room
     * that would refuse to load tomorrow is refused now, in the conversation), the key is
     * free, and the door asked for can actually be opened: the source room exists and does
     * not already have a door of that name (an existing door is never re-pointed).
     * @private
     * @param {{ logicalId: string, definition: Object, connectFrom: Object }} p
     * @returns {Array<string>}
     */
    _checkRoomCreation(p) {
        const errs = roomDefinitionErrors(String(p.logicalId ?? ''), p.definition);
        if (typeof p.logicalId !== 'string' || p.logicalId.trim() === '') {
            errs.push('"logicalId" is the key the "rooms" registry will read, e.g. "smelter_annex".');
        } else if (this.wsc.getRoomUidByLogicalId?.(p.logicalId)) {
            errs.push(`A room "${p.logicalId}" is already installed. An installed room is never redefined — name it something new.`);
        }
        const connectFrom = p.connectFrom;
        if (!connectFrom || typeof connectFrom !== 'object' || Array.isArray(connectFrom)) {
            errs.push('"connectFrom" is required: { roomId, door } — a room nobody can reach is not a room the world has.');
            return errs;
        }
        const sourceRoomId = this._resolveRoomId(connectFrom.roomId);
        if (!sourceRoomId) {
            errs.push(`"connectFrom.roomId": no room "${connectFrom.roomId}". Call list_rooms.`);
        } else if (sourceRoomId === this.wsc.getRoomUidByLogicalId?.(p.logicalId)) {
            errs.push('A room cannot connect to itself.');
        }
        if (typeof connectFrom.door !== 'string' || connectFrom.door.trim() === '') {
            errs.push('"connectFrom.door" is the door name to open in that room, e.g. "north_door".');
        } else if (sourceRoomId) {
            const source = this.wsc.getRooms?.()?.[sourceRoomId];
            if (Object.prototype.hasOwnProperty.call(source?.connections ?? {}, connectFrom.door.trim())) {
                errs.push(`Room "${connectFrom.roomId}" already has a door "${connectFrom.door}". An existing door is never re-pointed — choose a new name.`);
            }
        }
        return errs;
    }

    /**
     * The `connectFrom` the facade expects, with the source room passed through as named
     * (the facade resolves it the same way, against uid or logical key).
     * @private
     * @param {Object} connectFrom
     * @returns {{ roomId: string, door: string, targetDoor: string|null, position: Object|null }}
     */
    _normalizedConnectFrom(connectFrom = {}) {
        return {
            roomId: connectFrom.roomId,
            door: connectFrom.door,
            targetDoor: typeof connectFrom.targetDoor === 'string' && connectFrom.targetDoor.trim() !== ''
                ? connectFrom.targetDoor.trim()
                : null,
            position: connectFrom.position && typeof connectFrom.position === 'object' ? connectFrom.position : null
        };
    }

    _requireDefinition(registryKind, key, errs) {
        if (typeof key !== 'string' || key.trim().length === 0) return;
        if (!this.registryStore || typeof this.registryStore.has !== 'function') {
            errs.push(`Registry "${registryKind}" is not available; cannot confirm definition "${key}".`);
            return;
        }
        if (!this.registryStore.has(registryKind)) {
            errs.push(`Registry "${registryKind}" is not available; cannot confirm definition "${key}".`);
            return;
        }
        const reg = this.registryStore.read(registryKind);
        if (!reg || typeof reg !== 'object' || Array.isArray(reg)) {
            errs.push(`Registry "${registryKind}" is unreadable.`);
            return;
        }
        if (!Object.prototype.hasOwnProperty.call(reg, key)) {
            const available = Object.keys(reg).slice(0, 6);
            errs.push(`No "${registryKind}" definition "${key}". Available: ${available.join(', ') || 'none'}.`);
        }
    }

    _requireComponent(entityId, componentId, errs) {
        if (typeof componentId !== 'string' || componentId.trim().length === 0) return;
        const entity = this.wsc.getEntity?.(entityId) ?? null;
        if (!entity) return; // entity absence was already reported by _requireNonNullEntity
        const ids = (entity.components ?? []).map((c) => (c && typeof c === 'object' ? c.id : null)).filter(Boolean);
        if (!ids.includes(componentId)) errs.push(`No component "${componentId}" on entity "${entityId}". Call inspect_entity.`);
    }

    _knownTraitGroup(traitGroup) {
        return typeof traitGroup === 'string' && Object.values(TRAIT_GROUPS).includes(traitGroup);
    }

    _knownStatName(statName) {
        return typeof statName === 'string' && Object.values(STAT_NAMES).includes(statName);
    }

    _entityHasItem(entityId, itemId) {
        if (typeof itemId !== 'string' || itemId.trim().length === 0) return false;
        const entity = this.wsc.getEntity?.(entityId) ?? null;
        if (!entity) return false;
        const hasId = (item) => item && typeof item === 'object' && item.id === itemId;
        const containers = this.wsc.getEntityItems?.(entityId) ?? {};
        for (const list of Object.values(containers)) {
            if (Array.isArray(list) && list.some(hasId)) return true;
        }
        const equipped = this.wsc.getEquippedItems?.(entityId) ?? [];
        if (Array.isArray(equipped)) {
            for (const item of equipped) {
                if (item && typeof item === 'object' && item.itemId === itemId) return true;
            }
        }
        return false;
    }

    _entityAttributeDeclarations(blueprint) {
        try {
            if (typeof blueprint !== 'string' || blueprint.trim().length === 0) return null;
            const decls = this.wsc.getEntityAttributeDeclarations?.(blueprint);
            return decls && typeof decls === 'object' && !Array.isArray(decls) ? decls : null;
        } catch (error) {
            return null;
        }
    }
}

export default WorldOperatorService;