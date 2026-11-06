/**
 * PerceptionController — the "perception" engine: observers can look at the
 * world and ask "what changed since I last looked?" for any room (or, from
 * an agent's point of view, for the whole world).
 *
 * **Why this controller exists (wiki-first — wiki/subMDs/systems/perception_system.md):**
 * before this change, the LLM agent and the UI could only re-read the *current*
 * state of a room (worldStateController.getEntities / entityItems ...). Nobody
 * could ask "what's *new*?" — the event log records *intentions* (action
 * results), not the resulting *state*; and re-reading a full snapshot is (a)
 * the agent's whole context (already present as YOUR STATE/NEARBY) and (b)
 * exactly what the UI was supposed to get a diff of. This controller adds the
 * missing seam: it observes state *changes* and exposes them as a bounded,
 * ring-buffered, per-room stream of delta entries.
 *
 * **Why event-driven (dirty flags) and NOT per-tick:** the world mutates many
 * times per tick (spawns, item picks, stat changes from drain, component
 * breaks). Computing a full room diff on every tick is wasted work that would
 * also pollute the tick's cost model. Instead the facade *marks* a room
 * dirty whenever state changes (one O(1) `Map.set` per mutation), and the diff
 * is computed *lazily on first read*. Readers pay only when they look; the
 * tick path is untouched. This is the same lazy-materialisation philosophy the
 * project uses for the LLM context itself.
 *
 * **Why per-room ring buffers:** observer attention is room-scoped (same-room
 * perception is a first-class concept here — an agent only "sees" its own
 * room in depth). Per-room buffers keep each observer's stream bounded
 * (PERCEPTION_MAX_LIMIT) and independently evictable, and keep the /perception
 * REST endpoint O(limit) per room.
 *
 * **Why baselines:** an agent can't perceive *relative* changes in a room it
 * has never seen. The first read of a room therefore emits a *baseline* entry
 * (the room's initial contents) and only then switches to deltas. The LLM
 * context consumes the baseline implicitly: its "now in this room" state
 * section already renders the room contents, so getRoomDeltasForAgent
 * acknowledges baseline entries without displaying them (a first observation
 * renders state only, no "this round" lines).
 *
 * **Why per-agent cursors:** "since your last observation" is a *reader-relative*
 * time window, not a wall-clock one. Two readers (an NPC brain and the UI)
 * that start looking at the same room at different times need different
 * "since" points. The cursor advances when the *reader* looks — the LLM
 * context's room-scoped read (getRoomDeltasForAgent) advances it as part of
 * the read itself, and recordAgentObservation is the explicit variant for
 * readers that observe without reading (UI polling / observe endpoint) —
 * never when the world changed. So a reader that sleeps between ticks still
 * sees *everything* that changed while it was asleep.
 *
 * **Why performed-action rows ("only the components that were used"):** an
 * observer also wants to know *what the entities did*, not just what changed
 * as a side effect. Every successful action passes through the consequence
 * dispatcher, which records "which & how many components powered action X" in
 * the shared ActionAttributionStore — the single writer. A flush therefore
 * lists, per room entity, the distinct actions performed since the entity's
 * last surfacing (a per-entity seen-cursor over the store's write
 * timestamps) and claims *only* the components the store recorded as used —
 * never a re-derived guess. A row for an action with no recorded components
 * shows the action with an empty used list, so the surface never overclaims.
 *
 * **Coordinate display rule ("00.00"):** every coordinate an entry ships
 * (moved fromXY/toXY, dropped/item x/y, actor positions) is truncated to two
 * decimal places at build time (shared/CoordFormat.js) — a display concern
 * applied to the *artifact only*: the room snapshots (the diff input) keep
 * full precision, and the client's InTextPanel re-applies the same rule via
 * formatPosition (idempotent). The agent/NPC JSON view therefore never shows
 * full-precision floats either.
 *
 * **Dependency direction (architecture rule):** this controller receives
 * everything from the root controller (WorldStateController) through its
 * *public API* — no internal state is read. The root controller marks rooms
 * dirty (it owns the tick, it owns the mutation sites). The facade injects
 * this controller via DI (no direct instantiation); it owns *observation
 * history* (ring buffers + cursors), which is NOT world state, so it is
 * deliberately not part of the world-state broadcast.
 *
 * @see wiki/subMDs/systems/perception_system.md — the "why" doc
 * @see src/utils/DeltaDiff.js — the pure diff logic
 * @see src/utils/DeltaSummary.js — the pure summary logic
 */

import EventRingBuffer from '../../utils/EventRingBuffer.js';
import Logger from '../../utils/Logger.js';
import { PERCEPTION_MAX_LIMIT, PERCEPTION_RECENT_LIMIT } from '../../utils/Constants.js';
import { diffRoomSnapshots, buildBaselineEntry, hasDeltaChanges } from '../../utils/DeltaDiff.js';
import { buildDeltaSummary } from '../../utils/DeltaSummary.js';
import { truncateCoord } from '../../../shared/CoordFormat.js';
import { componentTypeName } from '../../utils/ComponentNaming.js';

/**
 * A copy of one body row that shares NOTHING with the row it came from — the
 * garments a part wears are a nested list, so a spread alone would let two action
 * rows of the same flush edit one another's clothing through the shared array.
 * @param {Object} part - one `{ type, identifier, shallow, worn? }` body row
 * @returns {Object} an independent copy
 */
function copyBodyPart(part) {
    return {
        ...part,
        ...(Array.isArray(part.worn) ? { worn: part.worn.map((garment) => ({ ...garment })) } : {})
    };
}

class PerceptionController {
    constructor() {
        /** @type {Map<string, EventRingBuffer>} roomId → delta ring buffer */
        this._buffers = new Map();
        /** @type {Map<string, import('../utils/DeltaDiff.js').RoomSnapshot>} roomId → last-seen snapshot (frozen, deep-cloned) */
        this._lastSeen = new Map();
        /** @type {Map<string, { firstTick: number, lastTick: number }>} roomId → dirty window (lazy-diff bookkeeping) */
        this._dirty = new Map();
        /** @type {Map<string, number>} entityId → highest sequence the reader has observed (agent cursor) */
        this._agentCursors = new Map();
        /** @type {Map<string, number>} entityId → highest attribution-record timestamp already surfaced (per-entity "action seen" cursor) */
        this._lastActionSeen = new Map();
        /** @type {number} monotonically increasing per-flush sequence; the tick-independent
         * ordering key for the agent "since your last observation" cursor */
        this._flushSequence = 0;
        /** @type {{ tick: number, entities: Array, droppedItems: Object }|null} snapshot cache (getEntities clones per call; invalidated on mutation via markDirty to stay valid even with a static tick) */
        this._snapshotCache = null;
        /** @type {object|null} the root facade (WorldStateController) — injected by the composition, used *only* through its public methods */
        this._facade = null;
        /** @type {object|undefined} the item type → definition registry (cached from the facade via getItemRegistry()). The single source of item *display names*; static (loaded from the item json), so cached once. */
        this._itemRegistry = undefined;
        /**
         * @type {object|null}
         * The generic ActionAttributionStore (wired by WorldComposition after the
         * facade). Backs the resolver passed to diffRoomSnapshots so `moved`
         * entries credit the authoritative "which & how many components powered the
         * action" set rather than re-deriving it from the Movement trait.
         */
        this._attributionStore = null;
    }

    /**
     * DI injection (same pattern as all other non-root controllers).
     * @param {object} facade - WorldStateController (the root)
     */
    setWorldStateController(facade) {
        this._facade = facade;
    }

    /**
     * DI injection of the generic action-attribution store (the single source of
     * truth for "which components powered action X" + "how many"). Wired by
     * WorldComposition after the facade is built (same pattern as
     * setWorldStateController). Perception uses it, via _attributionResolver, to
     * credit the authoritative component set on moved-entity perception rows.
     * @param {object|null} store
     */
    setActionAttributionStore(store) {
        this._attributionStore = store ?? null;
    }

    /**
     * Returns a resolver (entityId, actionName) => AttributionRecord|null backed by
     * the injected store, or null when no store is wired (in which case DeltaDiff
     * uses its pure heuristic locomotion). Kept as a function so the resolver is
     * evaluated at call time (post-injection), not at construction.
     * @private
     */
    _attributionResolver() {
        const store = this._attributionStore;
        if (!store) return null;
        return (entityId, actionName) => store.get(entityId, actionName);
    }

    // --------------------------------------------------------------------------
    // Dirty bookkeeping (public, root-controller side)
    // --------------------------------------------------------------------------

    /**
     * Marks a room as "state changed". Called by the root controller at every
     * mutation site (spawn, despawn, move, item change, stat change, component
     * break, dropped item change). O(1); no diffing happens here.
     *
     * @param {string} roomId
     * @param {number} tick - world tick at the time of the mutation (the root
     * owns the tick; perception never reads it directly — see module header on
     * the dependency direction)
     */
    markDirty(roomId, tick) {
        if (!roomId || this._dirty.size > PERCEPTION_MAX_LIMIT * 2) {
            // defensive: more dirty rooms than we can ever track would mean
            // the caller is marking rooms that aren't real rooms (or a bug).
            // we just drop the mark rather than grow unbounded memory.
            return;
        }
        const currentTick = typeof tick === 'number' && Number.isFinite(tick) ? tick : 0;
        const existing = this._dirty.get(roomId);
        this._dirty.set(roomId, existing
            ? { firstTick: existing.firstTick, lastTick: Math.max(existing.lastTick, currentTick) }
            : { firstTick: currentTick, lastTick: currentTick });
        // A mutation invalidates the per-tick snapshot cache: the cached clone was
        // taken before this change, so the next room read must re-derive the full
        // snapshot from the facade (getEntities()/getDroppedItems()). The tick-based
        // check in _roomSnapshot is insufficient when the tick is static (non-loop
        // contexts), so this explicit invalidation is the authoritative path.
        this._snapshotCache = null;
    }

    /**
     * Flush every dirty room at the CLOSE of a round, stamping the entries with
     * that round. This is what makes a delta entry mean exactly one round of
     * change: an agent's turn is scoped to the round that resolved
     * (wiki/decisions/round-scoped-context.md), and a window left to accumulate
     * across a round boundary would mix two of them into one sentence.
     *
     * Wired from the turn system's close routine (a hook, injected at the
     * composition root — the turn system never imports this controller).
     * Best-effort per room: a flush that throws is a broken diff, not a reason
     * to lose the round's resolution.
     * @param {number} round - the round that just resolved
     * @returns {number} how many rooms were flushed
     */
    flushDirtyForRound(round) {
        // Round 0 is a real round; -1 (nothing resolved yet), null and anything
        // not a whole number are not. Flushing with an unknown round would stamp
        // entries with a number no reader can ask for, and the change would be
        // undeliverable forever — so nothing is flushed and the room stays owed
        // to the next reader (wiki/decisions/round-scoped-context.md).
        if (!Number.isInteger(round) || round < 0) return 0;
        let flushed = 0;
        for (const roomId of Array.from(this._dirty.keys())) {
            try {
                // _flushRoom does not store: it diffs and RETURNS the entry, and
                // the reader is the one that pushes it into the room's ring. A
                // round-boundary flush has no reader, so it is the reader here —
                // pushing without that would consume the dirty mark and throw the
                // round's changes away (the ring would hold nothing for anybody).
                const buffer = this._bufferFor(roomId);
                const entry = this._flushRoom(roomId, round);
                if (entry) {
                    buffer.push(entry);
                    flushed += 1;
                }
            } catch (err) {
                // why: one room's diff must not abort the round's close. The
                // room stays dirty and its next reader retries the flush.
                Logger.warn(`[Perception] round-${round} flush failed for room ${roomId}: ${err?.message || err}`);
            }
        }
        return flushed;
    }

    /**
     * Clears all perception state (called by the root controller on
     * `restore` / world re-init — a full world reset means the observer has
     * a brand-new world and its history is void).
     */
    reset() {
        this._buffers.forEach((buffer) => buffer.clear());
        this._buffers.clear();
        this._lastSeen.clear();
        this._dirty.clear();
        this._agentCursors.clear();
        // The attribution store is shared with the dispatcher (writer); a world
        // reset voids the previous world's action history just as it voids the
        // observation history (its own doc says to call reset() on world reset).
        this._attributionStore?.reset();
        this._lastActionSeen.clear();
        this._flushSequence = 0;
        this._snapshotCache = null;
    }

    // --------------------------------------------------------------------------
    // Public read APIs (root-controller side; also used by the LLM context
    // and the REST endpoint via worldStateController.getPerceptionDeltasForRoom)
    // --------------------------------------------------------------------------

    /**
     * Returns up to `limit` recent delta entries for one room. If the room
     * is dirty (marked since the last read) — or has never been observed — it
     * flushes the pending diff (or baseline) first, so the returned list always
     * reflects the *current* state of the room.
     *
     * @param {string} roomId
     * @param {{ limit?: number }} [options]
     * @returns {Array} delta entries, oldest → newest (defensive copies)
     */
    getRoomDeltas(roomId, { limit = PERCEPTION_RECENT_LIMIT } = {}) {
        const buffer = this._bufferFor(roomId);
        const entry = this._flushRoom(roomId);
        if (entry) buffer.push(entry);
        return buffer.getRecent(limit);
    }

    /**
     * Returns delta entries for the *whole world* since the agent last looked
     * (per-agent cursor). Used by LlmContextController to build the "WHAT
     * CHANGED SINCE YOUR LAST OBSERVATION" section of the agent's context.
     * `limit` defaults to PERCEPTION_RECENT_LIMIT (the same tail the
     * /perception endpoint returns) so one number governs every reader of the
     * perception stream.
     *
     * Ordering is a *monotonic per-flush sequence*, not the simulation tick:
     * the tick is coarse (many mutations share one tick) and is static in
     * non-loop contexts, both of which would corrupt a tick-based `since`
     * comparison. Each flushed entry carries a strictly-increasing `sequence`,
     * and the agent cursor stores the highest sequence it has consumed, so
     * `since your last observation` is exact. The cursor is advanced to the
     * highest sequence visible *after* the collection + flush, so the next
     * read excludes everything this one covered (including entries we drop
     * via the `limit` tail).
     *
     * @param {string} entityId - the observing agent's entity id
     * @param {{ limit?: number }} [options]
     * @returns {Array} delta entries, oldest to newest (baseline entries included)
     */
    getAgentDeltas(entityId, { limit = PERCEPTION_RECENT_LIMIT } = {}) {
        if (!entityId) return [];
        const sinceSequence = this._agentCursors.get(entityId) ?? -1;
        const allRooms = this._knownRooms();
        const entries = [];
        for (const roomId of allRooms) {
            const buffer = this._bufferFor(roomId);
            const fresh = this._flushRoom(roomId);
            if (fresh) buffer.push(fresh);
            // read the full room buffer (capacity = PERCEPTION_MAX_LIMIT): every
            // entry still resident that post-dates the cursor must be surfaced
            // regardless of the tail length.
            for (const entry of buffer.getRecent(PERCEPTION_MAX_LIMIT)) {
                if (entry.sequence > sinceSequence) entries.push(entry);
            }
        }
        // The reader's observation is the *act of looking*; advance the cursor
        // to the highest sequence now visible so the next read excludes
        // everything this one covered. When nothing is visible, acknowledge
        // up to the current global sequence (never regresses, no stuck loop).
        this._agentCursors.set(
            entityId,
            entries.length
                ? entries.reduce((max, e) => Math.max(max, e.sequence), sinceSequence)
                : this._flushSequence
        );
        entries.sort((a, b) => a.sequence - b.sequence || (a.ts ?? 0) - (b.ts ?? 0));
        return entries.slice(-limit);
    }

    /**
     * Returns the delta entries of ONE room (the agent's own room) since the
     * agent last looked — the room-scoped variant of getAgentDeltas used by
     * the LLM context's "YOUR WORLD → this round" block.
     *
     * Same per-agent cursor as getAgentDeltas, with two deliberate semantic
     * differences (both serve the same-room perception model):
     *
     * 1. **Display is room-filtered, acknowledgment is not.** Only entries
     *    from `roomId` are returned, but the cursor still advances past
     *    everything in that room's buffer that post-dates it — including the
     *    baseline entry, which is *acknowledged but never displayed* (the
     *    agent's "now in this room" state section IS the baseline, so
     *    rendering it as "everything appeared" would double-report the room
     *    contents). Entries from OTHER rooms are untouched by this method:
     *    the cursor only moves past what this room's buffer holds, so a
     *    quiet-own-room stretch does not consume history the agent will
     *    later want when it moves rooms — arriving in a room surfaces what
     *    changed there while the agent was elsewhere (bounded by the room
     *    ring capacity).
     * 2. **Baseline entries are excluded from the display list** (see 1).
     *
     * The read is the observation: after this call the agent's cursor sits
     * at the highest sequence this room's buffer held since the previous
     * read, so the next round's build does not double-report.
     *
     * **The brain's read, and only the brain's — it consumes.** Two failures
     * are documented by the Agent View incident (2026-11-02): a debug reader
     * calling this erases what the agent was about to perceive; and a
     * non-consuming variant of THIS window is no use to an inspector either,
     * because once the round runner has read, "everything after the agent's
     * cursor" is empty by definition — the panel would show `(none)` while the
     * agent's own context carried the blow. A reader that is not the brain reads
     * the room's recent window ({@link getRoomDeltas}): stateless, and it shows
     * what actually happened.
     *
     * @param {string} entityId - the observing agent's entity id
     * @param {string} roomId - the agent's current room (UID)
     * @param {{ limit?: number }} [options] - tail cap (default
     *   PERCEPTION_RECENT_LIMIT); the window is sliced, never re-read
     *   (re-reading would find an already-advanced cursor).
     * @returns {Array} delta entries (kind 'delta' only), oldest → newest
     */
    getRoomDeltasForAgent(entityId, roomId, { limit = PERCEPTION_RECENT_LIMIT } = {}) {
        if (!entityId || !roomId) return [];
        const sinceSequence = this._agentCursors.get(entityId) ?? -1;
        const buffer = this._bufferFor(roomId);
        const fresh = this._flushRoom(roomId);
        if (fresh) buffer.push(fresh);
        // Read the full room buffer (capacity = PERCEPTION_MAX_LIMIT): every
        // entry still resident that post-dates the cursor must be
        // acknowledged, regardless of the display tail length.
        let acknowledged = sinceSequence;
        const visible = [];
        for (const entry of buffer.getRecent(PERCEPTION_MAX_LIMIT)) {
            if (entry.sequence <= sinceSequence) continue;
            acknowledged = Math.max(acknowledged, entry.sequence);
            if (entry.kind !== 'baseline') visible.push(entry);
        }
        // Advance only up to the acknowledged sequence (never regress):
        // a quiet room (nothing since the cursor) leaves the cursor where it
        // is — see the method header for why that is the desired behavior.
        if (acknowledged > sinceSequence) {
            this._agentCursors.set(entityId, acknowledged);
        }
        visible.sort((a, b) => a.sequence - b.sequence || (a.ts ?? 0) - (b.ts ?? 0));
        return visible.slice(-limit);
    }

    /**
     * Confirms that the agent has now observed everything up to the current
     * sequence. Advances the agent cursor to the latest global `sequence`
     * (i.e. `stop reporting changes until I look again`). Used by callers
     * that observe without reading deltas — the player UI polling path, the
     * /perception observe endpoint, and tests that want to control the
     * cursor independently. The LLM context path does NOT need this: its
     * getRoomDeltasForAgent read advances the cursor itself.
     *
     * @param {string} entityId
     */
    recordAgentObservation(entityId) {
        if (!entityId) return;
        this._agentCursors.set(entityId, this._flushSequence);
    }

    /**
     * Exposes the per-room ring buffers for introspection / tests.
     * @returns {Map<string, EventRingBuffer>}
     */
    getBuffers() {
        return new Map(this._buffers);
    }

    // --------------------------------------------------------------------------
    // Internal: lazy flush (dirty → diff → push)
    // --------------------------------------------------------------------------

    /**
     * Flushes the dirty window for one room: reads the *current* room state
     * (fresh clone from the facade's public API), diffs it against the last
     * seen snapshot (or builds a baseline if this is the first observation),
     * and pushes the result into the room's ring buffer.
     *
     * A room the observer has never seen is flushed on first read (baseline),
     * even if it was never marked dirty (e.g. a room populated only by the
     * initial world build) — otherwise it would never surface its contents.
     *
     * Returns the new delta entry (or baseline) if one was pushed, else `null`.
     *
     * @param {string} roomId
     * @param {number|null} [roundStamp=null] - the round to stamp the entry with
     *   (the round that just closed, from flushDirtyForRound). null falls back
     *   to the open round.
     * @private
     */
    _flushRoom(roomId, roundStamp = null) {
        if (!roomId) return null;
        const isFirstObservation = !this._lastSeen.has(roomId);
        if (!this._dirty.has(roomId) && !isFirstObservation) return null;
        const dirtyWindow =
            this._dirty.get(roomId) ?? { firstTick: 0, lastTick: this._currentTick() };
        this._dirty.delete(roomId); // clear *before* diffing: if diffing throws
        // (it should not — the diff is pure) we don't want to re-diff a room
        // whose snapshot we already read; the caller's next read will just be a
        // clean read.
        const current = this._roomSnapshot(roomId);
        const prev = this._lastSeen.get(roomId);
        const tick = dirtyWindow.lastTick;
        let entry;
        if (prev) {
            entry = diffRoomSnapshots(
                prev,
                current,
                tick,
                roomId,
                this._attributionResolver()
            );
        } else {
            entry = buildBaselineEntry(current, tick, roomId);
        }
        // Monotonic per-flush sequence: the global, tick-independent ordering
        // key for the agent `since your last observation` cursor. (The tick
        // field stays on the entry for display; it is not the sort/cursor key.)
        entry.sequence = ++this._flushSequence;
        // Stamp the round the entry belongs to (flush time). Without this the
        // UI would label every entry with the *viewer's* current round and old
        // history would all show as the latest round.
        // `roundStamp` is the round the turn system just closed (set by
        // flushDirtyForRound). Without it the stamp is the open round — the
        // round these changes happened in, because a flush at a round's close
        // runs while that round is still the open one.
        entry.roundNumber = Number.isInteger(roundStamp) ? roundStamp : this._currentRound();
        // Resolve the display *name* for every item / dropped-item row. The diff
        // only ever stores the item *type* key — the human name is looked up
        // from the item registry (the single source of truth for item names).
        // Pure enrichment: adds `name` to each row; never touches counts or the
        // diff classification. Must run before the summary (the sentence now
        // names the items).
        this._enrichItemNames(entry);
        // Credit the actions this room's entities performed since their last
        // surfacing (delta-only; the baseline is an initial observation, not an
        // action window). Must run before the summary (the sentence names the
        // actions). Deltas are the only entries that carry performed rows.
        this._collectPerformedActions(current, entry);
        // store the *current* snapshot as the new last-seen reference
        this._lastSeen.set(roomId, current);
        // Room name available to the client: the UI appends it to each bullet
        // so every line is a self-contained sentence ("… in The Entrance Hall").
        entry.roomName = this._roomName(roomId);
        // fill the summary (pure, in DeltaSummary.js)
        entry.summary = buildDeltaSummary(entry, entry.roomName);
        // Apply the perception display rule to every coordinate the entry
        // ships (truncated to 2 decimals — "00.00"): the agent/NPC JSON view
        // and the client both consume the entry, so neither may see a
        // full-precision float. Display-only: the snapshots stay full precision.
        this._truncateEntryCoordinates(entry);
        if (hasDeltaChanges(entry)) {
            return entry;
        }
        return null;
    }

    /**
     * Reads the current room state from the root facade's public API and
     * shapes it into a RoomSnapshot (see DeltaDiff module header). Uses the
     * per-tick cache to avoid re-cloning the full world when N rooms are
     * dirty in the same tick (getEntities() clones the whole world per call).
     */
    _roomSnapshot(roomId) {
        const cached = this._snapshotCache;
        if (!cached || cached.tick !== this._currentTick()) {
            const tick = this._currentTick();
            // getEntities() is a CLONED *map* keyed by entity id, not an
            // array — Object.values() gives the array of entity clones that
            // this loop (and the cached snapshot) needs.
            const entities = Object.values(this._facade?.getEntities?.() ?? {});
            // getDroppedItems() is the FLAT map (keyed by dropped-item id, each
            // item carrying its own roomId); getDroppedItemsByRoom() with no
            // arg would match nothing. Read the flat map once per tick and filter
            // to this room below.
            const droppedItems = this._facade?.getDroppedItems?.() ?? {};
            this._snapshotCache = { tick, entities, droppedItems };
        }
        const { entities, droppedItems } = this._snapshotCache;

        const byId = {};
        for (const entity of entities) {
            if (!entity?.location || entity.location !== roomId) continue;
            byId[entity.id] = this._extractEntity(entity);
        }

        // Reduce to the SnapshotItem shape ({ type, x, y, ownerId }) the diff
        // consumer (DeltaDiff.diffDroppedItems) expects, keeping only this room's
        // items. `ownerId` is preserved so the diff can credit who dropped/owns a
        // floor item (the facade stores it on every dropped item via writeDroppedItem).
        const dropped = {};
        for (const [itemId, item] of Object.entries(droppedItems ?? {})) {
            if (item?.roomId !== roomId) continue;
            dropped[itemId] = {
                type: item.type ?? item.itemType ?? null,
                x: item.x ?? null,
                y: item.y ?? null,
                ownerId: item.ownerId ?? null
            };
        }
        // Chat transcript, reduced to the room's ring (id → message). The
        // facade returns a fresh, bounded copy of the last `limit` messages
        // (limit defaults to the ring capacity), safe to keep as snapshot
        // data and diff for new lines only.
        const chat = {};
        for (const msg of this._facade?.getRoomChatMessages?.(roomId) ?? []) {
            if (msg?.id) {
                chat[msg.id] = {
                    id: msg.id,
                    speakerName: msg.speakerName ?? null,
                    speakerEntityId: msg.speakerEntityId ?? null,
                    text: msg.text ?? '',
                    tick: msg.tick ?? null,
                    ts: msg.ts ?? null
                };
            }
        }

        return {
            roomId,
            tick: this._currentTick(),
            entities: byId,
            dropped,
            chat
        };
    }

    /**
     * Builds the per-entity perception shape (name, blueprint, spatial,
     * attributes, components + stats, items by host, internal, equipped) from
     * the *frozen* entity record + the facade's public accessors. The entity
     * is *cloned* on return by the facade's getEntities(); we clone again
     * (shallow per field) so the snapshot is safe to keep and diff against
     * the next read.
     */
    _extractEntity(entity) {
        const components = {};
        for (const comp of entity?.components ?? []) {
            const stats = this._facade?.getComponentStats?.(comp.id) ?? null;
            components[comp.id] = {
                id: comp.id,
                name: comp.name ?? comp.id,
                type: comp.type ?? comp.id,
                stats: stats ?? {}
            };
        }
        // Items: getEntityItems() returns { [hostComponentId]: [item, ...] }.
        // We only need { [hostComponentId]: { [itemId]: { type } } } for diffing,
        // so reduce each host's item array to a type-keyed map. Only immutable
        // string values are stored, so the snapshot stays diffable.
        const items = {};
        const entityItems = this._facade?.getEntityItems?.(entity.id) ?? {};
        for (const hostComponentId of Object.keys(entityItems)) {
            items[hostComponentId] = {};
            for (const item of entityItems[hostComponentId] ?? []) {
                items[hostComponentId][item.id] = { type: item.type ?? 'unknown' };
            }
        }
        // Internal components: getInternalComponentsForEntity() returns
        // { [hostComponentId]: [internalComp, ...] } where each internalComp is
        // { id, type, hostComponentId, ... }. Key by the internal component's own
        // id so a move between host components (same org, new host) still diffs
        // cleanly. Only { type } is stored for the diff.
        const internal = {};
        const internalComps = this._facade?.getInternalComponentsForEntity?.(entity.id) ?? {};
        for (const list of Object.values(internalComps)) {
            for (const ic of list ?? []) {
                if (ic?.id) internal[ic.id] = { type: ic.type ?? 'unknown' };
            }
        }
        // Equipped: getEquippedItems() returns [{ itemId, itemType, componentId }, ...].
        // Key by itemId, store only the type needed by diffPerEntityMaps.
        const equipped = {};
        for (const eq of this._facade?.getEquippedItems?.(entity.id) ?? []) {
            const key = eq.itemId ?? eq.id;
            if (key) equipped[key] = { itemType: eq.itemType ?? eq.type ?? 'unknown' };
        }
        // Placed-machine placer lookup (world-wide — the placer may no longer
        // be in this room): the display name and CURRENT position that ride on
        // the machine row. Placement is "at the placer" by design (the client
        // places at the droid's feet), so the anchor is what makes a bare
        // "(0.00, 0.00)" legible in the panel (InTextPanel._placerLabel renders
        // it as "your droid @ (x, y)").
        const machinePlacer = entity?.isMachine === true ? (entity?.placedBy ?? null) : null;
        const placerEntity = machinePlacer ? (this._facade?.getEntity?.(machinePlacer) ?? null) : null;
        return {
            id: entity.id,
            name: entity.name ?? entity.id,
            blueprint: entity.blueprint ?? null,
            status: entity.status ?? null,
            location: entity.location ?? null,
            spatial: entity.spatial ?? null,
            attributes: entity.attributes ?? {},
            components,
            items,
            internal,
            equipped,
            // lastMoveAction: the action (name + tick) that last repositioned this
            // entity — set by the spatial consequence handler at move time. Read
            // by DeltaDiff to credit the *action* behind each movement delta in the
            // perception ring buffer. The world event log stores only free-text
            // "turn" lines that can't be matched back to an entity, so this per-
            // entity tag is the reliable seam. `null` when the entity has never
            // moved by an action.
            lastMoveAction: entity?.lastMoveAction ?? null,
            // Placed-machine attribution. The place choke point (PlaceMachineHandler)
            // tags the spawned entity (isMachine/machineType/placedBy), so the
            // snapshot carries WHO placed the machine: the placer's display name
            // and current position, resolved against the world at snapshot time
            // (nulls when the placer is gone or unnamed — the row then degrades
            // to the id, the same rule as action targets). DeltaDiff promotes
            // machine-tagged entity rows into the `machines` category
            // (placed/retrieved); the diff copies placedBy through by reference,
            // so the position anchor rides on both row kinds.
            machine: entity?.isMachine === true
                ? {
                    type: entity.machineType ?? null,
                    placedBy: machinePlacer
                        ? {
                            id: machinePlacer,
                            name: placerEntity?.name ?? null,
                            x: placerEntity?.spatial?.x ?? null,
                            y: placerEntity?.spatial?.y ?? null
                        }
                        : null
                }
                : null
        };
    }

    /**
     * Applies the perception coordinate display rule ("00.00") to every
     * coordinate the entry ships: truncate (toward zero) to two decimal
     * places, in place. The entry is the per-flush *artifact* both readers
     * consume (the InText panel via the room stream, the NPC/LLM brains via
     * the agent JSON view) — neither may see a full-precision float. This is
     * display-only by construction: it runs on the entry, never on the room
     * snapshots (the diff input keeps full precision), and truncation is
     * idempotent, so the client's formatPosition re-applying the same rule
     * later is a no-op. Defensive by design: every list/field is optional —
     * a shape change upstream degrades to "keep as is", never a crash.
     *
     * @private
     * @param {object} entry - the entry just built (baseline or delta)
     */
    _truncateEntryCoordinates(entry) {
        if (!entry || typeof entry !== 'object') return;
        const fixPoint = (p) => {
            if (!p || typeof p !== 'object') return;
            if (p.x != null) p.x = truncateCoord(p.x);
            if (p.y != null) p.y = truncateCoord(p.y);
        };
        const fixRow = (row) => {
            if (!row || typeof row !== 'object') return;
            if (row.x != null) row.x = truncateCoord(row.x);
            if (row.y != null) row.y = truncateCoord(row.y);
            fixPoint(row.fromXY);
            fixPoint(row.toXY);
            fixPoint(row.spatial);
            fixPoint(row.actor);
        };
        const lists = [
            ...(entry.entities?.moved ?? []),
            ...(entry.entities?.appeared ?? []),
            ...(entry.entities?.despawned ?? []),
            // Machine rows (who placed what where) share the fixRow shape —
            // their x/y ride directly on the row.
            ...(entry.machines?.placed ?? []),
            ...(entry.machines?.retrieved ?? []),
            ...(entry.items?.added ?? []),
            ...(entry.items?.removed ?? []),
            ...(entry.dropped?.added ?? []),
            ...(entry.dropped?.removed ?? []),
            ...(entry.dropped?.moved ?? []),
            ...(entry.equipped?.added ?? []),
            ...(entry.equipped?.removed ?? [])
        ];
        for (const row of lists) fixRow(row);
    }

    /**
     * Fills `entry.actions.performed`: one row per *distinct* action the
     * room's entities most recently performed since that entity's last
     * surfacing (per-entity cursor `_lastActionSeen`, keyed by the attribution
     * record's write timestamp — not the tick, which is coarse and static in
     * non-loop contexts).
     *
     * Each row claims *only* the components the ActionAttributionStore recorded
     * as used for that action ("only the components that were used") — the
     * store is the single writer, written at the dispatcher choke point. A
     * record without ids (or an absent store) still yields a row, with an
     * empty used list: the action is reported, no components are claimed. Used
     * component ids are resolved against the *current* snapshot for their
     * type; an id that no longer resolves (component broken/removed since the
     * action) is still listed, with `type: null`.
     *
     * Each row also carries the recorded TARGET (when the action had one):
     * `{ id, name, componentId, componentName }` — who was acted upon and which
     * component of it was hit, resolved against the current world by
     * `_resolvePerceivedTarget` (ids only live in the store).
     *
     * Each row also carries the recorded execution context: the world tick and
     * the turn-round number at the moment of the action (both nullable — null
     * when the recorder had no tick system / turn system, i.e. a bare test
     * seam).
     *
     * The cursor advances per entity when the room flushes, so each record is
     * surfaced at most once — in the room the entity stands in when the flush
     * happens (an entity that moved before the flush surfaces the action in
     * its new room; the perception model is same-room observation).
     *
     * Pure-with-respect-to-the-world: reads the store + the just-built
     * snapshot only; advances the per-entity cursor.
     *
     * @private
     * @param {import('../../utils/DeltaDiff.js').RoomSnapshot} current - the room snapshot just read
     * @param {object} entry - the delta entry being built (`kind === 'delta'`)
     */
    _collectPerformedActions(current, entry) {
        if (entry?.kind !== 'delta') return;
        const store = this._attributionStore;
        if (!store) {
            entry.actions = { performed: [] };
            entry.counts.actions = 0;
            return;
        }
        const performed = [];
        for (const [entityId, snap] of Object.entries(current?.entities ?? {})) {
            const records = store.listFor(entityId);
            if (!records || records.size === 0) continue;
            const seen = this._lastActionSeen.get(entityId) ?? 0;
            // The actor's body, resolved at most once per entity per flush and
            // copied into each row (rows never share the array, so no reader can
            // mutate a sibling's body through its own).
            let bodyCache;
            const bodyOf = () => {
                if (bodyCache === undefined) bodyCache = this._actorBody(entityId, snap);
                return bodyCache ? bodyCache.map(copyBodyPart) : null;
            };
            let maxTs = seen;
            for (const [actionName, record] of records) {
                const ts = record?.timestamp ?? 0;
                if (ts > maxTs) maxTs = ts;
                if (ts <= seen) continue;
                const used = [];
                const comps = snap?.components ?? {};
                for (const id of record?.ids ?? []) {
                    const comp = comps[id];
                    used.push({ type: comp?.type ?? null, id });
                }
                performed.push({
                    entity: entityId,
                    name: snap?.name ?? entityId,
                    action: actionName,
                    used,
                    body: bodyOf(),
                    target: this._resolvePerceivedTarget(record?.target, current),
                    tick: record?.tick ?? null,
                    round: record?.round ?? null,
                    source: 'store'
                });
            }
            if (maxTs > seen) this._lastActionSeen.set(entityId, maxTs);
        }
        entry.actions = { performed };
        entry.counts.actions = performed.length;
    }

    /**
     * What the acting entity is built of, recorded on every `actions.performed`
     * row of that flush: `[{ type, identifier }]` in the entity's own component
     * order, or null when nothing names a part.
     *
     * Why the WRITER records it (`wiki/decisions/action-prose.md`): a round's
     * action rows are flushed only after the round has resolved, so by the time any
     * reader asks, the round is closed and the actor may already have lost (or
     * grown) parts. A prose that read the body at render time would describe
     * today's body inside yesterday's sentence; recorded at the flush, the sentence
     * says what was true when the act became observable — and a row written before
     * the field existed simply carries no dossier, never a reconstructed one.
     *
     * The live entity is the source because it carries the blueprint placement —
     * `identifier` and `dependsOn` — that says WHICH arm threw the punch and what
     * hangs off what; the room snapshot keeps only `{ type, stats }` per component.
     * An actor already gone falls back to its snapshot row (types, no placement),
     * and an actor with no parts in either yields null — the prose then says nothing
     * about a body.
     *
     * Each entry is `{ type, identifier, shallow }`. `identifier` is the part's OWN
     * label, not the blueprint chain: the chain a component carries is its own label
     * with its parent's appended (a nail is "tip_f1_hand_left"), and a sentence that
     * recites the ancestry says twice what it already said ("Male Nail (tip toe5
     * foot frontal right)"). `shallow` is the same structural fact seen from the
     * other side: the part hangs off nothing, or off the body's own root. The prose
     * reads only the shallow ones (a human's 78 parts become head, torso, breasts,
     * arms, genitals, legs), and the filter is structural on purpose — a string rule
     * on the identifier cannot tell "frontal_left" (a leg's own label) from
     * "left_top" (an eyebrow inside a head).
     *
     * A part that is WEARING something carries it too (`worn`: the garments on that
     * exact component), because worn state is the one part of a body that changes
     * mid-round — recorded here, a closed round still says the actor was dressed when
     * the act became observable, even after a later reader finds it undressed.
     * Coverage is what the wear system says it is: the component the item is equipped
     * on (`WearLogic`), nothing inferred from the garment's kind.
     *
     * @param {string} entityId - the actor
     * @param {Object|null} snap - this room's snapshot row for the actor
     * @returns {Array<{ type: string, identifier: string|null, shallow: boolean, worn?: Array<{ type: string|null, name: string|null }> }>|null}
     * @private
     */
    _actorBody(entityId, snap) {
        const components = this._facade?.getEntity?.(entityId)?.components;
        if (Array.isArray(components)) {
            const body = this._bodyRecord(components, this._wornByComponent(entityId));
            if (body) return body;
        }
        const fromSnapshot = [];
        for (const comp of Object.values(snap?.components ?? {})) {
            const type = typeof comp?.type === 'string' ? comp.type.trim() : '';
            if (type) fromSnapshot.push({ type, identifier: null, shallow: true });
        }
        return fromSnapshot.length ? fromSnapshot : null;
    }

    /**
     * The `{ type, identifier, shallow, covered }` rows for one entity's component
     * list, in that list's own order (the body's order, not an alphabetical one —
     * two worlds built the same way say the parts in the same order, DETERMINISM).
     * @param {Array} components - the entity's live components
     * @param {Map<string, Array<{ type: string|null, name: string|null }>>|null} [wornByComponent]
     *   component id -> the garments worn on it (`_wornByComponent`); absent, no part
     *   is read as clothed, and none as covered
     * @returns {Array<{ type: string, identifier: string|null, shallow: boolean, covered?: true, worn?: Array<{ type: string|null, name: string|null }> }>|null}
     * @private
     */
    _bodyRecord(components, wornByComponent = null) {
        const byId = new Map();
        for (const comp of components) {
            if (comp && typeof comp.id === 'string' && comp.id) byId.set(comp.id, comp);
        }
        const covered = this._coveredIds(components, byId, wornByComponent);
        const body = [];
        for (const comp of components) {
            const type = typeof comp?.type === 'string' ? comp.type.trim() : '';
            if (!type) continue;
            const parent = this._bodyParent(comp, byId);
            const worn = wornByComponent?.get(comp?.id) ?? null;
            body.push({
                type,
                identifier: this._ownBodyLabel(comp, parent),
                // Shallow = one mount deep at most: it hangs off nothing (a root),
                // off a part no longer in this body (a wreck whose arm was torn off
                // still reports the stump), or off a root itself — the head, the
                // torso, an arm. Two mounts deep (a finger on an arm, an eyebrow on
                // a head) is detail the sentence does not read out.
                shallow: !parent || !this._bodyParent(parent, byId),
                // Absent, not null, when nothing covers the part: a bare body's rows
                // stay exactly the rows they were before clothing could be narrated.
                ...(worn ? { worn } : {}),
                // This part's matter is out of sight under cloth worn higher up the body,
                // because its own mount declared it hides with its parent (`_coveredIds`).
                ...(covered.has(comp?.id) ? { covered: true } : {})
            });
        }
        return body.length ? body : null;
    }

    /**
     * Which parts are under cloth worn HIGHER UP the body: a part whose mount
     * declares `hidesWithParent` shares its parent's fate — a breast hung on the
     * central body is behind whatever covers the central body, without the garment
     * having to name it.
     *
     * The mark is the blueprint's, on the mount (`data/mods/core-blueprints`, read
     * onto the instance by `EntityController.createEntityFromBlueprint`), so which
     * part hides under whose parent is authored world data, never a guess from
     * component names. Propagation is therefore opt-in per joint, and it chains:
     * a marked part under a marked part is covered when the cloth reaches the top
     * of the chain. A part wearing a garment of its own is never in this set — the
     * garment is the visible thing, and the row already says what covers it.
     *
     * Nothing worn, nothing covered: an undressed body yields an empty set and its
     * rows are byte-identical to the rows this file wrote before coverage existed.
     *
     * @param {Array} components - the entity's live components
     * @param {Map<string, Object>} byId - the same list keyed by component id
     * @param {Map<string, Array>|null} wornByComponent - component id -> garments on it
     * @returns {Set<string>} ids of parts under someone else's cloth
     * @private
     */
    _coveredIds(components, byId, wornByComponent) {
        const covered = new Set();
        if (!wornByComponent || wornByComponent.size === 0) return covered;
        // id -> computed, so a long chain is walked once. A `dependsOn` cycle is
        // broken data: the walk stops rather than claiming coverage it cannot see.
        const answer = new Map();

        const hiddenUnderCloth = (comp, walking) => {
            const id = typeof comp?.id === 'string' ? comp.id : '';
            if (!id) return false;
            if (answer.has(id)) return answer.get(id);
            if (walking.has(id)) return false;
            walking.add(id);
            const parent = this._bodyParent(comp, byId);
            // The parent hides its own matter when it wears cloth, or when it is itself
            // under cloth higher up (`hiddenUnderCloth`, which is what makes it chain).
            const parentCovered = parent
                ? (wornByComponent.has(parent.id) || hiddenUnderCloth(parent, walking))
                : false;
            const result = parentCovered && comp.hidesWithParent === true;
            answer.set(id, result);
            return result;
        };

        for (const comp of components) {
            if (!comp || wornByComponent.has(comp.id)) continue;
            if (hiddenUnderCloth(comp, new Set())) covered.add(comp.id);
        }
        return covered;
    }

    /**
     * Which of an entity's components are under clothing, keyed by component id:
     * the wear system's own answer (`WorldStateController.getWornItems` — the
     * equipped subset whose item type declares `wear.minVolume`), reduced to what a
     * sentence needs (the garment's type key and display name).
     *
     * Read ONCE per actor per flush (the body is cached there), never per row
     * (`PERF-4`). An unwired facade, or an entity wearing nothing, yields an empty
     * map — the body then reads exactly as it did before clothes could be narrated.
     *
     * @param {string} entityId - the entity to inspect
     * @returns {Map<string, Array<{ type: string|null, name: string|null }>>}
     * @private
     */
    _wornByComponent(entityId) {
        const byComponent = new Map();
        for (const worn of this._facade?.getWornItems?.(entityId) ?? []) {
            if (!worn || typeof worn.componentId !== 'string' || worn.componentId === '') continue;
            const garment = { type: worn.itemType ?? null, name: worn.name ?? null };
            const list = byComponent.get(worn.componentId);
            if (list) list.push(garment);
            else byComponent.set(worn.componentId, [garment]);
        }
        return byComponent;
    }

    /**
     * The component this one is mounted on, from its `dependsOn` (first dependency
     * that still exists in the body), or null for a root / an orphan.
     * @param {Object} comp
     * @param {Map<string, Object>} byId
     * @returns {Object|null}
     * @private
     */
    _bodyParent(comp, byId) {
        for (const depId of Array.isArray(comp?.dependsOn) ? comp.dependsOn : []) {
            const parent = typeof depId === 'string' ? byId.get(depId) : null;
            if (parent) return parent;
        }
        return null;
    }

    /**
     * The part's own label: its blueprint `identifier` with the parent's identifier
     * removed from the tail, because the chain is built as `<own>_<parent…>` (a nail
     * "tip_f1_hand_left" under a finger "f1_hand_left" is "tip"). A label with no
     * parent suffix in it is returned whole — "frontal_left" is a leg's OWN label,
     * not a leg inside a left.
     * @param {Object} comp
     * @param {Object|null} parent
     * @returns {string|null}
     * @private
     */
    _ownBodyLabel(comp, parent) {
        const raw = typeof comp?.identifier === 'string' ? comp.identifier.trim() : '';
        if (!raw) return null;
        const parentIdf = typeof parent?.identifier === 'string' ? parent.identifier.trim() : '';
        if (parentIdf && raw.length > parentIdf.length + 1 && raw.endsWith(`_${parentIdf}`)) {
            const own = raw.slice(0, raw.length - parentIdf.length - 1);
            if (own) return own;
        }
        return raw;
    }

    /**
     * Resolves a recorded action target (the ids the attribution store kept)
     * into display fields for the performed row: `{ id, name, componentId,
     * componentName }`, or null when the action had no entity/component target
     * (spatial actions) or nothing is usable.
     *
     * Names are resolved HERE, at flush time, against the current world — they
     * are never stored: the attribution store keeps ids only, so a renamed
     * entity/component always renders with its current name, and a destroyed
     * target degrades to ids (or null) instead of stale text. The target
     * entity is preferred from this room's snapshot (a punched target is
     * same-room by the action's range gate); the live facade is the fallback
     * for the rare cross-room / already-moved case. The hit component's name
     * comes from the shared ComponentNaming source — the same recipe table the
     * combat log phrases use — so the row and the log never disagree.
     *
     * @private
     * @param {{entityId?: string|null, componentId?: string|null}|null|undefined} target - the store record's target (ids only)
     * @param {import('../../utils/DeltaDiff.js').RoomSnapshot} current - the room snapshot just read
     * @returns {{id: string|null, name: string|null, componentId: string|null, componentName: string|null}|null}
     */
    _resolvePerceivedTarget(target, current) {
        if (!target || (target.entityId == null && target.componentId == null)) return null;
        const out = {
            id: typeof target.entityId === 'string' ? target.entityId : null,
            name: null,
            componentId: typeof target.componentId === 'string' ? target.componentId : null,
            componentName: null
        };
        if (out.id) {
            const live = current?.entities?.[out.id] ?? this._facade?.getEntity?.(out.id) ?? null;
            const name = live?.name;
            out.name = typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
        }
        if (out.componentId) {
            const comp = current?.entities?.[out.id]?.components?.[out.componentId]
                ?? this._facade?.getComponent?.(out.componentId)
                ?? null;
            out.componentName = componentTypeName(comp?.type ?? null);
        }
        if (out.id == null && out.componentId == null) return null;
        return out;
    }

    _currentTick() {
        return this._facade?.tickSystem?.currentTick ?? 0;
    }

    /**
     * The live round number as seen by the turn system — stamped onto each
     * perception entry so the entry *belongs* to a round. The UI needs this so
     * an old room-delta renders its own round instead of the viewer's current
     * round. Returns `undefined` when the turn system is not wired (e.g. bare-
     * mock facades), so the client can fall back to the passed round.
     * @private
     * @returns {number|undefined}
     */
    _currentRound() {
        try {
            const turns = this._facade?.subControllers?.turns ?? this._facade?.turns;
            const round = turns?.getRoundState?.()?.roundNumber;
            return Number.isFinite(round) ? round : undefined;
        } catch {
            return undefined;
        }
    }

    _roomName(roomId) {
        // Rooms are stored keyed by their UID (getAll() returns that map), so
        // the key IS the roomId — no find by .uid needed.
        const room = this._facade?.getRooms?.()[roomId] ?? {};
        return room?.name ?? roomId;
    }

    // --------------------------------------------------------------------------
    // Item display-name resolution. Delta rows carry only the item *type* key;
    // the human *name* is looked up from the item registry. Pure, additive:
    // these never change counts or the diff classification, only add a `name`.
    // --------------------------------------------------------------------------

    /**
     * Adds a display `name` (resolved from the item registry) to every item and
     * dropped-item delta row so the perception surface can show the human item
     * name rather than only the type key. Rows without a type get no name.
     * Pure: adds a `name` field to rows; never touches counts or classification.
     *
     * @private
     * @param {object} entry
     */
    _enrichItemNames(entry) {
        if (!entry || typeof entry !== 'object') return;
        // Resolve the human display name for each item-type row, AND the display
        // name of the agent involved with it (see _resolveActorName). Both are
        // server-side lookups (item registry + entity snapshot) so the client
        // renders human names without resolving them itself. Additive only: never
        // changes counts or the diff classification.
        const setName = (rows) => {
            for (const row of rows ?? []) {
                if (row && typeof row === 'object') {
                    // items/dropped rows carry the type in `type`; equipped rows
                    // use `itemType` — both are the item type key the registry
                    // is keyed by.
                    row.name = this._itemDisplayName(row.type ?? row.itemType);
                }
            }
        };
        const setActor = (rows, idField) => {
            for (const row of rows ?? []) {
                if (row && typeof row === 'object') {
                    row.actor = this._resolveActor(row[idField]);
                }
            }
        };
        const items = entry.items ?? {};
        const dropped = entry.dropped ?? {};
        const equipped = entry.equipped ?? {};
        setName(items.added);
        setName(items.removed);
        setName(dropped.added);
        setName(dropped.removed);
        setName(dropped.moved);
        setName(equipped.added);
        setName(equipped.removed);
        // Which field points at the agent involved differs by category: held and
        // equipped rows name their host `entity`; dropped rows name their
        // `ownerId`. When the agent is unknown/unresolvable, `actor` stays null
        // and the client omits the attribution.
        setActor(items.added, 'entity');
        setActor(items.removed, 'entity');
        setActor(dropped.added, 'ownerId');
        setActor(dropped.removed, 'ownerId');
        setActor(dropped.moved, 'ownerId');
        setActor(equipped.added, 'entity');
        setActor(equipped.removed, 'entity');
        // Position at the moment of the drop: a freshly added floor item
        // (dropped.added) has been at its drop point since the drop, so the
        // dropper's position "at the moment of the drop" is the drop point
        // (row.x / row.y), not the owner's *current* spatial (which may have
        // moved on since). Only dropped.added rows get this override; non-drop
        // rows keep the owner's current position. If the owner is missing (no
        // actor) the row simply shows no attribution. We never write non-finite
        // coordinates. Only additive (does not change counts or the diff).
        for (const row of dropped.added ?? []) {
            const a = row?.actor;
            if (a && Number.isFinite(row.x) && Number.isFinite(row.y)) {
                a.x = row.x;
                a.y = row.y;
            }
        }
    }

    /**
     * Resolves the agent involved with a delta row (the one who dropped / removed /
     * equipped an item): display name, id, and current floor position. Resolved
     * from the current-tick entity snapshot (getEntities() clones, all rooms).
     * Returns `null` when the id is missing or the entity isn't resolvable — the
     * client then renders no attribution.
     *
     * @private
     * @param {string|null} actorId
     * @returns {{id: string, name: string, x: number|null, y: number|null}|null}
     */
    _resolveActor(actorId) {
        if (!actorId || actorId === 'unknown') return null;
        for (const e of this._snapshotCache?.entities ?? []) {
            if (e?.id === actorId) {
                const spatial = e?.spatial ?? {};
                return {
                    id: actorId,
                    name: e.name ?? actorId,
                    x: spatial.x == null ? null : spatial.x,
                    y: spatial.y == null ? null : spatial.y
                };
            }
        }
        return null;
    }

    /**
     * Display name for an item *type* key (e.g. `knife` → `Knife`), resolved
     * from the cached item registry (type → definition). Returns `null` for an
     * unknown or empty type — the caller then falls back to the type key.
     *
     * @private
     * @param {string|null} type - item type key from a delta row
     * @returns {string|null}
     */
    _itemDisplayName(type) {
        if (type == null || type === '') return null;
        const def = (this._itemRegistry ?? this._buildItemRegistry())[type];
        return def ? (def.name ?? null) : null;
    }

    /**
     * Builds (once) and caches a type → item-definition map from the facade's
     * registry (`getItemRegistry()` returns a fresh deep copy per call). The
     * registry is static (loaded from the item json at build time), so a single
     * cached copy is safe to reuse. Returns `{}` when the facade is absent.
     *
     * @private
     * @returns {object}
     */
    _buildItemRegistry() {
        const registry = (this._facade?.getItemRegistry?.() ?? {}) || {};
        // Only cache a non-empty registry, so a not-yet-ready facade simply
        // re-queries (cheap) rather than freezing an empty map.
        if (Object.keys(registry).length > 0) {
            this._itemRegistry = registry;
        }
        return registry;
    }

    _knownRooms() {
        const rooms = new Set();
        const facadeRooms = this._facade?.getRooms?.() ?? {};
        for (const roomId of Object.keys(facadeRooms)) rooms.add(roomId);
        for (const roomId of this._lastSeen.keys()) rooms.add(roomId);
        for (const roomId of this._dirty.keys()) rooms.add(roomId);
        for (const roomId of this._buffers.keys()) rooms.add(roomId);
        return rooms;
    }

    _bufferFor(roomId) {
        const buffer = this._buffers.get(roomId);
        if (buffer) return buffer;
        const newBuffer = new EventRingBuffer(PERCEPTION_MAX_LIMIT);
        this._buffers.set(roomId, newBuffer);
        return newBuffer;
    }
}

export default PerceptionController;
