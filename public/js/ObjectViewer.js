/**
 * ObjectViewer — inspection panel for world objects
 * (wiki/subMDs/frontend/object_viewer.md).
 *
 * Answers the question the world objects page poses: given a static object
 * on the spatial map (the knife generator, a droid, anything that holds
 * matter), show what is INSIDE it and what it DOES per turn —
 *   - its components: live matter `existence`, capacity volume, full stats,
 *     materials;
 *   - its organs (internal components) with the shared generated description
 *     ("Every 1 turn, produces 1 knife.");
 *   - its inventory: stored items (name, volume, description) and the
 *     used/capacity bar — on a multi-component object the item rows are
 *     clickable and move the item to a player-chosen component of the same
 *     object (the single mutation the panel performs; everything else is
 *     read-only);
 *   - its production: the `generateItem` overTime summary ("Produces 1 Knife
 *     every 1 turn — 6/10 stored; when full, extras drop on the floor.").
 *
 * Data flow: the payload is fetched LIVE on every open from
 * GET /world-objects/:entityId (AppConfig.ENDPOINTS.OBJECT_INSPECT — the
 * Object Viewer is open only for a few seconds, so the fetch-on-open cost is
 * negligible and the data can never be stale) and re-fetched on every
 * world-state-update broadcast while the panel is open (production and
 * inventory change every round; the live-refresh path is owned by App.js,
 * which owns the fetch and passes the payload in via refresh()).
 *
 * The panel's one mutation reuses the existing inventory move endpoint
 * (POST /inventory/:entityId/move/:itemId, body { targetComponentId }) —
 * the same facade path (`moveItemInEntity`) the inventory UI uses, so the
 * server stays authoritative (volume capacity is re-checked there and a
 * rejection's message is shown in the picker). It consumes no turn, the
 * same UI-convenience precedent as the crafting panel (see
 * wiki/subMDs/data/inventory_system.md and the crafting design spec).
 *
 * The panel is opened programmatically from a world-object click on the
 * spatial map — it has no config-bar button and no keyboard shortcut (same
 * register shape as the pick-up overlay: both args null).
 *
 * Standing rules: every server-fetched value is guarded before rendering
 * (missing sections render empty states, never exceptions — the same
 * degradation contract as the Knowledge Panel); all user-visible strings
 * are English (client-side presentation layer, language-regression tested);
 * all interpolated values pass through escapeHtml (ItemTree).
 *
 * @module ObjectViewer
 */

import ClientLogger from '/utils/ClientLogger.js';
import { escapeHtml } from '/utils/ItemTree.js';
import { AppConfig } from './Config.js';

// =========================================================================
// Pure shapers — exported for unit tests (same pattern as KnowledgePanel and
// ComponentViewer: the render logic is a pure function of the payload).
// =========================================================================

/**
 * Normalizes a server-fetched inspection payload into the shape the renderer
 * consumes. Every field is guarded: missing sections degrade to empty
 * structures, never exceptions (wiki/subMDs/frontend/object_viewer.md —
 * "missing data must never crash the panel").
 * @param {Object|null|undefined} raw - The payload (the `object` envelope member).
 * @returns {Object|null} Normalized payload, or null when the input is not a
 *   usable object (the renderer then shows the fetch-failure state).
 */
export function normalizeObjectPayload(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const entity = (raw.entity && typeof raw.entity === 'object') ? raw.entity : {};
    const components = Array.isArray(raw.components) ? raw.components.filter(c => c && typeof c === 'object') : [];
    const items = Array.isArray(raw.items) ? raw.items.filter(i => i && typeof i === 'object') : [];
    const production = Array.isArray(raw.production) ? raw.production.filter(p => p && typeof p === 'object') : [];
    const inventory = (raw.inventory && typeof raw.inventory === 'object') ? raw.inventory : {};

    return {
        entity: {
            id: entity.id != null ? String(entity.id) : 'unknown',
            name: typeof entity.name === 'string' && entity.name ? entity.name : 'Unknown object',
            isStatic: entity.isStatic === true,
            isMachine: entity.isMachine === true,
            machineType: typeof entity.machineType === 'string' ? entity.machineType : null,
            spatial: (entity.spatial && typeof entity.spatial === 'object') ? entity.spatial : null,
            roomName: typeof entity.roomName === 'string' && entity.roomName ? entity.roomName : null
        },
        components: components.map((c) => ({
            id: c.id != null ? String(c.id) : '',
            type: typeof c.type === 'string' ? c.type : 'unknown',
            existence: typeof c.existence === 'number' ? c.existence : null,
            broken: c.broken === true,
            volume: typeof c.volume === 'number' ? c.volume : null,
            stats: (c.stats && typeof c.stats === 'object') ? c.stats : {},
            internalComponents: Array.isArray(c.internalComponents)
                ? c.internalComponents.filter(ic => ic && typeof ic === 'object')
                : []
        })),
        items: items.map((i) => ({
            id: i.id != null ? String(i.id) : '',
            type: typeof i.type === 'string' ? i.type : 'unknown',
            name: typeof i.name === 'string' && i.name ? i.name : (i.type || 'item'),
            description: typeof i.description === 'string' && i.description ? i.description : null,
            volume: typeof i.volume === 'number' ? i.volume : null,
            hostComponentId: typeof i.hostComponentId === 'string' ? i.hostComponentId : null
        })),
        inventory: {
            used: typeof inventory.used === 'number' ? inventory.used : 0,
            capacity: typeof inventory.capacity === 'number' ? inventory.capacity : 0,
            percent: typeof inventory.percent === 'number' ? inventory.percent : 0
        },
        production: production.map((p) => ({
            organType: typeof p.organType === 'string' ? p.organType : 'unknown',
            itemKey: typeof p.itemKey === 'string' ? p.itemKey : 'item',
            itemName: typeof p.itemName === 'string' && p.itemName ? p.itemName : (p.itemKey || 'item'),
            countPerTurn: Number.isInteger(p.countPerTurn) ? p.countPerTurn : 1,
            intervalTurns: Number.isInteger(p.intervalTurns) ? p.intervalTurns : 1,
            active: p.active !== false,
            organBroken: p.organBroken === true,
            hostBroken: p.hostBroken === true,
            stored: Number.isInteger(p.stored) ? p.stored : 0,
            capacity: Number.isInteger(p.capacity) ? p.capacity : 0
        })),
        takeOptions: (Array.isArray(raw.takeOptions) ? raw.takeOptions : [])
            .filter(o => o && typeof o === 'object')
            .map((o) => ({
                id: o.id != null ? String(o.id) : '',
                name: typeof o.name === 'string' && o.name ? o.name : (o.id != null ? String(o.id) : 'entity'),
                components: (Array.isArray(o.components) ? o.components : [])
                    .filter(c => c && typeof c === 'object')
                    .map((c) => ({
                        id: c.id != null ? String(c.id) : '',
                        type: typeof c.type === 'string' ? c.type : 'component',
                        used: typeof c.used === 'number' ? c.used : 0,
                        capacity: typeof c.capacity === 'number' ? c.capacity : null
                    }))
                    .filter(c => c.id)
            }))
            .filter(o => o.id)
    };
}

/**
 * Formats the inventory summary line ("6/10 volume (60%)").
 * @param {{used: number, capacity: number, percent: number}} inventory - Normalized inventory.
 * @returns {string} The human-readable line.
 */
export function inventoryLine(inventory) {
    if (!inventory) return 'No capacity';
    return `${inventory.used}/${inventory.capacity} volume (${inventory.percent}%)`;
}

/**
 * Formats one production entry into its human sentence. The active case
 * states the rate and the current storage; the halted case names the cause
 * (organ broken vs host destroyed) instead of a misleading rate.
 * @param {{organType: string, itemName: string, countPerTurn: number,
 *   intervalTurns: number, active: boolean, organBroken: boolean,
 *   hostBroken: boolean, stored: number, capacity: number}} p - Normalized entry.
 * @returns {string} The production sentence.
 */
export function productionLine(p) {
    if (!p || !p.active) {
        if (p && p.organBroken) return `Production halted — the ${p.organType} organ is broken.`;
        if (p && p.hostBroken) return 'Production halted — the host component is destroyed.';
        return 'Production halted.';
    }
    const turns = p.intervalTurns === 1 ? 'turn' : 'turns';
    const storage = p.capacity > 0 ? `${p.stored}/${p.capacity} stored; when full, extras drop on the floor` : 'stored';
    return `Produces ${p.countPerTurn} ${p.itemName} every ${p.intervalTurns} ${turns} — ${storage}.`;
}

/**
 * Formats a 0–1 matter existence value as a percentage label ("92%"),
 * or "—" when the value is absent.
 * @param {number|null} existence - The 0–1 existence value.
 * @returns {string} The label.
 */
export function existenceLabel(existence) {
    return typeof existence === 'number' ? `${Math.round(existence * 100)}%` : '—';
}

/**
 * Total volume of the items hosted on one component — the "used" side of
 * that component's capacity (the same sum the server's capacity check
 * considers when a move targets it).
 * @param {Array<Object>|null|undefined} items - Normalized item list.
 * @param {string} componentId - The component to sum.
 * @returns {number}
 */
export function componentUsedVolume(items, componentId) {
    return (Array.isArray(items) ? items : [])
        .filter((i) => i && i.hostComponentId === componentId)
        .reduce((sum, i) => sum + (i.volume != null ? i.volume : 0), 0);
}

/**
 * Builds the move-picker options for one item: one entry per component of
 * the object. The current host is shown but disabled (moving to the same
 * component is a no-op the player does not need), and a bounded component
 * without enough free volume is disabled as an ADVISORY preview — the
 * server re-checks capacity in InventoryManager on the move POST and its
 * rejection message is shown in the picker (server stays authoritative).
 *
 * Capacity semantics mirror the server check: a component capacity of
 * null/0 means "unbounded" (its definition has no volume form) and always
 * accepts; otherwise used + the item's volume must not exceed it.
 * @param {{id: string, name: string, volume: number|null,
 *   hostComponentId: string|null}} item - Normalized item to move.
 * @param {Array<Object>} items - Normalized item list (for the used sums).
 * @param {Array<Object>} components - Normalized component list.
 * @returns {Array<{id: string, type: string, current: boolean,
 *   disabled: boolean, capacityLabel: string}>}
 */
export function buildMoveOptions(item, items, components) {
    const comps = Array.isArray(components) ? components : [];
    const itemVol = item && item.volume != null ? item.volume : 0;
    return comps.map((c) => {
        const current = !!(item && item.hostComponentId === c.id);
        const unbounded = c.volume == null || c.volume <= 0;
        const used = componentUsedVolume(items, c.id);
        const fits = unbounded || used + itemVol <= c.volume;
        return {
            id: c.id,
            type: c.type,
            current,
            disabled: current || !fits,
            capacityLabel: unbounded ? 'unbounded' : `${used}/${c.volume} vol`
        };
    });
}

/**
 * HTML for the move-picker sub-panel: a title naming the item (with a
 * cancel control), one option row per component (current host and
 * no-space components disabled), and the result line of the last move POST
 * (success or the server's rejection message). Pure — unit-testable in
 * node like the other shapers; every interpolated value is escaped.
 * @param {{id: string, name: string}} item - Normalized item being moved.
 * @param {Array<Object>} options - buildMoveOptions() output.
 * @param {{ok: boolean, text: string}|null} message - Result line, or null.
 * @returns {string} HTML.
 */
export function renderMovePickerHTML(item, options, message) {
    const rows = (Array.isArray(options) ? options : [])
        .map((o) => {
            const cls = o.disabled
                ? `ov-move-option ${o.current ? 'is-current' : 'is-full'}`
                : 'ov-move-option';
            const tag = o.current
                ? ' <span class="ov-move-tag">(current)</span>'
                : (o.disabled ? ' <span class="ov-move-tag">not enough volume</span>' : '');
            return `<div class="${cls}" data-comp-id="${escapeHtml(o.id)}">` +
                `<span class="ov-move-comp-name">${escapeHtml(o.type)}${tag}</span>` +
                `<span class="ov-move-cap">${escapeHtml(o.capacityLabel)}</span>` +
                `</div>`;
        })
        .join('');
    const msg = message
        ? `<div class="${message.ok ? 'ov-move-ok' : 'ov-move-error'}">${escapeHtml(message.text)}</div>`
        : '';
    return `<div class="ov-move-picker" data-item-id="${escapeHtml(item ? item.id : '')}">` +
        `<div class="ov-move-title">Move ${escapeHtml(item ? item.name : '')} — choose the receiving component` +
        `<span class="ov-move-close" role="button">✕ cancel</span></div>` +
        rows +
        msg +
        `</div>`;
}

/**
 * Builds the take-picker options for one item: one row per component of
 * every non-static entity in the world (the entities an item can be given
 * to — e.g. the player's droid). Capacity semantics mirror the server's
 * take check: capacity null means "unbounded" (the definition has no
 * volume form) and always accepts; otherwise used + the item's volume
 * must not exceed it. The preview is advisory — the server re-validates on
 * the take POST and its rejection message is shown in the picker (server
 * stays authoritative).
 * @param {Array<{id: string, name: string, components: Array<{id:
 *   string, type: string, used: number, capacity: number|null}>}>} takeOptions -
 *   Normalized take options (from the payload).
 * @param {number|null} itemVolume - The item's volume (0 if unknown).
 * @returns {Array<{entityId: string, entityName: string, id: string,
 *   type: string, disabled: boolean, capacityLabel: string}>}
 */
export function buildTakeOptions(takeOptions, itemVolume) {
    const vol = itemVolume != null ? itemVolume : 0;
    const out = [];
    for (const entity of Array.isArray(takeOptions) ? takeOptions : []) {
        if (!entity || !entity.id) continue;
        for (const c of Array.isArray(entity.components) ? entity.components : []) {
            if (!c || !c.id) continue;
            const unbounded = c.capacity == null || c.capacity <= 0;
            const used = typeof c.used === 'number' ? c.used : 0;
            const fits = unbounded || used + vol <= c.capacity;
            out.push({
                entityId: entity.id,
                entityName: entity.name || entity.id,
                id: c.id,
                type: c.type,
                disabled: !fits,
                capacityLabel: unbounded ? 'unbounded' : `${used}/${c.capacity} vol`
            });
        }
    }
    return out;
}

/**
 * HTML for the take-picker sub-panel: a title naming the item (with a
 * cancel control), one option row per component of every non-static
 * entity in the world (no-space components disabled), an explanatory line
 * when the world has no receiving entity, and the result line of the last
 * take POST (success or the server's rejection message). Pure —
 * unit-testable in node like the other shapers; every interpolated value
 * is escaped.
 * @param {{id: string, name: string}} item - Normalized item being taken.
 * @param {Array<Object>} options - buildTakeOptions() output.
 * @param {{ok: boolean, text: string}|null} message - Result line, or null.
 * @returns {string} HTML.
 */
export function renderTakePickerHTML(item, options, message) {
    const rows = (Array.isArray(options) ? options : [])
        .map((o) => {
            const cls = o.disabled
                ? 'ov-move-option is-full ov-take-option'
                : 'ov-move-option ov-take-option';
            const tag = o.disabled ? ' <span class="ov-move-tag">not enough volume</span>' : '';
            return `<div class="${cls}" data-entity-id="${escapeHtml(o.entityId)}" data-comp-id="${escapeHtml(o.id)}">` +
                `<span class="ov-move-comp-name">${escapeHtml(o.entityName)} → ${escapeHtml(o.type)}${tag}</span>` +
                `<span class="ov-move-cap">${escapeHtml(o.capacityLabel)}</span>` +
                `</div>`;
        })
        .join('');
    const empty = !rows
        ? '<div class="ov-empty-sm">No entities in this world can receive items — nothing to take to.</div>'
        : '';
    const msg = message
        ? `<div class="${message.ok ? 'ov-move-ok' : 'ov-move-error'}">${escapeHtml(message.text)}</div>`
        : '';
    return `<div class="ov-move-picker ov-take-picker" data-item-id="${escapeHtml(item ? item.id : '')}">` +
        `<div class="ov-move-title">Take ${escapeHtml(item ? item.name : '')} — choose where it goes` +
        `<span class="ov-move-close" role="button">✕ cancel</span></div>` +
        rows + empty + msg +
        `</div>`;
}

// =========================================================================
// Panel controller
// =========================================================================

/**
 * The Object Viewer panel. Constructible without a DOM (node tests); call
 * init() once, then show()/hide()/toggle()/refresh() per OverlayManager.
 */
export default class ObjectViewer {
    constructor() {
        /** @private {HTMLElement|null} */
        this._overlay = null;
        /** @private {HTMLElement|null} */
        this._content = null;
        /** @private {boolean} */
        this._initialized = false;
        /** @private {Object|null} Last good normalized payload (move re-renders use it) */
        this._lastPayload = null;
        /** @private {string|null} Inspected entity id (from the payload) */
        this._entityId = null;
        /** @private {string|null} Item id whose move picker is open (null = closed) */
        this._moveTarget = null;
        /** @private {{ok: boolean, text: string}|null} Last move POST result line */
        this._moveMessage = null;
        /** @private {{ok: boolean, text: string}|null} Last take POST result line */
        this._takeMessage = null;
        /** @private {boolean} A move POST is in flight (double-click guard) */
        this._moveInFlight = false;
        /** @private {Object|null} The acting droid ({id, spatial}) behind the panel's mutations (range gate, see _distanceToActor) */
        this._actor = null;
        /** @private {Function|null} Callback to retrieve a placed machine (App.js wires it to ActionExecutor). */
        this._retrieveHandler = null;
    }

    /**
     * Binds the panel to its overlay markup (idempotent). Resolves
     * #object-viewer-overlay / #object-viewer-content and wires the close
     * button.
     * @public
     */
    init() {
        if (this._initialized) return;
        this._overlay = document.getElementById('object-viewer-overlay');
        this._content = document.getElementById('object-viewer-content');
        if (!this._overlay || !this._content) {
            ClientLogger.error('ObjectViewer', 'Overlay or content element not found. Cannot init.');
            return;
        }
        const closeBtn = this._overlay.querySelector('.overlay-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hide());
        }
        // Single delegated listener for the whole content root: the content
        // HTML is rewritten on every render, so per-row listeners would be
        // garbage; delegation survives re-renders (same pattern as the
        // spatial map).
        this._content.addEventListener('click', (e) => this._handleContentClick(e));
        this._initialized = true;
        this._overlay.style.display = 'none';
    }

    /**
     * Shows the overlay and renders the given (normalized-or-raw) payload.
     * @param {Object|null} data - The inspection payload (the fetch result);
     *   null renders the fetch-failure state.
     * @public
     */
    show(data) {
        if (!this._initialized) this.init();
        if (!this._overlay) return;
        this._overlay.style.display = 'block';
        this._render(data);
    }

    /**
     * Hides the overlay.
     * @public
     */
    hide() {
        if (this._overlay) this._overlay.style.display = 'none';
    }

    /**
     * Toggles the overlay.
     * @public
     */
    toggle() {
        if (this._overlay && this._overlay.style.display === 'block') {
            this.hide();
        } else {
            this.show();
        }
    }

    /**
     * True while the overlay is visible (App.js uses this to decide whether
     * to live-refresh the payload on a world-state-update broadcast).
     * @returns {boolean}
     * @public
     */
    isVisible() {
        return !!(this._overlay && this._overlay.style.display === 'block');
    }

    /**
     * The panel's root overlay element (for the OverlayManager).
     * @returns {HTMLElement|null}
     * @public
     */
    get overlay() {
        return this._overlay;
    }

    /**
     * Re-renders the current payload without changing visibility — the
     * live-refresh entry point (App.js calls it after a background fetch on
     * every world-state-update broadcast while the panel is open).
     * @param {Object|null} data - The fresh inspection payload.
     * @public
     */
    refresh(data) {
        if (!this._initialized) this.init();
        if (!this._overlay || this._overlay.style.display !== 'block') return;
        this._render(data);
    }

    /**
     * Sets the callback invoked by a placed machine's "Retrieve" button. The
     * handler receives the machine's entity id (App.js wires it to
     * ActionExecutor.retrieveMachine).
     * @param {Function|null} handler
     */
    setRetrieveHandler(handler) {
        this._retrieveHandler = handler;
    }

    /**
     * Registers the player's active droid as the actor of the panel's two
     * mutations (move/take). The viewer uses it for the advisory
     * out-of-reach banner, and both POST bodies carry its id so the server
     * can re-validate the same reach rule authoritatively. Pass null (or a
     * droid without spatial data) to clear it — the panel then degrades to
     * the legacy ungated behavior.
     * @param {Object|null} actor - The droid entity ({ id, spatial }).
     * @public
     */
    setActor(actor) {
        this._actor = (actor && actor.id && actor.spatial) ? actor : null;
    }

    /**
     * Euclidean distance from the actor to the inspected object, or null
     * when it cannot be computed (no actor registered, or missing spatial
     * data on either side). Out-of-range is computed against
     * AppConfig.OBJECT_INTERACT_RANGE — advisory only; the server
     * re-validates the same rule on both mutation POSTs.
     * @param {Object} payload - Normalized inspection payload.
     * @returns {number|null}
     * @private
     */
    _distanceToActor(payload) {
        const a = this._actor ? this._actor.spatial : null;
        const b = payload && payload.entity ? payload.entity.spatial : null;
        if (!a || typeof a.x !== 'number' || typeof a.y !== 'number'
            || !b || typeof b.x !== 'number' || typeof b.y !== 'number') return null;
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    // =========================================================================
    // Item move & take actions (the panel's two mutations — see module header)
    // =========================================================================

    /**
     * Delegated click handler for the content root. A movable item row
     * toggles that item's move picker; a picker option POSTs the move
     * (disabled options are ignored); the picker's cancel control closes
     * it.
     * @param {Event} e - The click event.
     * @private
     */
    _handleContentClick(e) {
        if (!e || !e.target || typeof e.target.closest !== 'function') return;

        const retrieve = e.target.closest('.ov-retrieve-btn');
        if (retrieve) {
            if (this._retrieveHandler && this._entityId) this._retrieveHandler(this._entityId);
            return;
        }

        const close = e.target.closest('.ov-move-close');
        if (close) {
            this._moveTarget = null;
            this._moveMessage = null;
            this._takeMessage = null;
            this._render(this._lastPayload);
            return;
        }

        const takeOption = e.target.closest('.ov-take-option');
        if (takeOption) {
            if (takeOption.classList.contains('is-full')) return;
            const picker = takeOption.closest('.ov-move-picker');
            this._takeItem(
                picker ? picker.getAttribute('data-item-id') : null,
                takeOption.getAttribute('data-entity-id'),
                takeOption.getAttribute('data-comp-id')
            );
            return;
        }

        const option = e.target.closest('.ov-move-option');
        if (option) {
            if (option.classList.contains('is-current') || option.classList.contains('is-full')) return;
            const picker = option.closest('.ov-move-picker');
            this._moveItem(
                picker ? picker.getAttribute('data-item-id') : null,
                option.getAttribute('data-comp-id')
            );
            return;
        }

        const row = e.target.closest('.ov-item-movable');
        if (row) {
            const itemId = row.getAttribute('data-item-id');
            if (!itemId) return;
            this._moveTarget = this._moveTarget === itemId ? null : itemId;
            this._moveMessage = null;
            this._render(this._lastPayload);
        }
    }

    /**
     * POSTs the item move to the existing inventory move endpoint
     * (POST /inventory/:entityId/move/:itemId, body { targetComponentId })
     * — the same facade path the inventory UI uses. On success the picker
     * closes and the world-state broadcast that the facade fires re-fetches
     * the payload through App's live-refresh path, so the item appears on
     * its new host in the next render. On failure (400 with the server's
     * message, or any transport error) the picker stays open with the
     * result line so the player can pick another component.
     * @param {string|null} itemId - The item to move.
     * @param {string|null} targetComponentId - The receiving component.
     * @private
     */
    async _moveItem(itemId, targetComponentId) {
        if (!itemId || !targetComponentId || this._moveInFlight || !this._entityId) return;
        this._moveInFlight = true;
        try {
            const url = `${AppConfig.ENDPOINTS.INVENTORY}/${encodeURIComponent(this._entityId)}` +
                `/move/${encodeURIComponent(itemId)}`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetComponentId, actorEntityId: this._actor ? this._actor.id : null })
            });
            if (response.ok) {
                this._moveMessage = { ok: true, text: 'Moved — the panel refreshes with the new layout.' };
                this._moveTarget = null;
            } else {
                const body = await response.json().catch(() => null);
                this._moveMessage = {
                    ok: false,
                    text: (body && (body.message || body.error)) || `Move failed (HTTP ${response.status}).`
                };
            }
        } catch (error) {
            ClientLogger.error('ObjectViewer', ' Item move failed:', error);
            this._moveMessage = { ok: false, text: 'Move failed — the request did not reach the server.' };
        } finally {
            this._moveInFlight = false;
        }
        this._render(this._lastPayload);
    }

    /**
     * POSTs the item take to the inventory take endpoint
     * (POST /inventory/:entityId/take/:itemId, body
     * { targetEntityId, targetComponentId }) — the cross-entity
     * counterpart of _moveItem: the item instance moves from the
     * inspected object to the chosen component of another entity (the
     * player's droid, picked from the take picker). On success the picker
     * closes and the world-state broadcast that the facade fires re-fetches
     * the payload through App's live-refresh path (the item is gone from
     * this object). On failure (400 with the server's message, or any
     * transport error) the picker stays open with the result line so the
     * player can pick another destination.
     * @param {string|null} itemId - The item to take.
     * @param {string|null} targetEntityId - The destination entity.
     * @param {string|null} targetComponentId - The receiving component.
     * @private
     */
    async _takeItem(itemId, targetEntityId, targetComponentId) {
        if (!itemId || !targetEntityId || !targetComponentId || this._moveInFlight || !this._entityId) return;
        this._moveInFlight = true;
        try {
            const url = `${AppConfig.ENDPOINTS.INVENTORY}/${encodeURIComponent(this._entityId)}` +
                `/take/${encodeURIComponent(itemId)}`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetEntityId, targetComponentId, actorEntityId: this._actor ? this._actor.id : null })
            });
            if (response.ok) {
                this._takeMessage = { ok: true, text: 'Taken — the item moves to the destination (world broadcast follows).' };
                this._moveTarget = null;
            } else {
                const body = await response.json().catch(() => null);
                this._takeMessage = {
                    ok: false,
                    text: (body && (body.message || body.error)) || `Take failed (HTTP ${response.status}).`
                };
            }
        } catch (error) {
            ClientLogger.error('ObjectViewer', ' Item take failed:', error);
            this._takeMessage = { ok: false, text: 'Take failed — the request did not reach the server.' };
        } finally {
            this._moveInFlight = false;
        }
        this._render(this._lastPayload);
    }

    // =========================================================================
    // Rendering
    // =========================================================================

    /**
     * Renders the payload into the content element. All values are escaped
     * (escapeHtml) — the payload comes from the server and must never be
     * interpolated raw.
     * @param {Object|null|undefined} data - The inspection payload (raw or
     *   normalized; normalizeObjectPayload accepts both shapes).
     * @private
     */
    _render(data) {
        if (!this._content) return;

        const payload = normalizeObjectPayload(data);
        if (!payload) {
            this._content.innerHTML =
                `<div class="ov-empty">Couldn't load this object's data.<br>` +
                `Close the panel and try again.</div>`;
            return;
        }
        // Remember the last good payload: the move action re-renders from it
        // after a POST, and the next live refresh replaces it with fresh data.
        this._lastPayload = payload;
        this._entityId = payload.entity.id;

        const distance = this._distanceToActor(payload);
        const outOfRange = distance != null && distance > AppConfig.OBJECT_INTERACT_RANGE;
        if (outOfRange && this._moveTarget) {
            // A refresh moved us out of range — drop the picker instead of
            // leaving mutations the server would now reject.
            this._moveTarget = null;
            this._moveMessage = null;
            this._takeMessage = null;
        }

        const parts = [];
        parts.push(this._renderHeader(payload.entity));
        parts.push(this._renderRetrieve(payload.entity));
        parts.push(this._renderProduction(payload.production));
        parts.push(this._renderInventory(payload.inventory, payload.items, payload.components, payload.takeOptions, outOfRange));
        parts.push(this._renderComponents(payload.components));

        this._content.innerHTML = parts.join('');
    }

    /**
     * The entity header block: name, object/entity badge, room, position.
     * @param {Object} entity - Normalized entity block.
     * @returns {string} HTML.
     * @private
     */
    _renderHeader(entity) {
        const badge = entity.isStatic ? 'Static object' : 'Entity';
        const where = entity.roomName
            ? ` in ${entity.roomName}`
            : '';
        const coords = (entity.spatial && typeof entity.spatial.x === 'number')
            ? ` · x ${entity.spatial.x}, y ${entity.spatial.y}`
            : '';
        return `<div class="ov-header">` +
            `<span class="ov-name">${escapeHtml(entity.name)}</span>` +
            `<span class="ov-badge">${escapeHtml(badge)}</span>` +
            `<span class="ov-where">${escapeHtml(where + coords)}</span>` +
            `</div>`;
    }

    /**
     * The "Retrieve machine" action, shown only for placed-machine objects. The
     * server enforces the retrieve range and returns produced items to the owner.
     * @param {Object} entity - Normalized entity.
     * @returns {string}
     * @private
     */
    _renderRetrieve(entity) {
        if (entity.isMachine !== true) return '';
        return `<div class="ov-section">` +
            `<button class="ov-retrieve-btn" type="button" title="Take this machine back (its produced items return to the owner)">🔧 Retrieve machine</button>` +
            `</div>`;
    }

    /**
     * The production section (the "how many knives per turn" answer).
     * Hidden entirely when the object has no producing organ — an empty
     * section is noise, not information.
     * @param {Array<Object>} production - Normalized production entries.
     * @returns {string} HTML ('' when empty).
     * @private
     */
    _renderProduction(production) {
        if (!Array.isArray(production) || production.length === 0) return '';
        const rows = production
            .map((p) => `<div class="ov-prod-row">${escapeHtml(productionLine(p))}</div>`)
            .join('');
        return `<div class="ov-section"><h4>Production</h4>${rows}</div>`;
    }

    /**
     * The inventory section: used/capacity line + bar, one item card per
     * stored item (name, description, volume badge), and — when a picker is
     * open for one of the items — the move-picker sub-panel. Every stored
     * item row is clickable: the picker lists all of the object's components
     * (the item's current host included, marked inert), so on a
     * single-component object the picker simply shows there is no other
     * destination.
     * @param {Object} inventory - Normalized inventory summary.
     * @param {Array<Object>} items - Normalized item list.
     * @param {Array<Object>} components - Normalized component list.
     * @returns {string} HTML.
     * @private
     */
    _renderInventory(inventory, items, components, takeOptions, outOfRange) {
        const pct = Math.max(0, Math.min(100, inventory.percent));
        const movable = Array.isArray(components) && components.length > 0 && !outOfRange;
        const rangeNote = outOfRange
            ? '<div class="ov-range-note">Out of reach — this object is beyond interaction range. Move closer to interact with it.</div>'
            : '';
        const itemRows = (Array.isArray(items) ? items : [])
            .map((i) => {
                const vol = i.volume != null ? `${i.volume} vol` : '';
                const desc = i.description
                    ? `<span class="ov-item-desc">${escapeHtml(i.description)}</span>`
                    : '';
                const move = movable ? '<span class="ov-item-move">⤴ move</span>' : '';
                const cls = movable ? 'ov-item-row ov-item-movable' : 'ov-item-row';
                const idAttr = movable ? ` data-item-id="${escapeHtml(i.id)}"` : '';
                const tip = i.description ? ` title="${escapeHtml(i.description)}"` : '';
                return `<div class="${cls}"${idAttr}${tip}>` +
                    `<span class="ov-item-name">${escapeHtml(i.name)}</span>` +
                    move +
                    (vol ? `<span class="ov-item-vol">${escapeHtml(vol)}</span>` : '') +
                    desc +
                    `</div>`;
            })
            .join('');
        let list = itemRows
            ? itemRows
            : '<div class="ov-empty-sm">Nothing stored.</div>';

        if (this._moveTarget) {
            const item = (Array.isArray(items) ? items : []).find((i) => i.id === this._moveTarget);
            if (item) {
                list += renderMovePickerHTML(item, buildMoveOptions(item, items, components), this._moveMessage);
                list += renderTakePickerHTML(item, buildTakeOptions(takeOptions, item.volume), this._takeMessage);
            } else {
                // The item vanished in a refresh (moved, removed) — drop the
                // picker instead of rendering it for a ghost.
                this._moveTarget = null;
                this._moveMessage = null;
                this._takeMessage = null;
            }
        }

        return `<div class="ov-section">` + rangeNote +
            `<h4>Inventory — ${escapeHtml(inventoryLine(inventory))}</h4>` +
            `<div class="ov-bar"><div class="ov-bar-fill" style="width:${pct}%"></div></div>` +
            list +
            `</div>`;
    }

    /**
     * The components section: one card per component — type, existence
     * (bar + label, broken badge), volume, the full stats table, and the
     * organs list with their shared generated descriptions.
     * @param {Array<Object>} components - Normalized component list.
     * @returns {string} HTML.
     * @private
     */
    _renderComponents(components) {
        const cards = (Array.isArray(components) ? components : [])
            .map((c) => this._renderComponentCard(c))
            .join('');
        if (!cards) return '';
        return `<div class="ov-section"><h4>Components</h4>${cards}</div>`;
    }

    /**
     * One component card.
     * @param {Object} c - Normalized component.
     * @returns {string} HTML.
     * @private
     */
    _renderComponentCard(c) {
        const frac = typeof c.existence === 'number' ? Math.max(0, Math.min(1, c.existence)) : 0;
        const brokenBadge = c.broken ? '<span class="ov-broken">BROKEN</span>' : '';
        const vol = c.volume != null ? ` · ${c.volume} volume` : '';

        // Stats table: every stat group → rows of "stat: value".
        const statRows = [];
        for (const [group, groupStats] of Object.entries(c.stats || {})) {
            if (!groupStats || typeof groupStats !== 'object') continue;
            for (const [key, value] of Object.entries(groupStats)) {
                if (value == null) continue;
                const shown = Array.isArray(value) ? value.join(', ') : value;
                statRows.push(`<tr><td>${escapeHtml(`${group}.${key}`)}</td><td>${escapeHtml(shown)}</td></tr>`);
            }
        }
        const statsTable = statRows.length
            ? `<table class="ov-stats">${statRows.join('')}</table>`
            : '';

        const organRows = (Array.isArray(c.internalComponents) ? c.internalComponents : [])
            .map((ic) => {
                const desc = ic.description ? `<div class="ov-organ-desc">${escapeHtml(ic.description)}</div>` : '';
                const broken = ic.broken === true ? ' <span class="ov-broken">BROKEN</span>' : '';
                return `<div class="ov-organ">` +
                    `<span class="ov-organ-type">${escapeHtml(ic.type)}</span>${broken}` +
                    desc +
                    `</div>`;
            })
            .join('');

        return `<div class="ov-comp">` +
            `<div class="ov-comp-head">` +
            `<span class="ov-comp-type">${escapeHtml(c.type)}</span>${brokenBadge}` +
            `<span class="ov-comp-exist">${escapeHtml(existenceLabel(c.existence))}${escapeHtml(vol)}</span>` +
            `</div>` +
            `<div class="ov-bar ov-bar-sm"><div class="ov-bar-fill" style="width:${Math.round(frac * 100)}%"></div></div>` +
            (organRows ? `<div class="ov-organs">${organRows}</div>` : '') +
            statsTable +
            `</div>`;
    }
}
