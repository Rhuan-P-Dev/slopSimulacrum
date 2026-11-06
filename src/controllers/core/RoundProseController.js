/**
 * RoundProseController — the "give me round N, give me prose" reader.
 *
 * Why it exists: perception keeps a per-room ring of delta entries, each
 * stamped with its own tick and carrying a one-line human summary
 * (buildDeltaSummary); the turn system keeps, per round, the tick window in
 * which the round ran (startTick..endTick, endTick null while the round is
 * live). This controller crosses those two reader sources: round prose = the
 * room deltas whose tick falls in the round's window, assembled into one
 * flowing paragraph per room, plus a one-line round summary (buildRoundProse).
 * The same reader serves an inclusive range of rounds
 * (`getRoundRangeProse`, exposed by the `/perception/rounds/:from/:to` route):
 * one row per requested round, `observed: false` where the in-memory horizon
 * no longer holds it, so a range spanning an evicted gap still returns every
 * round the caller asked for. And one ENTITY (`getEntityProse`, exposed by
 * `/perception/round/:roundNumber/byEntity/:entityId`): the same window, but the
 * rows that name one entity — see `selectEntityRows` / `buildEntityProse`.
 * Because the rings are per room and an entity can cross a room mid-round, the
 * entity read walks every room's entries rather than one room's.
 *
 * Contract (same family as PerceptionController / RoomChatController):
 *   - pure reader: never mutates world state, never owns a tick (the tick
 *     clock is the turn system's; the reader only queries it);
 *   - reads through the facade's public read wrappers only (`getRooms`,
 *     `getPerceptionDeltasForRoom`, `getEntity`, `getActionRegistry`) plus the
 *     facade's direct `turnSystemController` property (`getRoundWindow`);
 *   - the actor's body it narrates is never read from the world: it is the
 *     `body` recorded on the action row at the round's flush, so a closed round
 *     re-rendered tomorrow says what it said today.
 *   - no `getAll()` — this is a reader's derived view, not world state, so it
 *     must never appear in the full-state broadcast aggregate (see the comments
 *     on perceptionController / roomChatController in WorldComposition.js);
 *   - null-tolerant: an unwired facade or unwired turn system yields `null`
 *     (routes respond 503 / 404, never 500).
 *
 * History is recent-only, by design: a round is reconstructable only while its
 * entries still live in the per-room perception rings (PERCEPTION_MAX_LIMIT per
 * room, oldest evicted first) AND the turn system still holds the round
 * window (ROUND_PROSE_HISTORY_LIMIT, in memory, cleared on reset/restore).
 * Beyond both horizons the reader returns `null` — "out of recent history", not
 * an error.
 *
 * Three resolvers are handed to the builder per read, each built once per request
 * and each a lookup over data the reader already has: the material owner says how
 * a part looks (`_lookResolver`), the item registry says how a garment looks
 * (`_garmentLookResolver` — an item's own `visual` block, which is not the look of
 * the matter its recipe is built from), and the action registry says what an act is
 * called (`_verbResolver` — prose owns no verbs at all). What an actor is built of
 * needs no resolver here: the perception flush records it on the action row
 * itself (`PerceptionController._actorBody`), so the dossier clause is a field of
 * the row, true in the tenth re-reading as in the first. Without the resolvers
 * the prose is the paragraph this server wrote before they existed.
 *
 * @module RoundProseController
 */

import { PERCEPTION_MAX_LIMIT } from '../../utils/Constants.js';
import { buildRoomProse, buildRoundProse, buildEntityProse, selectEntityRows } from '../../utils/RoundProseBuilder.js';
import { describeVisual } from '../../utils/materialLook.js';

/**
 * Inclusive [startTick, endTick] filter over a room's perception entries
 * (oldest → newest, already in prose order).
 * @param {Array|null} entries
 * @param {{ startTick: number, endTick: number }} window
 * @returns {Array}
 */
function entriesInRange(entries, window) {
    if (!Array.isArray(entries) || !window) {
        return [];
    }
    if (!Number.isFinite(window.startTick) || !Number.isFinite(window.endTick)) {
        return [];
    }
    return entries.filter(
        (entry) =>
            entry &&
            Number.isFinite(entry.tick) &&
            entry.tick >= window.startTick &&
            entry.tick <= window.endTick
    );
}

class RoundProseController {
    constructor() {
        /** @private {import('../../controllers/WorldStateController.js')|null} Root facade, injected post-construction. */
        this._worldStateController = null;
    }

    /**
     * Post-construction DI (same convention as PerceptionController /
     * RoomChatController).
     * @param {import('../../controllers/WorldStateController.js')|null} facade
     */
    setWorldStateController(facade) {
        if (facade && typeof facade === 'object') {
            this._worldStateController = facade;
        }
    }

    /**
     * One round, as prose, across all rooms.
     * @param {number} round - non-negative round number
     * @returns {null|{ round: number, live: boolean, startTick: number, endTick: number, summary: string, entryCount: number, rooms: {[roomId]: {name: string, text: string, entryCount: number}} }}
     *         `null` when the reader is unwired or the round is unknown / out
     *         of the recent-history window. A live round is returned (live:
     *         true, endTick = current tick at read time).
     */
    getRoundProse(round) {
        const facade = this._worldStateController;
        const turns = facade ? facade.turnSystemController : null;
        const window = turns ? turns.getRoundWindow(round) : null;
        if (!window) {
            return null;
        }
        const rooms = this._collectRoundRooms(facade, window);
        return {
            round: window.round,
            live: window.live,
            startTick: window.startTick,
            endTick: window.endTick,
            ...buildRoundProse({
                round: window.round,
                live: window.live,
                startTick: window.startTick,
                endTick: window.endTick,
                rooms
            })
        };
    }

    /**
     * All requested rounds in [from, to] (inclusive), ascending, one row per
     * integer in the range. `from`/`to` are non-negative integers with `from
     * <= to <= current round`, validated at the route (the edge) and trusted
     * here; the iteration is bounded by that range. Each observed round returns
     * the exact `getRoundProse` shape plus `observed: true` (a live round is
     * `live: true`, endTick = current tick as of the read); each round not in
     * the in-memory horizon returns `{ round, observed: false }` (partial
     * result, never a `null` round — the caller sees which part of the range
     * is recoverable). `null` when the reader is unwired (same contract as
     * `getRoundProse`), so a nulling facade can not silently answer a range
     * as an empty range.
     * @param {number} from - lower bound of the range (route-validated, >= 0)
     * @param {number} to - upper bound of the range (route-validated, <= current round)
     * @returns {null | { from: number, to: number, rounds: Array<{ round: number,
     *   observed: boolean, live?: boolean, startTick?: number, endTick?: number,
     *   summary?: string, entryCount?: number,
     *   rooms?: { [roomId: string]: { name: string, text: string, entryCount: number } } }> }}
     */
    getRoundRangeProse(from, to) {
        const facade = this._worldStateController;
        const turns = facade ? facade.turnSystemController : null;
        if (!facade || !turns) {
            return null;
        }
        const observed = new Set(turns.getRoundWindowNumbers());
        const rows = [];
        for (let round = from; round <= to; round += 1) {
            if (!observed.has(round)) {
                rows.push({ round, observed: false });
                continue;
            }
            const entry = this.getRoundProse(round);
            rows.push(entry
                ? { observed: true, ...entry }
                : { round, observed: false });
        }
        return { from, to, rounds: rows };
    }

    /**
     * One entity's round, as prose: the rows of the round window that NAME it
     * (what it did, what was done to it, its stat / component shifts, what it
     * picked up, dropped, equipped or wore, its arrival and departure, and what
     * it said). The entity counterpart of `getRoomProse`.
     *
     * The rings are per room, so this read walks EVERY room's entries in the
     * window — an entity that crossed a door mid-round has its past in two
     * rooms' rings, and a single-room read would silently drop half of it.
     * Ordering is deterministic; see `_collectEntityEntries` for the rule (and
     * for why room ids cannot take part in it).
     *
     * The name is read from the world while the entity exists and from the rows
     * that name it otherwise: an entity that despawned during the round still
     * has a past to report, so prose is not gated on it still being here. An
     * entity with no row in the window is a real answer, not a failure —
     * `entryCount: 0` with empty text (the same shape as a room that had
     * nothing to say). `null` only when the reader is unwired or the round is
     * not in the recent-history window (route: 503 / 404).
     *
     * @param {string} entityId - the entity's typed id (route-validated `ent-…`)
     * @param {number} round
     * @returns {null|{ round: number, live: boolean, startTick: number, endTick: number,
     *   entityId: string, entity: string, room: string|null, entryCount: number, text: string }}
     */
    getEntityProse(entityId, round) {
        const facade = this._worldStateController;
        const turns = facade ? facade.turnSystemController : null;
        const window = turns ? turns.getRoundWindow(round) : null;
        if (!window) {
            return null;
        }
        const rooms = facade.getRooms?.() ?? {};
        const collected = this._collectEntityEntries(facade, window, entityId, rooms);
        const entity = facade.getEntity?.(entityId) ?? null;
        const name = (entity && entity.name) || collected.name || entityId;
        const { text, entryCount } = buildEntityProse({
            entries: collected.entries,
            entityId,
            entityName: name,
            lookOf: this._lookResolver(),
            garmentLookOf: this._garmentLookResolver(),
            verbOf: this._verbResolver()
        });
        return {
            round: window.round,
            live: window.live,
            startTick: window.startTick,
            endTick: window.endTick,
            entityId,
            entity: name,
            room: entity ? (rooms[entity.location]?.name ?? entity.location ?? null) : null,
            entryCount,
            text
        };
    }

    /**
     * One room, as prose, for one round. Logical room name or uid accepted;
     * resolution mirrors the WSC read wrapper so a route-level 404 matches
     * what the read path would resolve.
     * @param {string} roomId
     * @param {number} round
     * @returns {null|{ round: number, live: boolean, startTick: number, endTick: number, roomId: string, room: string, entryCount: number, text: string }}
     */
    getRoomProse(roomId, round) {
        const facade = this._worldStateController;
        const turns = facade ? facade.turnSystemController : null;
        const window = turns ? turns.getRoundWindow(round) : null;
        if (!window) {
            return null;
        }
        const rooms = facade.getRooms?.() ?? {};
        const resolved = this._resolveRoom(rooms, facade, roomId);
        if (!resolved) {
            return null;
        }
        const entries = entriesInRange(
            facade.getPerceptionDeltasForRoom(resolved.uid, { limit: PERCEPTION_MAX_LIMIT }),
            window
        );
        return {
            round: window.round,
            live: window.live,
            startTick: window.startTick,
            endTick: window.endTick,
            roomId,
            room: resolved.name,
            entryCount: entries.length,
            text: buildRoomProse({
                entries,
                roomName: resolved.name,
                room: rooms[resolved.uid] ?? null,
                lookOf: this._lookResolver(),
                garmentLookOf: this._garmentLookResolver(),
                verbOf: this._verbResolver()
            })
        };
    }

    /** { uid, name } or null; same resolution the WSC read wrapper performs. */
    _resolveRoom(rooms, facade, roomId) {
        if (!rooms || typeof roomId !== 'string' || roomId === '') {
            return null;
        }
        if (Object.prototype.hasOwnProperty.call(rooms, roomId)) {
            return { uid: roomId, name: rooms[roomId].name ?? roomId };
        }
        const uid =
            facade && typeof facade.getRoomUidByLogicalId === 'function'
                ? facade.getRoomUidByLogicalId(roomId)
                : null;
        if (uid && Object.prototype.hasOwnProperty.call(rooms, uid)) {
            return { uid, name: rooms[uid].name ?? uid };
        }
        return null;
    }

    /**
     * The round's entries that name one entity, across every room, in a
     * deterministic order — plus the display name those rows report, so a gone
     * entity is still namable.
     *
     * The order is: tick, then the world's own room order, then each ring's own
     * oldest-to-newest order. Only the tick is compared; `Array.sort` is stable,
     * so equal ticks keep the order the rooms were walked in. Room ids must NOT
     * be a tiebreaker — they are generated per world build, so sorting by them
     * would reorder the same events differently on every boot (two rooms' rows
     * for one round always carry the same tick: the flush that closed it).
     * @param {Object} rooms - the caller's room map (read once per request, so a
     *   large world is cloned once, not twice)
     * @returns {{ entries: Array, name: string }}
     */
    _collectEntityEntries(facade, window, entityId, rooms) {
        const found = [];
        let name = '';
        for (const roomId of Object.keys(rooms)) {
            const entries = entriesInRange(
                facade.getPerceptionDeltasForRoom(roomId, { limit: PERCEPTION_MAX_LIMIT }),
                window
            );
            for (const entry of entries) {
                const selected = selectEntityRows(entry, entityId);
                if (!selected.rowCount) continue;
                if (!name && selected.name) name = selected.name;
                found.push({ tick: entry.tick, entry });
            }
        }
        // Tick only — see the note above: room ids are per-build, so they cannot
        // order ties. `sort` is stable, so the room-walk order survives.
        found.sort((a, b) => a.tick - b.tick);
        return { entries: found.map((row) => row.entry), name };
    }

    /**
     * The material-look resolver for prose: component type -> look words ("tan,
     * satin"), or null when there is nothing to resolve with.
     *
     * Built ONCE per request: `getComponentMaterialsByType()` rebuilds and clones
     * the whole composition map, so the paragraph gets a plain lookup per part and
     * never a re-scan (`PERF-4`). Null-tolerant like every other prose input — an
     * unwired material owner answers with no look clause at all, which is the
     * paragraph this server produced before appearance existed.
     *
     * @returns {((componentType: string) => string|null)|null}
     * @private
     */
    _lookResolver() {
        const facade = this._worldStateController;
        const materialController = facade?.materialController;
        if (!materialController || typeof materialController.describeCompositionLook !== 'function') return null;
        const byType = facade.componentController?.getComponentMaterialsByType?.() ?? null;
        if (!byType) return null;
        return (componentType) => materialController.describeCompositionLook(byType[componentType]);
    }

    /**
     * The garment-look resolver for prose: item type -> look words ("red, rough"),
     * read from the `visual` block an item recipe declares for itself.
     *
     * A garment needs its own appearance because the matter it is modelled from has
     * another: the shipped t-shirt is `wood` ("brown, rough, grained"), and the shirt
     * is red. The numbers are narrowed at the edge (`WorldComposition` boot pass,
     * `CompositionClassifier` quarantine) and named by the same law a material's are
     * — `describeVisual` is the only place a number becomes a word, so prose never
     * becomes a second claim about the same appearance (`DOC-1`).
     *
     * Built ONCE per request over the already-loaded item registry (`PERF-4`), and
     * null-tolerant like every prose input: with no registry wired, a covered part
     * still hides its own look (the row says the part is clothed) and the garment is
     * named without a look clause — the prose invents nothing.
     *
     * @returns {((itemType: string) => string|null)|null}
     * @private
     */
    _garmentLookResolver() {
        const registry = this._worldStateController?.getItemRegistry?.() ?? null;
        if (!registry || typeof registry !== 'object') return null;
        return (itemType) => describeVisual(registry[itemType]?.visual)?.phrase ?? null;
    }

    /**
     * The action-wording resolver for prose: action name -> that action's `prose`
     * block in the action registry (data/mods/core-actions/actions.json).
     *
     * The prose has no verbs of its own (`wiki/decisions/action-prose.md`): the
     * registry is the only source, so a shipped action needs no code to be
     * narrated. The registry's `description` is NOT used here — it is written for
     * the actor ("Advance your droid … using your rolling wheels") and belongs to
     * the actor's own available-actions list.
     *
     * Built ONCE per request (a plain lookup over the registry, `PERF-4`), and
     * null-tolerant like every prose input: with no registry wired, an action
     * clause falls back to "did <action>" — the act happened, its wording is
     * simply not available to this reader.
     * @returns {((action: string) => Object|null)|null}
     * @private
     */
    _verbResolver() {
        const registry = this._worldStateController?.getActionRegistry?.() ?? null;
        if (!registry || typeof registry !== 'object') return null;
        return (action) => {
            const prose = registry[action]?.prose;
            return prose && typeof prose === 'object' ? prose : null;
        };
    }

    /** All rooms of the world with at least one entry in the round window. */
    _collectRoundRooms(facade, window) {
        const rooms = facade.getRooms?.() ?? {};
        const lookOf = this._lookResolver();
        const garmentLookOf = this._garmentLookResolver();
        const verbOf = this._verbResolver();
        const out = {};
        for (const [roomId, room] of Object.entries(rooms)) {
            const name = room.name ?? roomId;
            const entries = entriesInRange(
                facade.getPerceptionDeltasForRoom(roomId, { limit: PERCEPTION_MAX_LIMIT }),
                window
            );
            if (entries.length === 0) {
                continue;
            }
            out[roomId] = {
                name,
                text: buildRoomProse({ entries, roomName: name, room, lookOf, garmentLookOf, verbOf }),
                entryCount: entries.length
            };
        }
        return out;
    }
}

export default RoundProseController;
