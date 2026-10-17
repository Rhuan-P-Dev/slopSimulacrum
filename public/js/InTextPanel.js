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
//   3. Doors: one line per exit — "door (x, y) → Target Room", where (x, y)
//      is the door's room-relative exit point (same math as the map renderer
//      and the server door-traversal spawn: client-server parity).
//   4. Droids: the room's non-static entities — position, display name, NPC
//      flag, "you" flag, components with existence.
//   5. Objects: static props (`isStatic` entities, e.g. the wooden tree).
//   6. Items: `state.droppedItems` filtered to the room.
//   7. Turn: round, phase, barrier status (ready count or close reason + tick),
//      initiative order — the same fields the Turn HUD reads.
//   8. Recent events: tail of GET /world-events (AppConfig.EVENTS.HISTORY_LIMIT)
//      with the same 60s staleness guard EventLogPanel uses.
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

/**
 * Milliseconds older than which an event (that carries a tick) is considered
 * stale — mirrors the EventLogPanel staleness guard, so both panels can never
 * disagree about "what happened".
 */
const STALE_EVENT_MS = 60_000;

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
    }

    // =========================================================================
    // PUBLIC FORMATTERS (pure — return strings, testable without a DOM)
    // =========================================================================

    /**
     * "(x, y)" — matches the map's positional format.
     */
    formatPosition(x, y) {
        return `(${Number.isFinite(x) ? x : '?'}, ${Number.isFinite(y) ? y : '?'})`;
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
     * "YYYY-MM-DD HH:MM:SS · message @ tick N" — one event line (same shape as
     * EventLogPanel).
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

        // 2. Doors
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
     * Loads recent events and paints them into the events sub-container.
     * Uses the same endpoint, limit and 60s staleness guard as EventLogPanel
     * so both panels can never disagree about "what happened".
     *
     * @private
     */
    _loadEvents(state) {
        const limit = AppConfig.EVENTS.HISTORY_LIMIT ?? 50;
        const url = `${AppConfig.ENDPOINTS.WORLD_EVENTS}?limit=${limit}`;
        return fetch(url, { headers: { Accept: 'application/json' } })
            .then((r) => {
                if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
                return r.json();
            })
            .then((events) => {
                const now = typeof state?.serverTime === 'number' ? state.serverTime : Date.now();
                const visible = (Array.isArray(events) ? events : []).filter((e) => {
                    if (typeof e.tick !== 'number') return true;
                    return e.tick >= now - STALE_EVENT_MS;
                });
                // Query AFTER the render pass: _buildHtml recreates this node.
                const eventsEl = this.content?.querySelector(this.eventsSelector);
                if (!eventsEl) return;
                if (visible.length === 0) {
                    eventsEl.innerHTML = '<p class="in-text-none">no recent events</p>';
                } else {
                    eventsEl.innerHTML = visible
                        .slice(0, 10)
                        .map((e) => `<p class="in-text-event">${this.formatEventLine(e)}</p>`)
                        .join('');
                }
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
