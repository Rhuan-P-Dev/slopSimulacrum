/**
 * LlmContextController — State→text translation layer for the LLM.
 *
 * Feature B (spec §4.3): a local LLM can only reason about the world
 * through text. This controller composes a bounded, sectioned narrative
 * (hard cap of 5000 chars) from the live world state: entity self-state,
 * nearby entities, executable actions (with the natural-language
 * descriptions from data/actions.json), the recent world-event ring buffer,
 * and (when the room-chat layer exists) the room chat.
 *
 * It is a reader/composer — a logic controller, not a state owner. It
 * receives the facade via setWorldStateController() and only ever reads
 * through its public API (spec "public API only" rule).
 *
 * The section headers are stable and deliberate (prompt engineering):
 *   === YOUR STATE ===, === NEARBY ENTITIES ===,
 *   === YOUR ACTIONS (executable now) ===, === RECENT EVENTS ===,
 *   === ROOM CHAT ===
 * Empty sections still print their header plus "(none)" so weak local
 * models always see the same structure.
 *
 * @module LlmContextController
 */

import {
    CONTEXT_MAX_ENTITIES,
    CONTEXT_MAX_DROPPED_ITEMS,
    CONTEXT_MAX_EXITS,
    CHAT_MESSAGE_MAX_LENGTH,
    AGENT_FEEDBACK_CAPACITY,
    LLM_CONTEXT_MAX_CHARS,
    LLM_CONTEXT_OTHER_ROOM_ENTITIES,
    LLM_CONTEXT_MAX_EVENTS,
    LLM_CONTEXT_MAX_CHAT,
    LLM_CONTEXT_MAX_INSTINCTS,
    LLM_CONTEXT_MAX_NEARBY_STATS,
    LLM_CONTEXT_MAX_HINTS,
    LLM_CONTEXT_MAX_CHAT_IN_CONTEXT,
    LLM_CONTEXT_MAX_INSTINCTS_IN_CONTEXT
} from '../../utils/Constants.js';
import { TRAIT_GROUPS, STAT_NAMES, flatKey } from '../../../shared/StatVocabulary.js';
import { resolveRoomExits } from '../../utils/ContextResolution.js';

class LlmContextController {
    static BUDGET = {
        maxChars: LLM_CONTEXT_MAX_CHARS,          // hard cap on the rendered text (~1.3k–1.5k tokens); raised from 4000 to preserve the enriched spatial detail (room size/positions/exits)
        maxEntities: CONTEXT_MAX_ENTITIES,       // same-room entities listed (single-sourced in Constants.js)
        otherRoomEntities: LLM_CONTEXT_OTHER_ROOM_ENTITIES,    // entities from other rooms (room-named)
        maxDroppedItems: CONTEXT_MAX_DROPPED_ITEMS, // current-room dropped items listed (positions) (single-sourced in Constants.js)
        maxExits: CONTEXT_MAX_EXITS,             // current-room exits listed (safety cap) (single-sourced in Constants.js)
        maxEvents: LLM_CONTEXT_MAX_EVENTS,
        maxChat: LLM_CONTEXT_MAX_CHAT,
        maxInstincts: LLM_CONTEXT_MAX_INSTINCTS,         // displayed instincts (display cap)
        perMessageChars: CHAT_MESSAGE_MAX_LENGTH     // per chat/event line truncation (shared with the room-chat message cap)
    };

    /**
     * @param {Object} deps
     * @param {Object} deps.actionRegistry - data/actions.json (loaded by the composition root).
     */
    constructor({ actionRegistry }) {
        this.actionRegistry = actionRegistry && typeof actionRegistry === 'object' ? actionRegistry : {};
        /** @type {WorldStateController|null} Injected post-construction. */
        this.worldStateController = null;
    }

    /**
     * Injects the world state facade (WorldStateController).
     * @param {WorldStateController} facade
     */
    setWorldStateController(facade) {
        this.worldStateController = facade;
    }

    /**
     * Builds the LLM context for one entity.
     *
     * @param {string} entityId - Typed entity ID (ent-…).
     * @param {Object} [options] - May override maxEntities / maxEvents / maxChat
     *   (each clamped to the BUDGET maximum).
     * @returns {{ text: string, data: Object, stats: { chars: number, budgetChars: number, truncated: { entities: boolean, events: boolean, chat: boolean } } }}
     */
    buildContext(entityId, options = {}) {
        const facade = this.worldStateController;
        if (!facade) {
            throw new Error('LlmContextController: facade not injected (call setWorldStateController first)');
        }

        const maxEntities = this._clampOption(options.maxEntities, LlmContextController.BUDGET.maxEntities);
        const maxEvents = this._clampOption(options.maxEvents, LlmContextController.BUDGET.maxEvents);
        const maxChat = this._clampOption(options.maxChat, LlmContextController.BUDGET.maxChat);

        const entity = facade.getEntity(entityId);
        if (!entity) {
            return { text: '', data: null, stats: { chars: 0, budgetChars: LlmContextController.BUDGET.maxChars, truncated: { entities: false, events: false, chat: false } } };
        }

        // Compute the rooms map ONCE (a defensive deep clone from the facade)
        // and thread it into every room-reading helper below. The UID-keyed
        // map is the O(1) index, so no separate reverse map is needed (spec §9.5).
        const rooms = this.worldStateController?.getRooms() || {};
        const roomName = this._roomName(entity.location, rooms);
        const self = this._buildSelfData(entity);
        const nearData = this._buildNearbyData(entity, entity.location, maxEntities, rooms);
        const actionData = this._buildActionData(entityId);
        const hintsData = this._buildHintsData(entityId);
        const eventsData = this._buildEventData(maxEvents);
        const chatData = this._buildChatData(entity.location, maxChat);
        const feedbackData = this._buildFeedbackData(entityId);

        const stats = {
            chars: 0,
            budgetChars: LlmContextController.BUDGET.maxChars,
            truncated: { entities: false, events: false, chat: false, feedback: false, instincts: false }
        };

        // Build instincts data: preferred source is options.instincts (agent path),
        // else facade fallback (debug endpoint path).
        const instincts = options.instincts !== undefined
            ? options.instincts
            : (facade.instinctController?.generateForEntity?.(entityId) ?? []);

        // Truncation order when over budget (spec §4.3): events first, then
        // entities (same-room first), then chat (drop to 5), then feedback
        // (least critical — dropped entirely), then instincts (reduced to 3).
        // The `data` mirror always reflects exactly what was rendered (the truncated versions).
        let near = nearData;
        let events = eventsData;
        let chat = chatData;
        let feedback = feedbackData;
        let instinctSection = instincts.slice(0, LlmContextController.BUDGET.maxInstincts);
        const droppedItems = this._buildDroppedItemsData(entity.location);
        let text = this._render(entity, roomName, self, near, actionData, hintsData, events, chat, feedback, instinctSection, droppedItems, maxEntities, rooms);

        if (text.length > stats.budgetChars) {
            events = this._buildEventData(Math.max(5, Math.floor(maxEvents / 2)));
            text = this._render(entity, roomName, self, near, actionData, hintsData, events, chat, feedback, instinctSection, droppedItems, maxEntities, rooms);
            stats.truncated.events = events.length < eventsData.length || text.length > stats.budgetChars;

            if (text.length > stats.budgetChars) {
                near = this._buildNearbyData(entity, entity.location, Math.max(2, Math.floor(maxEntities / 2)), rooms);
                text = this._render(entity, roomName, self, near, actionData, hintsData, events, chat, feedback, instinctSection, droppedItems, maxEntities, rooms);
                stats.truncated.entities = near.sameRoom.length < nearData.sameRoom.length || text.length > stats.budgetChars;
            }

            if (text.length > stats.budgetChars && chat.length > LLM_CONTEXT_MAX_CHAT_IN_CONTEXT) {
                chat = chat.slice(0, LLM_CONTEXT_MAX_CHAT_IN_CONTEXT);
                text = this._render(entity, roomName, self, near, actionData, hintsData, events, chat, feedback, instinctSection, droppedItems, maxEntities, rooms);
                stats.truncated.chat = true;
            }

            // Drop feedback section first (least critical, spec §4.3)
            if (text.length > stats.budgetChars && feedback.length > 0) {
                feedback = [];
                text = this._render(entity, roomName, self, near, actionData, hintsData, events, chat, feedback, instinctSection, droppedItems, maxEntities, rooms);
                stats.truncated.feedback = true;
            }

            // Reduce instincts to 3 (spec §4.3: instincts are lowest priority after feedback)
            if (instinctSection.length > LLM_CONTEXT_MAX_INSTINCTS_IN_CONTEXT) {
                instinctSection = instinctSection.slice(0, LLM_CONTEXT_MAX_INSTINCTS_IN_CONTEXT);
                text = this._render(entity, roomName, self, near, actionData, hintsData, events, chat, feedback, instinctSection, droppedItems, maxEntities, rooms);
                stats.truncated.instincts = true;
            }

            // Final fallback: if still over budget after all truncation, truncate instincts further
            if (text.length > stats.budgetChars && instinctSection.length > 0) {
                instinctSection = [];
                text = this._render(entity, roomName, self, near, actionData, hintsData, events, chat, feedback, instinctSection, droppedItems, maxEntities, rooms);
                stats.truncated.instincts = true; // already set, but ensure clarity
            }
        }

        stats.chars = text.length;
        const data = {
            self,
            room: this._buildRoomData(entity.location, rooms),
            entities: [
                ...near.sameRoom.map(e => ({ ...e, room: 'same' })),
                ...near.otherRooms.map(e => ({ ...e, room: e.roomName }))
            ],
            droppedItems,
            actions: actionData,
            hints: hintsData.slice(0, LLM_CONTEXT_MAX_HINTS),
            recentEvents: events,
            roomChat: chat,
            lastActionsResults: feedback,
            instincts: instinctSection
        };
        return { text, data, stats };
    }

    // =========================================================================
    // SECTION BUILDERS — each returns the structured data for one section
    // =========================================================================

    /**
     * Self section data: name, durability (lowest-ratio components first, max 2),
     * key stats, equipped items, inventory grouped by host component.
     * @param {Object} entity
     * @returns {Object}
     * @private
     */
    _buildSelfData(entity) {
        const facade = this.worldStateController;
        const components = entity.components || [];

        // Durability: components with Physical.durability, lowest ratio first, max 2.
        const durability = components
            .map(comp => {
                const stats = facade.getComponentStats(comp.id);
                const cur = stats?.[TRAIT_GROUPS.PHYSICAL]?.[STAT_NAMES.DURABILITY];
                const def = this._componentDef(comp.type);
                const max = def?.traits?.[TRAIT_GROUPS.PHYSICAL]?.[STAT_NAMES.DURABILITY] ?? cur;
                if (typeof cur !== 'number' || typeof max !== 'number' || max <= 0) return null;
                return { component: comp.type, current: cur, max, ratio: cur / max };
            })
            .filter(Boolean)
            .sort((a, b) => a.ratio - b.ratio)
            .slice(0, 2);

        // Key stats aggregated across components.
        const stats = {};
        const sum = (trait, stat) => components.reduce((acc, comp) => {
            const v = facade.getComponentStats(comp.id)?.[trait]?.[stat];
            return acc + (typeof v === 'number' ? v : 0);
        }, 0);
        const has = (trait, stat) => components.some(comp => {
            const v = facade.getComponentStats(comp.id)?.[trait]?.[stat];
            return typeof v === 'number';
        });
        const statsLines = {
            [flatKey(TRAIT_GROUPS.PHYSICAL, STAT_NAMES.STRENGTH)]: has(TRAIT_GROUPS.PHYSICAL, STAT_NAMES.STRENGTH) ? sum(TRAIT_GROUPS.PHYSICAL, STAT_NAMES.STRENGTH) : null,
            [flatKey(TRAIT_GROUPS.PHYSICAL, STAT_NAMES.SHARPNESS)]: has(TRAIT_GROUPS.PHYSICAL, STAT_NAMES.SHARPNESS) ? sum(TRAIT_GROUPS.PHYSICAL, STAT_NAMES.SHARPNESS) : null,
            'Movement.move': has('Movement', 'move') ? sum('Movement', 'move') : null,
            'Mind.think_level': has('Mind', 'think_level') ? sum('Mind', 'think_level') : null
        };

        // Equipped items (live stats from EquippedItemStatsController).
        const equipped = (facade.getEquippedItems(entity.id) || []).map(eq => {
            const itemStats = facade.equippedItemStats?.getStats(eq.eqId) || null;
            return {
                eqId: eq.eqId,
                itemId: eq.itemId,
                type: eq.itemType,
                hostComponent: eq.componentId,
                stats: itemStats || null
            };
        });

        // Inventory grouped by host component: type xN.
        const inventory = [];
        const itemsByHost = facade.getEntityItems(entity.id) || {};
        for (const [hostComponentId, items] of Object.entries(itemsByHost)) {
            const byType = {};
            for (const item of items || []) {
                byType[item.type] = (byType[item.type] || 0) + 1;
            }
            for (const [type, count] of Object.entries(byType)) {
                inventory.push({ type, count, hostComponent: hostComponentId });
            }
        }

        return {
            name: entity.name || 'Droid',
            isNPC: Boolean(entity.isNPC),
            durability,
            stats: statsLines,
            equipped,
            inventory
        };
    }

    /**
     * Room data for the "You are in" block: identity, description, size and
     * resolved exits. Reads the room from the UID-keyed rooms map supplied by
     * the caller (computed once in buildContext).
     * @param {string|null} roomUid - Room UID (entity.location).
     * @param {Object<string, Object>} rooms - UID-keyed rooms map (from `getRooms()`).
     * @returns {{ id: string, name: string, description: string, width: number, height: number, x: number, y: number, exits: Array<{ door: string, targetRoomName: string }> }|null}
     *   Null when the room cannot be resolved (degrade gracefully).
     * @private
     */
    _buildRoomData(roomUid, rooms) {
        const room = this._getRoomByUid(roomUid, rooms);
        if (!room) return null;

        const exits = resolveRoomExits(rooms, room, LlmContextController.BUDGET.maxExits);

        return {
            id: room.id,
            name: room.name || roomUid,
            description: room.description || '',
            width: room.width,
            height: room.height,
            x: room.x,
            y: room.y,
            exits
        };
    }

    /**
     * Dropped items in the current room with positions, for the
     * "Dropped items:" line. Capped at BUDGET.maxDroppedItems.
     * @param {string|null} roomUid - Room UID (entity.location).
     * @returns {Array<{ id: string, name: string, itemType: string, x: number, y: number }>}
     * @private
     */
    _buildDroppedItemsData(roomUid) {
        const facade = this.worldStateController;
        if (!roomUid || !facade.getDroppedItemsByRoom) return [];
        try {
            const items = facade.getDroppedItemsByRoom(roomUid) || {};
            return Object.values(items)
                .slice(0, LlmContextController.BUDGET.maxDroppedItems)
                .map(it => ({
                    id: it.id,
                    name: it.name || it.itemType || 'item',
                    itemType: it.itemType,
                    x: it.x,
                    y: it.y
                }));
        } catch {
            return [];
        }
    }

    /**
     * Nearby entities: same room (distance-sorted, capped) + up to 2 from
     * other rooms (room-named).
     * @param {Object} self
     * @param {string} selfRoomUid
     * @param {number} maxEntities
     * @param {Object<string, Object>} rooms - UID-keyed rooms map (from `getRooms()`).
     * @returns {{ sameRoom: Array, otherRooms: Array }}
     * @private
     */
    _buildNearbyData(self, selfRoomUid, maxEntities, rooms) {
        const facade = this.worldStateController;
        const all = Object.values(facade.getAll().entities || {});
        const sameRoom = [];
        const otherRooms = [];

        for (const other of all) {
            if (other.id === self.id) continue;
            const inSameRoom = other.location === selfRoomUid;
            const distance = inSameRoom
                ? Math.round(Math.hypot((other.spatial?.x || 0) - (self.spatial?.x || 0), (other.spatial?.y || 0) - (self.spatial?.y || 0)))
                : null;
            const durability = this._firstDurability(other);
            const stats = this._topStats(other, LLM_CONTEXT_MAX_NEARBY_STATS);
            const entry = {
                id: other.id,
                name: other.name || 'Droid',
                distance,
                durability,
                stats
            };
            if (inSameRoom) {
                // Room-relative coordinates so the LLM can "see" where each
                // same-room entity stands (spec: better text & vision).
                sameRoom.push({
                    ...entry,
                    x: typeof other.spatial?.x === 'number' ? other.spatial.x : null,
                    y: typeof other.spatial?.y === 'number' ? other.spatial.y : null
                });
            } else {
                otherRooms.push({ ...entry, roomName: this._roomName(other.location, rooms) });
            }
        }

        sameRoom.sort((a, b) => a.distance - b.distance);
        return { sameRoom: sameRoom.slice(0, maxEntities), otherRooms: otherRooms.slice(0, LlmContextController.BUDGET.otherRoomEntities) };
    }

    /**
     * Action section: one entry per action with at least one executable
     * component, plus the list of names that are not executable.
     * @param {string} entityId
     * @returns {{ entries: Array, notExecutable: string[] }}
     * @private
     */
    _buildActionData(entityId) {
        const facade = this.worldStateController;
        const actions = facade.getActionsForEntity(entityId) || {};
        const entries = [];
        const notExecutable = [];

        for (const [name, data] of Object.entries(actions)) {
            const canExecute = data.canExecute || [];
            if (canExecute.length === 0) {
                notExecutable.push(name);
                continue;
            }
            entries.push({
                name,
                description: data.description || '',
                range: typeof data.range === 'number' ? data.range : 'self',
                canExecute: canExecute.map(e => e.componentId),
                requirement: this._formatRequirements(data.requirements)
            });
        }
        return { entries, notExecutable };
    }

    /**
     * Hints section: deterministic suggestions for the entity.
     * Returns raw hint objects (up to 3) for the data mirror; the rendered
     * HINTS section uses hint.message strings.
     * @param {string} entityId
     * @returns {Object[]}
     * @private
     */
    _buildHintsData(entityId) {
        try {
            const facade = this.worldStateController;
            if (!facade.hintController || !facade.hintController.getHints) return [];
            const result = facade.hintController.getHints(entityId);
            if (!result || !Array.isArray(result.hints)) return [];
            return result.hints.slice(0, LLM_CONTEXT_MAX_HINTS);
        } catch {
            // Missing hintController or getHints() throwing → degrade gracefully.
            return [];
        }
    }

    /**
     * Events section: last `limit` world events, rendered as
     * "[tick] [action] message".
     * @param {number} limit
     * @returns {string[]}
     * @private
     */
    _buildEventData(limit) {
        const facade = this.worldStateController;
        if (!facade.getRecentEvents) return [];
        const perMessageChars = LlmContextController.BUDGET.perMessageChars;
        return (facade.getRecentEvents(limit) || []).map(ev => {
            const msg = (ev.message || '').slice(0, perMessageChars);
            return `[${ev.tick ?? '----'}] [${ev.action}] ${msg}`;
        });
    }

    /**
     * Chat section (Feature D's RoomChatController — optional at this step):
     * "Speaker: text" lines for the entity's current room.
     * @param {string} roomUid
     * @param {number} limit
     * @returns {string[]}
     * @private
     */
    _buildChatData(roomUid, limit) {
        const facade = this.worldStateController;
        if (!facade.getRoomChatMessages) return [];
        try {
            const messages = facade.getRoomChatMessages(roomUid, limit) || [];
            const perMessageChars = LlmContextController.BUDGET.perMessageChars;
            return messages.map(m => `${m.speakerName || '???'}: ${(m.text || '').slice(0, perMessageChars)}`);
        } catch {
            return [];
        }
    }

    /**
     * Feedback data for "YOUR LAST ACTIONS & RESULTS" section: reads recent
     * action-outcome entries from the per-agent feedback controller (Feature E).
     * Returns an array of outcome objects sorted newest-first, limited to 5.
     * @param {string} entityId
     * @returns {Array<Object>}
     * @private
     */
    _buildFeedbackData(entityId) {
        const facade = this.worldStateController;
        if (!facade.llmAgentFeedbackController?.getRecent) return [];
        try {
            const outcomes = facade.llmAgentFeedbackController.getRecent(entityId, AGENT_FEEDBACK_CAPACITY) || [];
            return outcomes;
        } catch {
            return [];
        }
    }

    // =========================================================================
    // RENDER
    // =========================================================================

    /**
     * Renders the sectioned narrative text.
     * @param {Object} rooms - UID-keyed rooms map (from `getRooms()`), threaded in
     *   by buildContext so the room block is resolved from the same single clone.
     * @private
     */
    _render(entity, roomName, self, near, actions, hints, events, chat, feedback, instincts, droppedItems, _maxEntities, rooms) {
        const roomData = this._buildRoomData(entity.location, rooms);
        const lines = [];

        // === YOUR STATE ===
        lines.push('=== YOUR STATE ===');
        lines.push(`Name: ${self.name}`);
        if (roomData) {
            lines.push(`You are in: ${roomData.name} — ${roomData.description || ''}`);
            const pos = (entity.spatial?.x != null && entity.spatial?.y != null)
                ? `Your position: (${Math.round(entity.spatial.x)}, ${Math.round(entity.spatial.y)})`
                : '';
            lines.push(`Room size: ${roomData.width} x ${roomData.height}${pos ? ` | ${pos}` : ''}`);
            lines.push(roomData.exits.length > 0
                ? `Exits: ${roomData.exits.map(ex => `${ex.door} → ${ex.targetRoomName}`).join(' | ')}`
                : 'Exits: (none)');
        } else {
            lines.push(`You are in: ${roomName || 'unknown'}`);
        }
        lines.push(self.durability.length > 0
            ? `Durability: ${self.durability.map(d => `${d.component} ${d.current}/${d.max}`).join(', ')}`
            : 'Durability: (none)');
        const statParts = [
            self.stats[flatKey(TRAIT_GROUPS.PHYSICAL, STAT_NAMES.STRENGTH)] !== null && `strength=${self.stats[flatKey(TRAIT_GROUPS.PHYSICAL, STAT_NAMES.STRENGTH)]}`,
            self.stats[flatKey(TRAIT_GROUPS.PHYSICAL, STAT_NAMES.SHARPNESS)] !== null && `sharpness=${self.stats[flatKey(TRAIT_GROUPS.PHYSICAL, STAT_NAMES.SHARPNESS)]}`,
            self.stats['Movement.move'] !== null && `move=${self.stats['Movement.move']}`,
            self.stats['Mind.think_level'] !== null && `think=${self.stats['Mind.think_level']}`
        ].filter(Boolean);
        lines.push(statParts.length > 0 ? `Key stats: ${statParts.join(' ')}` : 'Key stats: (none)');
        lines.push(self.equipped.length > 0
            ? `Equipped: ${self.equipped.map(eq => eq.type).join(', ')}`
            : 'Equipped: (none)');
        lines.push(self.inventory.length > 0
            ? `Inventory: ${self.inventory.map(i => `${i.type} x${i.count} (${i.hostComponent})`).join(', ')}`
            : 'Inventory: (none)');
        lines.push('');

        // === NEARBY ENTITIES ===
        lines.push('=== NEARBY ENTITIES ===');
        const nearby = [...near.sameRoom, ...near.otherRooms];
        if (nearby.length === 0) {
            lines.push('(none)');
        } else {
            nearby.forEach((e, i) => {
                const stats = Object.entries(e.stats)
                    .map(([k, v]) => `${k.split('.')[1]}=${v}`)
                    .slice(0, LLM_CONTEXT_MAX_NEARBY_STATS)
                    .join(', ');
                const dur = e.durability ? ` - durability ${e.durability.current}/${e.durability.max}` : '';
                const where = e.roomName ? ` (in ${e.roomName})` : ` (${e.distance} away)`;
                // Same-room entities carry their room-relative position so the
                // LLM can gauge where each one stands; other-room entries do not.
                const at = (e.x != null && e.y != null) ? ` at (${Math.round(e.x)}, ${Math.round(e.y)})` : '';
                lines.push(`${i + 1}. ${e.name}${where}${at}${dur}${stats ? `, ${stats}` : ''}`);
            });
        }
        if (Array.isArray(droppedItems) && droppedItems.length > 0) {
            lines.push(`Dropped items: ${droppedItems.map(it => `${it.name} at (${Math.round(it.x)}, ${Math.round(it.y)})`).join(', ')}`);
        }
        lines.push('');

        // === YOUR ACTIONS (executable now) ===
        lines.push('=== YOUR ACTIONS (executable now) ===');
        if (actions.entries.length === 0) {
            lines.push('(none)');
        } else {
            for (const a of actions.entries) {
                lines.push(`- ${a.name}: ${a.description} | range ${a.range} | needs ${a.requirement || 'nothing'} | use ${a.canExecute[0]}`);
            }
        }
        if (actions.notExecutable.length > 0) {
            lines.push(`${actions.notExecutable.length} action${actions.notExecutable.length > 1 ? 's' : ''} not executable right now: ${actions.notExecutable.join(', ')}`);
        }
        lines.push('');

        // === YOUR INSTINCTS ===
        lines.push('=== YOUR INSTINCTS ===');
        if (instincts.length === 0) {
            lines.push('(none)');
        } else {
            for (const inst of instincts) {
                lines.push(`- ${inst.name}: ${inst.description}`);
            }
        }
        lines.push('');

        // === HINTS ===
        lines.push('=== HINTS ===');
        const hintLines = hints.slice(0, LLM_CONTEXT_MAX_HINTS).map(h => `- ${h.message || h}`);
        lines.push(hintLines.length > 0 ? hintLines.join('\n') : '(none)');
        lines.push('');

        // === RECENT EVENTS ===
        lines.push('=== RECENT EVENTS ===');
        lines.push(events.length > 0 ? events.join('\n') : '(none)');
        lines.push('');

        // === YOUR LAST ACTIONS & RESULTS ===
        lines.push('=== YOUR LAST ACTIONS & RESULTS ===');
        if (feedback.length === 0) {
            lines.push('(none — this is your first round or no actions recorded yet)');
        } else {
            for (const f of feedback) {
                const status = f.success ? '✓' : '✗';
                const instinctTag = f.instinct ? ` (instinct: ${f.instinct})` : '';
                lines.push(`- ${status} ${f.actionName}: ${f.detail}${instinctTag}`);
            }
        }
        lines.push('');

        // === ROOM CHAT ===
        lines.push('=== ROOM CHAT ===');
        lines.push(chat.length > 0 ? chat.join('\n') : '(none)');

        return lines.join('\n');
    }

    // =========================================================================
    // HELPERS
    // =========================================================================

    /**
     * Component type definition from data/components.json (via the registry
     * held by the component controller — same source the server merges stats
     * from, per spec §3: "mesma fonte do server").
     * @param {string} componentType
     * @returns {Object|null}
     * @private
     */
    _componentDef(componentType) {
        // Public accessor only (BUG-032 pattern): no direct reads of
        // componentController.componentRegistry.
        return this.worldStateController.componentController?.getComponentDefinition?.(componentType) ?? null;
    }

    /**
     * First durability-bearing component of an entity (current/max).
     * @param {Object} entity
     * @returns {Object|null}
     * @private
     */
    _firstDurability(entity) {
        const facade = this.worldStateController;
        for (const comp of entity.components || []) {
            const stats = facade.getComponentStats(comp.id);
            const cur = stats?.[TRAIT_GROUPS.PHYSICAL]?.[STAT_NAMES.DURABILITY];
            const max = this._componentDef(comp.type)?.traits?.[TRAIT_GROUPS.PHYSICAL]?.[STAT_NAMES.DURABILITY] ?? cur;
            if (typeof cur === 'number' && typeof max === 'number' && max > 0) {
                return { component: comp.type, current: cur, max };
            }
        }
        return null;
    }

    /**
     * Top-`n` stats (by value) across an entity's components, keyed
     * trait.stat.
     * @param {Object} entity
     * @param {number} n
     * @returns {Object}
     * @private
     */
    _topStats(entity, n) {
        const facade = this.worldStateController;
        const totals = {};
        for (const comp of entity.components || []) {
            const stats = facade.getComponentStats(comp.id) || {};
            for (const [trait, values] of Object.entries(stats)) {
                if (trait === 'Spatial') continue; // position is not a stat
                for (const [stat, value] of Object.entries(values)) {
                    if (typeof value !== 'number') continue;
                    if (stat === STAT_NAMES.DURABILITY) continue;
                    const key = `${trait}.${stat}`;
                    totals[key] = (totals[key] || 0) + value;
                }
            }
        }
        return Object.fromEntries(
            Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, n)
        );
    }

    /**
     * Requirement list → "Trait.stat >= min" summary (joined with ", ").
     * @param {Array|null} requirements
     * @returns {string}
     * @private
     */
    _formatRequirements(requirements) {
        if (!Array.isArray(requirements) || requirements.length === 0) return 'nothing';
        return requirements.map(r => `${r.trait}.${r.stat} >= ${r.minValue}`).join(', ');
    }

    /**
     * Room display name by room UID.
     * @param {string|null} roomUid
     * @param {Object<string, Object>} rooms - UID-keyed rooms map (from `getRooms()`).
     * @returns {string}
     * @private
     */
    _roomName(roomUid, rooms) {
        const room = this._getRoomByUid(roomUid, rooms);
        return room?.name || roomUid || 'unknown';
    }

    /**
     * Centralized null-guarded room lookup by UID against the UID-keyed rooms
     * map (spec §9.4). Returns the room record or null when the UID is missing
     * or not present in the map, so callers never index the map directly.
     * @param {string|null} roomUid - Room UID to look up.
     * @param {Object<string, Object>} rooms - UID-keyed rooms map (from `getRooms()`).
     * @returns {Object|null} The room record, or null.
     * @private
     */
    _getRoomByUid(roomUid, rooms) {
        if (!roomUid) return null;
        const room = rooms[roomUid];
        return room || null;
    }

    /**
     * Clamps an optional numeric override to [0, max].
     * @param {number|undefined} value
     * @param {number} max
     * @returns {number}
     * @private
     */
    _clampOption(value, max) {
        if (value === undefined || value === null) return max;
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) return max;
        return Math.min(n, max);
    }
}

export default LlmContextController;
