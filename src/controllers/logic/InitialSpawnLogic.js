/**
 * InitialSpawnLogic — FASE 6 (facade logic extraction).
 *
 * Applies the declarative initial spawns from data/world.json (initialSpawns)
 * to a just-spawned entity: slot resolution (type / firstFit: /
 * bestAvailable[:prefs] / fallback), top-level count, container children,
 * weapon ammo. Generic interpreter of the data file — no hardcoded loads.
 *
 * Extracted verbatim from WorldStateController (only change: `this.` became
 * `facade.` and the method became a plain function). The facade keeps a thin
 * delegator method per extracted method so instance-level spies/mocks and
 * direct calls keep working. Narrow-deps rule (mirrors
 * consequences/DropItemHandler.js): `facade` is the WorldStateController
 * instance and each function only uses the members named in its JSDoc.
 */

import DataLoader from '../../utils/DataLoader.js';
import Logger from '../../utils/Logger.js';
import { getDefinitionFootprint } from '../../utils/definitionVolume.js';

/**
 * Applies the declarative initial spawns from data/world.json to a spawned entity.
 * Generic replacement of the former hardcoded spawn methods (_spawnMetalBoxWithKnives,
 * _addKnifeToClientEntity, _addTestItemToClientEntity, _addT1WeaponToEntity): the exact
 * item composition is now declared in data/world.json (initialSpawns) and this method
 * only interprets it.
 *
 * Supported entry fields:
 * - { item, slot, count?: number, children?: [{ item, count }], ammo?: number,
 *   fallback?: "<type>" }: add `item` to a component resolved by `slot`, then add each
 *   child item `count` times inside the created container item. `count` is an optional
 *   top-level multiplicity (default 1) — the item is added that many times to the same
 *   resolved slot, mirroring the children count loop one level up (children and ammo
 *   apply to each added instance). Entries without `count` add exactly one item,
 *   identical to the pre-count behavior. slot forms: "<type>" (first component of that
 *   type), "firstFit:<type>[,<type>...]" (first of the listed types with enough
 *   available volume).
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


function applyInitialSpawns(facade, entityId, spawnConfig) {
    // Feature D (spec §7.2): NPC entities opt out of the declarative
    // world.json spawns — their goods come from the npcs.json
    // initialItems list instead. The opt-out keys off the persisted
    // `isNPC` field (already merged into the record before this
    // observer runs): no separate boot-time flag is stored anywhere, so
    // nothing can leak into persistence snapshots or broadcasts.
    if (facade.stateEntityController.getEntity(entityId)?.isNPC === true) {
        return { applied: 0, failed: 0 };
    }

    let config = spawnConfig;
    if (!config) {
        config = DataLoader.loadJsonSafe('data/world.json', {});
    }

    const entries = config?.initialSpawns;
    if (!Array.isArray(entries) || entries.length === 0) {
        return { applied: 0, failed: 0 };
    }

    const entity = facade.stateEntityController.getEntity(entityId);
    if (!entity || !entity.components || !Array.isArray(entity.components)) {
        Logger.warn(`[WorldStateController] Entity "${entityId}" not found or has no components for initial spawns.`);
        return { applied: 0, failed: entries.length };
    }

    let applied = 0;
    let failed = 0;

    for (const entry of entries) {
        try {
            const target = facade._resolveInitialSpawnSlot(entity, entry);
            if (!target) {
                Logger.warn(`[WorldStateController] Initial spawn "${entry.item}" has no valid slot ("${entry.slot}") on entity "${entityId}".`);
                failed++;
                continue;
            }

            // Optional top-level multiplicity (data/world.json `count`, default
            // 1): mirrors the children count loop one level up so a loadout
            // entry can add the same item several times (e.g. the M1 coal
            // loadout). Entries without `count` add exactly one item —
            // identical to the pre-count behavior.
            const spawnCount = Math.max(1, Math.floor(Number(entry.count) || 1));
            let addedAny = false;
            for (let i = 0; i < spawnCount; i++) {
                const addResult = facade.inventoryManager.addItem(entity, entry.item, target.component.id, {
                    componentController: facade.componentController
                });
                if (!addResult.success) {
                    Logger.warn(`[WorldStateController] Initial spawn "${entry.item}"${spawnCount > 1 ? ` #${i + 1}` : ''} failed on ${target.component.type} (entity ${entityId}): ${addResult.message}`);
                    continue;
                }

                // Container children (e.g., metalBox pre-filled with knives)
                if (Array.isArray(entry.children)) {
                    for (const child of entry.children) {
                        const count = Math.max(0, Number(child?.count) || 0);
                        for (let j = 0; j < count; j++) {
                            const childResult = facade.inventoryManager.addItemToContainer(entity, addResult.item?.id, child.item);
                            if (!childResult.success) {
                                Logger.warn(`[WorldStateController] Initial spawn child "${child.item}" #${j + 1} into "${entry.item}" failed (entity ${entityId}): ${childResult.message}`);
                            }
                        }
                    }
                }

                // Weapon ammo (e.g., t1 pre-loaded with knife projectiles)
                if (typeof entry.ammo === 'number' && entry.ammo > 0) {
                    for (let j = 0; j < entry.ammo; j++) {
                        const ammoResult = facade.inventoryManager.addItemToContainer(entity, addResult.item?.id, 'knife');
                        if (!ammoResult.success) {
                            Logger.warn(`[WorldStateController] Initial spawn ammo #${j + 1} into "${entry.item}" failed (entity ${entityId}): ${ammoResult.message}`);
                        }
                    }
                }

                addedAny = true;
            }

            if (!addedAny) {
                failed++;
                continue;
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


function resolveInitialSpawnSlot(facade, entity, entry) {
    const itemDef = facade.inventoryManager.getItemDefinitions()[entry.item];
    if (!itemDef) {
        Logger.warn(`[WorldStateController] Unknown item type "${entry.item}" in initial spawn config.`);
        return null;
    }
    // Items like T1 occupy their externalVolume footprint on the host component.
    // Single source of truth: the shared footprint helper (definitionVolume.js),
    // so the initial-spawn resolver and InventoryManager.addItem agree.
    const hostFootprint = getDefinitionFootprint(itemDef);

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
                if (matchesPreference && facade.inventoryManager.getAvailableVolume(entity, component.id) >= hostFootprint) {
                    return { component };
                }
            }
        }
        // Fallback: the component with the highest available volume (first one wins ties,
        // identical to the legacy strict-greater selection).
        let bestComponent = null;
        let bestAvailableVolume = 0;
        for (const component of entity.components) {
            const availableVolume = facade.inventoryManager.getAvailableVolume(entity, component.id);
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
            if (candidate && facade.inventoryManager.getAvailableVolume(entity, candidate.id) >= hostFootprint) {
                return { component: candidate };
            }
        }
        return null;
    }

    // Plain type slot, with optional fallback type
    const primary = firstOfType(slot);
    if (primary && facade.inventoryManager.getAvailableVolume(entity, primary.id) >= hostFootprint) {
        return { component: primary };
    }
    if (entry.fallback) {
        const fallback = firstOfType(entry.fallback);
        if (fallback && facade.inventoryManager.getAvailableVolume(entity, fallback.id) >= hostFootprint) {
            return { component: fallback };
        }
    }
    return null;
}


export { applyInitialSpawns, resolveInitialSpawnSlot };
