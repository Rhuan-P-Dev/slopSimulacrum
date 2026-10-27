/**
 * ViewController — the generic "what can I see?" reader.
 *
 * Owns the payload behind GET /view/:id (viewRoutes.js). Resolves a typed id
 * into a view node describing what is observable about it:
 *   - ENTITY    — the entity record, one node per component (component node
 *     or clothing node — see clothing rule below), and the entity's full
 *     inventory with inventory totals;
 *   - COMPONENT — that component's node (or a clothing node, same rule);
 *   - ITEM      — an item instance: registry data (name/description/materials/
 *     form/wear) plus live instance data (owner, host component, worn flag,
 *     container contents);
 *   - EQUIPPED  — a typed equipped entry (eq-<uuid>): resolved to its item
 *     instance, then the same item node as ITEM (with the eq id preserved).
 *
 * Clothing rule: any component holding one or more worn clothing items (the
 * clothes system — item types declaring a positive `wear.minVolume`, equipped
 * on that component) is REPLACED in the payload by a clothing node carrying
 * the clothes' data; the component's own data (material, stats, organs) is
 * not shown. Applied uniformly: in an entity view the clothing node takes the
 * component's slot in `components`; as the view target it becomes the entire
 * payload. The flat entity `items` list is always the complete entity
 * inventory (worn items included, flagged `worn: true`) — the rule replaces
 * component nodes, not inventory entries.
 *
 * Dependencies: the facade's public API only (getEntity, getItem,
 * getEquippedItems, getItemRegistry, stateEntityController, componentController,
 * internalComponentController, inventoryManager, roomsController,
 * holdingCostController). Deliberately does not:
 *   - mutate world state or emit broadcasts (reader only);
 *   - expose action data such as production summaries or take options — those
 *     belong to the object-viewer contract (getObjectInspectData), not to "what
 *     can be seen".
 *   Read-only with no persistent data → deliberately kept OUT of the
 *   subControllers broadcast map (same rule as craftingController /
 *   knowledgeController).
 */
import Logger from '../../utils/Logger.js';
import InternalComponentUtils from '../../utils/InternalComponentUtils.js';
import { getWornItems } from '../logic/WearLogic.js';
import { TRAIT_GROUPS, STAT_NAMES, EXISTENCE_GONE_AT } from '../../../shared/StatVocabulary.js';

export default class ViewController {

    /**
     * Constructor. No dependencies at construction: the facade reference is
     * injected post-construction by WorldComposition (same pattern as the
     * other facade-dependent controllers).
     */
    constructor() {
        /** @private {import('../WorldStateController.js').default|null} */
        this._facade = null;
    }

    /**
     * DI injection (same pattern as all other non-root controllers).
     * @param {import('../WorldStateController.js').default} facade - The world-state facade (root).
     */
    setWorldStateController(facade) {
        this._facade = facade;
    }

    /**
     * Builds a fresh view node for a typed id, or null when the id does not
     * resolve to a live object.
     * @param {string} id - The typed id (ent-/comp-/item-/eq- prefix).
     * @param {'ENTITY'|'COMPONENT'|'ITEM'|'EQUIPPED'} kind - The id kind,
     *   classified at the route boundary (the contract; the route sends 400
     *   before calling this controller with an unclassified id).
     * @returns {Object|null} The view node (`{ kind: 'entity' | 'component' |
     *   'clothing' | 'item' }` — the clothing node replaces a component node
     *   per the clothing rule), or null when the id is unknown.
     */
    view(id, kind) {
        const facade = this._facade;
        if (!facade) {
            return null;
        }
        switch (kind) {
            case 'ENTITY':
                return this._viewEntity(facade, id);
            case 'COMPONENT':
                return this._viewComponent(facade, id);
            case 'ITEM':
                return this._viewItem(facade, id);
            case 'EQUIPPED':
                return this._viewEquipped(facade, id);
            default:
                // Contract violation: the route classifies kind before calling
                // this; never pass an unknown kind (400 at the boundary instead).
                Logger.error(
                    `[ViewController] unknown view kind "${kind}" for id "${id}" — the route boundary must classify the id first.`
                );
                return null;
        }
    }

    // =========================================================================
    // Entity view
    // =========================================================================

    _viewEntity(facade, entityId) {
        const entity = facade.getEntity(entityId);
        if (!entity) {
            return null;
        }

        const compList = Array.isArray(entity.components) ? entity.components : [];
        const wornItems = this._wornItems(facade, entity.id);
        const wornSet = new Set(wornItems.map((eq) => eq.itemId));

        const rows = compList.map((comp) => ({
            comp,
            context: this._componentContext(facade, comp),
        }));
        const capacity = rows.reduce((sum, row) => sum + (this._componentVolume(row.context) || 0), 0);

        const components = rows
            .map((row) => this._componentNode(facade, entity, row.comp, wornItems))
            .filter((node) => node !== null);

        const manager = this._inventoryManager(facade);
        const items = (Array.isArray(entity.items) ? entity.items : []).map((it) =>
            this._itemRow(manager, it, wornSet)
        );
        const used = items.reduce((sum, it) => sum + (typeof it.volume === 'number' ? it.volume : 0), 0);

        const room = facade.roomsController?.getRoom?.(entity.location || null) || null;

        return {
            kind: 'entity',
            entity: {
                id: entity.id,
                name: entity.name || entity.id,
                blueprint: entity.blueprint || null,
                isStatic: entity.isStatic === true,
                isMachine: entity.isMachine === true,
                machineType: entity.machineType || null,
                spatial: entity.spatial ? { x: entity.spatial.x ?? 0, y: entity.spatial.y ?? 0 } : null,
                roomId: entity.location || null,
                roomName: room ? (room.name || null) : null,
            },
            components,
            items,
            inventory: {
                used,
                capacity,
                percent: capacity > 0 ? Math.round((used / capacity) * 100) : 0,
            },
        };
    }

    // =========================================================================
    // Component view (target itself is a component)
    // =========================================================================

    _viewComponent(facade, compId) {
        const sec = facade.stateEntityController;
        if (!sec) {
            return null;
        }
        const entity = sec.findEntityByComponent ? sec.findEntityByComponent(compId) : null;
        if (!entity) {
            return null;
        }
        const comp = (Array.isArray(entity.components) ? entity.components : [])
            .find((c) => c?.id === compId);
        if (!comp) {
            return null;
        }
        const wornItems = this._wornItems(facade, entity.id);
        return this._componentNode(facade, entity, comp, wornItems);
    }

    // =========================================================================
    // Item views (item- and eq- ids)
    // =========================================================================

    _viewItem(facade, id) {
        const sec = facade.stateEntityController;
        if (!sec) {
            return null;
        }
        const entity = this._findEntityForItemId(facade, sec, id);
        if (!entity) {
            return null;
        }
        const item = (Array.isArray(entity.items) ? entity.items : [])
            .find((it) => it?.id === id);
        if (!item) {
            return null;
        }
        return this._buildItem(facade, entity, item, id);
    }

    _viewEquipped(facade, id) {
        const sec = facade.stateEntityController;
        const hcc = facade.holdingCostController;
        if (!sec || !hcc) {
            return null;
        }
        const byEntity = (hcc.getEquippedItemsByEntity && typeof hcc.getEquippedItemsByEntity === 'function')
            ? hcc.getEquippedItemsByEntity()
            : null;
        if (!byEntity || typeof byEntity !== 'object') {
            return null;
        }
        const entry = Object.keys(byEntity).find((key) => byEntity[key] && byEntity[key][id]);
        if (entry === undefined || entry === null) {
            return null;
        }
        const all = sec.getAll ? sec.getAll() : {};
        const entity = all[entry] || null;
        const item = (entity && Array.isArray(entity.items) ? entity.items : [])
            .find((it) => it?.id === byEntity[entry][id].itemId);
        if (!item) {
            return null;
        }
        return this._buildItem(facade, entity, item, id);
    }

    _findEntityForItemId(facade, sec, itemId) {
        const all = sec.getAll ? sec.getAll() : {};
        for (const entity of Object.values(all)) {
            if (!entity || !Array.isArray(entity.items)) {
                continue;
            }
            if (entity.items.some((it) => it?.id === itemId)) {
                return entity;
            }
        }
        return null;
    }

    _buildItem(facade, entity, item, askedId) {
        const manager = this._inventoryManager(facade);
        let def = (manager.getItemDefinition && typeof manager.getItemDefinition === 'function')
            ? manager.getItemDefinition(item?.type)
            : null;
        if (!def || typeof def !== 'object') {
            const registry = this._itemRegistry(facade);
            def = (registry && registry[item?.type]) || {};
        }

        const wornSet = new Set(this._wornItems(facade, entity.id).map((eq) => eq.itemId));
        const worn = wornSet.has(item.id);

        let contents = null;
        if (manager.getContainerItems && typeof manager.getContainerItems === 'function') {
            const raw = manager.getContainerItems(entity, item.id);
            contents = (raw && typeof raw === 'object')
                ? Object.values(raw)
                    .filter((v) => v && typeof v === 'object')
                    .map((v) => ({
                        id: v.id ?? null,
                        type: v.type ?? null,
                        name: v.name || v.type || null,
                        volume: v.volume ?? null,
                    }))
                : null;
            if (contents.length === 0) {
                contents = null;
            }
        }

        return {
            kind: 'item',
            id: askedId,
            itemId: item.id ?? null,
            entityType: entity.id || null,
            itemType: item?.type || null,
            name: item?.name || def.name || item?.type || null,
            description: def.description || null,
            materials: this._defArray(def, 'materials'),
            form: def.form && typeof def.form === 'object' ? structuredClone(def.form) : null,
            wear: def.wear && typeof def.wear === 'object' ? structuredClone(def.wear) : null,
            volume: item.volume ?? null,
            traits: item.traits && typeof item.traits === 'object' ? structuredClone(item.traits) : null,
            hostComponentId: item.hostComponentId || null,
            worn,
            contents,
        };
    }

    // =========================================================================
    // Component node building (component node or clothing node)
    // =========================================================================


    _componentNode(facade, entity, comp, wornItems) {
        const compId = comp?.id;
        if (!compId) {
            return null;
        }

        // Clothing rule: worn clothing on this component replaces its node.
        const wornHere = wornItems.filter((eq) => eq?.componentId === compId);
        if (wornHere.length > 0) {
            return {
                kind: 'clothing',
                componentId: compId,
                worn: wornHere.map((eq) => this._clothingEntry(facade, eq)),
            };
        }

        const { def, stats } = this._componentContext(facade, comp);
        const physical = (stats[TRAIT_GROUPS.PHYSICAL] && typeof stats[TRAIT_GROUPS.PHYSICAL] === 'object')
            ? stats[TRAIT_GROUPS.PHYSICAL]
            : {};
        const existence = (typeof physical[STAT_NAMES.EXISTENCE] === 'number') ? physical[STAT_NAMES.EXISTENCE] : null;
        const volume = this._componentVolume({ def, stats });
        const broken = existence !== null && existence <= EXISTENCE_GONE_AT;

        const manager = this._inventoryManager(facade);
        const wornSet = new Set(wornItems.map((eq) => eq.itemId));
        const compItems = (Array.isArray(entity.items) ? entity.items : [])
            .filter((it) => it?.hostComponentId === compId)
            .map((it) => this._itemRow(manager, it, wornSet));
        const organs = this._organs(facade, entity.id, compId);

        return {
            kind: 'component',
            id: compId,
            type: comp?.type || null,
            name: def.name || comp?.type || null,
            exists: comp?.exists !== false,
            existence,
            broken,
            volume,
            stats: structuredClone(stats),
            materials: this._defArray(def, 'materials'),
            form: def.form && typeof def.form === 'object' ? structuredClone(def.form) : null,
            internalComponents: organs,
            items: compItems,
        };
    }

    _organs(facade, entityId, compId) {
        const ic = facade.internalComponentController;
        if (!ic) {
            return [];
        }
        const all = ic.getAll ? ic.getAll() : {};
        const hostMap = (all && all[entityId]) || {};
        const raw = Array.isArray(hostMap[compId]) ? hostMap[compId] : [];
        const organs = raw.map((icInst) => structuredClone(icInst));
        InternalComponentUtils.enrichWithDescriptions(organs, ic.registry || {});
        return organs;
    }

    _componentContext(facade, comp) {
        const def = (facade.componentController?.getComponentDefinition && typeof facade.componentController.getComponentDefinition === 'function')
            ? facade.componentController.getComponentDefinition(comp?.type)
            : {};
        const instances = facade.componentController?.getAll?.()?.instances;
        const stats = (instances && typeof instances === 'object' && instances[comp?.id]) ? instances[comp?.id] : {};
        return { def, stats };
    }

    _componentVolume(context) {
        const physical = (context.stats[TRAIT_GROUPS.PHYSICAL] && typeof context.stats[TRAIT_GROUPS.PHYSICAL] === 'object')
            ? context.stats[TRAIT_GROUPS.PHYSICAL]
            : {};
        if (typeof physical.volume === 'number') {
            return physical.volume;
        }
        if (context.def.form && typeof context.def.form.volume === 'number') {
            return context.def.form.volume;
        }
        return 0;
    }

    // =========================================================================
    // Shared helpers
    // =========================================================================

    /**
     * Facade inventory manager, or an empty object when absent.
     * @private
     * @returns {object} The inventory manager or an empty stand-in.
     */
    _inventoryManager(facade) {
        const manager = facade.inventoryManager;
        return (manager && typeof manager === 'object') ? manager : {};
    }

    /**
     * Facade item registry, or null when unavailable (never throws).
     * @private
     * @returns {object|null} The item registry or null.
     */
    _itemRegistry(facade) {
        const registry = facade.getItemRegistry ? facade.getItemRegistry() : null;
        return (registry && typeof registry === 'object') ? registry : null;
    }

    /**
     * Registry materials list (defensive clone, null when unknown).
     * @private
     * @param {object} def - The item or component definition.
     * @returns {Array|object|null} Cloned `materials` or null.
     */
    _defArray(def, field) {
        return (def && Array.isArray(def[field])) ? structuredClone(def[field]) : null;
    }

    /**
     * Worn clothing entries for one entity. Delegates to the clothes-system
     * helper (getWornItems): equipped items whose type declares a positive
     * `wear.minVolume`. Never throws — missing facade helpers yield [].
     * @private
     * @param {object} facade - The facade.
     * @param {string|null} entityId - Entity id (null/missing → []).
     * @returns {Array<{itemId: string, itemType: string, componentId: string|null}>} Worn entries.
     */
    _wornItems(facade, entityId) {
        const worn = getWornItems(facade, entityId);
        return Array.isArray(worn) ? worn : [];
    }

    /**
     * Flat inventory row for an item instance (name from registry, `worn` flag
     * from the worn clothing set).
     * @private
     * @param {object} manager - The inventory manager (or empty stand-in).
     * @param {object} it - The item instance record (raw, unvalidated).
     * @param {Set<string>} wornSet - Set of worn clothing item ids.
     * @returns {object} The row.
     */
    _itemRow(manager, it, wornSet) {
        const def = (manager.getItemDefinition && typeof manager.getItemDefinition === 'function')
            ? manager.getItemDefinition(it?.type)
            : null;
        return {
            id: it?.id ?? null,
            type: it?.type ?? null,
            name: it?.name || def?.name || it?.type || null,
            volume: it?.volume ?? null,
            hostComponentId: it?.hostComponentId || null,
            worn: wornSet.has(it?.id ?? ''),
        };
    }

    /**
     * Clothing node payload entry for one worn entry (the item's data that
     * replaces the component's data per the clothing rule).
     * @private
     * @param {object} facade - The facade.
     * @param {object} eq - A worn entry `{ itemId, itemType, componentId }`.
     * @returns {object} The clothing entry.
     */
    _clothingEntry(facade, eq) {
        const registry = this._itemRegistry(facade);
        const manager = this._inventoryManager(facade);
        let def = (manager.getItemDefinition && typeof manager.getItemDefinition === 'function')
            ? manager.getItemDefinition(eq?.itemType)
            : null;
        if (!def || typeof def !== 'object') {
            def = (registry && registry[eq?.itemType]) || {};
        }
        return {
            itemId: eq?.itemId ?? null,
            itemType: eq?.itemType ?? null,
            name: def.name || eq?.itemType || null,
            description: def.description || null,
            materials: this._defArray(def, 'materials'),
            form: def.form && typeof def.form === 'object' ? structuredClone(def.form) : null,
            wear: def.wear && typeof def.wear === 'object' ? structuredClone(def.wear) : null,
        };
    }
}

