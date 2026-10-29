/**
 * WearLogic — the clothing system (clothes feature), simplified to a
 * pure volume fit.
 *
 * A wearable is an item whose item registry recipe declares
 * `wear: { minVolume: X }` (the t-shirt declares minVolume 2, which is
 * its own volume). The fit rule is the spec verbatim: the target
 * component must HAVE X of free volume; if it does, the item fits.
 * There are no named layers, no per-species registry and no extra
 * strength gate: any component with enough free volume accepts the
 * item, so a human t-shirt fits a droid, an orc or a charro exactly
 * the same way (whatever species exists).
 *
 * The target component is chosen by the CALLER (like /equip): the HTTP
 * route passes it in the body, and the spawn rules (world.json /
 * npcs.json) pick it deterministically (the slot-resolved component for
 * the player; the first component in order with enough free volume for
 * NPCs and card droids). Wearing reuses the existing equipped machinery
 * (HoldingCostController.equipItem) on that component, so persistence
 * (serialize/restore) and the `equipped` broadcast already carry it for
 * free; unequipItem takes a worn item off.
 *
 * One broadcast per wear; the broadcast service additionally derives a
 * `worn` list per entity (the equipped subset whose type declares a
 * `wear.minVolume`) so clients can render clothing without re-deriving
 * the fit.
 *
 * Next change (not this one): an LLM tool that lets an agent decide to
 * wear / take off its own clothing (the agent context already lists
 * equipped items).
 */

/**
 * The fit rule: the minimum free volume a component must have for the
 * item type to fit on it (the `wear.minVolume` declared in the item
 * registry recipe).
 * @param {Object} facade - The world-state facade (WorldStateController).
 * @param {string} itemType - The item type.
 * @returns {number|null} The required free volume, or null when the
 *   item type is not wearable (no positive `wear.minVolume` declared).
 */
function getWearMinVolume(facade, itemType) {
    const minVolume = facade.getItemRegistry?.()[itemType]?.wear?.minVolume;
    return typeof minVolume === 'number' && Number.isFinite(minVolume) && minVolume > 0
        ? minVolume
        : null;
}

/**
 * Wears a carried item on a caller-chosen component of the entity.
 *
 * The fit rule: the component must have at least the item's
 * `wear.minVolume` of free volume. Non-wearable items, components that
 * do not belong to the entity, already-worn items and components with
 * too little free volume all fail (no state change). On success the
 * item is equipped on the chosen component (same machinery as /equip)
 * and one world broadcast is emitted.
 *
 * @param {Object} facade - The world-state facade (WorldStateController).
 * @param {string} entityId - The entity that wears the item.
 * @param {string} itemId - The carried item to wear (in the entity's inventory).
 * @param {string} componentId - The target component (must belong to the entity).
 * @returns {{ success: boolean, message: string, itemId?: string, itemType?: string,
 *   componentId?: string }}
 */
function wearItem(facade, entityId, itemId, componentId) {
    const entity = facade.getEntity(entityId);
    if (!entity) {
        return { success: false, message: `Entity not found: ${entityId}` };
    }

    const item = facade.getItem(entityId, itemId);
    if (!item) {
        return { success: false, message: `Item not found in ${entityId} inventory: ${itemId}` };
    }

    const minVolume = getWearMinVolume(facade, item.type);
    if (minVolume === null) {
        return {
            success: false,
            message: `Item type "${item.type}" cannot be worn (no wear.minVolume declared in the item registry).`
        };
    }

    // A worn item is an equipped entry: re-wearing the same item is an
    // idempotent no-op failure (the client take-off flow relies on it).
    const equipped = facade.getEquippedItems(entityId);
    if (equipped.some((eq) => eq.itemId === itemId)) {
        return { success: false, message: `Item "${item.type}" is already worn by ${entityId}.` };
    }

    // The caller picks the component, but only its own components count
    // (no aiming at another entity's part).
    const component = facade.getComponent(componentId);
    if (!component || !Array.isArray(entity.components) || !entity.components.some((c) => c?.id === component.id)) {
        return { success: false, message: `Component "${componentId}" does not belong to entity ${entityId}; it cannot be a wear target.` };
    }

    // THE fit rule: the component must have at least `minVolume` of free
    // volume; if it does, the item fits (and only then).
    const available = facade.inventoryManager.getAvailableVolume(entity, componentId);
    if (available < minVolume) {
        return { success: false, message: `Component ${component.type} has ${available} free volume; "${item.type}" needs ${minVolume} to fit.` };
    }

    const result = facade.holdingCostController.equipItem(entityId, itemId, item.type, componentId);
    if (!result.success) {
        return { success: false, message: `Failed to wear "${item.type}": ${result.message || result.error || 'unknown error'}` };
    }

    // One broadcast per wear (same discipline as EquipLogic): the world
    // is authoritative; clients re-derive the worn state from equipped.
    facade._broadcastService?.broadcast();

    return {
        success: true,
        message: `Wore "${item.type}" on ${component.type} (${componentId}).`,
        itemId: item.id,
        itemType: item.type,
        componentId
    };
}

/**
 * Lists the items currently worn by an entity (the equipped subset whose
 * item type declares a `wear.minVolume`).
 *
 * @param {Object} facade - The world-state facade (WorldStateController).
 * @param {string} entityId - The entity to inspect.
 * @returns {Array<{ itemId: string, itemType: string, name: string, componentId: string, componentType: string|null }>}
 */
function getWornItems(facade, entityId) {
    const entity = facade.getEntity(entityId);
    if (!entity) return [];

    const itemRegistry = facade.getItemRegistry?.() || {};
    const worn = [];
    for (const eq of facade.getEquippedItems(entityId)) {
        if (getWearMinVolume(facade, eq.itemType) === null) continue;
        const item = facade.getItem(entityId, eq.itemId);
        worn.push({
            itemId: eq.itemId,
            itemType: eq.itemType,
            name: item?.name || itemRegistry[eq.itemType]?.name || eq.itemType,
            componentId: eq.componentId,
            componentType: facade.getComponent(eq.componentId)?.type || null
        });
    }
    return worn;
}

export { wearItem, getWornItems, getWearMinVolume };
