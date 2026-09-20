/**
 * NpcSpawnLogic — FASE 6 (facade logic extraction).
 *
 * Data-driven NPC spawning (Feature D, spec §7.2): loads data/npcs.json and,
 * per registry entry, gates on env, validates the optional ai block, assembles
 * the persisted npcConfig, spawns the entity, positions it at the room center,
 * and applies the declared initialItems (add / nest / equip — warnings only,
 * spawn never fails).
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
import { isEnvFlagOn } from '../../utils/Constants.js';

/**
 * Spawns every NPC declared in data/npcs.json (Feature D, spec §7.2).
 *
 * Registry shape (key = blueprint name; the same registry LLMAgentController
 * validates in its constructor):
 *   { [blueprint]: { displayName, room, personality, objective?,
 *                    initialItems? ({ item, count, equip?,
 *                                     contents? ({ item, count })[] }),
 *                    maxWorldActionsPerRound?, maxChatMessagesPerRound?,
 *                    envGate? } }
 *
 * Per entry (each concern delegated to a single-purpose helper):
 *   - `_checkNpcSpawnGate(entry, blueprint)` — the data-driven spawn
 *     gate: the optional envGate names an env var that must be ON per
 *     isEnvFlagOn (string equal to "true" after trim and case-folding;
 *     unset/other values are OFF) for the entry to spawn. The gate is
 *     read once at bootstrap (spawn time, not a runtime toggle). A
 *     missing/malformed envGate means "no gate" (the entry spawns
 *     normally, as before); a gated-out entry is skipped with an info
 *     log;
 *   - `_normalizeNpcAiConfig(entry)` — validates the optional ai block
 *     at boot (behavior/attackRange/attackAction/moveAction), warning
 *     per invalid field and falling back to the registry defaults;
 *   - `_buildNpcConfig(entry, normalizedAi)` — assembles the persisted
 *     npcConfig: personality, the per-round action/chat caps, and the
 *     normalized ai block; the optional objective is persisted
 *     alongside personality only when present (non-empty), so existing
 *     entries keep their exact stored shape;
 *   - `_applyInitialItems(entityId, entry)` — places each initialItems
 *     entry on a merchantArm (fallback: first arm-like component, then
 *     any component) via the existing addItemToEntity() API, nests any
 *     declared contents into the just-added instance via the public
 *     addItemToContainer() API, and equips equip: true items on a
 *     holding-capable component via the public equipItem() API; a
 *     failed add/equip/nest is a warning only (the item stays held and
 *     the entity keeps its unequipped baseline — spawn never fails).
 *
 * The outer loop (per entry, inside a try/catch): malformed-entry warn
 * → gate check → displayName/personality check → room logical→UID
 * resolution → npcConfig build → spawnEntity with extra = { isNPC: true,
 * name: displayName, npcConfig: {…} } → room-center positioning →
 * _applyInitialItems. The persisted isNPC field is what makes the
 * world.json spawn observer bypass the NPC (the declarative spawns
 * target player-droid component types and would spam warn-logs on an
 * NPC); no separate opt-out flag is stored — nothing to leak into
 * serialize() snapshots or broadcasts.
 *
 * Tolerant of a missing/malformed registry — a boot-time warning only,
 * never a crash (the same tolerance as LLMAgentController._loadNpcRegistry).
 * @private
 */


function spawnDataDrivenNpcs(facade) {
    const raw = DataLoader.loadJsonSafe('data/npcs.json', {});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return; // no NPC registry configured — not an error
    }

    let count = 0;
    for (const [blueprint, entry] of Object.entries(raw)) {
        try {
            if (!entry || typeof entry !== 'object') {
                Logger.warn(`[WorldStateController] npcs.json: entry "${blueprint}" is malformed — skipped.`);
                continue;
            }
            if (!facade._checkNpcSpawnGate(entry, blueprint)) continue;
            if (typeof entry.displayName !== 'string' || typeof entry.personality !== 'string') {
                Logger.warn(`[WorldStateController] npcs.json: entry "${blueprint}" lacks displayName/personality — skipped.`);
                continue;
            }
            const roomLogicalId = typeof entry.room === 'string' ? entry.room : 'start_room';
            const roomUid = facade.roomsController.getUidByLogicalId(roomLogicalId);
            if (!roomUid) {
                Logger.warn(`[WorldStateController] npcs.json: "${entry.displayName}" has unknown room "${roomLogicalId}" — skipped.`);
                continue;
            }
            const room = Object.values(facade.roomsController.rooms || {}).find(r => r.id === roomUid) || null;

            const normalizedAi = facade._normalizeNpcAiConfig(entry);

            const npcConfig = facade._buildNpcConfig(entry, normalizedAi);

            const entityId = facade.stateEntityController.spawnEntity(blueprint, roomUid, {
                isNPC: true,
                name: entry.displayName,
                npcConfig
            });
            if (!entityId) {
                Logger.warn(`[WorldStateController] NPC spawn failed for blueprint "${blueprint}".`);
                continue;
            }

            // Position at the room center (spec §7.2).
            if (room && typeof room.width === 'number' && typeof room.height === 'number') {
                facade.stateEntityController.updateEntitySpatial(entityId, { x: room.width / 2, y: room.height / 2 });
            }

            // Apply initialItems (e.g. Bolt's wares) to an arm component.
            facade._applyInitialItems(entityId, entry);

            count++;
            Logger.info(`[WorldStateController] NPC spawned: "${entry.displayName}" (${blueprint}) in room "${roomLogicalId}" as ${entityId}.`);
        } catch (error) {
            Logger.error(`[WorldStateController] NPC spawn failed for "${entry?.displayName || blueprint}": ${error.message}`);
        }
    }
    if (count > 0) {
        Logger.info(`[WorldStateController] ${count} NPC(s) spawned from data/npcs.json.`);
    }
}

/**
 * Data-driven spawn gate for a single registry entry: the optional
 * `envGate` names an environment variable that must be ON (per
 * isEnvFlagOn: a string equal to "true" after trim and case-folding) for
 * the entry to spawn. Unset/empty/malformed envGate means "no gate"
 * (spawn normally); any other value skips the entry with an info log.
 * The variable is read once at bootstrap (spawn time), not a runtime
 * toggle — restarting the server applies changes to it.
 * @private
 * @param {Object} entry - The registry entry being checked (known to be
 *   an object at this point).
 * @param {string} blueprint - The registry key; used as the display-name
 *   fallback in the skip log when the entry's displayName is not a string.
 * @returns {boolean} true = spawn the entry, false = skip it.
 */


function checkNpcSpawnGate(facade, entry, blueprint) {
    const gateVar = typeof entry.envGate === 'string' ? entry.envGate.trim() : '';
    if (gateVar === '') return true;
    if (isEnvFlagOn(process.env[gateVar])) return true;
    Logger.info(`[WorldStateController] npcs.json: "${typeof entry.displayName === 'string' ? entry.displayName : blueprint}" is gated by ${gateVar} (not "true") — skipped.`);
    return false;
}

/**
 * M1 + M4: Validates the optional ai block at boot (behavior,
 * attackRange, attackAction, moveAction), warning per invalid field and
 * ignoring the offending value (the registry defaults apply downstream).
 * @private
 * @param {Object} entry - The registry entry (used for the displayName in
 *   the warn logs and for entry.ai).
 * @returns {Object|null} The normalized `{ behavior[, attackAction,
 *   moveAction, attackRange] }`, or null when the entry has no usable
 *   ai block (an LLM-routed NPC).
 */


function normalizeNpcAiConfig(facade, entry) {
    const rawAi = entry.ai;
    let normalizedAi = null;

    if (rawAi && typeof rawAi === 'object') {
        const hasValidBehavior = typeof rawAi.behavior === 'string' && rawAi.behavior !== '';

        let hasValidAttackRange = true;
        if (rawAi.attackRange !== undefined && rawAi.attackRange !== null) {
            if (typeof rawAi.attackRange === 'number') {
                hasValidAttackRange = isFinite(rawAi.attackRange) && rawAi.attackRange > 0;
                if (!hasValidAttackRange) {
                    Logger.warn(`[WorldStateController] NPC "${entry.displayName}": ai.attackRange=${rawAi.attackRange} is invalid (must be finite and > 0) — ignoring config value, will use registry fallback.`);
                }
            } else {
                Logger.warn(`[WorldStateController] NPC "${entry.displayName}": ai.attackRange=${JSON.stringify(rawAi.attackRange)} is present but has type ${typeof rawAi.attackRange}, expected number — ignoring config value, will use registry fallback.`);
                hasValidAttackRange = false;
            }
        }

        if (hasValidBehavior && hasValidAttackRange) {
            normalizedAi = { behavior: rawAi.behavior };
            if (rawAi.attackAction !== undefined && rawAi.attackAction !== null) {
                if (typeof rawAi.attackAction === 'string' && rawAi.attackAction !== '') {
                    normalizedAi.attackAction = rawAi.attackAction;
                } else {
                    Logger.warn(`[WorldStateController] NPC "${entry.displayName}": ai.attackAction=${JSON.stringify(rawAi.attackAction)} is present but has type ${typeof rawAi.attackAction}, expected non-empty string — ignoring config value.`);
                }
            }
            if (rawAi.moveAction !== undefined && rawAi.moveAction !== null) {
                if (typeof rawAi.moveAction === 'string' && rawAi.moveAction !== '') {
                    normalizedAi.moveAction = rawAi.moveAction;
                } else {
                    Logger.warn(`[WorldStateController] NPC "${entry.displayName}": ai.moveAction=${JSON.stringify(rawAi.moveAction)} is present but has type ${typeof rawAi.moveAction}, expected non-empty string — ignoring config value.`);
                }
            }
            if (hasValidAttackRange) normalizedAi.attackRange = rawAi.attackRange;
        } else if (!hasValidBehavior) {
            Logger.warn(`[WorldStateController] NPC "${entry.displayName}": ai.behavior is missing or empty — AI disabled for this entity.`);
        }
    }

    return normalizedAi;
}

/**
 * Assembles the persisted npcConfig for a registry entry: personality,
 * the per-round action/chat caps (undefined passes through — the agent
 * applies its own defaults), and the normalized ai block. The optional
 * objective is added only when present (non-empty string) so existing
 * entries keep the exact npcConfig shape they stored before the
 * objective feature.
 *
 * Note: the LLM prompt is rendered from the agent's in-memory registry
 * (LLMAgentController._loadNpcRegistry re-reads data/npcs.json), NOT
 * from this persisted npcConfig copy — that one exists for
 * serialization and inspection only; the two stay in sync via the
 * data file.
 * @private
 * @param {Object} entry - The registry entry (displayName and personality
 *   known to be non-empty-able strings by the caller's checks).
 * @param {Object|null} normalizedAi - Result of _normalizeNpcAiConfig(entry).
 * @returns {Object} The npcConfig object stored on the spawned entity.
 */


function buildNpcConfig(facade, entry, normalizedAi) {
    const npcConfig = {
        personality: entry.personality,
        maxWorldActionsPerRound: entry.maxWorldActionsPerRound,
        maxChatMessagesPerRound: entry.maxChatMessagesPerRound,
        ai: normalizedAi
    };
    if (typeof entry.objective === 'string' && entry.objective.trim() !== '') {
        npcConfig.objective = entry.objective;
    }
    return npcConfig;
}

/**
 * Applies the entry's initialItems to a just-spawned entity. Each
 * `{ item, count, equip?, contents? }` is added `count` times via the
 * existing addItemToEntity() API: unequipped entries go to a merchantArm
 * (fallback: first arm-like component, then any component); equip: true
 * entries go to a component that can meet the item's holding-cost
 * requirements (see _resolveEquippableHostComponent). Any declared
 * `contents` ({ item, count }[]) are nested into the just-added instance
 * through the public addItemToContainer() facade (never InventoryManager
 * directly). equip: true items are then equipped on the same host
 * component. A failed add/equip/nest is a warning only — the item stays
 * held (or absent) and the entity keeps its unequipped baseline; spawn
 * never fails.
 * @private
 * @param {string} entityId - The just-spawned entity.
 * @param {Object} entry - The registry entry (displayName is a string).
 */


function applyInitialItems(facade, entityId, entry) {
    const entity = facade.stateEntityController.getEntity(entityId);
    const items = Array.isArray(entry.initialItems) ? entry.initialItems : [];
    for (const { item, count: n, equip, contents } of items) {
        const times = Math.max(0, Number(n) || 0);
        // equip: true entries are placed on a component that can
        // actually meet the item's holding-cost requirements, so
        // the equip below can succeed (e.g. a droidHand with
        // strength, not a bare droidArm). Unequipped entries keep
        // the historical arm-first placement.
        const hostComponent = equip === true
            ? facade._resolveEquippableHostComponent(entity, item)
            : entity?.components?.find(c => c.type === 'merchantArm')
                || entity?.components?.find(c => /arm|hand/i.test(c.type || ''))
                || entity?.components?.[0]
                || null;
        if (!hostComponent) {
            Logger.warn(`[WorldStateController] NPC "${entry.displayName}" has no component to hold item "${item}".`);
            continue;
        }
        for (let i = 0; i < times; i++) {
            const result = facade.addItemToEntity(entityId, item, hostComponent.id);
            if (!result.success) {
                Logger.warn(`[WorldStateController] NPC item "${item}" #${i + 1} failed on ${hostComponent.type}: ${result.message}`);
                continue;
            }
            // Nest the entry's declared contents into the just-added
            // instance (public facade only; the instance's own
            // internal volume bounds how many fit).
            const declaredContents = Array.isArray(contents) ? contents : [];
            for (const c of declaredContents) {
                const type = typeof c?.item === 'string' ? c.item.trim() : '';
                const nestTimes = Math.max(0, Number(c?.count) || 0);
                if (!type || !result?.item?.id || nestTimes === 0) continue;
                for (let j = 0; j < nestTimes; j++) {
                    const nest = facade.addItemToContainer(entityId, result.item.id, type);
                    if (!nest?.success) Logger.warn(`[WorldStateController] NPC "${entry.displayName}" contents "${type}" #${j + 1} into "${item}" failed: ${nest?.message}`);
                }
            }
            if (equip === true && result.item?.id) {
                // Equip on the same host component the item was
                // added to (spec §3.3). A failed equip (volume,
                // insufficient stats) is a warning only: the item
                // stays held and the entity keeps its unequipped
                // baseline — spawn never fails.
                const equipResult = facade.equipItem(entityId, result.item.id, item, hostComponent.id);
                if (!equipResult.success) {
                    Logger.warn(`[WorldStateController] NPC item "${item}" #${i + 1} added but equip failed on ${hostComponent.type}: ${equipResult.message}`);
                }
            }
        }
    }
}

/**
 * Resolves the host component for an initialItems entry flagged
 * `equip: true`: the first component whose current stats satisfy the item
 * type's holding-cost requirements (data/holdingCost.json), so the
 * subsequent equipItem() call can actually succeed (e.g. a droidHand with
 * strength, not a bare droidArm). Falls back to the standard
 * arm/hand/first-component chain when no component qualifies — in that
 * case the item is still added, the equip fails with a warning, and the
 * entity keeps its unequipped baseline (spawn never fails).
 * @private
 * @param {Object} entity - The spawned entity.
 * @param {string} itemType - The item type to be equipped.
 * @returns {Object|null} The resolved component, or null if the entity has none.
 */


function resolveEquippableHostComponent(facade, entity, itemType) {
    const components = entity?.components;
    if (Array.isArray(components)) {
        for (const component of components) {
            const stats = facade.componentController.getComponentStats(component.id);
            if (stats && facade.holdingCostController.canHoldItem(itemType, stats).success) {
                return component;
            }
        }
    }
    return components?.find(c => c.type === 'merchantArm')
        || components?.find(c => /arm|hand/i.test(c.type || ''))
        || components?.[0]
        || null;
}


export { spawnDataDrivenNpcs, checkNpcSpawnGate, normalizeNpcAiConfig, buildNpcConfig, applyInitialItems, resolveEquippableHostComponent };
