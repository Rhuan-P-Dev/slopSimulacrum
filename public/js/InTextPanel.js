// =============================================================================
// InTextPanel — always-visible text mirror of the player's world view.
// =============================================================================
//
// PURPOSE:
//   Render everything the player currently sees on the spatial map as plain
//   text, in a fixed column beside the map (a split screen). The spatial map
//   is the canonical visual view; this column exists so that the *same*
//   information is readable as text at a glance (and accessible without
//   scanning a geometry grid).
//
// ONE-WAY CONTRACT:
//   The panel reads `state` (rooms, entities, components, droppedItems, turns)
//   exactly the way the map does — via the same `refreshWorldAndActions()`
//   call with the same `state` snapshot and `droid` entity. It never mutates
//   state, sends no socket messages, and is not an overlay: it is a permanent
//   part of the main layout, not an on-demand window, so it
//   (a) is never targeted by the overlay keyboard protocol (no Esc / 1-4
//   conflict, no backdrop steal) and
//   (b) cannot desync from the map — both refresh from the same broadcast
//   with the same data.
//
// RENDERED SECTIONS (top → bottom):
//   1. Header row: server tick (`state.turns.currentTick`).
//   2. Room: name · position · size · description.
//   3. What Changed (perception, async): the room's recent delta entries —
//      "what changed since I last looked" (Feature G). Fetched from
//      GET /perception/:roomId into a dedicated sub-container; entity movers
//      are named in bullets, the other change types are a one-line summary.
//      First read is a `baseline` (initial contents) before deltas begin.
//   4. Doors: one line per exit — "door (x, y) → Target Room", where (x, y)
//      is the door's room-relative exit point (same math as the map renderer
//      and the server door-traversal spawn: client-server parity).
//   5. Droids: the room's non-static entities — position, display name, NPC
//      flag, "you" flag, components with existence.
//   6. Objects: static props (`isStatic` entities, e.g. the wooden tree).
//   7. Items: `state.droppedItems` filtered to the room.
//   8. Turn: round, phase, barrier status (ready count or close reason + tick),
//      initiative order — the same fields the Turn HUD reads.
//   9. Recent events: the unified world-event log (GET /world-events, tail up
//      to AppConfig.EVENTS.HISTORY_LIMIT, newest-first) with the room context
//      (room, size, your position, same-room others, items, exits) and warn
//      coloring — merged from the old Events tab.
//
// WHY A SINGLE innerHTML RENDER PASS (not per-section DOM surgery):
//   The map re-renders the whole canvas per frame; rebuilding one small text
//   tree per broadcast is the same one-way discipline. It also keeps the DOM
//   event model intact: nothing in the mirror is interactive (no clicks, no
//   focus, no keyboard), so there are no delegated listeners to wire up and
//   no click-vs-map hit-test conflict.
//
// WHY PURE PUBLIC FORMATTERS (format* returning strings):
//   Testable without a DOM (see test/unit/InTextPanel.client.test.js); the
//   render pass stays a trivial assembly of already-verified strings.
//
// =============================================================================

import { AppConfig } from './Config.js';
import { TURN_PHASES } from '../../shared/TurnPhases.js';
import ClientLogger from '/utils/ClientLogger.js';
import { getRoomEdgePoint } from '/utils/geometry.js';
import { formatPosition as formatPositionShared } from '../../shared/CoordFormat.js';


/**
 * How many recent perception (delta) entries the "What Changed" column renders.
 * A short tail — the reader cares about the freshest changes, not history.
 */
const PERCEPTION_LIMIT = 10;

export class InTextPanel {
    /**
     * @param {Object} [options]
     * @param {Function} [options.handleError] - Error sink (ClientApp wires the
     *   error controller). Errors are logged, never thrown into the render loop.
     * @param {Function} [options.getEntityId] - Returns the player's entity id
     *   (or null) so the player's droid can be marked as "YOU".
     * @param {string} [options.eventsSelector] - Selector of the events
     *   sub-container inside the column (default: '#in-text-events').
     */
    constructor(options = {}) {
        this.errorHandler = options.handleError ?? (() => {});
        this.getEntityId = options.getEntityId ?? (() => null);
        this.eventsSelector = options.eventsSelector ?? '#in-text-events';
        this.perceptionSelector = options.perceptionSelector ?? '#in-text-perception';
        this.container = null;
        this.content = null;
        this.tickEl = null;
    }

    /**
     * Grabs the column from the DOM. No-op (with a one-line warning) if any
     * slot is missing — a layout change must never crash world refresh.
     */
    init() {
        this.container = document.querySelector('#in-text-section');
        if (!this.container) {
            ClientLogger.warn('InTextPanel', 'No #in-text-section in the DOM — panel disabled (layout unaffected).');
            return;
        }
        this.content = this.container.querySelector('.in-text-content');
        this.tickEl = this.container.querySelector('.in-text-tick');
        if (!this.content) {
            ClientLogger.warn('InTextPanel', 'No content slot inside #in-text-section — panel disabled.');
        }
    }

    /**
     * Full mirror refresh. Called from App.refreshWorldAndActions() right
     * after the map and action list update — same snapshot, same moment.
     *
     * @param {Object|null} state - Current world state (from worldState.getState()).
     * @param {Object|null} droid - The player's entity (or null before incarnate).
     */
    update(state, droid) {
        if (!this.content) return;
        const myId = this._safeGetEntityId();
        this.content.innerHTML = this._buildHtml(state ?? {}, droid ?? null, myId);

        // Tick badge — writes 'tick N' on every broadcast; empty when the
        // state carries no turn tick.
        if (this.tickEl) {
            const tick = state?.turns?.currentTick;
            this.tickEl.textContent = tick != null ? `tick ${tick}` : '';
        }

        this._loadEvents(state).catch((err) => {
            this.errorHandler?.(err);
        });

        // Perception — the room-scoped "what changed since I looked" stream
        // (GET /perception/:roomId). A pure read: it does not advance any
        // cursor and never mutates state, so it is safe to run on every state
        // refresh, matching _loadEvents(). Only when the player is incarnate
        // in a room (droid.location set).
        const currentRoomId = droid?.location ?? null;
        if (currentRoomId) {
            this._loadPerception(state, currentRoomId).catch((err) => {
                this.errorHandler?.(err);
            });
        }
    }

    // =========================================================================
    // PUBLIC FORMATTERS (pure — return strings, testable without a DOM)
    // =========================================================================

    /**
     * "(x, y)" — the perception coordinate display rule (shared/CoordFormat.js,
     * mirrored server-side on the delta entries): values are truncated to two
     * decimals and always shown with exactly two decimal digits ("00.00"):
     * 18.81000041279735 → "(18.81, …)". A non-finite axis renders "?".
     */
    formatPosition(x, y) {
        return formatPositionShared(x, y);
    }

    /**
     * Server `Physical.existence` is a 0–1 store (matter ratio, 0 = gone).
     * Rendered as a percentage, clamped to [0, 1], so the text matches the
     * prop/existence bar on the map exactly.
     * @param {*} value
     * @returns {string} "75%", "100%", "0%", or "—" when unknown.
     */
    formatExistencePercent(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return '—';
        }
        const frac = Math.max(0, Math.min(1, value));
        return `${Math.round(frac * 100)}%`;
    }



    /**
     * One text line for an entity, plus the component breakdown.
     * @param {Object} entity
     * @param {Object} componentInstances - state.components.instances.
     * @param {string|null} myId - Entity id to mark as "YOU".
     * @returns {{ line: string, components: string|null }}
     */
    formatEntity(entity, componentInstances = {}, myId = null) {
        const name = this.esc(entity?.name ?? 'Droid');
        const pos = this.formatPosition(entity?.spatial?.x, entity?.spatial?.y);
        const parts = [pos, name];
        if (entity?.isNPC) {
            parts.push('<span class="in-text-npc-tag">NPC</span>');
        }
        if (myId && entity?.id === myId) {
            parts.push('<span class="in-text-you-tag">YOU</span>');
        }
        return { line: parts.join(' '), components: this.formatComponents(entity, componentInstances) };
    }

    /**
     * "compA 92% · compB 30%" — the entity's components with existence.
     * @param {Object} entity
     * @param {Object} componentInstances
     * @returns {string|null}
     */
    formatComponents(entity, componentInstances = {}) {
        const comps = Array.isArray(entity?.components) ? entity.components : [];
        if (comps.length === 0) return null;
        const parts = comps
            .map((c) => {
                const type = c?.type ?? 'unknown';
                const stats = componentInstances?.[c?.id];
                return `${this.esc(type)} ${this.formatExistencePercent(stats?.Physical?.existence)}`;
            })
            .filter(Boolean);
        return parts.length ? parts.join(' · ') : null;
    }

    /**
     * "Round N · planning · Ready 1/3 · #1 Name(12) · #2 Name(7)"
     * @param {Object|null} turns - state.turns.
     * @returns {string}
     */
    formatTurn(turns = null) {
        if (!turns || typeof turns !== 'object') return '—';
        const parts = [];
        parts.push(`Round ${Number.isFinite(turns.roundNumber) ? turns.roundNumber : '?'}`);
        const phase = turns.phase;
        parts.push(
            phase === TURN_PHASES.PLANNING
                ? 'planning'
                : phase === TURN_PHASES.RESOLUTION
                    ? 'resolution'
                    : String(phase)
        );
        const barrier = turns.barrier;
        if (barrier && typeof barrier === 'object') {
            if (barrier.closed) {
                const reason = barrier.closeReason ?? 'unknown';
                const tick = barrier.closedAtTick ?? '?';
                parts.push(`planning closed (${this.esc(reason)}) @ tick ${tick}`);
            } else {
                const ready = Number.isFinite(barrier.readyCount) ? barrier.readyCount : 0;
                const pending = Array.isArray(barrier.pendingEntityIds) ? barrier.pendingEntityIds.length : 0;
                parts.push(`ready ${ready}/${ready + pending}`);
            }
        }
        const order = Array.isArray(turns.actorOrder) ? turns.actorOrder.slice(0, 6) : [];
        if (order.length) {
            parts.push(
                order
                    .map((a, i) => `#${i + 1} ${this.esc(a?.name ?? String(a?.id ?? 'unknown'))} (${Number.isFinite(a?.initiative) ? a.initiative : '?'})`)
                    .join(' · ')
            );
        }
        return parts.join(' · ');
    }

    /**
     * "YYYY-MM-DD HH:MM:SS · message @ tick N" — the main line of an event in
     * the unified view. An optional room-context sub-line (merged from the old
     * Events tab) is appended separately by _eventRow() when the server sent
     * enrichment.
     * @param {Object} event
     * @returns {string}
     */
    formatEventLine(event = {}) {
        const time = this._formatTime(typeof event.time === 'number' ? event.time : event.timestamp);
        const msg = this.esc(String(event.message ?? event.event ?? ''));
        const tick = typeof event.tick === 'number' ? ` @ tick ${event.tick}` : '';
        return `${time} · ${msg}${tick}`;
    }

    /**
     * Doors-section line with coordinates: "right_door (300, 190) → The
     * Eastern Corridor". The (x, y) is the room-relative boundary point the
     * connection exits from — same `getRoomEdgePoint` math the map renderer
     * uses to draw the connection line and the server uses to spawn entities
     * through the door (client-server parity).
     *
     * @param {string} doorName
     * @param {*} connection - Connection value: room id string (legacy) or
     *   `{ target: roomId }` (current)
     * @param {Object} room - The room carrying the door (geometry source)
     * @param {Object} rooms - All rooms keyed by id (target-room lookup)
     * @returns {string}
     */
    formatDoor(doorName, connection, room, rooms = {}) {
        const target = typeof connection === 'object' ? connection.target : connection;
        const targetRoom = rooms[target];
        const label = targetRoom?.name ?? target ?? 'Unknown';
        return `${doorName}${this._doorCoordsText(room, targetRoom)} → ${this.esc(label)}`;
    }

    /**
     * " (x, y)" for the door, or '' when the door's or target room's geometry
     * is incomplete — in which case the line degrades to "door → Target" and
     * never crashes the render pass.
     * @private
     * @param {Object} room
     * @param {Object|null} targetRoom
     * @returns {string}
     */
    _doorCoordsText(room, targetRoom) {
        const values = [
            room?.x, room?.y, room?.width, room?.height,
            targetRoom?.x, targetRoom?.y, targetRoom?.width, targetRoom?.height
        ];
        if (!values.every((n) => Number.isFinite(n))) return '';
        const [x, y] = getRoomEdgePoint(room, targetRoom, room.width / 2, room.height / 2);
        return ` ${this.formatPosition(x, y)}`;
    }

    /**
     * HTML block for a single perception delta entry: a `round · kind · summary`
     * headline and a compact breakdown. Movers that the summary compresses to a
     * count — entities (appeared / despawned / moved) and item changes (held,
     * dropped, equipped: added / removed / moved) — are also named in bullets,
     * so the "who/what changed" is scannable, not buried in the sentence. Each
     * item row carries a display *name* resolved server-side (type key → item
     * registry); we fall back to the type key for client-side deltas lacking it.
     * Baselines list the room's initial entities only: their dropped/equipped/
     * held items are already named in the "initial observation" summary and can
     * be huge (a room full of dropped knives), so they are skipped from bullets.
     * Pure: returns a string, testable without a DOM.
     *
     * @param {Object|null} [entry]
     * @param {number|string|null} [roundNumber] — the round shown to the player
     *   (same source the Turn section uses: state.turns.roundNumber). Perception
     *   entries don't carry their own round, so the caller supplies the current
     *   one. When provided the headline reads "round N" (aligned with the Turn
     *   badge); when absent it falls back to the entry's own tick so the
     *   headline never goes blank.
     * @returns {string}
     */
    formatPerceptionEntry(entry = null, roundNumber) {
        if (!entry || typeof entry !== 'object') {
            return '<p class="in-text-none">—</p>';
        }
        const isBaseline = entry.kind === 'baseline';
        // Each entry carries its own round (stamped by the perception flush), so
        // re-rendering the room's history labels every bullet with *its* round
        // instead of the viewer's current one. Fall back to the passed round
        // (or the tick) only when the entry has no round of its own.
        const effectiveRound =
            (entry.roundNumber != null && Number.isFinite(entry.roundNumber))
                ? entry.roundNumber
                : roundNumber;
        const headlineLabel =
            (effectiveRound != null && Number.isFinite(effectiveRound))
                ? `round ${effectiveRound}`
                : (entry.tick != null ? `tick ${entry.tick}` : '');
        const kindLabel = isBaseline ? 'Initial observation' : 'Changes';
        const summaryRaw = typeof entry.summary === 'string' ? entry.summary : '';
        // Reliable room name (set by the perception controller). Used both for
        // the bullets (self-contained sentences) and is the room we render.
        const roomName = entry.roomName ?? null;
        // Headline keeps only the high-level sentence — the first one, which is
        // the entity/stat-change counts. Per-item / dropped / equipped detail now
        // lives in the bullets below, so the headline is a concise "what changed"
        // count instead of repeating every change.
        const summarySentences = summaryRaw ? summaryRaw.split('. ') : [];
        const headSummary = summarySentences.length
            ? summarySentences[0] + (summarySentences.length > 1 ? '.' : '')
            : '';

        const headParts = [headlineLabel, kindLabel, headSummary ? this.esc(headSummary) : '']
            .filter(Boolean);

        const bullets = [];
        const push = (text) => {
            if (text) bullets.push(text);
        };
        const entities = entry.entities ?? {};
        // Baselines carry *all* present entities in `appeared` — list them.
        // Deltas carry only the newcomers — list those too (the "who's new").
        for (const ent of entities.appeared ?? []) {
            push(`+ ${this.esc(ent.name ?? ent.id ?? '?')}`);
        }
        for (const ent of entities.despawned ?? []) {
            push(`− ${this.esc(ent.name ?? ent.id ?? '?')}`);
        }
        for (const ent of entities.moved ?? []) {
            // Friendly name when present; otherwise the raw entity id (shown once).
            // The parenthetical id is added *only* when a distinct friendly name
            // exists — so an unnamed entity reads "↔ <id>" (id once), not "<id> (id <id>)".
            const hasName = ent.name != null && String(ent.name) !== '';
            const name = hasName ? this.esc(ent.name) : (ent.id != null ? this.esc(ent.id) : '?');
            const id = (hasName &&
                ent.id != null &&
                String(ent.id) !== String(ent.name))
                ? ` (id ${this.esc(ent.id)})` : '';
            // Primary from→to: the *coordinate* delta (the within-room spatial
            // move — what actually changed in the current room). Fallback: a
            // room change. (Real per-room moves are within-room, so coords are
            // the normal case; the room branch is defensive.)
            const fp = (p) =>
                p && Number.isFinite(p.x) && Number.isFinite(p.y)
                    ? this.formatPosition(p.x, p.y)
                    : null;
            const fromX = fp(ent.fromXY);
            const toX = fp(ent.toXY);
            const pos = fromX
                ? (toX ? `${fromX} → ${toX}` : fromX)
                : (toX ?? '');
            const roomFrom = ent.fromRoom ? this.esc(ent.fromRoom) : '';
            const roomTo = ent.toRoom ? this.esc(ent.toRoom) : '';
            // Room display on the moved bullet:
            //   • within-room move (fromRoom === toRoom) → OMIT the room (the
            //     bullet carries the room header; the coordinate delta carries the
            //     meaning). Avoids printing a raw/unnamed room id twice.
            //   • cross-room move (fromRoom !== toRoom) → show "from → to".
            //   • only one side present → show that side (defensive).
            let roomPart = '';
            if (roomFrom != null && roomTo != null && roomFrom !== roomTo) {
                roomPart = ` ${roomFrom} → ${roomTo}`;
            } else if (roomFrom == null && roomTo != null) {
                roomPart = ` ${roomTo}`;
            } else if (roomFrom != null && roomTo == null) {
                roomPart = ` ${roomFrom}`;
            }
            let line = `↔ ${name}${id}` + (pos ? ` ${pos}` : '') + roomPart;
            // Component list (type (id), …) and its count. Build once, above the
            // labeling, so the same list feeds the "used to execute" (authoritative)
            // and "locomotion" (best-effort) labels. Check the array case FIRST:
            // `typeof [] === 'object'` is true, so a plain-object check would
            // swallow the array and drop the legs.
            const loco = ent.locomotion;
            let fmt = '';
            let count = 0;
            if (loco != null) {
                count = Array.isArray(loco) ? loco.length : 1;
                fmt = Array.isArray(loco)
                    ? loco
                        .map((c) => (typeof c === 'object' ? `${c.type ?? '?'} (${c.id ?? '?'})` : c))
                        .join(', ')
                    : typeof loco === 'object'
                        ? `${loco.type ?? '?'} (${loco.id ?? '?'})`
                        : typeof loco === 'string'
                            ? loco
                            : String(loco);
            }
            if (ent.action) {
                line += ` · action: ${this.esc(ent.action)}`;
                if (fmt) {
                    // How many + which components actually powered the action. The
                    // authoritative count/list comes from the generic attribution
                    // store (attributionSource === 'store'): every part listed really
                    // granted this action — this is the exact "which & how many
                    // executed action X" answer (multi-limb droid → every limb).
                    // When the store did NOT credit the action (no store, or a
                    // non-attributable move) the diff flagged it 'heuristic' (best-
                    // effort Movement.move granters); we then label it "locomotion"
                    // and NEVER claim "used to execute the action".
                    if (ent.attributionSource === 'store') {
                        line += ` · used to execute the action '${this.esc(ent.action)}' (${count}): ${this.esc(fmt)}`;
                    } else {
                        line += ` · locomotion: ${this.esc(fmt)}`;
                    }
                }
            } else if (fmt) {
                // Direct / non-action reposition: no action to credit, just the
                // movement parts (heuristic, from the diff).
                line += ` · locomotion: ${this.esc(fmt)}`;
            }
            push(line);
        }

        // Item / dropped / equipped changes (delta only). Each bullet names the
        // item (display name resolved server-side; type-key fallback if absent),
        // tags the surface it lives in (`item` = held, `dropped` = on the floor,
        // `equipped`), and shows the item's id — plus its current position via
        // formatPosition whenever it sits on the floor (added / removed / moved
        // dropped items). Held/equipped items live in a component slot, so they
        // have no floor position. Baselines are skipped here: they already
        // enumerate every dropped/held item in the "initial observation" summary
        // and can be huge (a room full of knives).
        if (!isBaseline) {
            // Performed actions: each *distinct* action the room's entities
            // performed since the last observation, with the components the
            // attribution store recorded as actually used ("only the ones
            // used" — the server claims none when it has no record). A `move`
            // row already appears above as a moved bullet (with from → to and
            // the same used components), so it is skipped here to avoid a
            // duplicate line for the same action.
            const movedEntityIds = new Set((entities.moved ?? []).map((m) => m?.id));
            for (const a of entry.actions?.performed ?? []) {
                if (a?.action === 'move' && movedEntityIds.has(a.entity)) continue;
                const used = (a.used ?? []).filter((u) => u && u.id);
                let line = `⚔ ${this.esc(a.name ?? a.entity ?? '?')} · action: ${this.esc(a.action ?? '?')}`;
                if (used.length) {
                    line += ` · used (${used.length}): ` +
                        this.esc(used.map((u) => `${u.type ?? 'component'} (${u.id})`).join(', '));
                }
                // Target: WHO was acted upon (the punch's victim, the object a
                // tool was used on) and WHICH component of it was hit. The ids
                // come from the attribution store; the server named them
                // against the current world (a destroyed target degrades to
                // ids only; spatial actions carry no target at all).
                if (a.target) {
                    const t = a.target;
                    const who = t.name ? `${this.esc(t.name)} (${this.esc(t.id ?? '?')})` : this.esc(t.id ?? '?');
                    line += ` → ${who}`;
                    if (t.componentId) {
                        line += ` · hit: ${this.esc(t.componentName ? `${t.componentName} (${t.componentId})` : t.componentId)}`;
                    }
                }
                if (roomName) line += ` in ${this.esc(roomName)}`;
                push(line);
            }

            // `verb` is the category attribution phrase, rendered after the item
            // id. `verbSep` is the separator before the verb (default "· "); the
            // item-removal line uses a single space so it reads as one flowing
            // phrase ("removed from X") rather than "· … · from X". Per category:
            // item → "gained by" / "removed from"; dropped → "dropped by" / "from"
            // / "owned by"; equipped → "equipped by" / "unequipped by".
            const itemBullets = (rows, marker, tag, verb, verbSep = ' · ') => {
                for (const it of rows ?? []) {
                    const name = it.name ?? it.type ?? it.itemType ?? '?';
                    const id = it.itemId ?? it.id ?? null;
                    // Where the item lives now. Added/removed dropped rows carry
                    // x/y; a moved dropped row carries fromXY/toXY — show the
                    // *new* position (toXY). Held/equipped items: no floor pos.
                    let pos = null;
                    if (it.x != null && it.y != null) {
                        pos = this.formatPosition(it.x, it.y);
                    } else if (it.toXY && it.toXY.x != null) {
                        pos = this.formatPosition(it.toXY.x, it.toXY.y);
                    }
                    let line = `${marker} ${this.esc(name)} (${tag})`;
                    if (id != null) line += ` · id ${this.esc(id)}`;
                    if (pos) line += ` ${pos}`;
                    // Credit the agent involved with this row (resolved server-side
                    // in the perception controller as { name, id, x, y }: the
                    // entity that dropped/removed/equipped the item). Render name +
                    // id + current floor position. Omitted when the actor is unknown
                    // so we never render "by undefined".
                    const actor = it.actor;
                    if (verb && actor && (actor.name || actor.id)) {
                        // Show the agent's human name. When the entity has no
                        // friendly name the name falls back to the id, so the
                        // `(id …)` parenthetical is only worth keeping when it
                        // differs from the displayed name — otherwise we'd print
                        // the same id twice ("from ent-… (id ent-…)").
                        const displayName =
                            (actor.name != null && actor.name !== '')
                                ? actor.name
                                : (actor.id != null ? actor.id : '?');
                        line += `${verbSep}${verb} ${this.esc(displayName)}`;
                        if (actor.id != null && String(actor.id) !== String(displayName)) {
                            line += ` (id ${this.esc(actor.id)})`;
                        }
                        if (Number.isFinite(actor.x) && Number.isFinite(actor.y)) {
                            line += ` @ ${this.formatPosition(actor.x, actor.y)}`;
                        }
                    }
                    if (roomName) line += ` in ${this.esc(roomName)}`;
                    push(line);
                }
            };
            itemBullets(entry.items?.added, '+', 'item', 'gained by');
            itemBullets(entry.items?.removed, '−', 'item', 'removed from', ' ');
            itemBullets(entry.dropped?.added, '+', 'dropped', 'dropped by');
            itemBullets(entry.dropped?.removed, '−', 'dropped', 'from');
            itemBullets(entry.dropped?.moved, '↔', 'dropped', 'owned by');
            itemBullets(entry.equipped?.added, '+', 'equipped', 'equipped by');
            itemBullets(entry.equipped?.removed, '−', 'equipped', 'unequipped by');
        }

        // Stat changes: the *last-resort* bullet, shown only when no named
        // mover above was listed (so a pure stat-change entry still renders
        // something beneath its headline).
        const statCount = (entities.statChanges ?? []).length;
        if (!bullets.length && statCount > 0) {
            const first = (entities.statChanges ?? [])[0];
            push(`~ ${statCount} stat change${statCount === 1 ? '' : 's'} ${this.esc(first?.statName ?? '?')} ${this.esc(first?.from ?? '')} → ${this.esc(first?.to ?? '')}`);
        }

        const head = headParts.length ? `<p class="in-text-perc-headline">${headParts.join(' · ')}</p>` : '';
        const list = bullets.length
            ? `<ul class="in-text-perc-bullets">${bullets.map(b => `<li class="in-text-perc-bullet">${b}</li>`).join('')}</ul>`
            : '';

        return [
            '<div class="in-text-perc-entry">',
            head,
            list,
            '</div>'
        ].filter(Boolean).join('');
    }

    // =========================================================================
    // RENDERING (assembles the pure-formatted strings into the column)
    // =========================================================================

    /**
     * Full HTML of the in-text column, built once per refresh from `state`.
     * Every user-visible value goes through `esc()` before interpolation.
     *
     * @private
     * @param {Object} state
     * @param {Object|null} droid
     * @param {string|null} myId
     * @returns {string}
     */
    _buildHtml(state, droid, myId) {
        const html = [];

        if (!droid || droid.location == null) {
            // Before incarnate (or no room data) the player sees nothing in the
            // map — mirror that: a single line, no false content.
            return '<p class="in-text-none">No droid incarnate yet.</p>';
        }

        const roomId = droid.location;
        const roomsMap = state.rooms ?? {};
        const room = roomsMap[roomId];

        // 1. Room
        html.push(
            this._section('Room', [
                room
                    ? [
                        `<p class="in-text-row"><strong>${this.esc(room.name ?? '?')}</strong> · ${this.formatPosition(room.x, room.y)} · ${Number.isFinite(room.width) ? room.width : '?'} × ${Number.isFinite(room.height) ? room.height : '?'}</p>`,
                        ...(room.description ? [`<p class="in-text-desc">${this.esc(room.description)}</p>`] : []),
                    ]
                    : ['<p class="in-text-none">No room data.</p>'],
            ])
        );

        // 2. What Changed (perception) — async, filled by _loadPerception() after
        //   this render pass. The sub-container is re-created by every render, so
        //   the fetch queries the *current* node (never a stale captured ref).
        html.push(
            '<section class="in-text-section">\n    <h3 class="in-text-sec-title">What Changed</h3>\n    <div id="in-text-perception" class="in-text-perception">\n        <p class="in-text-none">Waiting for perception data…</p>\n    </div>\n  </section>'
        );

        // 3. Doors
        const doorLines = room && typeof (room.connections ?? null) === 'object'
            ? Object.entries(room.connections).map(([doorName, conn]) =>
                this.formatDoor(doorName, conn, room, roomsMap))
            : [];
        html.push(
            this._section(
                'Doors',
                doorLines.length
                    ? doorLines.map((line) => `<p class="in-text-row">${line}</p>`).join('')
                    : '<p class="in-text-none">none</p>'
            )
        );

        // 3. Droids + 4. Objects (world objects are isStatic entities) + 5. Items
        const entities = this._entitiesInRoom(state, roomId);
        const droids = entities.filter((e) => !e.isStatic);
        const props = entities.filter((e) => e.isStatic);
        const componentInstances = state.components?.instances ?? {};

        html.push(
            this._section(
                `Droids (${droids.length})`,
                droids.length === 0
                    ? '<p class="in-text-none">none</p>'
                    : droids
                        .slice()
                        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
                        .map((e) => this._entityRow(e, componentInstances, myId))
                        .join('')
            )
        );

        html.push(
            this._section(
                `Objects (${props.length})`,
                props.length === 0
                    ? '<p class="in-text-none">none</p>'
                    : props
                        .slice()
                        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
                        .map((e) => this._entityRow(e, componentInstances, myId, true))
                        .join('')
            )
        );

        const items = this._itemsInRoom(state.droppedItems, roomId);
        html.push(
            this._section(
                `Items (${items.length})`,
                items.length === 0
                    ? '<p class="in-text-none">none</p>'
                    : items
                        .map((it) => `<p class="in-text-row">${this.formatPosition(it.x, it.y)} <strong>${this.esc(it.name ?? it.itemType ?? '?')}</strong></p>`)
                        .join('')
            )
        );

        // 6. Turn
        html.push(this._section('Turn', `<p class="in-text-turn">${this.formatTurn(state.turns)}</p>`));

        // 7. Events — sub-section, filled asynchronously by _loadEvents. The
        //   element is re-created by every render pass, so _loadEvents queries
        //   it *after* the render (never a stale captured reference).
        html.push(
            `<section class="in-text-section">
            <h3 class="in-text-sec-title">Recent Events</h3>
            <div id="in-text-events" class="in-text-events">
                <p class="in-text-none">Waiting for events…</p>
            </div>
          </section>`
        );

        return html.join('');
    }

    /**
     * A single entity line: "(x, y) Name [NPC] [YOU] · compA 92% · compB 30%".
     * @private
     */
    _entityRow(entity, componentInstances, myId, isStatic = false) {
        const { line, components } = this.formatEntity(entity, componentInstances, myId);
        const cls = [
            'in-text-entity',
            ...(isStatic ? ['in-text-entity-static'] : []),
            ...(entity?.id === myId ? ['in-text-entity-you'] : []),
            ...(entity?.isNPC ? ['in-text-entity-npc'] : []),
        ].join(' ');
        const compHtml = components ? `<span class="in-text-entity-components">${components}</span>` : '';
        return `<p class="${cls}">${line}${compHtml}</p>`;
    }

    /**
     * A "section" fragment: `<section>` with title + rows.
     * @private
     */
    _section(title, rows) {
        const t = this.esc(typeof title === 'string' ? title : String(title));
        const rowHtml = typeof rows === 'string' ? rows : rows.join('');
        return `<section class="in-text-section">\n    <h3 class="in-text-sec-title">${t}</h3>\n    ${rowHtml}\n  </section>`;
    }

    /**
     * Entities in a room (same filter the map uses: e.location === room id).
     * `state.entities` is a map keyed by entity id (typed ent- ids) — same
     * access every other consumer uses (`state.entities[id]`, `Object.values`
     * in UIManager/WorldStateManager/ActionManager).
     * @private
     */
    _entitiesInRoom(state, roomId) {
        if (roomId == null) return [];
        const entities = Object.values(state?.entities ?? {});
        return entities.filter((e) => e && e.location === roomId);
    }

    /**
     * Dropped items in a room (items carry their roomId from spawn).
     * @private
     */
    _itemsInRoom(droppedItems, roomId) {
        if (roomId == null || !droppedItems) return [];
        return Object.values(droppedItems).filter((it) => it && it.roomId === roomId);
    }

    /**
     * Loads recent events and paints them into the events sub-container. The
     * unified view: sends the active entity so the server enriches every event
     * with the requesting room's context (same endpoint, same limit, same
     * `&entityId=…` param the old Events tab used). Renders newest-first, up
     * to the configured limit. The element is re-created by every render pass,
     * so this queries it *after* the render (never a stale captured reference).
     *
     * @private
     * @param {Object|null} [_state] - Accepted for call-site compatibility;
     *   the events tail no longer reads a per-broadcast field.
     */
    _loadEvents(_state) {
        const limit = AppConfig.EVENTS.HISTORY_LIMIT ?? 50;
        let url = `${AppConfig.ENDPOINTS.WORLD_EVENTS}?limit=${limit}`;
        const entityId = this.getEntityId?.() ?? null;
        if (entityId) {
            url += `&entityId=${encodeURIComponent(entityId)}`;
        }
        return fetch(url, { headers: { Accept: 'application/json' } })
            .then((r) => {
                if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
                return r.json();
            })
            .then((data) => {
                const events = Array.isArray(data?.events)
                    ? data.events
                    : Array.isArray(data)
                        ? data
                        : [];
                // Query AFTER the render pass: _buildHtml recreates this node.
                const eventsEl = this.content?.querySelector(this.eventsSelector);
                if (!eventsEl) return;
                // Server returns oldest → newest; the column reads newest first.
                const rows = [...events].reverse()
                    .slice(0, limit)
                    .map((e) => this._eventRow(e))
                    .join('');
                eventsEl.innerHTML = rows || '<p class="in-text-none">no recent events</p>';
            });
    }

    /**
     * One event row: the main line (time · message @ tick) plus an optional
     * context sub-line (room, size, your position, same-room others, items,
     * exits) and warn coloring. The context is the enrichment the old Events
     * tab sent with `&entityId=…`.
     *
     * @private
     * @param {Object} [event]
     * @returns {string}
     */
    _eventRow(event = {}) {
        const isWarn = event.level === 'warn';
        const cls = [
            'in-text-event',
            ...(isWarn ? ['in-text-event-warn'] : []),
        ].join(' ');
        const main = this.formatEventLine(event);
        const context = event?.context && Object.keys(event.context).length > 0
            ? `<span class="in-text-event-context">${this.esc(this._formatEventContext(event.context))}</span>`
            : '';
        return `<p class="${cls}">${main}${context}</p>`;
    }

    /**
     * Formats the enriched room context as a compact summary:
     * "@ RoomName 40x30 you: (1, 2) | others: A (3,5), B (0,0) | items: 2 | exits: door→Room".
     *
     * @private
     * @param {Object} context - Enriched context object from /world-events.
     * @returns {string}
     */
    _formatEventContext(context) {
        const size = (context.roomWidth != null && context.roomHeight != null)
            ? ` ${context.roomWidth}x${context.roomHeight}`
            : '';
        const you = (context.playerPosition)
            ? ` you: (${Math.round(context.playerPosition.x)}, ${Math.round(context.playerPosition.y)})`
            : '';
        const others = this._formatOthers(context.entities);
        const items = Array.isArray(context.droppedItems) ? context.droppedItems.length : 0;
        const exits = Array.isArray(context.exits) && context.exits.length > 0
            ? ` | exits: ${context.exits.map(e => `${e.door}→${e.targetRoomName}`).join(', ')}`
            : '';
        return `@ ${context.roomName || 'unknown'}${size}${you} | ${others} | items: ${items}${exits}`;
    }

    /**
     * The `others:` segment: each same-room entity by name + position, capped
     * at AppConfig.EVENTS.CONTEXT_MAX_ENTITIES, remainder collapsed to `+N`.
     *
     * @private
     * @param {Array<{name?: string, x?: number|null, y?: number|null}>|*} [entities]
     *   - The same-room entity records from the event context.
     * @returns {string}
     */
    _formatOthers(entities) {
        if (!Array.isArray(entities) || entities.length === 0) {
            return 'others: none';
        }
        const max = AppConfig.EVENTS.CONTEXT_MAX_ENTITIES;
        const shown = entities.slice(0, max);
        const overflow = entities.length - shown.length;
        const parts = shown.map((e) => {
            const name = e?.name || 'Droid';
            const hasCoords = typeof e?.x === 'number' && typeof e?.y === 'number';
            return hasCoords
                ? `${name} (${Math.round(e.x)}, ${Math.round(e.y)})`
                : name;
        });
        const tail = overflow > 0 ? ` … +${overflow}` : '';
        return `others: ${parts.join(', ')}${tail}`;
    }

    /**
     * Loads the current room's recent perception (delta) entries and paints them
     * into the "What Changed" sub-container (Feature G). Uses the room-scoped
     * GET /perception/:roomId endpoint — a pure read (does not advance any
     * cursor, never mutates state), so it is safe to run on every world-state
     * refresh (the same discipline as _loadEvents()). Queries after the render
     * pass: _buildHtml recreates the sub-container each time, so the node is
     * always the current one.
     *
     * @private
     * @param {Object|null} [state]
     * @param {string|null} [roomId]
     */
    _loadPerception(state, roomId) {
        if (roomId == null) return Promise.resolve();
        const base = AppConfig.ENDPOINTS?.PERCEPTION_ROOM;
        if (!base) return Promise.resolve();
        const url = `${base}/${encodeURIComponent(roomId)}?limit=${PERCEPTION_LIMIT}`;
        return fetch(url, { headers: { Accept: 'application/json' } })
            .then((r) => {
                if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
                return r.json();
            })
            .then((data) => {
                // Real endpoint: { success, kind, deltas: [...] }. Tolerate a
                // bare array too (defensive; the node mock can return a raw list).
                const deltas = Array.isArray(data)
                    ? data
                    : (data?.deltas ?? []);
                const sel = this.perceptionSelector ?? '#in-text-perception';
                const el = this.content?.querySelector(sel);
                if (!el) return;
                if (!deltas.length) {
                    el.innerHTML = '<p class="in-text-none">no changes yet</p>';
                    return;
                }
                // Round number (same source the Turn section uses: state.turns.
                // roundNumber). Perception entries don't carry their own round,
                // so pass the current one in so the headline reads "round N" and
                // lines up with the Turn badge.
                const roundNumber = state?.turns?.roundNumber;

                // Newest first (mirrors the event-tail ordering).
                el.innerHTML = (deltas.slice(-PERCEPTION_LIMIT).reverse()).map((e) =>
                    this.formatPerceptionEntry(e, roundNumber)
                ).join('');
            });
    }

    /**
     * "YYYY-MM-DD HH:MM:SS" from a millisecond timestamp.
     * @private
     */
    _formatTime(ms) {
        if (typeof ms !== 'number' || !Number.isFinite(ms)) return '?';
        const d = new Date(ms);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    /**
     * HTML-escape a user-visible value.
     * @private
     */
    esc(value) {
        if (value == null) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Safe entity-id getter — a throwing App getter must not crash world refresh.
     * @private
     */
    _safeGetEntityId() {
        try {
            return this.getEntityId?.() ?? null;
        } catch {
            return null;
        }
    }
}
