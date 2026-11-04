/**
 * LlmContextController — State→text translation layer for the LLM.
 *
 * Feature B (spec §4.3): a local LLM can only reason about the world
 * through text. This controller composes a bounded, sectioned narrative
 * (hard cap of 5000 chars) from the live world state: entity self-state,
 * executable actions (with the natural-language descriptions the actions
 * registry ships), world failures (the warn-level event tail), its world
 * (current room state + the perception delta stream), and (when the
 * room-chat layer exists) the room chat.
 *
 * It is a reader/composer — a logic controller, not a state owner. It
 * receives the facade via setWorldStateController() and only ever reads
 * through its public API (spec "public API only" rule).
 *
 * EVERY EVENT SECTION IS ONE ROUND'S (wiki/decisions/round-scoped-context.md).
 * The NPC's LLM turn fires at ROUND START: after the previous round resolved,
 * before the actions this turn queues will resolve. The one round a turn can be
 * about is therefore the round that JUST RESOLVED, and every event section is
 * filtered to it — `getWorldEventsForRound`, `getRoomChatMessagesForRound`, the
 * perception window filtered by the round an entry covers, and the agent's own
 * action outcomes filtered by the round they were recorded in.
 *
 * Nothing is delivered late: an event from a round the agent did not experience
 * is never shown to it. That is why no per-agent delivery cursor exists here —
 * a cursor is the mechanism that produces backlogs, and the backlog was the
 * complaint. The frame line names the round once per section; a row carries no
 * round of its own (no `[round N]` on "HAPPENED TO YOU", no `[tick]` on "WORLD
 * FAILURES"), because a provenance stamp inside a block whose header already
 * names the round contradicts it. Before the first resolution — or with no turn
 * system wired — the sections are empty and the label carries no number: a
 * round is never invented.
 *
 * The "YOUR WORLD" section is the integrated perception seam (wiki
 * subMDs/systems/perception_system.md): "now in this room" renders the
 * current layout (state), "this round" renders the room's delta
 * stream since the agent's observation cursor — the read of that block IS
 * the observation (the per-agent cursor advances on read, so the next
 * round's build shows only what changed after this one). State comes before
 * change on purpose: the budget cascade sheds delta lines before state
 * lines, so the agent never loses its spatial anchor. Each "now in this
 * room" line also carries the entity's LIVE target ids (entity id for
 * targetEntityId actions; its first existence-bearing component id for
 * targetingType "component" actions like cut) — rebuilt from the world
 * every round, because ids regenerate on respawn and any older copy in the
 * transcript is stale (the Minako/tree "target entity not found" incident,
 * 2026-10-21).
 *
 * The section headers are stable and deliberate (prompt engineering):
 *   === YOUR STATE ===, === HINTS ===,
 *   === WORLD FAILURES ===, === YOUR LAST ACTIONS & RESULTS ===,
 *   === HAPPENED TO YOU ===, === YOUR WORLD (room) ===, === ROOM CHAT ===,
 *   === RECENT TOOLS ===
 * (the executable action list and instincts moved out of the context into
 * native discovery tools, get_actions / get_instincts — the agent discovers
 * them on demand instead of reading a fixed section). === RECENT TOOLS ===
 * lists the newest outcomes of the outcome-producing tools the agent invoked
 * (execute_action, toApproach, use_instinct, speak_in_room), success and
 * failure, named the way it called each tool. Recorded at dispatch time in
 * the round runner. Placed after the room chat so the newest local signal
 * is the most likely to survive the 5000-char budget cascade (sheds oldest
 * first). Empty sections still print their header plus "(none)" so weak
 * local models always see the same structure.
 *
 * === HAPPENED TO YOU === is the agent-relative half of the perception action
 * stream. Every successful action records WHO IT WAS DIRECTED AT in the shared
 * ActionAttributionStore (one writer: the consequence dispatcher), and the
 * perception flush turns those records into performed-action rows carrying the
 * resolved target. This section reads the very same window the "this round"
 * block renders and keeps the rows whose target is THIS agent, so an
 * attack lands in its brain as its own sentence — `Droid used "droid punch" on
 * you (hit: Droid Head, used: 1x left droidHand, 1x right droidHand)` — instead
 * of dissolving into the shared,
 * reader-independent delta summary ("1 action performed …"), which never can
 * say "you" because one summary serves every reader of the room. It is action-
 * agnostic by construction: any action the dispatcher runs is captured, from
 * any actor (another NPC, the player, a machine), with no per-action list and
 * no special casing. Rows this agent performed itself are excluded (the agent
 * did those — "YOUR LAST ACTIONS & RESULTS" says them, with their target); the
 * direction is deliberately spelled out in both sections because a local model
 * that cannot tell who hit whom keeps attacking its own attacker's attacker.
 *
 * Inside === YOUR STATE ===, the stable "Body attributes:" line lists the
 * whole-entity stats declared for the entity's blueprint in
 * data/mods/core-entity-attributes/entityAttributes.json — flat "Group.stat" keys with
 * current/max (current is the live value; ceiling and per-turn drain come
 * from the declaration itself, read fresh each build), plus "(drain N/turn)"
 * when the file declares a nonzero per-turn drain. A blueprint with no entry
 * prints "(none)" — "no data, no stats" (the line is always present, so the
 * agent always sees the stat space, and a legacy entity without live
 * attributes still renders its declared stats at 0). Two deliberate seams:
 * (a) a malformed decl (non-finite max/drainPerTurn — reachable only with an
 * unvalidated facade, since the production facade validates through
 * EntityAttributeData) is guarded: the stat renders as "Group.stat=current"
 * with no "/max" suffix; (b) displayed caps follow the data file while live
 * clamping follows the spawn-snapshot attributesConfig, so the two can
 * diverge only if a user edits the gitignored data file after an entity
 * exists.
 *
 * @module LlmContextController
 */

import {
    CONTEXT_MAX_ENTITIES,
    CONTEXT_MAX_DROPPED_ITEMS,
    CONTEXT_MAX_EXITS,
    CONTEXT_MAX_PLACED_MACHINES,
    CHAT_MESSAGE_MAX_LENGTH,
    AGENT_FEEDBACK_CAPACITY,
    LLM_CONTEXT_MAX_CHARS,
    LLM_CONTEXT_OTHER_ROOM_ENTITIES,
    LLM_CONTEXT_MAX_FAILURES,
    LLM_CONTEXT_MAX_DELTAS,
    LLM_CONTEXT_MAX_ACTIONS_ON_YOU,
    LLM_CONTEXT_MAX_CHAT,
    LLM_CONTEXT_MAX_INSTINCTS,
    LLM_CONTEXT_MAX_NEARBY_STATS,
    LLM_CONTEXT_MAX_HINTS,
    LLM_CONTEXT_MAX_CHAT_IN_CONTEXT,
    LLM_CONTEXT_MAX_INSTINCTS_IN_CONTEXT,
    WORLD_EVENTS_MAX_LIMIT
} from '../../utils/Constants.js';
import { TRAIT_GROUPS, STAT_NAMES, flatKey } from '../../../shared/StatVocabulary.js';
import { hasUsableComponent } from '../../utils/npcAiUtils.js';
import { resolveRoomExits } from '../../utils/ContextResolution.js';
import { DEFAULT_ITEM_VOLUME } from '../../../shared/Defaults.js';

/**
 * Whether a round number is known. Round 0 is a real round (the first one the
 * turn system resolves); `-1` (nothing resolved yet), `null`, `undefined` and
 * anything that is not an integer are unknown.
 *
 * Unknown is never delivered. A section whose round nobody knows would put
 * unattributed history inside a turn that claims a round, and a row with no
 * round of its own matches nothing — so both halves of the comparison are
 * checked here, not just the one the reader brought
 * (wiki/decisions/round-scoped-context.md).
 * @param {unknown} round
 * @returns {boolean}
 */
function hasRound(round) {
    return Number.isInteger(round) && round >= 0;
}

class LlmContextController {
    static BUDGET = {
        maxChars: LLM_CONTEXT_MAX_CHARS,          // hard cap on the rendered text (~1.3k–1.5k tokens); raised from 4000 to preserve the enriched spatial detail (room size/positions/exits)
        maxEntities: CONTEXT_MAX_ENTITIES,       // same-room entities listed (single-sourced in Constants.js)
        otherRoomEntities: LLM_CONTEXT_OTHER_ROOM_ENTITIES,    // entities from other rooms (room-named)
        maxDroppedItems: CONTEXT_MAX_DROPPED_ITEMS, // current-room dropped items listed (positions) (single-sourced in Constants.js)
        maxExits: CONTEXT_MAX_EXITS,             // current-room exits listed (safety cap) (single-sourced in Constants.js)
        maxPlacedMachines: CONTEXT_MAX_PLACED_MACHINES, // current-room placed machines listed (positions) (single-sourced in Constants.js)
        maxFailures: LLM_CONTEXT_MAX_FAILURES,   // warn-level world event tail ("WORLD FAILURES" section)
        maxDeltas: LLM_CONTEXT_MAX_DELTAS,       // perception delta lines ("this round" block)
        maxActionsOnYou: LLM_CONTEXT_MAX_ACTIONS_ON_YOU, // rows in "HAPPENED TO YOU" (actions targeting this agent)
        maxChat: LLM_CONTEXT_MAX_CHAT,
        maxInstincts: LLM_CONTEXT_MAX_INSTINCTS,         // displayed instincts (display cap)
        perMessageChars: CHAT_MESSAGE_MAX_LENGTH     // per chat/event line truncation (shared with the room-chat message cap)
    };

    /**
     * @param {Object} deps
     * @param {Object} deps.actionRegistry - data/mods/core-actions/actions.json (loaded by the composition root).
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
     * @param {Object} [options] - May override maxEntities / maxFailures
     *   (a.k.a. the historical `maxEvents`) / maxDeltas / maxChat (each
     *   clamped to the BUDGET maximum). The "HAPPENED TO YOU" cap is not an
     *   option: it is `LLM_CONTEXT_MAX_ACTIONS_ON_YOU`, because the section is
     *   the agent's own bodily history and no caller gets to tune it away.
     *   `instincts` (agent path) bypasses the facade instinct fallback.
     *   `observe` (default `true`) decides WHOSE window this composition reads.
     *   `true` is the agent's brain: its room window since ITS observation
     *   cursor, and the read IS the observation (the cursor advances). `false`
     *   is a reader that is not the brain (the Agent View inspector,
     *   `GET /llm/context/:entityId`): the ROOM's recent window, stateless — it
     *   neither consumes the agent's perception (a camera that eats what it
     *   films is not a camera) nor depends on the agent's cursor, which the
     *   round runner has already moved past (peeking that window shows `(none)`
     *   to an operator while the agent's own context carries the blow).
     * @returns {{ text: string, data: Object, stats: { chars: number, budgetChars: number, truncated: { entities: boolean, failures: boolean, deltas: boolean, actionsOnYou: boolean, chat: boolean, feedback: boolean, instincts: boolean } } }}
     */
    buildContext(entityId, options = {}) {
        const facade = this.worldStateController;
        if (!facade) {
            throw new Error('LlmContextController: facade not injected (call setWorldStateController first)');
        }

        const maxEntities = this._clampOption(options.maxEntities, LlmContextController.BUDGET.maxEntities);
        // `maxEvents` is the historical option name; the section it capped is
        // now the warn-only "WORLD FAILURES" feed (maxFailures is the new name).
        const maxFailures = this._clampOption(
            options.maxFailures ?? options.maxEvents, LlmContextController.BUDGET.maxFailures);
        const maxDeltas = this._clampOption(options.maxDeltas, LlmContextController.BUDGET.maxDeltas);
        const maxChat = this._clampOption(options.maxChat, LlmContextController.BUDGET.maxChat);

        // Whether this composition consumes the agent's perception window.
        // Default true (the brain). Debug readers pass observe: false.
        const observe = options.observe !== false;

        const entity = facade.getEntity(entityId);
        if (!entity) {
            return { text: '', data: null, stats: { chars: 0, budgetChars: LlmContextController.BUDGET.maxChars, truncated: { entities: false, failures: false, deltas: false, actionsOnYou: false, chat: false, feedback: false, instincts: false } } };
        }

        // Compute the rooms map ONCE (a defensive deep clone from the facade)
        // and thread it into every room-reading helper below. The UID-keyed
        // map is the O(1) index, so no separate reverse map is needed (spec §9.5).
        const rooms = this.worldStateController?.getRooms() || {};
        const roomName = this._roomName(entity.location, rooms);
        const self = this._buildSelfData(entity);
        const nearData = this._buildNearbyData(entity, entity.location, maxEntities, rooms);
        // The round every event section is scoped to — the one that just
        // resolved (wiki/decisions/round-scoped-context.md). Read ONCE, here, so
        // a round cannot change mid-composition (A-6); it is the only round
        // number that ever appears in this context.
        const roundNumber = this._referenceRound(facade);
        // Read ONCE: the room-scoped perception read IS the observation (the
        // agent cursor advances on this call), so truncation later slices the
        // result in memory — a second facade read would find an already-
        // advanced cursor and nothing left to show. Filtered to `roundNumber`
        // below, like every other event stream.
        const deltasData = this._buildDeltasData(entity, maxDeltas, observe, roundNumber);
        const actionData = this._buildActionData(entityId);
        const hintsData = this._buildHintsData(entityId);
        const failuresData = this._buildFailureData(maxFailures, roundNumber);
        const chatData = this._buildChatData(entity.location, maxChat, roundNumber);
        const feedbackData = this._buildFeedbackData(entityId, roundNumber);
        // Derived from the SAME perception read as the delta block (never a
        // second read — the cursor already advanced). Built from the full
        // window here, before the cascade can slice `deltas` in memory, so
        // shedding delta lines never hides what was done to the agent.
        const happenedToYouData = this._buildInboundActionsData(entity, deltasData);

        const stats = {
            chars: 0,
            budgetChars: LlmContextController.BUDGET.maxChars,
            truncated: { entities: false, failures: false, deltas: false, actionsOnYou: false, chat: false, feedback: false, instincts: false }
        };

        // Build instincts data: preferred source is options.instincts (agent path),
        // else facade fallback (debug endpoint path).
        const instincts = options.instincts !== undefined
            ? options.instincts
            : (facade.instinctController?.generateForEntity?.(entityId) ?? []);

        // Truncation order when over budget (spec §4.3): delta lines first
        // (the "this round" window is the most expendable — the
        // state block is the agent's spatial anchor and must survive), then
        // entities (same-room first), then failures, then chat (drop to 5),
        // then feedback (dropped entirely), then instincts (reduced to 3, then
        // dropped). The `data` mirror always reflects exactly what was
        // rendered (the truncated versions).
        let near = nearData;
        let deltas = deltasData;
        let happenedToYou = happenedToYouData;
        let failures = failuresData;
        let chat = chatData;
        let feedback = feedbackData;
        let instinctSection = instincts.slice(0, LlmContextController.BUDGET.maxInstincts);
        const droppedItems = this._buildDroppedItemsData(entity.location);
        const placedMachines = this._buildPlacedMachinesData(entity.location);
        // One render closure for the whole cascade. It reads the shedding `let`
        // bindings above, so every step below is a single `render()` call over
        // ONE argument bundle (`CHG-4`: the section list is the only thing a
        // cascade step ever changes, and a positional list of a dozen sections
        // is where a silently swapped pair would hide).
        const render = () => this._render({
            entity, roomName, self, near, deltas, hintsData, failures, chat, feedback, happenedToYou, droppedItems, placedMachines, rooms, roundNumber
        });
        let text = render();

        if (text.length > stats.budgetChars) {
            // Deltas are sliced in memory (NOT re-read): the perception read
            // above IS the observation — the cursor already advanced, so a
            // second facade read would find nothing left to show.
            if (deltas.length > 2) {
                deltas = deltas.slice(-Math.max(2, Math.floor(deltas.length / 2)));
                text = render();
                stats.truncated.deltas = true;
            }

            if (text.length > stats.budgetChars) {
                near = this._buildNearbyData(entity, entity.location, Math.max(2, Math.floor(maxEntities / 2)), rooms);
                text = render();
                stats.truncated.entities = near.sameRoom.length < nearData.sameRoom.length || text.length > stats.budgetChars;
            }

            if (text.length > stats.budgetChars && failures.length > 2) {
                failures = failures.slice(-Math.max(2, Math.floor(failures.length / 2)));
                text = render();
                stats.truncated.failures = true;
            }

            if (text.length > stats.budgetChars && chat.length > LLM_CONTEXT_MAX_CHAT_IN_CONTEXT) {
                chat = chat.slice(0, LLM_CONTEXT_MAX_CHAT_IN_CONTEXT);
                text = render();
                stats.truncated.chat = true;
            }

            // "HAPPENED TO YOU" gives way only after the delta window, the
            // entities, the failures feed and the chat — never before them: what
            // was done TO this agent is the row it needs in order to decide
            // anything about its own condition. Halved, newest kept; its cap is
            // its own constant (LLM_CONTEXT_MAX_ACTIONS_ON_YOU).
            if (text.length > stats.budgetChars && happenedToYou.length > 1) {
                happenedToYou = happenedToYou.slice(-Math.max(1, Math.floor(happenedToYou.length / 2)));
                text = render();
                stats.truncated.actionsOnYou = true;
            }

            // Drop feedback section first (least critical, spec §4.3)
            if (text.length > stats.budgetChars && feedback.length > 0) {
                feedback = [];
                text = render();
                stats.truncated.feedback = true;
            }

            // Reduce instincts to 3 (spec §4.3: instincts are lowest priority after feedback)
            if (instinctSection.length > LLM_CONTEXT_MAX_INSTINCTS_IN_CONTEXT) {
                instinctSection = instinctSection.slice(0, LLM_CONTEXT_MAX_INSTINCTS_IN_CONTEXT);
                text = render();
                stats.truncated.instincts = true;
            }

            // Final fallback: if still over budget after all truncation, truncate instincts further
            if (text.length > stats.budgetChars && instinctSection.length > 0) {
                instinctSection = [];
                text = render();
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
            placedMachines,
            actions: actionData,
            hints: hintsData.slice(0, LLM_CONTEXT_MAX_HINTS),
            deltas,
            worldFailures: failures,
            roomChat: chat,
            lastActionsResults: feedback,
            happenedToYou,
            instincts: instinctSection
        };
        return { text, data, stats };
    }

    // =========================================================================
    // SECTION BUILDERS — each returns the structured data for one section
    // =========================================================================

    /**
     * Self section data: name, body (every component, each with its existence
     * current/max when it carries a Physical.existence stat, and its side
     * label `identifier` when it is not the blueprint's default label), key
     * stats, whole-entity attributes declared for the blueprint (the
     * "Body attributes:" line, from data/mods/core-entity-attributes/entityAttributes.json),
     * equipped items, inventory grouped by host component.
     * @param {Object} entity
     * @returns {Object}
     * @private
     */
    _buildSelfData(entity) {
        const facade = this.worldStateController;
        const components = entity.components || [];

        // Body: every component of the droid, in the droid's own order (the
        // "Existence:" line is the droid's full component list, not a top-N
        // of damaged parts). Each entry carries the component's side label
        // (its blueprint `identifier`, e.g. "frontal_left" / "left_frontal_left")
        // so repeated types (two legs, three toes) are unambiguous; the plain
        // "default" label (roots like m1Head) renders as bare type. Components
        // that carry a Physical.existence stat render as "type (label) current/max";
        // the rest render as "type (label)" or bare "type". `max` is only
        // carried when there is a live `current`.
        const existence = components.map(comp => {
            const stats = facade.getComponentStats(comp.id);
            const cur = stats?.[TRAIT_GROUPS.PHYSICAL]?.[STAT_NAMES.EXISTENCE];
            const def = this._componentDef(comp.type);
            const hasCur = typeof cur === 'number';
            const max = hasCur
                ? (def?.traits?.[TRAIT_GROUPS.PHYSICAL]?.[STAT_NAMES.EXISTENCE] ?? cur)
                : null;
            const identifier =
                (comp.identifier && comp.identifier !== 'default')
                    ? comp.identifier
                    : null;
            return {
                component: comp.type,
                identifier,
                current: hasCur ? cur : null,
                max,
                ratio: (hasCur && max > 0) ? cur / max : null
            };
        });

        // Key stats aggregated across components.
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

        // Named-trait flags (flammable, conductive, corrosive) and transient
        // conditions (burning, wet, corroded) per component. Flags are a derived
        // union (composition-derived + organ-granted) so they never desync;
        // conditions are world-state stored so they survive save/load.
        const componentStates = components.map(comp => ({
            id: comp.id,
            type: comp.type,
            flags: (facade.getComponentFlags?.(comp.id) ?? facade.componentController?.getComponentFlags?.(comp.id)) || [],
            conditions: (facade.getComponentConditions?.(comp.id) ?? facade.componentController?.getComponentConditions?.(comp.id)) || []
        }));

        // Whole-entity attributes declared for the entity's blueprint
        // (data/mods/core-entity-attributes/entityAttributes.json): entity-owned stats (energy,
        // pleasure, ...), distinct from the component-derived key stats above.
        // `current` reads the live value off the entity's own `attributes`
        // (seeded at spawn, moved by world logic); `max` and `drainPerTurn`
        // come from the facade declaration registry — the data file itself —
        // so a declared stat still renders when a legacy entity lost its seed.
        // Displayed caps follow the data file; live clamping follows the
        // spawn-snapshot `attributesConfig` (module header: seam (b)).
        const attrDecls = facade.getEntityAttributeDeclarations?.(entity.blueprint) || {};
        const attrLive = entity.attributes || {};
        const entityAttributes = {};
        for (const keyDecl of Object.keys(attrDecls)) {
            const [group, stat] = keyDecl.split('.');
            const decl = attrDecls[keyDecl];
            const rawCurrent = attrLive[group]?.[stat];
            // The production facade validates every decl (EntityAttributeData,
            // drops non-finite numbers); the finite guards below are a
            // defensive no-op for it — they only stop an unvalidated decl
            // from leaking "/undefined" into the LLM text (seam (a)).
            entityAttributes[keyDecl] = {
                current: Number.isFinite(rawCurrent) ? rawCurrent : 0,
                max: Number.isFinite(decl.max) ? decl.max : null,
                drainPerTurn: Number.isFinite(decl.drainPerTurn) ? decl.drainPerTurn : 0
            };
        }

        return {
            name: entity.name || 'Droid',
            isNPC: Boolean(entity.isNPC),
            existence,
            stats: statsLines,
            entityAttributes,
            equipped,
            inventory,
            componentStates
        };
    }

    /**
     * Room data for the "You are in" block: identity, environment (surface,
     * acoustic, light source, ceiling, condition, power), size and resolved
     * exits. Reads the room from the
     * UID-keyed rooms map supplied by the caller (computed once in buildContext).
     * @param {string|null} roomUid - Room UID (entity.location).
     * @param {Object<string, Object>} rooms - UID-keyed rooms map (from `getRooms()`).
     * @returns {{ id: string, name: string, width: number, height: number, x: number, y: number, surface: string|null, acoustic: string|null, lightSource: string|null, ceiling: string|null, condition: string|null, power: string|null, exits: Array<{ door: string, targetRoomName: string }>, atmosphere: { temperature: number|null, lightLevel: string|null, lightColor: string|null, smell: string|null, ambientSound: string|null, humidity: number|null, airQuality: string|null, fog: string|null }|null }|null}
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
            width: room.width,
            height: room.height,
            x: room.x,
            y: room.y,
            surface: room.surface || null,
            acoustic: room.acoustic || null,
            lightSource: room.lightSource || null,
            ceiling: room.ceiling || null,
            condition: room.condition || null,
            power: room.power || null,
            exits,
            atmosphere: room.atmosphere || null
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
     * Placed machines in the current room (static world objects set down by an
     * agent or player), with positions and entity ids, for the
     * "Placed machines:" line. The agent can see these (name, type, position,
     * ent-… id) so it can retrieve them by machineType or targetEntityId. The
     * list is capped at BUDGET.maxPlacedMachines so a room full of machines
     * cannot blow the context budget.
     * @param {string|null} roomUid - Room UID (entity.location).
     * @returns {Array<{ id: string, name: string, machineType: string, x: number, y: number }>}
     * @private
     */
    _buildPlacedMachinesData(roomUid) {
        const facade = this.worldStateController;
        if (!roomUid || !facade.getAll) return [];
        try {
            const entities = Object.values(facade.getAll().entities || {});
            return entities
                .filter(e => e && e.location === roomUid && e.isMachine === true)
                .slice(0, LlmContextController.BUDGET.maxPlacedMachines)
                .map(m => ({
                    id: m.id,
                    name: m.name || m.machineType || 'machine',
                    machineType: m.machineType,
                    x: m.spatial?.x ?? null,
                    y: m.spatial?.y ?? null
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
            // Defense-in-depth: a component-less "ghost" (mid-cascade or not
            // yet despawned) is excluded from the section entirely — no dead
            // marker, the corpse must be invisible to the LLM. See
            // _isViableTarget for the rationale.
            if (!this._isViableTarget(other)) continue;
            const inSameRoom = other.location === selfRoomUid;
            const distance = inSameRoom
                ? Math.round(Math.hypot((other.spatial?.x || 0) - (self.spatial?.x || 0), (other.spatial?.y || 0) - (self.spatial?.y || 0)))
                : null;
            const existence = this._firstExistence(other);
            const stats = this._topStats(other, LLM_CONTEXT_MAX_NEARBY_STATS);
            const entry = {
                id: other.id,
                name: other.name || 'Droid',
                distance,
                existence,
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
     * Public accessor for the action data (executable entries + not-executable
     * names). Shared by the agent's get_actions tool; no perception side
     * effects — safe to call on every tool round.
     * @param {string} entityId
     * @returns {{ entries: Array, notExecutable: string[] }}
     */
    getActionData(entityId) {
        return this._buildActionData(entityId);
    }

    /**
     * Builds the craft data for one entity (the discovery side of the
     * craft / get_crafts tools). Mirrors _buildActionData: the recipe
     * registry is the ONLY source of craftable options; this method decides
     * per recipe whether it is craftable right now plus why each recipe is
     * not craftable.
     *
     * A recipe is craftable when (a) the ENTITY holds at least `need[type]`
     * items of each input type ACROSS ITS COMPONENTS (instances are picked
     * server-side at dispatch, in entity component order — surplus of a
     * type is fine; crafting consumes exactly the multiset the model named)
     * and (b) at least one component can receive the outputs under the same
     * volume inequality the craft transaction itself checks:
     * free + freed >= needed, where `free` is that component's free volume
     * now, `freed` is the volume freed entity-wide by removing the consumed
     * instances (their host volume), and `needed` is the sum of the output
     * footprint per unit (external footprint when declared, else full
     * volume, else DEFAULT_ITEM_VOLUME) — the same math as
     * CraftingLogic.precheckCraftVolume, so the discovery list and the
     * actual craft transaction agree. The returned `componentId` is the
     * FIRST component in entity order that passes (b) — the outputs'
     * destination, rendered on formatCraftList's "on <comp>" line; the
     * consumed inputs may sit on any of the entity's components.
     *
     * All reads go through the facade's public API (reader/composer
     * contract); no mutation ever happens here.
     * @param {string} entityId
     * @returns {{
     *   craftable: Array<{ recipeId: string, name: string, description: string,
     *     needs: Array<{ type: string, quantity: number }>,
     *     outputs: Array<{ type: string, quantity: number }>,
     *     componentId: string }>,  // the outputs' destination component
     *   notCraftable: Array<{ recipeId: string, name: string, reason: string }>
     * }}
     * @private
     */
    _buildCraftData(entityId) {
        const facade = this.worldStateController;
        if (!facade) {
            return { craftable: [], notCraftable: [] };
        }

        const recipes =
            (typeof facade.getCraftingRecipes === 'function'
                ? (facade.getCraftingRecipes() || [])
                : []);
        if (!Array.isArray(recipes) || recipes.length === 0) {
            return { craftable: [], notCraftable: [] };
        }

        const entity = facade.getEntity?.(entityId);
        if (!entity || typeof entity !== 'object') {
            return { craftable: [], notCraftable: [] };
        }

        const inventoryManager = facade.inventoryManager;
        const itemDefinitions =
            (inventoryManager
                && typeof inventoryManager.getItemDefinitions === 'function')
            ? (inventoryManager.getItemDefinitions() || {})
            : {};

        // Output footprint (the space a NEW output occupies): the declared
        // external footprint (form.externalVolume, then top-level
        // externalVolume) when present, else the full volume (form.volume,
        // then top-level volume), else the no-item-loss floor. Mirrors
        // CraftingLogic.precheckCraftVolume so the discovery "craftable" list
        // and the real transaction agree.
        const outputFootprint = (type) => {
            const def = itemDefinitions[type] || {};
            const external =
                (def.form && typeof def.form.externalVolume === 'number')
                    ? def.form.externalVolume
                    : (typeof def.externalVolume === 'number'
                        ? def.externalVolume
                        : undefined);
            if (typeof external === 'number') {
                return external;
            }
            const full =
                (def.form && typeof def.form.volume === 'number')
                    ? def.form.volume
                    : (typeof def.volume === 'number'
                        ? def.volume
                        : undefined);
            return (typeof full === 'number') ? full : DEFAULT_ITEM_VOLUME;
        };

        // Per-recipe input multiset (a type named in two entries accumulates
        // — same convention as CraftingController.checkExactInputs).
        const needsOf = (recipe) => (recipe.inputs || []).reduce((map, input) => {
            if (!input || typeof input.type !== 'string'
                || !Number.isFinite(input.quantity) || input.quantity < 1) {
                return map;
            }
            map[input.type] = (map[input.type] || 0) + input.quantity;
            return map;
        }, {});

        const itemsByHost =
            (facade.getEntityItems?.(entityId) || {}) || {};

        // The pool a cross-component craft draws from: items hosted directly
        // on entity components (nested/unhosted excluded), in entity
        // component order.
        const topLevelItems = [];
        for (const component of entity.components || []) {
            for (const item of itemsByHost[component.id] || []) {
                if (item && typeof item.type === 'string') {
                    topLevelItems.push(item);
                }
            }
        }

        const craftable = [];
        const notCraftable = [];

        for (const recipe of recipes) {
            if (!recipe || typeof recipe.id !== 'string' || recipe.id.length === 0) {
                continue;
            }
            const needs = needsOf(recipe);
            if (Object.keys(needs).length === 0) {
                // No inputs at all (malformed data): no component can be
                // pointed at for the craft.
                notCraftable.push({
                    recipeId: recipe.id,
                    name: recipe.name || recipe.id,
                    reason: 'recipe has no inputs (malformed data)'
                });
                continue;
            }

            const neededVolume = (recipe.outputs || []).reduce((sum, output) => {
                if (!output || typeof output.type !== 'string') {
                    return sum;
                }
                const qty =
                    (typeof output.quantity === 'number' && output.quantity > 0)
                        ? output.quantity
                        : 1;
                return sum + outputFootprint(output.type) * qty;
            }, 0);

            // (a) Inputs held ACROSS the entity's components — one
            // component no longer has to hold everything.
            const held = {};
            for (const item of topLevelItems) {
                held[item.type] = (held[item.type] || 0) + 1;
            }
            const missing = [];
            for (const [type, qty] of Object.entries(needs)) {
                const have = held[type] || 0;
                if (have < qty) {
                    missing.push(`${type} x${qty - have}`);
                }
            }
            if (missing.length > 0) {
                notCraftable.push({
                    recipeId: recipe.id,
                    name: recipe.name || recipe.id,
                    reason: `missing ${missing.join(' ')}`
                });
                continue;
            }

            // (b) Volume: same inequality as the craft transaction itself
            // (free + freed >= needed). `freed` = host volume of the
            // instances that would be removed — the first `need[type]` of
            // each required type, entity-wide, exactly as the LLM dispatch
            // picks them (a player POST re-runs the pre-check with its own
            // ids). It is the space the craft frees regardless of which
            // component the outputs land on.
            const freed = Object.entries(needs).reduce((sum, entry) => {
                const [type, qty] = entry;
                let added = 0;
                for (const item of topLevelItems) {
                    if (item.type === type && added < qty) {
                        sum += (typeof item.hostVolume === 'number'
                            ? item.hostVolume
                            : (typeof item.volume === 'number'
                                ? item.volume
                                : 0));
                        added += 1;
                    }
                }
                return sum;
            }, 0);

            // The FIRST component in entity order whose free volume passes
            // (b) becomes the outputs' destination.
            let firstReason = null;
            let pushed = false;
            for (const component of entity.components || []) {
                const componentId = component.id;
                const vol =
                    (inventoryManager
                        && typeof inventoryManager.getComponentVolume === 'function')
                    ? (inventoryManager.getComponentVolume(entity, componentId) || {})
                    : { used: 0, max: 0 };
                const free = Math.max(
                    0,
                    (typeof vol.max === 'number' ? vol.max : 0)
                        - (typeof vol.used === 'number' ? vol.used : 0)
                );

                if (free + freed >= neededVolume) {
                    craftable.push({
                        recipeId: recipe.id,
                        name: recipe.name || recipe.id,
                        description:
                            (typeof recipe.description === 'string')
                                ? recipe.description
                                : '',
                        needs: Object.entries(needs).map(([type, quantity]) => ({
                            type,
                            quantity
                        })),
                        outputs: (recipe.outputs || [])
                            .filter((output) => output && typeof output.type === 'string')
                            .map((output) => ({
                                type: output.type,
                                quantity:
                                    (typeof output.quantity === 'number'
                                        && output.quantity > 0)
                                        ? output.quantity
                                        : 1
                            })),
                        componentId
                    });
                    pushed = true;
                    break;
                }
                if (!firstReason) {
                    firstReason = `no component has room for the outputs ` +
                        `(tried "${componentId}": free ${free}, gains ${freed}, needs ${neededVolume})`;
                }
            }

            if (!pushed) {
                notCraftable.push({
                    recipeId: recipe.id,
                    name: recipe.name || recipe.id,
                    reason: firstReason || 'unknown'
                });
            }
        }

        return { craftable, notCraftable };
    }

    /**
     * Public accessor for the craft data (craftable recipes + not-craftable
     * entries with reasons). Shared by the agent's get_crafts tool; no
     * perception side effects — safe to call on every tool round.
     * @param {string} entityId
     * @returns {{ craftable: Array, notCraftable: Array }}
     */
    getCraftData(entityId) {
        return this._buildCraftData(entityId);
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
     * World-failures section: the warn-level events of ONE round, rendered as
     * "[action] message". The whole round is scanned (not a recent tail) so up
     * to `limit` WARN events are found even when it wrote mostly info. Success
     * (info) events are intentionally excluded: their state consequences are
     * reported by the perception delta stream, which carries the better
     * information (with component attribution).
     *
     * Round-scoped — never a tail, never "new to this agent": a tail re-
     * delivers another round's failure and a cursor re-delivers a backlog of
     * them (wiki/decisions/round-scoped-context.md).
     *
     * No `[tick]` prefix: the section header already names the round these
     * events are being read as, and a tick stamp inside the block is a second,
     * contradicting provenance stamp for a number the agent has no concept of.
     * The tick survives in the data mirror and in `GET /world-events`.
     *
     * @param {number} limit
     * @param {number|null} round - the round the section is scoped to; null
     *   (nothing resolved yet, or no turn system) yields an empty section
     * @returns {string[]}
     * @private
     */
    _buildFailureData(limit, round) {
        const facade = this.worldStateController;
        if (!facade.getWorldEventsForRound) return [];
        if (!hasRound(round)) return [];
        try {
            const perMessageChars = LlmContextController.BUDGET.perMessageChars;
            const ring = facade.getWorldEventsForRound({ round, limit: WORLD_EVENTS_MAX_LIMIT }) || [];
            return ring
                .filter(ev => ev.round === round)
                .filter(ev => ev.level === 'warn')
                .slice(-limit)
                .map(ev => `[${ev.action}] ${(ev.message || '').slice(0, perMessageChars)}`);
        } catch {
            return [];
        }
    }

    /**
     * Perception delta section: the agent's own room, since the agent's
     * observation cursor. The read IS the observation —
     * PerceptionController.getRoomDeltasForAgent advances the cursor on this
     * call, so buildContext never re-reads (truncation slices in memory).
     * Each entry renders its prebuilt summary sentence (DeltaSummary: counts
     * + representative examples; the full rows live on the data mirror).
     * Baseline entries are never displayed: the "now in this room" state
     * block is the baseline, so a first observation renders state only.
     * Every entry is then filtered to ONE round (wiki/decisions/round-scoped-
     * context.md): a cursor window can straddle rounds, and an agent's turn
     * carries the round that resolved — no older change, and no planning-time
     * change from the round the agent is writing right now.
     * @param {Object} entity
     * @param {number} limit
     * @param {boolean} [observe=true] - WHOSE window this reads. true is the
     *   agent's brain (its room window, cursor advances). false is a reader that
     *   is not the brain (`GET /llm/context`): the ROOM's recent window,
     *   stateless, so watching an agent never eats its perception (the
     *   2026-11-02 incident). The round filter applies either way.
     * @param {number|null} [round=null] - the round the block is scoped to
     * @returns {Array<Object>} raw delta entries, oldest to newest
     * @private
     */
    _buildDeltasData(entity, limit, observe = true, round = null) {
        const facade = this.worldStateController;
        // The brain read is keyed by (entity, room); the room read takes the
        // room alone. .call(facade, …): these facade methods read `this`
        // internally — detaching them loses it (the 2026-10-21 Minako
        // chat-loss incident).
        const read = observe ? facade.getAgentRoomPerception : facade.getPerceptionDeltasForRoom;
        if (typeof read !== 'function') return [];
        try {
            const raw = (observe
                ? read.call(facade, entity.id, entity.location, { limit })
                : read.call(facade, entity.location, { limit })) || [];
            // Defense in depth: a baseline is the state block's job, never
            // the change window. The facade already filters baselines; this
            // guards the renderer against any other producer of the stream.
            // Then the round filter — an entry carries the round its window
            // covers, and only the section's round is shown.
            return raw.filter(d => d && d.kind !== 'baseline' && hasRound(round) && d.roundNumber === round);
        } catch {
            return [];
        }
    }

    /**
     * "HAPPENED TO YOU" section: the actions performed ON this agent since its
     * observation cursor.
     *
     * Generic by construction: it reads the performed-action rows the
     * PerceptionController built from the shared ActionAttributionStore (one
     * writer — the consequence dispatcher, every successful action, whatever
     * the action was), and keeps exactly the rows whose recorded target is this
     * entity. No action names, no per-action table, no special casing: a punch,
     * a cut, a grab, a machine's output and a future action nobody has written
     * yet all arrive through the same shape.
     *
     * Direction is the whole point of the section, so the row states it in
     * words ("<actor> used <action> on you") instead of leaving the reader to
     * infer it from a count. Rows this agent performed on ITSELF are excluded:
     * it did those, and "YOUR LAST ACTIONS & RESULTS" already says them with
     * their target — repeating them here would double every self-action and
     * blur the one distinction the section exists to make (someone else did
     * this TO me).
     *
     * Names are resolved HERE, against the live world (the same rule the "now
     * in this room" block follows — ids regenerate on respawn, so any older
     * copy of a name is stale, and the perception row's own `name` falls back
     * to the raw id, which is noise for a local model). An actor that is gone
     * by the time the context is composed is "Something": the action is still
     * true, only its author is not.
     *
     * @param {Object} entity - the observing agent (its id is the filter)
     * @param {Array<Object>} deltas - the SAME delta entries the "since you
     *   last looked" block renders (never re-read: the read is the observation)
     * @returns {Array<{actorId: string, actorName: string, action: string,
     *   hitComponentName: string|null, hitComponentSide: string|null,
     *   usedComponents: Array<{type: string|null, identifier: string|null}>,
     *   tick: number|null, round: number|null}>} oldest → newest, capped
     *   to the newest BUDGET.maxActionsOnYou
     * @private
     */
    _buildInboundActionsData(entity, deltas) {
        const rows = [];
        for (const entry of deltas ?? []) {
            for (const row of entry?.actions?.performed ?? []) {
                const targetId = row?.target?.id ?? null;
                if (targetId == null || targetId !== entity.id) continue;
                if (row.entity === entity.id) continue; // the agent's own action — other section
                rows.push({
                    actorId: row.entity,
                    actorName: this._entityDisplayName(row.entity),
                    action: String(row.action ?? 'unknown'),
                    hitComponentName: row?.target?.componentName ?? null,
                    hitComponentSide: this._hitComponentSide(row?.target, entity.id),
                    usedComponents: this._usedComponentsWithSides(row.entity, row?.used),
                    tick: row?.tick ?? null,
                    round: row?.round ?? null
                });
            }
        }
        return rows.slice(-LlmContextController.BUDGET.maxActionsOnYou);
    }

    /**
     * The components that powered one action, per use, each with the side label
     * that makes a repeated type unambiguous. Without it a punch from a humanoid
     * reads `2x maleArm` — true, and useless: which arm, and therefore whether
     * the other is free, is the information the victim actually has.
     *
     * The label is the component's blueprint `identifier` (the blueprint pairs
     * each instance with a position: `["maleArm", "left"]`, `["maleLeg",
     * "frontal_right"]`), resolved against the live world by the rule this whole
     * section already follows — names resolve where the context is composed,
     * never from a stored copy, because ids and bodies change between the blow
     * and the reading. Two cases carry no label, both honest rather than
     * invented: a root component whose blueprint label is `default` (m1Head,
     * minakoBody has no side), and a component the actor no longer has
     * (destroyed since) — which arm threw the punch is then unknown.
     *
     * @param {string} actorId - the entity that performed the action
     * @param {Array<{type?: string, id?: string}>} used - the perception row's
     *   used set (the attribution store's selected fulfillers)
     * @returns {Array<{type: string|null, identifier: string|null}>} in the
     *   order the row lists them (deterministic; the renderer groups by label)
     * @private
     */
    _usedComponentsWithSides(actorId, used) {
        const entries = Array.isArray(used) ? used : [];
        if (entries.length === 0) return [];
        const components = this.worldStateController?.getEntity?.(actorId)?.components ?? [];
        const byId = new Map(components.map((c) => [c.id, c]));
        return entries.map((u) => {
            const live = byId.get(u?.id);
            return {
                type: (typeof u?.type === 'string' && u.type !== '') ? u.type : (live?.type ?? null),
                identifier: LlmContextController._sideLabel(live?.identifier)
            };
        });
    }

    /**
     * The informative part of a component's blueprint `identifier`.
     *
     * Identifiers are composed from the parent's label and the instance's own
     * slot, so a hand hanging off the root body arrives as `default_left` and a
     * toe as `left_frontal_left`. `default` is the root's own label — it says
     * nothing about position, and in a rendered line it is pure noise (`1x
     * default_left droidHand` against `1x left droidHand`). Dropping the token
     * is a string rule on a label, not a claim about the body: a real position
     * (`frontal_left`, `top_hand`, `back_right`) is never touched, and neither
     * is a composite whose first segment carries meaning.
     *
     * @param {string|null|undefined} identifier - as the blueprint stamped it
     * @returns {string|null} the label to render, or null when there is none
     * @private
     */
    static _sideLabel(identifier) {
        if (typeof identifier !== 'string' || identifier === '') return null;
        if (identifier === 'default') return null;
        const stripped = identifier.replace(/^default_/, '');
        return stripped === '' ? null : stripped;
    }

    /**
     * The side of the component a blow landed on, resolved against the live
     * world exactly as `usedComponents` resolves the attacker's sides. This is
     * the "which leg" half of the same bug the side labels fix: `hit: maleLeg`
     * told the agent a leg was hit but not which one, and a side-free target
     * is worse than a count because a count at least admitted the ambiguity.
     * The target here is the reading agent itself (this section filters to the
     * rows aimed at it), so the component hangs off its own body list. The
     * label is honest in the same three ways: it never invents a side for a
     * root component (m1Head, minakobody, centralBall — no position, `default`
     * or no identifier, renders unchanged as `hit: Droid Head` / `hit:
     * minakobody`), it strips the meaningless `default_` token of a composed
     * label, and it is null when the recorded component no longer exists
     * (the blow is still true; the body it struck has already been rebuilt). The
     * rendered form is `hit: <name> (<side>)` — the same shape the body block
     * uses for a side label, so a local model already knows what `type
     * (label)` means from `YOUR BODY`.
     *
     * @param {Object|null} target - the row's resolved target ({ id, name,
     *   componentId, componentName })
     * @param {string} observerId - the reading agent; the target is always it
     *   (this section filters to its rows), used only to resolve the live body
     * @returns {string|null}
     * @private
     */
    _hitComponentSide(target, observerId) {
        const componentId =
            typeof target?.componentId === 'string' ? target.componentId : null;
        if (componentId == null) return null;
        const entity =
            (typeof target?.id === 'string'
                ? this.worldStateController?.getEntity?.(target.id)
                    ?? this.worldStateController?.getEntity?.(observerId)
                : this.worldStateController?.getEntity?.(observerId))
            ?? null;
        const comp = (entity?.components ?? []).find((c) => c.id === componentId) ?? null;
        return LlmContextController._sideLabel(comp?.identifier);
    }

    /**
     * The display name of one entity id, resolved against the live world.     * Follows the block the agent reads its neighbours from (`name || 'Droid'`),
     * so the same token names the same actor in both places. Null when the
     * entity is gone — callers pick the honest wording for that case.
     * @param {string} entityId
     * @returns {string|null}
     * @private
     */
    _entityDisplayName(entityId) {
        if (typeof entityId !== 'string' || entityId === '') return null;
        const record = this.worldStateController?.getEntity?.(entityId);
        if (!record) return null;
        return record.name || 'Droid';
    }

    /**
     * Renders one "HAPPENED TO YOU" row. `<actor> used "<action>" on you`, plus
     * the part it hit (with the side that tells which component it was) and the
     * components that powered it when they are known — the attribution the
     * perception row already carries, never a guess:
     * `(hit: minakoLeg (frontal_left), used: 1x left maleArm, 1x right maleArm)`
     * and the unchanged `(hit: Droid Head, used: 1x left droidHand, 1x right
     * droidHand)` when the hit component has no side. The target side uses the
     * same body-block shape `type (label)` (`_hitComponentSide`), so a local
     * model already knows what that syntax means from `YOUR BODY`.
     * `used:` is spelled out because the counts alone were not readable: a bare
     * `(2x droidHand)` left a local model to work out that the parenthetical
     * described the attacker's body and not the damage. The side label splits a
     * repeated type into the instances that actually acted (`_usedComponentsWithSides`),
     * and grouping is by the rendered label, so two components with no side
     * collapse back to `2x droidHand`. An unknown actor is "Something": the
     * action happened, only its author is no longer in the world. No row is
     * tagged with a round: the section header frames every line of this block as
     * this round's news (wiki/decisions/current-round-events.md), so a per-row
     * `[round N]` would restate the header or contradict it.
     * @param {Object} row - one row from `_buildInboundActionsData`
     * @returns {string}
     * @private
     */
    _inboundActionLine(row) {
        const actor = row.actorName || 'Something';
        // Insertion-ordered Map (never a sort of a locale-sensitive string): the
        // sides appear in the order the action used them, every time (DETERMINISM).
        const counts = new Map();
        for (const comp of row.usedComponents ?? []) {
            const label = comp?.type
                ? (comp.identifier ? `${comp.identifier} ${comp.type}` : comp.type)
                : null;
            if (!label) continue;
            counts.set(label, (counts.get(label) ?? 0) + 1);
        }
        const usedPhrase = [...counts].map(([label, count]) => `${count}x ${label}`).join(', ');
        const hit = row.hitComponentName
            ? `hit: ${row.hitComponentName}${row.hitComponentSide ? ` (${row.hitComponentSide})` : ''}`
            : null;
        const details = [
            hit,
            usedPhrase ? `used: ${usedPhrase}` : null
        ].filter(Boolean).join(', ');
        // No per-row round tag: the section header already frames every row as
        // this round's news (wiki/decisions/current-round-events.md), and the
        // execution round the store recorded stays on the row's DATA for the dev
        // inspector. The same number on every line of a single-round block is
        // attention the reader pays for nothing.
        return `- ${actor} used "${row.action}" on you${details ? ` (${details})` : ''}`;
    }

    /**
     * Chat section (Feature D's RoomChatController — optional at this step):
     * "Speaker: text" lines for the entity's current room.
     *
     * The brain's read is agent-relative and CONSUMING: a transcript tail hands
     * the agent the lines it answered last round, and it answers them again
     * (wiki/decisions/current-round-events.md). A non-observing reader keeps the
     * stateless room tail, so the dev panel still shows the whole conversation
     * without eating the agent's next lines.
     * @param {string} roomUid
     * @param {number} limit
     * @param {number|null} round - the round the section is scoped to: only
     *   lines said in that round are rendered, and a line with no round stamp is
     *   never handed to a model (wiki/decisions/round-scoped-context.md)
     * @returns {string[]}
     * @private
     */
    _buildChatData(roomUid, limit, round) {
        const facade = this.worldStateController;
        if (!facade.getRoomChatMessagesForRound) return [];
        if (!hasRound(round)) return [];
        try {
            const messages = (facade.getRoomChatMessagesForRound(roomUid, { round, limit }) || [])
                .filter((m) => m && m.round === round);
            const perMessageChars = LlmContextController.BUDGET.perMessageChars;
            return messages.map(m => `${m.speakerName || '???'}: ${(m.text || '').slice(0, perMessageChars)}`);
        } catch {
            return [];
        }
    }

    /**
     * Feedback data for "YOUR LAST ACTIONS & RESULTS": the agent's own action
     * outcomes FROM ONE ROUND (Feature E holds the ring). An outcome is stamped
     * with the round it was recorded in, which for a world action is the round
     * whose resolution ran it — so this is the result of what the agent did in
     * that round, delivered in the turn that follows it and never later
     * (wiki/decisions/round-scoped-context.md).
     * @param {string} entityId
     * @param {number|null} round - the round the section is scoped to; entries
     *   with no round stamp are never delivered
     * @returns {Array<{ round: number|null, actionName: string, targetEntityId: string|null, success: boolean, detail: string, instinct: string|null }>}
     * @private
     */
    _buildFeedbackData(entityId, round) {
        const facade = this.worldStateController;
        if (!facade.llmAgentFeedbackController?.getRecent) return [];
        if (!hasRound(round)) return [];
        try {
            const outcomes = facade.llmAgentFeedbackController.getRecent(entityId, AGENT_FEEDBACK_CAPACITY) || [];
            return outcomes.filter((o) => o && o.round === round);
        } catch {
            return [];
        }
    }

    // =========================================================================
    // RENDER
    // =========================================================================

    /**
     * Renders the sectioned narrative text from the already-built section data
     * (this method never reads the world: every section arrives as data, which
     * is what lets the budget cascade re-render after slicing a section in
     * memory — see `buildContext`).
     *
     * @param {Object} sections
     * @param {Object} sections.entity - the live entity record (position, location)
     * @param {string} roomName - the agent's room display name
     * @param {Object} sections.self - `_buildSelfData` output
     * @param {{ sameRoom: Array, otherRooms: Array }} sections.near - nearby entities
     * @param {Array<Object>} sections.deltas - the perception change window
     * @param {Array<Object>} sections.hintsData - HINTS section rows
     * @param {string[]} sections.failures - the warn-level world-event tail
     * @param {string[]} sections.chat - room chat lines
     * @param {Array<Object>} sections.feedback - this agent's action outcomes
     * @param {Array<Object>} sections.happenedToYou - actions targeting this
     *   agent since its observation cursor (`_buildInboundActionsData`)
     * @param {Array<Object>} sections.droppedItems - dropped items in the room
     * @param {Array<Object>} sections.placedMachines - machines placed in the room
     * @param {Object} sections.rooms - UID-keyed rooms map (from `getRooms()`),
     *   threaded in by buildContext so the room block is resolved from the same
     *   single clone.
     * @param {number|undefined} sections.roundNumber - the round the READER is
     *   in; the frame every event section is labelled with. Undefined when no
     *   turn system is wired — the label then carries no number.
     * @private
     */
    _render({ entity, roomName, self, near, deltas, hintsData: hints, failures, chat, feedback, happenedToYou, droppedItems, placedMachines, rooms, roundNumber }) {
        const roomData = this._buildRoomData(entity.location, rooms);
        const lines = [];

        // === YOUR STATE ===
        lines.push('=== YOUR STATE ===');
        lines.push(`Name: ${self.name}`);
        if (roomData) {
            lines.push(`You are in: ${roomData.name}`);
            const pos = (entity.spatial?.x != null && entity.spatial?.y != null)
                ? `Your position: (${Math.round(entity.spatial.x)}, ${Math.round(entity.spatial.y)})`
                : '';
            lines.push(`Room size: ${roomData.width} x ${roomData.height}${pos ? ` | ${pos}` : ''}`);
            const atmo = roomData.atmosphere;
            if (atmo) {
                const atmoParts = [];
                if (atmo.lightLevel != null) atmoParts.push(`light=${atmo.lightLevel}`);
                if (atmo.lightColor != null) atmoParts.push(`color=${atmo.lightColor}`);
                if (atmo.temperature != null) atmoParts.push(`temperature=${atmo.temperature}`);
                if (atmo.humidity != null) atmoParts.push(`humidity=${atmo.humidity}%`);
                if (atmo.airQuality != null) atmoParts.push(`air=${atmo.airQuality}`);
                if (atmo.fog != null) atmoParts.push(`fog=${atmo.fog}`);
                if (atmo.smell != null) atmoParts.push(`smell=${atmo.smell}`);
                if (atmo.ambientSound != null) atmoParts.push(`sound=${atmo.ambientSound}`);
                if (atmoParts.length > 0) lines.push(`Atmosphere: ${atmoParts.join(', ')}`);
            }
            const envParts = [];
            if (roomData.surface != null) envParts.push(`Surface: ${roomData.surface}`);
            if (roomData.acoustic != null) envParts.push(`Acoustic: ${roomData.acoustic}`);
            if (roomData.lightSource != null) envParts.push(`Light source: ${roomData.lightSource}`);
            if (roomData.ceiling != null) envParts.push(`Ceiling: ${roomData.ceiling}`);
            if (roomData.condition != null) envParts.push(`Condition: ${roomData.condition}`);
            if (roomData.power != null) envParts.push(`Power: ${roomData.power}`);
            if (envParts.length > 0) lines.push(envParts.join(' | '));
            lines.push(roomData.exits.length > 0
                ? `Exits: ${roomData.exits.map(ex => `${ex.door} → ${ex.targetRoomName}`).join(' | ')}`
                : 'Exits: (none)');
        } else {
            lines.push(`You are in: ${roomName || 'unknown'}`);
        }
        lines.push('Existence: ' + (self.existence.length > 0
            ? self.existence.map(d => {
                const label = d.identifier ? ` (${d.identifier})` : '';
                const type = `${d.component}${label}`;
                return (d.current != null && d.max != null)
                    ? `${type} ${d.current}/${d.max}`
                    : type;
            }).join(', ')
            : '(none)'));
        const statParts = [
            self.stats[flatKey(TRAIT_GROUPS.PHYSICAL, STAT_NAMES.STRENGTH)] !== null && `strength=${self.stats[flatKey(TRAIT_GROUPS.PHYSICAL, STAT_NAMES.STRENGTH)]}`,
            self.stats[flatKey(TRAIT_GROUPS.PHYSICAL, STAT_NAMES.SHARPNESS)] !== null && `sharpness=${self.stats[flatKey(TRAIT_GROUPS.PHYSICAL, STAT_NAMES.SHARPNESS)]}`,
            self.stats['Movement.move'] !== null && `move=${self.stats['Movement.move']}`,
            self.stats['Mind.think_level'] !== null && `think=${self.stats['Mind.think_level']}`
        ].filter(Boolean);
        lines.push(statParts.length > 0 ? `Key stats: ${statParts.join(' ')}` : 'Key stats: (none)');
        // Body attributes: whole-entity stats declared for the blueprint
        // (data/mods/core-entity-attributes/entityAttributes.json), rendered separately from the
        // component-derived key stats because they are owned by the entity,
        // not by components. One flat "Group.stat" key with current/max, plus
        // "(drain N/turn)" when the file declares a nonzero per-turn drain.
        const attrParts = Object.entries(self.entityAttributes || {})
            .map(([keyDecl, a]) => {
                // A malformed decl (max null, seam (a)) omits the "/max"
                // suffix instead of printing "/null".
                const maxPart = a.max == null ? '' : '/' + a.max;
                const parts = [`${keyDecl}=${a.current}${maxPart}`];
                if (a.drainPerTurn > 0) {
                    parts.push(`(drain ${a.drainPerTurn}/turn)`);
                }
                return parts.join(' ');
            });
        lines.push(attrParts.length > 0
            ? `Body attributes: ${attrParts.join(', ')}`
            : 'Body attributes: (none)');
        lines.push(self.equipped.length > 0
            ? `Equipped: ${self.equipped.map(eq => eq.type).join(', ')}`
            : 'Equipped: (none)');
        lines.push(self.inventory.length > 0
            ? `Inventory: ${self.inventory.map(i => `${i.type} x${i.count} (${i.hostComponent})`).join(', ')}`
            : 'Inventory: (none)');
        lines.push('');

        // === HINTS ===
        lines.push('=== HINTS ===');
        const hintLines = hints.slice(0, LLM_CONTEXT_MAX_HINTS).map(h => `- ${h.message || h}`);
        lines.push(hintLines.length > 0 ? hintLines.join('\n') : '(none)');
        lines.push('');

        // === WORLD FAILURES ===
        // The warn-level events new to THIS agent (failed actions +
        // round-level warnings). Success events are intentionally absent:
        // their state consequences ride the perception stream in the
        // "this round" block above.
        lines.push('=== WORLD FAILURES ===');
        lines.push(this._roundFrame('events of this round', roundNumber));
        lines.push(failures.length > 0 ? failures.join('\n') : '(none)');
        lines.push('');

        // === YOUR LAST ACTIONS & RESULTS ===
        lines.push('=== YOUR LAST ACTIONS & RESULTS ===');
        if (feedback.length === 0) {
            lines.push('(none — this is your first round or no actions recorded yet)');
        } else {
            for (const f of feedback) {
                const status = f.success ? '✓' : '✗';
                const instinctTag = f.instinct ? ` (instinct: ${f.instinct})` : '';
                // The outbound half of the direction: the ring carries the id of
                // whoever the action was aimed at, and naming it here is what
                // turns "cut: executed" into "cut on Tree: executed". Resolved
                // live like every other name in this context; a target that has
                // since left the world is named honestly, never as a bare UUID.
                const targetLabel = f.targetEntityId
                    ? (this._entityDisplayName(f.targetEntityId) ?? 'something that is no longer here')
                    : null;
                lines.push(`- ${status} ${f.actionName}${targetLabel ? ` on ${targetLabel}` : ''}: ${f.detail}${instinctTag}`);
            }
        }
        lines.push('');

        // === HAPPENED TO YOU ===
        // The actions performed ON this agent since its observation cursor, one
        // sentence each (built from the same perception read as the change block
        // below). Above "YOUR WORLD" on purpose: the agent reads what was done
        // to it before it reads the room it has to react in, and the budget
        // cascade sheds this block after the state block, never before it.
        lines.push('=== HAPPENED TO YOU ===');
        lines.push(this._roundFrame('events of this round', roundNumber));
        lines.push(happenedToYou.length > 0
            ? happenedToYou.map((r) => this._inboundActionLine(r)).join('\n')
            : '(none)');
        lines.push('');

        // === YOUR WORLD ({room}) ===
        // State first, then change: the "now in this room" block is the
        // agent's spatial anchor (it survives the budget cascade), the
        // "this round" block is the perception delta stream (shed
        // first under budget pressure — see buildContext).
        // Rendered at the end of the context, directly above ROOM CHAT
        // (operator directive, 2026-10-23): the agent's spatial anchor is the
        // last thing it reads before the social feed.
        lines.push(`=== YOUR WORLD (${roomName || 'unknown'}) ===`);
        lines.push('now in this room:');
        const nearby = [...near.sameRoom, ...near.otherRooms];
        if (nearby.length === 0) {
            lines.push('(none)');
        } else {
            nearby.forEach((e, i) => {
                const stats = Object.entries(e.stats)
                    .map(([k, v]) => `${k.split('.')[1]}=${v}`)
                    .slice(0, LLM_CONTEXT_MAX_NEARBY_STATS)
                    .join(', ');
                const dur = e.existence ? ` - existence ${e.existence.current}/${e.existence.max}` : '';
                const where = e.roomName ? ` (in ${e.roomName})` : ` (${e.distance} away)`;
                // Same-room entities carry their room-relative position so the
                // LLM can gauge where each one stands; other-room entries do not.
                const at = (e.x != null && e.y != null) ? ` at (${Math.round(e.x)}, ${Math.round(e.y)})` : '';
                // LIVE targeting ids: the entity id (targetEntityId actions
                // like shootT1 / hand shotgun) and its first existence-bearing
                // component id (targetingType "component" actions like cut).
                // Rebuilt from the world every round — ids regenerate on
                // respawn, so the model must target from this line, never from
                // a stale transcript copy (the Minako/tree incident).
                const targetIds = e.id
                    ? ` [ent: ${e.id}${e.existence?.id ? ` | target comp: ${e.existence.id}` : ''}]`
                    : '';
                lines.push(`${i + 1}. ${e.name}${where}${at}${dur}${stats ? `, ${stats}` : ''}${targetIds}`);
            });
        }
        if (Array.isArray(droppedItems) && droppedItems.length > 0) {
            lines.push(`Dropped items: ${droppedItems.map(it => `${it.name} at (${Math.round(it.x)}, ${Math.round(it.y)})`).join(', ')}`);
        }
        if (Array.isArray(placedMachines) && placedMachines.length > 0) {
            // Placed machines are static world objects the agent itself may have
            // set down: the agent can see them (name, type, position, ent-… id) so
            // it can retrieveMachine { machineType } / { targetEntityId } without
            // guessing which machine it placed. Capped at BUDGET.maxPlacedMachines.
            lines.push(`Placed machines: ${placedMachines.map(m => `${m.name} [type:${m.machineType}] at (${Math.round(m.x)}, ${Math.round(m.y)}), ent:${m.id}`).join(', ')}`);
        }
        // The perception delta stream: one summary line per room delta since
        // the agent's observation cursor (baselines never appear here — the
        // state block above is the baseline, so a first observation prints
        // "(none)").
        lines.push(this._roundFrame('this round', roundNumber));
        lines.push(deltas.length > 0
            ? deltas.map(d => `- ${d.summary || '(change)'}`).join('\n')
            : '(none)');
        lines.push('');

        // === ROOM CHAT ===
        // The lines new to this agent since it last read this room — not the
        // room's whole transcript tail (see `_buildChatData`).
        lines.push('=== ROOM CHAT ===');
        lines.push(this._roundFrame('said in this room this round', roundNumber));
        lines.push(chat.length > 0 ? chat.join('\n') : '(none)');
        lines.push('');

        // === RECENT TOOLS ===
        // The newest outcomes of the outcome-producing tools the agent invoked
        // (execute_action, toApproach, use_instinct, speak_in_room), success
        // and failure, named the way it called each tool (registry action name
        // for execute_action, the tool name for the others). Recorded at
        // dispatch time in the round runner via _recordImmediateOutcome.
        // Placed after the room chat so the agent reads it last — the most
        // recent local signal is the last thing it sees. Shares the feedback
        // priority tier with "YOUR LAST ACTIONS & RESULTS" (both render from
        // the same feedback ring; the budget cascade drops it together when
        // over budget).
        lines.push('=== RECENT TOOLS ===');
        if (feedback.length === 0) {
            lines.push('(none)');
        } else {
            feedback.forEach((f) => {
                const status = f.success ? '✓' : '✗';
                const name = (f.actionName || 'tool').replace(/\n/g, ' ').trim();
                const detail = String(f.detail || '').replace(/\n/g, ' ').trim();
                lines.push(`- ${status} ${name}${detail ? `: ${detail}` : ''}`);
            });
        }

        return lines.join('\n');
    }

    // =========================================================================
    // HELPERS
    // =========================================================================

    /**
     * The frame line printed under an event-section header: the label, plus the
     * round the reader is in when there is one. One definition so the four event
     * sections agree on how they name the round — and on what they do when no
     * turn system is wired: the label stays, the number does not, because a
     * round is never invented.
     * @param {string} label - section lead-in, e.g. 'this round'
     * @param {number|undefined} roundNumber - the reader's round
     * @returns {string}
     * @private
     */
    _roundFrame(label, roundNumber) {
        return Number.isInteger(roundNumber)
            ? `${label} (round ${roundNumber}):`
            : `${label}:`;
    }



    /**
     * The round every event section is scoped to: the one that RESOLVED, not the
     * one that is open. An agent's turn fires while a round is open, and the
     * events that exist for it are the previous round's — so "this round", in
     * the mouth of the context, is the round that just resolved and whose events
     * this context carries (wiki/decisions/round-scoped-context.md).
     *
     * Sources, in order: `turns.getStatus().resolvedRound` (the bookkeeping the
     * turn system keeps — `-1` means nothing has resolved, and null is the
     * honest answer, not round 0); then `getRoundState().roundNumber` for a
     * partial seam that answers only that.
     *
     * The composition root publishes the turn system at
     * `facade.subControllers.turns`; `turnSystemController` is the property the
     * facade class itself holds, so both paths are read.
     * @param {Object} facade - the world state facade
     * @returns {number|null} the round of record, or null when there is none
     * @private
     */
    _referenceRound(facade) {
        try {
            const turns = facade?.subControllers?.turns ?? facade?.turnSystemController;
            if (!turns) return null;
            // The RESOLVED round, when there is one. An agent plans in the round
            // after the one that produced its news: the events, the line spoken
            // and the outcome of its own action all carry the number of the round
            // that resolved, while the round now open is the one it is deciding
            // about. Naming the open round would deliver nothing at all.
            const resolved = typeof turns.getResolvedRound === 'function'
                ? turns.getResolvedRound()
                : undefined;
            if (Number.isInteger(resolved) && resolved >= 0) return resolved;
            // Nothing has resolved yet (-1), or a seam that cannot say: the world
            // is in its first round, and that is the only round there is to read.
            const open = typeof turns.getRoundState === 'function'
                ? turns.getRoundState()?.roundNumber
                : undefined;
            return Number.isInteger(open) && open >= 0 ? open : null;
        } catch {
            // why: a turn system that throws is a broken seam, not a fact about
            // the world — the event sections render empty rather than naming a
            // round nobody resolved.
            return null;
        }
    }

    /**
     * Component type definition from data/mods/core-components/components.json (via the registry
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
     * First existence-bearing component of an entity (current/max).
     * Also returns the component's id (`id`): the target id for
     * targetingType "component" actions (e.g. cut) — the context's
     * "now in this room" lines render it so the LLM can target the live
     * component, not a stale transcript copy.
     * @param {Object} entity
     * @returns {{component: string, id: string, current: number, max: number}|null}
     * @private
     */
    _firstExistence(entity) {
        const facade = this.worldStateController;
        for (const comp of entity.components || []) {
            const stats = facade.getComponentStats(comp.id);
            const cur = stats?.[TRAIT_GROUPS.PHYSICAL]?.[STAT_NAMES.EXISTENCE];
            const max = this._componentDef(comp.type)?.traits?.[TRAIT_GROUPS.PHYSICAL]?.[STAT_NAMES.EXISTENCE] ?? cur;
            if (typeof cur === 'number' && typeof max === 'number' && max > 0) {
                return { component: comp.type, id: comp.id, current: cur, max };
            }
        }
        return null;
    }

    /**
     * Viability predicate for the YOUR WORLD section's entity list
     * (defense-in-depth).
     *
     * WHY: a mid-cascade or not-yet-despawned entity can briefly linger in the
     * world state with no components (a "ghost"). Rendering it would hand the
     * LLM a phantom target — a goal-bearing drone re-targets the corpse every
     * round and its punch fails at component resolution, so the loop never
     * converges. An eliminated entity must be invisible to the LLM ("really
     * deleted"), so such entities are excluded from the section rather than
     * marked as dead. The root fix (WorldStateController despawns
     * fully-eliminated entities) makes this rare; the exclusion is the
     * backstop for the window where a ghost is still visible.
     *
     * Mirrors the deterministic brain's targetability notion
     * (NpcAIController._isViableTarget): both delegate to the SAME shared core
     * predicate (npcAiUtils.hasUsableComponent), so the brain and the LLM
     * context can never disagree about what is viable — a component is usable
     * iff its existence is unknown or > EXISTENCE_GONE_AT. The only consumer-
     * local difference is the data-source adapter: this reader reads the
     * authoritative nested store via the facade's public getComponentStats()
     * (no flat-key fallback — the LLM context only ever reads the live store),
     * whereas the brain's reader adds a flat-key fallback for test fixtures.
     *
     * @param {Object} entity — entity from getAll().entities
     * @returns {boolean} true when the entity is still a viable target
     * @private
     */
    _isViableTarget(entity) {
        const allComponents = Array.isArray(entity.components) ? entity.components : [];
        // Malformed components (no id) cannot be damaged — skip them exactly as
        // the prior inline loop did, so an all-malformed entity is not viable.
        const components = allComponents.filter(comp => comp && comp.id);
        if (components.length === 0) return false;
        const facade = this.worldStateController;
        // Core targetability (single source of truth — npcAiUtils): ≥ 1 usable
        // component. The reader is this consumer's inline getComponentStats()
        // read of the authoritative nested store.
        return hasUsableComponent(components, (comp) => {
            const stats = facade.getComponentStats ? facade.getComponentStats(comp.id) : null;
            const existence = stats?.[TRAIT_GROUPS.PHYSICAL]?.[STAT_NAMES.EXISTENCE];
            return (typeof existence === 'number' && Number.isFinite(existence)) ? existence : undefined;
        });
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
                    if (stat === STAT_NAMES.EXISTENCE) continue;
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

/**
 * Renders the action list in the classic format: one line per executable
 * action, plus a summary line for not-executable names. Shared by the
 * get_actions tool and any future renderer.
 *
 * @param {Array<Object>} entries - Executable entries from getActionData
 *   ({ name, description, range, requirement, canExecute }).
 * @param {string[]} notExecutable - Names currently not executable.
 * @param {string} [filter] - Case-insensitive substring matched against the
 *   executable action lines only. Omitted/empty returns the full list (plus
 *   the not-executable summary). No match returns "(no match: '...')".
 * @returns {string}
 */
export function formatActionList(entries, notExecutable, filter) {
    const needle = (filter && typeof filter === 'string') ? filter.trim().toLowerCase() : null;
    const execLines = (entries || []).map(
        (a) =>
            `- ${a.name}: ${a.description} | range ${a.range} | needs ${a.requirement || 'nothing'} | use ${a.canExecute[0]}`);
    if (!needle) {
        const lines = [...execLines];
        if (notExecutable && notExecutable.length > 0) {
            lines.push(`${notExecutable.length} action${notExecutable.length > 1 ? 's' : ''} not executable right now: ${notExecutable.join(', ')}`);
        }
        return lines.join('\n');
    }
    const hit = execLines.filter(line => line.toLowerCase().includes(needle));
    return hit.length > 0 ? hit.join('\n') : `(no match: "${filter}")`;
}

/**
 * Renders instinct lines as "- name: description". The instincts section of
 * the context text was removed (instincts are now discovered via the
 * get_instincts tool); this keeps the line format consistent for the tool.
 * @param {Array<Object>} instincts - ({ name, description }) objects.
 * @param {string} [filter] - Case-insensitive substring matched against the
 *   instinct lines only. No match returns "(no match: '...')".
 * @returns {string}
 */
export function formatInstinctList(instincts, filter) {
    const needle = (filter && typeof filter === 'string') ? filter.trim().toLowerCase() : null;
    const lines = (instincts || [])
        .map((i) => `- ${i.name}: ${i.description}`);
    if (!needle) {
        return lines.length > 0 ? lines.join('\n') : '(none)';
    }
    const hit = lines.filter(line => line.toLowerCase().includes(needle));
    return hit.length > 0 ? hit.join('\n') : `(no match: "${filter}")`;
}

/**
 * Renders the craft list for the get_crafts tool. One line per craftable
 * recipe — `name (recipeId): description | need <type xqty, ...> | gets
 * <type xqty, ...> | on <componentId>` (the `on <comp>` component is the
 * outputs' destination; the ingredients may be pooled on any of the entity's
 * components) — plus one summary line listing the
 * recipes that are not craftable right now with the reason (missing
 * ingredients or no component with room for the outputs). An optional case-insensitive substring
 * filter narrows the craftable lines (matches name / recipeId / description /
 * component); no match → "(no match: '...')". Mirrors formatActionList:
 * with a filter the not-craftable summary line is dropped, with no filter
 * it is appended.
 * @param {Array<{ recipeId: string, name: string, description?: string,
 *   needs?: Array<{ type: string, quantity: number }>,
 *   outputs?: Array<{ type: string, quantity: number }>,
 *   componentId: string }>} craftable - Craftable recipes (getCraftData().craftable).
 * @param {Array<{ recipeId: string, name: string, reason: string }>} notCraftable - Not craftable right now (getCraftData().notCraftable).
 * @param {string} [filter] - Optional text filter to narrow the craftable lines.
 * @returns {string}
 */
export function formatCraftList(craftable, notCraftable, filter) {
    const lines = (craftable || []).map((r) =>
        `- ${r.name} (${r.recipeId}): ${(typeof r.description === 'string' ? r.description : '')}` +
        ` | need ${(r.needs || []).map((i) => `${i.type} x${i.quantity}`).join(', ')}` +
        ` | gets ${(r.outputs || []).map((o) => `${o.type} x${o.quantity}`).join(', ')}` +
        ` | on ${r.componentId}`
    );
    const needle = (filter && typeof filter === 'string') ? filter.trim().toLowerCase() : null;

    if (!needle) {
        const out = [...lines];
        if (notCraftable && notCraftable.length > 0) {
            out.push(
                `${notCraftable.length} recipe${notCraftable.length > 1 ? 's' : ''} not craftable right now: ` +
                notCraftable.map((r) => `${r.recipeId} (${r.reason})`).join(', ')
            );
        }
        return out.join('\n');
    }

    const hit = lines.filter(line => line.toLowerCase().includes(needle));
    return hit.length > 0 ? hit.join('\n') : `(no match: "${filter}")`;
}

export default LlmContextController;
