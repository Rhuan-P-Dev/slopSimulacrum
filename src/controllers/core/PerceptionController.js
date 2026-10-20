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
 * context section handles the baseline by rendering "initial observation".
 *
 * **Why per-agent cursors:** "since your last observation" is a *reader-relative*
 * time window, not a wall-clock one. Two readers (an NPC brain and the UI)
 * that start looking at the same room at different times need different
 * "since" points. The cursor advances when the *reader* confirms it looked
 * (recordAgentObservation), never when the world changed — so a reader that
 * sleeps between ticks still sees *everything* that changed while it was
 * asleep.
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
import { PERCEPTION_MAX_LIMIT, PERCEPTION_RECENT_LIMIT } from '../../utils/Constants.js';
import { diffRoomSnapshots, buildBaselineEntry, hasDeltaChanges } from '../../utils/DeltaDiff.js';
import { buildDeltaSummary } from '../../utils/DeltaSummary.js';

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
     * Confirms that the agent has now observed everything up to the current
     * sequence. Advances the agent cursor to the latest global `sequence`
     * (i.e. `stop reporting changes until I look again`). Called by
     * LlmContextController after it built the context so the cursor and the
     * rendered "WHAT CHANGED" section advance together.
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
     */
    _flushRoom(roomId) {
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
        entry.roundNumber = this._currentRound();
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

        return {
            roomId,
            tick: this._currentTick(),
            entities: byId,
            dropped
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
            lastMoveAction: entity?.lastMoveAction ?? null
        };
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
                    tick: record?.tick ?? null,
                    source: 'store'
                });
            }
            if (maxTs > seen) this._lastActionSeen.set(entityId, maxTs);
        }
        entry.actions = { performed };
        entry.counts.actions = performed.length;
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
