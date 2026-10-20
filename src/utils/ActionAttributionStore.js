/**
 * ActionAttributionStore — a generic, action-agnostic per-entity store that
 * records, for every action executed on an entity, *which components powered it*
 * and *how many*.
 *
 * Reusability / separation of concerns:
 *   - This module knows nothing about specific actions, component types, or the
 *     world. It is a pure (entity, action) → attribution record store.
 *   - It is written from exactly ONE choke point (the consequence dispatcher, which
 *     every successful action passes through) and read by any consumer —
 *     perception ("which components powered the change I observed?"), logging,
 *     or a future API — for the SAME action.
 *
 * Keying: (entityId, actionName) → the *most recent* attribution record for that
 * action on that entity. Overwrites are intentional: a new execution of the same
 * action on the same entity supersedes the older one (perception cares about the
 * latest observation, not history).
 *
 * @module ActionAttributionStore
 */

/**
 * The payload passed to `record()` (produced by the recording choke point).
 *
 * @typedef {Object} AttributionPayload
 * @property {string|null} [primary] - The gate component id (the "best" per the
 *   first requirement, or the explicitly chosen attacker).
 * @property {string[]} [ids] - The components that ACTUALLY powered the action.
 *   Resolution at the recording choke point: (1) the caller's explicit
 *   designations for the action (SOURCE-role components — if N were named, N
 *   were used); (2) otherwise the resolver's *selected* fulfillers (one "best"
 *   per requirement, deduped across requirements). Components that merely
 *   satisfied a requirement without being named/selected are NOT part of this
 *   set — they live in `fulfillment` as metadata. This is the "which
 *   components were used" answer.
 * @property {Object<string, {best?: string, ids: string[]}?>} [fulfillment] -
 *   Per-requirement breakdown (`Trait.stat` → `{ best, ids }`). `best` is the
 *   component selected to power that requirement (e.g. the best mover for
 *   `Movement.move` — the one whose stats the action consumed); `ids` is every
 *   component that satisfied the requirement, in most-capable order (eligible,
 *   not necessarily used — e.g. all four legs of a droid during a move).
 *   Metadata only: never claimed as the "used" set.
 * @property {Object?} requirementValues
 * @property {number} timestamp - Monotonic write timestamp (ms); drives "most
 *   recent" when `get(entityId)` is called without an action name.
 */

/**
 * A generic, action-agnostic per-entity store of action attributions.
 *
 * @example
 *   const store = new ActionAttributionStore();
 *   // A four-leg droid moves: the resolver selected ONE leg (the best mover);
 *   // the other three merely satisfy the requirement and stay in `fulfillment`.
 *   store.record('ent-1', 'move', {
 *     primary: 'comp-leg1',
 *     ids: ['comp-leg1'],
 *     fulfillment: {
 *       'Movement.move': { best: 'comp-leg1', ids: ['comp-leg1', 'comp-leg2', 'comp-leg3', 'comp-leg4'] }
 *     },
 *     tick: 42
 *   });
 *   store.get('ent-1', 'move');     // → { ids: [the used legs], count, primary, ... }
 *   store.getCount('ent-1', 'move'); // → number of used legs
 */
export default class ActionAttributionStore {
    /**
     * Initializes the store with no attributions. No external dependencies.
     */
    constructor() {
        /** @type {import('util').Map<string, import('util').Map<string, AttributionRecord>>} */
        this._store = new Map();
    }

    /**
     * Records (or overwrites) the attribution for `actionName` on `entityId`.
     * `ids` is normalized to a deduplicated, null-free string array (order
     * preserved) and `count` is derived.
     *
     * @param {string} entityId - The entity the action was executed on.
     * @param {string} actionName - The action name (registry name).
     * @param {AttributionPayload} payload - The attribution payload.
     * @returns {AttributionRecord|null} The normalized record, or `null` when
     *   the entity/action ids are invalid (kept null-safe so bare callers can
     *   pass partially-populated payloads without crashing).
     */
    record(entityId, actionName, payload) {
        if (!entityId || typeof entityId !== 'string' || !actionName || typeof actionName !== 'string') {
            return null;
        }
        const perEntity = this._store.get(entityId) ?? new Map();
        const ids = this._normalizeIds(payload?.ids);
        const record = {
            actionName,
            tick: payload?.tick ?? null,
            primary: payload?.primary ?? null,
            ids,
            count: ids.length,
            fulfillment: payload?.fulfillment ?? null,
            requirementValues: payload?.requirementValues ?? null,
            timestamp: Date.now(),
        };
        perEntity.set(actionName, record);
        this._store.set(entityId, perEntity);
        return record;
    }

    /**
     * Returns the most recent attribution for `entityId` and the given
     * `actionName`.
     *
     * When `actionName` is omitted, returns the most recently *written* record
     * across all actions on that entity (by `timestamp`; on a tie, the last one
     * iterated — deterministic within a single map).
     *
     * @param {string} entityId
     * @param {string} [actionName] - Optional; narrows to that action.
     * @returns {AttributionRecord|null}
     */
    get(entityId, actionName) {
        if (!entityId || typeof entityId !== 'string') return null;
        const perEntity = this._store.get(entityId);
        if (!perEntity) return null;
        if (actionName != null) {
            return perEntity.get(actionName) ?? null;
        }
        let newest = null;
        for (const record of perEntity.values()) {
            if (newest === null || record.timestamp > newest.timestamp) {
                newest = record;
            }
        }
        return newest;
    }

    /**
     * Returns the component ids that powered `actionName` on `entityId` (an
     * empty array when there is no attribution yet).
     *
     * @param {string} entityId
     * @param {string} [actionName]
     * @returns {string[]}
     */
    getIds(entityId, actionName) {
        const record = this.get(entityId, actionName);
        return record?.ids ?? [];
    }

    /**
     * Returns the *most recent* attribution record for every distinct action
     * `entityId` has performed, as a shallow copy of the internal
     * action-name → record map, or `null` when the entity has no recorded
     * actions yet.
     *
     * This is the enumeration seam for readers that need "what did this
     * entity do?" (perception's performed-action rows): the store keeps at
     * most one record per (entity, action), so the map IS the most-recent
     * execution of each distinct action — exactly the window a perception
     * flush needs, with no history storage.
     *
     * The returned map is a copy (mutating it never touches the store); the
     * record objects it contains are the live records (treated as read-only
     * after `record()`).
     *
     * @param {string} entityId
     * @returns {Map<string, AttributionRecord>|null}
     */
    listFor(entityId) {
        if (!entityId || typeof entityId !== 'string') return null;
        const perEntity = this._store.get(entityId);
        if (!perEntity) return null;
        return new Map(perEntity);
    }

    /**
     * Returns the number of components that powered `actionName` on `entityId`
     * (0 when there is no attribution yet). The "how many" one-liner.
     *
     * @param {string} entityId
     * @param {string} [actionName]
     * @returns {number}
     */
    getCount(entityId, actionName) {
        const record = this.get(entityId, actionName);
        return record?.count ?? 0;
    }

    /**
     * Removes every attribution for one entity (call on despawn / for test
     * isolation so a stale entity never leaks memory).
     *
     * @param {string} entityId
     * @returns {boolean} true when the entry existed and was removed.
     */
    clear(entityId) {
        return this._store.delete(entityId);
    }

    /**
     * Drops all attributions (call when a world is reset or a test needs a clean
     * slate).
     *
     * @returns {void}
     */
    reset() {
        this._store.clear();
    }

    /**
     * Normalizes an ids payload to a deduplicated, null/undefined-free string
     * array, preserving first-seen order.
     *
     * @param {Array<string|number|null|undefined>|null|undefined} [ids]
     * @returns {string[]}
     */
    _normalizeIds(ids) {
        if (!Array.isArray(ids)) return [];
        const seen = new Set();
        const out = [];
        for (const id of ids) {
            if (id == null) continue;
            const s = String(id);
            if (s === '' || seen.has(s)) continue;
            seen.add(s);
            out.push(s);
        }
        return out;
    }
}
