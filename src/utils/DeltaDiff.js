/**
 * DeltaDiff — pure comparison of two room perception snapshots.
 *
 * **Why a pure utility (not a controller):** the comparison has no world
 * access, no state and no side effects. Keeping it in a util module makes it
 * trivially testable and independent of the controller lifecycle; the
 * PerceptionController decides *when* to compare (dirty → lazy flush), this
 * module only decides *what* changed.
 *
 * **Why room-scoped snapshots:** an observer's attention is room-scoped
 * (same-room perception is a first-class concept in this project — the LLM
 * agent only "sees" its own room in the context, wiki/subMDs/systems/perception_system.md).
 * Diffing one room at a time keeps the operation bounded and the ring buffers
 * separable per room.
 *
 * **What a snapshot is (perception contract):** a frozen description of a room's
 * *current* content — entities and, per entity: stats, component stats, items
 * by host component, internal components, equipped items — plus dropped items
 * in the room. Everything else (rooms metadata, actions, turns) is either
 * static or already covered by the "YOUR STATE / NEARBY" context sections,
 * so it is intentionally NOT part of the diff surface.
 *
 * @module DeltaDiff
 */

import { TRAIT_GROUPS, STAT_NAMES } from '../../shared/StatVocabulary.js';
import { truncateCoord } from '../../shared/CoordFormat.js';

/**
 * Shape of a perception snapshot (internal to PerceptionController + this module).
 *
 * @typedef {Object} RoomSnapshot
 * @property {string} roomId
 * @property {number} tick
 * @property {Object<string, SnapshotEntity>} entities
 * @property {Object<string, SnapshotItem>} dropped
 *
 * @typedef {Object} SnapshotEntity
 * @property {string} name
 * @property {string} blueprint
 * @property {string} status
 * @property {string} location
 * @property {{ x: number, y: number }|null} spatial
 * @property {Object<string, Object<string, number>>} attributes   — per entity
 * @property {Object<string, { type: string, stats: Object<string, Object<string, number>> }>} components
 * @property {Object<string, Object<string, { type: string }>>} items       — hostComponentId → itemId → { type }
 * @property {Object<string, { type: string }>} internal
 * @property {Object<string, { itemType: string }>} equipped
 *
 * @typedef {Object} SnapshotItem
 * @property {string} type
 * @property {number|null} x
 * @property {number|null} y
 */

/**
 * The minimal subset of a delta entry needed to answer "did anything change?".
 * A delta with zero counts and no category rows is considered *empty*: the
 * perception system treats it as no-op (no ring buffer entry pushed), because
 * a flush can legitimately find nothing new (e.g. a dirty mark that was
 * resolved by another change already absorbed into the last-seen snapshot).
 *
 * @param {Object} delta
 * @returns {boolean}
 */
export function hasDeltaChanges(delta) {
    if (!delta || typeof delta !== 'object') return false;

    // A baseline: the initial "what is here" — any entity or dropped item that
    // is present is content worth reporting. (An empty room => nothing to push.)
    if (delta.kind === 'baseline') {
        return (delta.entities?.appeared ?? []).length > 0 || (delta.dropped?.added ?? []).length > 0;
    }

    // A delta: a category row array is the source of truth (see module header:
    // "zero counts and no category rows is considered empty"). `counts.total`
    // is checked first for speed; the row checks are a defensive second gate so
    // a malformed entry with a nonzero-but-wrong count is never pushed.
    if ((delta.counts?.total ?? 0) > 0) return true;
    return (
        (delta.entities?.appeared ?? []).length > 0 ||
        (delta.entities?.despawned ?? []).length > 0 ||
        (delta.entities?.moved ?? []).length > 0 ||
        (delta.entities?.statChanges ?? []).length > 0 ||
        (delta.actions?.performed ?? []).length > 0 ||
        (delta.items?.added ?? []).length > 0 ||
        (delta.items?.removed ?? []).length > 0 ||
        (delta.dropped?.added ?? []).length > 0 ||
        (delta.dropped?.removed ?? []).length > 0 ||
        (delta.dropped?.moved ?? []).length > 0 ||
        (delta.components?.added ?? []).length > 0 ||
        (delta.components?.removed ?? []).length > 0 ||
        (delta.components?.changed ?? []).length > 0 ||
        (delta.equipped?.added ?? []).length > 0 ||
        (delta.equipped?.removed ?? []).length > 0 ||
        (delta.internal?.added ?? []).length > 0 ||
        (delta.internal?.removed ?? []).length > 0
    );
}

/**
 * Flattens one entity's `attributes` into `{ [traitId]: { [statName]: number } }`
 * or an empty object when there is nothing to compare.
 */
function flattenAttributes(attributes) {
    const out = {};
    if (!attributes || typeof attributes !== 'object') return out;
    for (const [traitId, group] of Object.entries(attributes)) {
        out[traitId] = {};
        for (const [statName, value] of Object.entries(group ?? {})) {
            if (typeof value === 'number') out[traitId][statName] = value;
        }
    }
    return out;
}

/**
 * Collects entity-level changes between two snapshots.
 * An entity is classified as *moved* when its room or its spatial coordinates
 * changed (room change takes precedence, since it is a coarser, higher-signal
 * movement); *stat changes* are reported per attribute slot (traitId.statName),
 * which covers both whole-entity attributes and per-component stats — both are
 * stored in the snapshot as numeric values and compared with `!==`, so a
 * 0 → 0 or 100 → 100 write is never reported (defensive: callers pass no-ops
 * through the same seam, e.g. clamped drains).
 *
 * @param {{ [id]: RoomSnapshot['entities'][string] }} prevEntities
 * @param {{ [id]: RoomSnapshot['entities'][string] }} nextEntities
 * @returns {{ appeared: Array, despawned: Array, moved: Array, statChanges: Array }}
 */
function diffEntities(prevEntities, nextEntities, attributionResolver = null) {
    const appeared = [];
    const despawned = [];
    const moved = [];
    const statChanges = [];
    const allIds = new Set([...Object.keys(prevEntities ?? {}), ...Object.keys(nextEntities ?? {})]);
    for (const id of allIds) {
        const prev = prevEntities?.[id];
        const next = nextEntities?.[id];
        if (!prev && next) {
            appeared.push({ id, name: next.name ?? id, blueprint: next.blueprint ?? null });
            continue;
        }
        if (prev && !next) {
            despawned.push({ id, name: prev.name ?? id });
            continue;
        }
        if (!prev || !next) continue; // never expected — defensive
        const prevLocation = prev.location ?? null;
        const nextLocation = next.location ?? null;
        // A move: a room change (coarser, higher-signal) and/or a spatial
        // reposition that is VISIBLE at the display resolution (0.01 — the
        // "00.00" rule, shared/CoordFormat.js). The comparison uses the same
        // truncation as the display, so a moved row can never claim what it
        // cannot show: a strict float `!==` would report sub-grid drift (e.g.
        // a ±1 ulp oscillation around a dash target) as a "move" whose
        // from/to coordinates print identically — "(35.85, -17.73) →
        // (35.85, -17.73)" — a move no observer could see, which fed back
        // into agent brains that re-dashed every round to "keep moving".
        // Credit the action that caused it (set on the entity as
        // `lastMoveAction` by the spatial consequence handler at move time —
        // the event log only carries free-text "turn" lines, which cannot be
        // matched back to an entity). Name the components that *powered the
        // action*: prefer the *recorded* generic attribution (ActionAttributionStore,
        // read through `attributionResolver` and keyed by `lastMoveAction.action`
        // — the authoritative "which & how many components executed action X" set,
        // independent of which consequence repositioned the entity), and only when
        // that set is absent/empty fall back to the heuristic `getLocomotionForMove`
        // (every component that grants a positive `Movement.move`). Room change and
        // spatial change are mutually reinforcing, so one entry covers both (the
        // two former branches pushed identical rows).
        const spatialChanged =
            truncateCoord(prev.spatial?.x) !== truncateCoord(next.spatial?.x) ||
            truncateCoord(prev.spatial?.y) !== truncateCoord(next.spatial?.y);
        if (prevLocation !== nextLocation || spatialChanged) {
            // Compute the move's attribution once, before the row, so the row carries
            // both the component list and its provenance. The resolver is the
            // generic ActionAttributionStore keyed by the action that last repositioned
            // this entity — the authoritative "which & how many powered action X".
            const { locomotion, attributionSource } = attributionResolver
                ? getAttributedLocomotion(next, id, attributionResolver)
                : { locomotion: getLocomotionForMove(next), attributionSource: 'heuristic' };
            moved.push({
                id,
                name: next.name ?? id,
                fromRoom: prevLocation,
                toRoom: nextLocation,
                fromXY: prev.spatial ?? null,
                toXY: next.spatial ?? null,
                action: next?.lastMoveAction?.action ?? null,
                // The components credited for the move. `attributionSource` is 'store'
                // when the generic ActionAttributionStore credited *exactly* these
                // components to the action (authoritative = "only the components
                // used"), and 'heuristic' when we fell back to the Movement.move
                // granters (best-effort guess — the UI labels it differently and never
                // claims "used to execute the action" from it).
                locomotion,
                attributionSource
            });
        }
        // Attribute slots: compare the flattened numeric maps.
        const prevAttrs = flattenAttributes(prev.attributes);
        const nextAttrs = flattenAttributes(next.attributes);
        const slotIds = new Set([...Object.keys(prevAttrs), ...Object.keys(nextAttrs)]);
        for (const traitId of slotIds) {
            const prevGroup = prevAttrs[traitId] ?? {};
            const nextGroup = nextAttrs[traitId] ?? {};
            const statIds = new Set([...Object.keys(prevGroup), ...Object.keys(nextGroup)]);
            for (const statName of statIds) {
                const from = prevGroup[statName];
                const to = nextGroup[statName];
                if (from === to) continue;
                statChanges.push({ id, name: next.name ?? id, traitId, statName, from: from ?? null, to: to ?? null });
            }
        }
    }
    return { appeared, despawned, moved, statChanges };
}

/**
 * Returns *every* locomotion component — all components on the entity that grant
 * a positive `Movement.move`. This is a pure **best-effort fallback** used only
 * when the shared store has no recorded attribution for the action (pre-store
 * history or a build without the store); it cannot distinguish which leg the
 * resolver actually selected, so the UI labels it as a guess and never claims
 * "used to execute the action" from it. Components without stats, or with a
 * missing/empty/non-positive `move` stat (purely non-kinetic), are skipped.
 *
 * @param {{ [id]: { name?: string, type?: string, id: string, stats?: object } }} next
 * @returns {{ type: string, id: string }[]|null} array of { type, id } for every
 *         component that grants Movement.move (snapshot order), or null when
 *         none does.
 */
function getLocomotionForMove(next) {
    const out = [];
    for (const comp of Object.values(next?.components ?? {})) {
        if (!comp || typeof comp !== 'object') continue;
        const group = comp?.stats?.[TRAIT_GROUPS.MOVEMENT];
        if (!group || typeof group !== 'object') continue;
        const move = group[STAT_NAMES.MOVE];
        if (typeof move !== 'number' || !Number.isFinite(move) || move <= 0) continue;
        out.push({ type: comp.type ?? comp.name ?? comp.id ?? '?', id: comp.id ?? null });
    }
    return out.length ? out : null;
}

/**
 * Resolves the components that powered an entity's move from the *recorded* generic
 * action attribution (action-agnostic) rather than re-deriving it from the
 * Movement trait. This is what makes the perception "which & how many components
 * executed action X" reusable for ANY action: the diff reads the authoritative
 * set from the shared store, keyed by the action that last repositioned the
 * entity (`next.lastMoveAction.action`), and only falls back to the `Movement.move`
 * heuristic when that set is absent/empty.
 *
 * "Used" = the components the resolver SELECTED to power the action — the store
 * record's `ids` (one "best" per requirement, the one whose stats the action
 * consumed). Eligible-but-unused components (e.g. the other three legs of a
 * four-leg droid during a move) are NOT part of `ids`; they remain in the
 * record's `fulfillment` metadata. That's what the count (N) reflects: a move
 * that used one leg credits exactly one leg.
 *
 * @param {{ [id]: { name?: string, type?: string, id: string, components?: object } }} next
 * @param {string} entityId
 * @param {(entityId: string, actionName: string) => ({ids?: string[]}|null)|null} attributionResolver
 * @returns {{ locomotion: { type: string, id: string }[]|null, attributionSource: 'store'|'heuristic' }}
 *   `{ locomotion, attributionSource }`: `locomotion` is the *used* component list
 *   (the selected fulfillers recorded in the store) and `attributionSource` tags
 *   the provenance so the UI can label it honestly ("used to execute" only when
 *   sourced from the store).
 */
function getAttributedLocomotion(next, entityId, attributionResolver) {
    const moveAction = next?.lastMoveAction?.action;
    if (moveAction && typeof moveAction === 'string') {
        const record = attributionResolver(entityId, moveAction);
        // The components that powered the move = the resolver's SELECTED
        // fulfillers recorded by the dispatcher (one "best" per requirement —
        // for a `move`, exactly the leg whose stats drove it, never the other
        // eligible legs).
        const ids = record && Array.isArray(record.ids) ? record.ids : [];
        if (ids.length > 0) {
            const components = next?.components ?? {};
            const out = ids
                .map((cid) => {
                    const comp = components[cid];
                    return {
                        type: comp?.type ?? comp?.name ?? String(cid),
                        id: String(cid)
                    };
                })
                .filter(Boolean);
            if (out.length > 0) {
                return { locomotion: out, attributionSource: 'store' };
            }
        }
    }
    // No store-sourced set (non-action reposition, or a record with no ids / a
    // build without the store): fall back to the Movement.move granters — a
    // best-effort guess, flagged so the UI never claims "used to execute".
    return { locomotion: getLocomotionForMove(next), attributionSource: 'heuristic' };
}

/**
 * Diff component-level entries (by component id). Components that exist in one
 * snapshot but not the other are reported under `removed`/`added` respectively;
 * present in both compare their numeric stats slot-by-slot, with the same
 * `!==` rule as attributes (unchanged slots are never reported).
 */
function diffComponents(prevEntities, nextEntities) {
    const added = [];
    const removed = [];
    const changed = [];
    const allIds = new Set([...Object.keys(prevEntities ?? {}), ...Object.keys(nextEntities ?? {})]);
    for (const entityId of allIds) {
        const prevEntity = prevEntities?.[entityId];
        const nextEntity = nextEntities?.[entityId];
        if (!prevEntity && !nextEntity) continue;
        const prevComps = prevEntity?.components ?? {};
        const nextComps = nextEntity?.components ?? {};
        const compIds = new Set([...Object.keys(prevComps), ...Object.keys(nextComps)]);
        for (const compId of compIds) {
            const prevComp = prevComps[compId];
            const nextComp = nextComps[compId];
            if (!prevComp && nextComp) {
                added.push({ componentId: compId, type: nextComp.type, entity: entityId });
            } else if (prevComp && !nextComp) {
                removed.push({ componentId: compId, type: prevComp.type, entity: entityId });
            } else if (prevComp && nextComp) {
                const prevStats = flattenAttributes(prevComp.stats);
                const nextStats = flattenAttributes(nextComp.stats);
                const slotIds = new Set([...Object.keys(prevStats), ...Object.keys(nextStats)]);
                for (const traitId of slotIds) {
                    const prevGroup = prevStats[traitId] ?? {};
                    const nextGroup = nextStats[traitId] ?? {};
                    const statIds = new Set([...Object.keys(prevGroup), ...Object.keys(nextGroup)]);
                    for (const statName of statIds) {
                        const from = prevGroup[statName];
                        const to = nextGroup[statName];
                        if (from === to) continue;
                        changed.push({ componentId: compId, type: nextComp.type ?? prevComp.type, entity: entityId, traitId, statName, from: from ?? null, to: to ?? null });
                    }
                }
            }
        }
    }
    return { added, removed, changed };
}

/**
 * Diff items stored on entities. The snapshot groups items by host component
 * (`entityId.hostComponentId.itemId`), so a move between two components of the
 * same entity is reported as one removal + one addition in the two components —
 * intentional: the observer's question is "which component now holds which
 * item", not a change-log reconstruction.
 */
function diffEntityItems(prevEntities, nextEntities) {
    const added = [];
    const removed = [];
    const entityIds = new Set([...Object.keys(prevEntities ?? {}), ...Object.keys(nextEntities ?? {})]);
    for (const entityId of entityIds) {
        const prevItems = prevEntities?.[entityId]?.items ?? {};
        const nextItems = nextEntities?.[entityId]?.items ?? {};
        const hostIds = new Set([...Object.keys(prevItems), ...Object.keys(nextItems)]);
        for (const hostComponentId of hostIds) {
            const prevHost = prevItems[hostComponentId] ?? {};
            const nextHost = nextItems[hostComponentId] ?? {};
            const itemIds = new Set([...Object.keys(prevHost), ...Object.keys(nextHost)]);
            for (const itemId of itemIds) {
                const prevItem = prevHost[itemId];
                const nextItem = nextHost[itemId];
                if (!prevItem && nextItem) {
                    added.push({ itemId, type: nextItem.type ?? null, entity: entityId, hostComponent: hostComponentId });
                } else if (prevItem && !nextItem) {
                    removed.push({ itemId, type: prevItem.type ?? null, entity: entityId, hostComponent: hostComponentId });
                }
            }
        }
    }
    return { added, removed };
}

/**
 * Diff items dropped on the floor of the room (by dropped-item id, keyed in the
 * snapshot map). Position changes are reported as a moved entry.
 */
function diffDroppedItems(prevDropped, nextDropped) {
    const added = [];
    const removed = [];
    const moved = [];
    const allIds = new Set([...Object.keys(prevDropped ?? {}), ...Object.keys(nextDropped ?? {})]);
    for (const itemId of allIds) {
        const prev = prevDropped?.[itemId];
        const next = nextDropped?.[itemId];
        if (!prev && next) {
            added.push({ itemId, type: next.type ?? null, x: next.x ?? null, y: next.y ?? null, ownerId: next.ownerId ?? null });
        } else if (prev && !next) {
            removed.push({ itemId, type: prev.type ?? null, ownerId: prev.ownerId ?? null });
        } else if (prev && next) {
            // Same perceptual rule as entities (see §8.1): a dropped item that
            // drifted by less than one display step (0.01) shows identical
            // from/to coordinates and is not a visible move.
            const xMoved = truncateCoord(prev.x) !== truncateCoord(next.x);
            const yMoved = truncateCoord(prev.y) !== truncateCoord(next.y);
            const typeMoved = prev.type !== next.type;
            if (xMoved || yMoved || typeMoved) {
                moved.push({ itemId, type: next.type ?? null, fromXY: { x: prev.x ?? null, y: prev.y ?? null }, toXY: { x: next.x ?? null, y: next.y ?? null }, ownerId: next.ownerId ?? null });
            }
        }
    }
    return { added, removed, moved };
}

/**
 * Diff internal components and equipped items per entity. Both are keyed maps
 * (internal component id / equipped id) with a single identifying field; an
 * add/remove in the key set is the only change possible, so this is a key-set
 * diff.
 */
function diffPerEntityMaps(prevEntities, nextEntities, field, label) {
    const added = [];
    const removed = [];
    const entityIds = new Set([...Object.keys(prevEntities ?? {}), ...Object.keys(nextEntities ?? {})]);
    for (const entityId of entityIds) {
        const prevMap = prevEntities?.[entityId]?.[label] ?? {};
        const nextMap = nextEntities?.[entityId]?.[label] ?? {};
        const allKeys = new Set([...Object.keys(prevMap), ...Object.keys(nextMap)]);
        for (const key of allKeys) {
            if (!prevMap[key] && nextMap[key]) {
                added.push({ id: key, [field]: nextMap[key][field] ?? null, entity: entityId });
            } else if (prevMap[key] && !nextMap[key]) {
                removed.push({ id: key, [field]: prevMap[key][field] ?? null, entity: entityId });
            }
        }
    }
    return { added, removed };
}

/**
 * Builds the baseline entry — the first thing an observer learns about a room.
 * A baseline is not a "change" in the usual sense, but it answers the same
 * question ("what do you see in this room?") and without it an agent could
 * only perceive *relative* changes from a room it never actually observed,
 * which would make a brand-new room indistinguishable from an unchanged one.
 * The baseline snapshot becomes the last-seen reference, so the next entry
 * is a normal diff.
 */
export function buildBaselineEntry(snapshot, tick, roomId) {
    const entities = snapshot.entities ?? {};
    const dropped = snapshot.dropped ?? {};
    const allEntities = Object.keys(entities);
    const allDropped = Object.keys(dropped);
    return {
        tick,
        sinceTick: tick,
        ts: Date.now(),
        roomId,
        kind: 'baseline',
        // A baseline *is* a change: on first observation everything that is
        // already there has "appeared". `total` mirrors the sum of the change
        // lists (entities + dropped) so hasDeltaChanges() keeps it; an empty
        // room yields total === 0 and is simply not pushed (nothing to report).
        counts: {
            total: allEntities.length + allDropped.length,
            entities: allEntities.length,
            dropped: allDropped.length,
            items: 0,
            components: 0,
            internal: 0,
            equipped: 0,
            // Baselines carry no performed-action rows (an initial observation
            // is not an action window); the key exists for a stable schema.
            actions: 0
        },
        summary: null, // filled by DeltaSummaryBuilder
        actions: { performed: [] },
        entities: { appeared: allEntities.map((id) => ({ id, name: entities[id]?.name ?? id })), despawned: [], moved: [], statChanges: [] },
        items: { added: [], removed: [] },
        // Initial dropped items are reported as "added" (they appeared relative
        // to the empty previous state), matching the delta schema exactly.
        dropped: {
            added: allDropped.map((itemId) => ({ itemId, type: dropped[itemId]?.type ?? null, x: dropped[itemId]?.x ?? null, y: dropped[itemId]?.y ?? null })),
            removed: [],
            moved: []
        },
        components: { added: [], removed: [], changed: [] },
        equipped: { added: [], removed: [] },
        internal: { added: [], removed: [] }
    };
}

/**
 * Compares two room snapshots and returns a *delta* entry describing every
 * difference between them, classified into the categories an observer cares
 * about (see module header). The comparison is intentionally *total* per room:
 * a deep diff, not a list of events — the caller (PerceptionController) feeds
 * it the frozen last-seen snapshot and the freshly-read current snapshot, so
 * the diff is always "everything that changed while nobody was looking",
 * which is exactly what the perception surface promises.
 *
 * @param {RoomSnapshot} prev - last-seen snapshot
 * @param {RoomSnapshot} next - freshly-read snapshot
 * @param {number} tick - world tick of the latest dirty mark that triggered this flush
 * @param {string} roomId
 * @param {(entityId: string, actionName: string) => ({ids?: string[]}|null)|null} [attributionResolver]
 *   Optional resolver of the *recorded* generic action attribution (action-
 *   agnostic) for the action that last repositioned a moved entity. When provided,
 *   the `locomotion` on `entities.moved` rows is derived from it (the authoritative
 *   "which components powered action X" set) and falls back to the `Movement.move`
 *   heuristic only when it yields no component ids. When omitted, behaviour is
 *   identical to before (pure heuristic locomotion).
 * @returns {{ tick: number, sinceTick: number, ts: number, roomId: string, kind: 'delta', counts: { total: number }, summary: null, actions: { performed: Array }, entities: Object, items: Object, dropped: Object, components: Object, equipped: Object, internal: Object }}
 */
export function diffRoomSnapshots(prev, next, tick, roomId, attributionResolver = null) {
    const prevEntities = prev?.entities ?? {};
    const nextEntities = next?.entities ?? {};
    const entityChanges = diffEntities(prevEntities, nextEntities, attributionResolver);
    const componentChanges = diffComponents(prevEntities, nextEntities);
    const itemChanges = diffEntityItems(prevEntities, nextEntities);
    const droppedChanges = diffDroppedItems(prev?.dropped ?? {}, next?.dropped ?? {});
    const internalChanges = diffPerEntityMaps(prevEntities, nextEntities, 'type', 'internal');
    const equippedChanges = diffPerEntityMaps(prevEntities, nextEntities, 'itemType', 'equipped');
    const total =
        entityChanges.appeared.length +
        entityChanges.despawned.length +
        entityChanges.moved.length +
        entityChanges.statChanges.length +
        componentChanges.changed.length +
        componentChanges.added.length +
        componentChanges.removed.length +
        itemChanges.added.length +
        itemChanges.removed.length +
        droppedChanges.added.length +
        droppedChanges.removed.length +
        droppedChanges.moved.length +
        internalChanges.added.length +
        internalChanges.removed.length +
        equippedChanges.added.length +
        equippedChanges.removed.length;
    return {
        tick,
        sinceTick: prev?.tick ?? tick,
        ts: Date.now(),
        roomId,
        kind: 'delta',
        counts: {
            total,
            entities: entityChanges.appeared.length + entityChanges.despawned.length + entityChanges.moved.length + entityChanges.statChanges.length,
            items: itemChanges.added.length + itemChanges.removed.length,
            dropped: droppedChanges.added.length + droppedChanges.removed.length + droppedChanges.moved.length,
            components: componentChanges.added.length + componentChanges.removed.length + componentChanges.changed.length,
            internal: internalChanges.added.length + internalChanges.removed.length,
            equipped: equippedChanges.added.length + equippedChanges.removed.length,
            // Intentionally NOT part of `total`: performed-action rows are
            // filled in later by the PerceptionController (it owns the
            // attribution store); the controller updates this count when it
            // does. hasDeltaChanges() checks the rows directly, so an
            // action-only flush (total === 0) still surfaces.
            actions: 0
        },
        summary: null, // filled by DeltaSummaryBuilder
        // Filled by the PerceptionController (_collectPerformedActions) from the
        // shared ActionAttributionStore: one row per distinct action the room's
        // entities performed since their last surfacing, each claiming *only*
        // the components recorded as used for that action.
        actions: { performed: [] },
        entities: {
            appeared: entityChanges.appeared,
            despawned: entityChanges.despawned,
            moved: entityChanges.moved,
            statChanges: entityChanges.statChanges
        },
        items: { added: itemChanges.added, removed: itemChanges.removed },
        dropped: { added: droppedChanges.added, removed: droppedChanges.removed, moved: droppedChanges.moved },
        components: { added: componentChanges.added, removed: componentChanges.removed, changed: componentChanges.changed },
        equipped: { added: equippedChanges.added, removed: equippedChanges.removed },
        internal: { added: internalChanges.added, removed: internalChanges.removed }
    };
}
