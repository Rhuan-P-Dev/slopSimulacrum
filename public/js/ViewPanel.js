/**
 * ViewPanel
 * The generic "what can I see?" inspector tab — the client surface of
 * GET /view/:id (src/controllers/core/ViewController.js, viewRoutes.js).
 *
 * Two inputs, both resolved through the same endpoint:
 *   - a click on the room-contents list (entities + dropped items of the
 *     focused room, taken from the latest world-state broadcast);
 *   - a pasted typed id (ent- / comp- / item- / eq-) in the form.
 *
 * The payload is fetched LIVE on every selection and re-fetched while the
 * panel is open on every world broadcast — the same contract as the Object
 * Viewer and the Agent View (inventory, existence and production stats move
 * every turn; a cached copy would lie).
 *
 * DOM contract (public/index.html):
 *   #view-overlay.overlay-panel
 *     .overlay-header > h3.overlay-title, #view-room-label, .overlay-close-btn
 *     .view-grid
 *       .view-left
 *         .view-list-label
 *         ul#view-list.view-list
 *         .view-paste-label
 *         .view-input-row > #view-id-input + #view-go
 *         #view-input-hint.view-input-hint
 *       #view-detail.view-detail
 *
 * Follows the client patterns: no app.locals (world state arrives via
 * syncWorldState() on each broadcast), no console.* (ClientLogger), no raw
 * HTML strings (all rendered text goes through textContent — the values are
 * server data or user paste, neither trusted as HTML).
 *
 * @module ViewPanel
 */
import { ID_PREFIXES, isPrefixed } from '../../shared/IdPrefixes.js';
import { AppConfig } from './Config.js';
import ClientLogger from '../utils/ClientLogger.js';

/**
 * Display order for the room list: entities first, dropped items after.
 * @type {{ [kind: string]: number }}
 */
const KIND_ORDER = { entity: 0, item: 1 };

/**
 * Display label + badge class for each payload `kind` (the `kind` field the
 * ViewController puts in the envelope).
 * @type {{ [kind: string]: { label: string, cls: string } }}
 */
const PAYLOAD_KIND = {
    entity: { label: 'Entity', cls: 'kind-entity' },
    component: { label: 'Component', cls: 'kind-component' },
    item: { label: 'Item', cls: 'kind-item' },
    clothing: { label: 'Clothing', cls: 'kind-clothing' },
};

/** Badge for an equipped id (an eq- prefix resolves to a kind 'item' payload). */
const EQUIPPED_BADGE = { label: 'Equipped', cls: 'kind-eq' };

/**
 * Returns the kind key of a typed id ('ENTITY' | 'COMPONENT' | 'ITEM' |
 * 'EQUIPPED'), or null when it has no known prefix — the route would answer
 * 400, so refuse client-side to avoid the wasted request.
 * @param {*} id
 * @returns {'ENTITY'|'COMPONENT'|'ITEM'|'EQUIPPED'|null}
 */
function idKind(id) {
    if (isPrefixed(id, ID_PREFIXES.ENTITY)) return 'ENTITY';
    if (isPrefixed(id, ID_PREFIXES.COMPONENT)) return 'COMPONENT';
    if (isPrefixed(id, ID_PREFIXES.ITEM)) return 'ITEM';
    if (isPrefixed(id, ID_PREFIXES.EQUIPPED)) return 'EQUIPPED';
    return null;
}

/**
 * Appends a plain (textContent-set) element to a parent. No HTML string —
 * every value is either a client literal or server/pasted text, and both
 * are rendered through textContent.
 * @param {HTMLElement|DocumentFragment} parent
 * @param {string} tag
 * @param {string} [className]
 * @param {string|null} [text]
 * @returns {HTMLElement}
 */
function addEl(parent, tag, className, text) {
    const el = document.createElement(tag);
    if (className) {
        el.className = className;
    }
    if (text !== undefined && text !== null && text !== '') {
        el.textContent = String(text);
    }
    parent.appendChild(el);
    return el;
}

/** "label: value" row. Fixed label width keeps long values visually aligned. */
function addRow(container, label, value) {
    const row = addEl(container, 'div', 'view-row');
    addEl(row, 'span', 'view-row-label', label);
    addEl(row, 'span', 'view-row-value', value);
    return row;
}

/** Inline badge (kind / status / worn). */
function addBadge(container, className, text) {
    addEl(container, 'span', className, text);
}

/**
 * `section-label` + body for a detail block. The body is hidden by default
 * (summary-only policy: raw ids, materials, organs and other detail live in
 * the body and appear only on Reveal); `.view-section-rows` sections keep the
 * summary rows visible at all times and hide only the per-row extra parts.
 * `static: true` renders a plain section with no toggle (summary content only).
 * @param {HTMLElement} container
 * @param {string} label
 * @param {{ rows?: boolean, static?: boolean }} [options]
 * @returns {{ body: HTMLElement }}
 */
function startSection(container, label, options = {}) {
    const section = addEl(container, 'div', 'view-section');
    if (options.rows) {
        section.classList.add('view-section-rows');
    }
    const head = addEl(section, 'div', 'view-section-head');
    addEl(head, 'span', 'view-section-label', label);
    if (!options.static) {
        const toggle = addEl(head, 'button', 'view-section-toggle');
        toggle.type = 'button';
        toggle.textContent = 'Reveal';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.addEventListener('click', () => {
            const open = section.classList.toggle('open');
            toggle.textContent = open ? 'Hide' : 'Reveal';
            toggle.setAttribute('aria-expanded', String(open));
        });
    }
    const body = addEl(section, 'div', 'view-section-body');
    if (options.static) {
        section.classList.add('static');
    }
    return { body };
}

/** Human-readable percentage of a material fraction (a fraction >= 1 is full). */
function formatFraction(fraction) {
    if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return null;
    return fraction >= 1 ? '100%' : Math.round(fraction * 100) + '%';
}

/** Renders the payload's `materials` array as composition badges (label first). */
function addMaterialBadges(container, materials) {
    if (!Array.isArray(materials) || materials.length === 0) return;
    addEl(container, 'p', 'view-section-label', 'Materials');
    const row = addEl(container, 'div', 'view-materials');
    for (const m of materials) {
        const badge = addEl(row, 'span', 'view-material-badge');
        const label = (m && typeof m === 'object') ? (m.material ?? 'material') : String(m);
        const fraction = formatFraction(m?.fraction);
        badge.textContent = fraction ? `${label} ${fraction}` : label;
    }
}

/**
 * Renders a component's internal organs (the enriched `description` comes
 * from InternalComponentUtils.enrichWithDescriptions in the payload).
 */
function addOrgans(container, organs) {
    if (!Array.isArray(organs) || organs.length === 0) {
        addRow(container, 'Internal components', 'none');
        return;
    }
    const body = startSection(container, 'Internal components').body;
    for (const ic of organs) {
        const block = addEl(body, 'div', 'view-organ');
        if (ic && typeof ic === 'object' && typeof ic.type === 'string') {
            addEl(block, 'span', 'view-organ-name', ic.type);
        }
        if (ic && typeof ic === 'object' && typeof ic.description === 'string' && ic.description) {
            addEl(block, 'span', 'view-organ-desc', ' ' + ic.description);
        }
    }
}

/**
 * Renders one flat inventory row (entity full inventory, hosted component
 * items, container contents).
 * @param {HTMLElement} container
 * @param {Object} item
 */
function addItemRow(container, item) {
    if (!item || typeof item !== 'object') return;
    const row = addEl(container, 'div', 'view-item-row');
    // Summary part (always visible): name + volume + worn flag. Raw ids and
    // host component ids are reveal-only extras, hidden by CSS until the
    // reveal of the section (or component block) that holds this row opens.
    addEl(row, 'span', 'view-item-name', item.name || (item.type ?? item.itemType ?? 'item'));
    if (typeof item.volume === 'number' && Number.isFinite(item.volume)) {
        addEl(row, 'span', 'view-item-vol', 'vol ' + item.volume);
    }
    if (item.worn === true) {
        addBadge(row, 'view-badge worn', 'worn');
    }
    const extras = [];
    if (item.id) {
        extras.push('(' + item.id + ')');
    }
    if (item.hostComponentId) {
        extras.push('on ' + item.hostComponentId);
    }
    if (extras.length > 0) {
        addEl(row, 'span', 'view-item-extra', extras.join(' · '));
    }
}

/** Status line for a component node (existence, broken flag, volume). */
function componentStatusLine(comp) {
    const parts = [];
    if (typeof comp.exists === 'boolean' && comp.exists === false) {
        parts.push('non-existent');
    }
    if (comp.broken === true) {
        parts.push('broken');
    }
    if (typeof comp.existence === 'number' && Number.isFinite(comp.existence)) {
        parts.push('existence ' + comp.existence + '%');
    }
    if (typeof comp.volume === 'number' && Number.isFinite(comp.volume)) {
        parts.push('vol ' + comp.volume);
    }
    return parts.join(' · ');
}

/**
 * Renders one component node (as a block of an entity view, or as the whole
 * payload). When `showName` is false the detail header already carries the
 * name, so the block starts straight at status.
 */
function renderComponentNode(container, comp, showName) {
    if (!comp || typeof comp !== 'object') return;
    if (comp.kind === 'clothing') {
        renderClothingNode(container, comp, showName);
        return;
    }
    // Summary = component name (always visible). Detail (status, materials,
    // organs, stored items) is collapsed behind the per-block Reveal toggle.
    const { detail } = addComponentBlock(container, showName,
        comp.name || comp.type || comp.id || 'component');
    const statusBody = startSection(detail, 'Status').body;
    addRow(statusBody, 'Status', componentStatusLine(comp) || '—');
    if (comp.broken === true) {
        addBadge(statusBody, 'view-badge broken', 'broken');
    }
    addMaterialBadges(statusBody, comp.materials);
    addOrgans(statusBody, comp.internalComponents);

    const items = Array.isArray(comp.items) ? comp.items : [];
    if (items.length > 0) {
        const itemBody = startSection(detail, `Stored items (${items.length})`, { rows: true }).body;
        items.forEach((it) => addItemRow(itemBody, it));
    }
}

/**
 * A named, collapsible component block: always-visible name row plus a
 * Reveal toggle that opens the hidden detail container. Returns the detail
 * container to fill.
 */
function addComponentBlock(container, showName, label) {
    if (showName) {
        const block = addEl(container, 'div', 'view-component-block');
        const head = addEl(block, 'div', 'view-component-head');
        addEl(head, 'span', 'view-component-name', label);
        const toggle = addEl(head, 'button', 'view-section-toggle');
        toggle.type = 'button';
        toggle.textContent = 'Reveal';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.addEventListener('click', () => {
            const open = block.classList.toggle('open');
            toggle.textContent = open ? 'Hide' : 'Reveal';
            toggle.setAttribute('aria-expanded', String(open));
        });
        return { detail: addEl(block, 'div', 'view-component-detail') };
    }
    return { detail: container };
}

/**
 * Renders one clothing node (payload kind that replaces a component slot per
 * the clothes rule; as a block of an entity view or as the whole payload).
 */
function renderClothingNode(container, node, showName) {
    if (!node || typeof node !== 'object') return;
    const worn = Array.isArray(node.worn) ? node.worn : [];
    if (showName) {
        // Summary = first worn entry name (always visible). The component id
        // that owns the clothing is detail, not a summary row.
        const first = worn.length > 0 ? worn[0] : null;
        const label = first
            ? (first.name || first.itemType || 'clothing')
            : (node.componentId ? 'Clothing item' : 'clothing');
        const { detail } = addComponentBlock(container, true, label);
        if (node.componentId) {
            addEl(detail, 'p', 'view-detail-sub', 'Worn on ' + node.componentId);
        }
        wornRows(detail, worn);
        return;
    }
    const body = startSection(container, `Worn (${worn.length})`, { rows: true }).body;
    wornRows(body, worn);
}

/** Summary rows for worn clothing entries: name + form volume + WORN always
 * visible; entry id, materials and minVolume are reveal-only extras. */
function wornRows(container, entries) {
    if (entries.length === 0) {
        addRow(container, 'Entries', 'none');
        return;
    }
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const row = addEl(container, 'div', 'view-item-row view-clothing-entry');
        addEl(row, 'span', 'view-item-name', entry.name || (entry.itemType ?? 'clothing'));
        const form = entry.form && typeof entry.form === 'object' ? entry.form : null;
        if (form && typeof form.volume === 'number' && Number.isFinite(form.volume)) {
            addEl(row, 'span', 'view-item-vol', 'vol ' + form.volume);
        }
        addBadge(row, 'view-badge worn', 'worn');
        const extra = addEl(row, 'span', 'view-item-extra');
        const parts = [];
        if (entry.itemId) {
            parts.push('(' + entry.itemId + ')');
        }
        const mats = Array.isArray(entry.materials) ? entry.materials : [];
        for (const m of mats) {
            const badge = addEl(extra, 'span', 'view-material-badge');
            const label = (m && typeof m === 'object') ? (m.material ?? 'material') : String(m);
            const fraction = formatFraction(m?.fraction);
            badge.textContent = fraction ? `${label} ${fraction}` : label;
        }
        const wear = entry.wear && typeof entry.wear === 'object' ? entry.wear : null;
        if (wear && typeof wear.minVolume === 'number') {
            parts.push('wear.minVolume ' + wear.minVolume);
        }
        if (parts.length > 0) {
            addEl(extra, 'span', 'view-item-meta', parts.join(' · '));
        }
    }
}

/**
 * Renders the entity detail: entity header sub (room, position, flags),
 * inventory totals, one block per component (component or clothing node) and
 * the flat full inventory (worn items included, flagged `worn`).
 */
function renderEntity(detail, node) {
    const ent = node.entity && typeof node.entity === 'object' ? node.entity : {};
    const roomName = ent.roomName ?? ent.roomId ?? null;
    const spatial = ent.spatial && typeof ent.spatial === 'object' ? ent.spatial : null;
    const parts = [];
    if (roomName) {
        parts.push(`room ${roomName}`);
    }
    if (spatial && (spatial.x !== undefined || spatial.y !== undefined)) {
        parts.push(`pos (${spatial.x ?? 0}, ${spatial.y ?? 0})`);
    }
    if (ent.isStatic === true) {
        parts.push('static');
    }
    if (ent.isMachine === true) {
        parts.push('machine' + (ent.machineType ? ' ' + ent.machineType : ''));
    }
    if (ent.blueprint) {
        parts.push('blueprint ' + ent.blueprint);
    }
    if (parts.length > 0) {
        addEl(detail, 'p', 'view-detail-sub', parts.join(' · '));
    }

    const inv = node.inventory && typeof node.inventory === 'object' ? node.inventory : {};
    const used = typeof inv.used === 'number' && Number.isFinite(inv.used) ? inv.used : 0;
    const capacity = typeof inv.capacity === 'number' && Number.isFinite(inv.capacity) ? inv.capacity : 0;
    const percent = typeof inv.percent === 'number' && Number.isFinite(inv.percent) ? inv.percent : 0;
    const invBody = startSection(detail, 'Inventory', { static: true }).body;
    addRow(invBody, 'Capacity', `${used} / ${capacity} (${percent}%)`);

    // Components: summary = name (always visible); detail (status, materials,
    // organs, stored items) is collapsed behind each block's Reveal toggle.
    const components = Array.isArray(node.components) ? node.components : [];
    if (components.length > 0) {
        const compBody = startSection(detail, `Components (${components.length})`, { rows: true }).body;
        components.forEach((comp) => renderComponentNode(compBody, comp, true));
    } else {
        addEl(startSection(detail, 'Components', { static: true }).body, 'p', 'view-placeholder', 'none');
    }

    // Full inventory: summary rows (name + vol + WORN) always visible; raw ids
    // and "on comp-…" are reveal-only per-row extras.
    const items = Array.isArray(node.items) ? node.items : [];
    if (items.length > 0) {
        const itemBody = startSection(detail, `Inventory contents (${items.length})`, { rows: true }).body;
        items.forEach((it) => addItemRow(itemBody, it));
    }
}

/**
 * Renders a standalone component detail (the whole payload is a component
 * node — the component's own name is already in the detail header).
 */
function renderComponent(detail, node) {
    renderComponentNode(detail, node, false);
}

/**
 * Renders the standalone clothing detail (the whole payload is a clothing
 * node — the header already shows "Clothing on <comp id>", so the node body
 * starts at "Worn").
 */
function renderClothing(detail, node) {
    renderClothingNode(detail, node, false);
}

/**
 * Renders the item detail (item- / eq- ids resolve to kind 'item'). Summary
 * (always visible) is name + live volume + WORN. Everything else — description,
 * type/owner, form, materials, wear, host, contents, traits — is inside the
 * collapsed Details section and only appears on Reveal.
 */
function renderItem(detail, node) {
    const name = node.name || (node.itemType ?? 'item');
    // Summary row (always visible): name + live volume + worn flag.
    const summary = addEl(detail, 'div', 'view-item-row view-item-summary');
    addEl(summary, 'span', 'view-item-name', name);
    if (typeof node.volume === 'number' && Number.isFinite(node.volume)) {
        addEl(summary, 'span', 'view-item-vol', 'vol ' + node.volume);
    }
    if (node.worn === true) {
        addBadge(summary, 'view-badge worn', 'worn');
    }

    const body = startSection(detail, 'Details').body;

    if (node.description) {
        addEl(body, 'p', 'view-detail-sub', node.description);
    }
    const parts = [];
    if (node.itemType) {
        parts.push('type ' + node.itemType);
    }
    if (node.entityType) {
        parts.push('owned by ' + node.entityType);
    }
    if (parts.length > 0) {
        addEl(body, 'p', 'view-detail-sub', parts.join(' · '));
    }

    const form = node.form && typeof node.form === 'object' ? node.form : null;
    if (form && typeof form.volume === 'number') {
        addRow(body, 'Form volume', form.volume);
    }
    addMaterialBadges(body, node.materials);
    const wear = node.wear && typeof node.wear === 'object' ? node.wear : null;
    if (wear && typeof wear.minVolume === 'number') {
        addRow(body, 'Wear minVolume', wear.minVolume);
    }
    addRow(body, 'Worn', node.worn === true ? 'yes' : 'no');
    addRow(body, 'Host component', node.hostComponentId || '—');

    const contents = Array.isArray(node.contents) ? node.contents : [];
    if (contents.length > 0) {
        const contBody = startSection(body, `Contents (${contents.length})`, { rows: true }).body;
        contents.forEach((c) => addItemRow(contBody, c));
    }

    if (node.traits && typeof node.traits === 'object') {
        const traitBody = startSection(body, 'Traits').body;
        const traitParts = Object.entries(node.traits).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
        addEl(traitBody, 'p', 'view-row-value', traitParts.join(', '));
    }
}

/**
 * Degrades an unknown payload kind to the kind + field names (a future
 * node shape must never crash the detail pane).
 */
function renderUnknown(detail, node, askedId) {
    addEl(detail, 'p', 'view-detail-sub', askedId);
    const body = startSection(detail, 'Unknown payload shape').body;
    addRow(body, 'Kind', node.kind);
    addRow(body, 'Fields', Object.keys(node).join(', ') || 'none');
}

/**
 * Renders the detail header: kind badge(s) + node name + the raw id as sub
 * line. An equipped id (eq-) shows an "Equipped" badge on top of its item
 * payload kind.
 */
function renderDetailHeader(container, node, askedId, isEquipped) {
    const title = addEl(container, 'h3', 'view-detail-title', '');
    const payloadKind = (node && typeof node === 'object' && PAYLOAD_KIND[node.kind])
        ? PAYLOAD_KIND[node.kind]
        : null;
    if (isEquipped) {
        addBadge(title, `view-badge ${EQUIPPED_BADGE.cls}`, EQUIPPED_BADGE.label);
        addBadge(title, `view-badge ${payloadKind ? payloadKind.cls : EQUIPPED_BADGE.cls}`,
            payloadKind ? payloadKind.label : 'Item');
    } else if (payloadKind) {
        addBadge(title, `view-badge ${payloadKind.cls}`, payloadKind.label);
    } else {
        addBadge(title, 'view-badge kind-entity', 'View');
    }
    let name = null;
    if (node && typeof node === 'object') {
        if (isEquipped && node.name) {
            name = node.name;
        } else if (node.kind === 'entity' && node.entity && typeof node.entity === 'object') {
            name = node.entity.name || null;
        } else if (node.name) {
            name = node.name;
        }
        if (!name && node.kind === 'clothing') {
            const worn = Array.isArray(node.worn) ? node.worn : [];
            const first = worn.length > 0 ? worn[0] : null;
            name = first
                ? (first.name || first.itemType || 'clothing')
                : 'Worn';
        }
    }
    if (name) {
        addEl(title, 'span', 'view-detail-title-name', name);
    }
    addEl(container, 'p', 'view-detail-sub', askedId);
}

export default class ViewPanel {
    /**
     * Creates the panel. World state arrives via App.syncWorldState() on each
     * broadcast; nothing is injected.
     */
    constructor() {
        this._initialized = false;

        /** @type {HTMLElement|null} */
        this._overlay = null;
        /** @type {HTMLElement|null} */
        this._detailEl = null;
        /** @type {HTMLElement|null} */
        this._listEl = null;
        /** @type {HTMLElement|null} */
        this._roomLabelEl = null;
        /** @type {HTMLElement|null} */
        this._countEl = null;
        /** @type {HTMLElement|null} */
        this._inputEl = null;
        /** @type {HTMLElement|null} */
        this._goBtn = null;
        /** @type {HTMLElement|null} */
        this._hintEl = null;

        /** @type {Object|null} The latest world state received from App sync. */
        this._lastState = null;
        /** @type {string|null} The latest focused room id (active droid's room). */
        this._lastRoomId = null;

        /** @type {string|null} The id currently displayed in the detail pane. */
        this._detailId = null;
        /** @type {string|null} Kind key for the currently displayed id (badge). */
        this._detailKindKey = null;
        /** @type {string|null} The id of the in-flight fetch (dedupe guard). */
        this._pendingId = null;
        /** @type {string|null} Kind key of the in-flight fetch (badge on reload). */
        this._pendingKindKey = null;
        /** @type {number} Monotonic fetch token — only the latest fetch for
         * this detail slot may render its response.
         */
        this._viewFetchToken = 0;
    }

    /**
     * Idempotent DOM setup (called from show(); safe to call repeatedly).
     */
    init() {
        if (this._initialized) return;
        this._overlay = document.getElementById('view-overlay');
        this._detailEl = document.getElementById('view-detail');
        this._listEl = document.getElementById('view-list');
        this._roomLabelEl = document.getElementById('view-room-label');
        this._countEl = document.getElementById('view-list-count');
        this._inputEl = document.getElementById('view-id-input');
        this._goBtn = document.getElementById('view-go');
        this._hintEl = document.getElementById('view-input-hint');

        if (!this._overlay || !this._detailEl || !this._listEl) {
            ClientLogger.warn('ViewPanel', 'init: #view-overlay / #view-detail / #view-list not found — View tab disabled.');
            this._initialized = true;
            return;
        }

        const closeBtn = this._overlay.querySelector('.overlay-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hide());
        }
        if (this._goBtn) {
            this._goBtn.addEventListener('click', () => this._submitInput());
        }
        if (this._inputEl) {
            this._inputEl.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    this._submitInput();
                }
            });
        }
        this._initialized = true;
        this._overlay.style.display = 'none';
    }

    /**
     * OverlayManager contract: called with showData data (ignored here — the
     * panel owns its own live fetch and re-fetches on every world broadcast,
     * same as the Object Viewer / Agent View).
     * @param {*} [data]
     */
    show(data) {
        void data;
        this.init();
        if (!this._overlay) return;
        this._overlay.style.display = 'block';
        this._setRoomLabel();
        this._renderList();
        if (this._detailId) {
            this._doLoad(this._detailId, this._detailKindKey);
        } else {
            this._renderPlaceholder();
        }
    }

    hide() {
        if (this._overlay) {
            this._overlay.style.display = 'none';
        }
    }

    toggle() {
        if (this._overlay && this._overlay.style.display === 'block') {
            this.hide();
        } else {
            this.show(null);
        }
    }

    /**
     * OverlayManager contract (drag + z-index), same public shape as the
     * other panels (ObjectViewer, KnowledgePanel, CraftingPanel, ...).
     */
    get overlay() {
        return this._overlay;
    }

    /**
     * Called by App.refreshWorldAndActions() on every world-state broadcast.
     * Re-lists the room contents (entities + dropped items move every turn)
     * and re-fetches the selected id's payload while the panel is open (live
     * data, same contract as Object Viewer / Agent View).
     * @param {Object|null} state - The latest world-state snapshot.
     * @param {string|null} roomId - The focused room id (active droid's room).
     */
    syncWorldState(state, roomId) {
        this._lastState = (state && typeof state === 'object') ? state : null;
        this._lastRoomId = (typeof roomId === 'string' && roomId) ? roomId : null;
        if (!this._initialized) return;
        this._setRoomLabel();
        if (!this.isVisible()) return;
        this._renderList();
        this.refreshIfOpen();
    }

    /**
     * Re-fetches the currently displayed id's payload (live data, no-op
     * when closed or when nothing is selected).
     */
    refreshIfOpen() {
        if (!this.isVisible() || !this._detailId) return;
        this._doLoad(this._detailId, this._detailKindKey);
    }

    isVisible() {
        return !!this._overlay && this._overlay.style.display === 'block';
    }

    /**
     * Builds the room-contents list from the latest world state: every entity
     * in the focused room (ent.location === roomId), then every dropped item
     * of that room. Without a focused room (no active droid), falls back to
     * all entities / all dropped items.
     * @param {Object|null} state
     * @param {string|null} roomId
     * @returns {Array<{ id: string, label: string, kind: 'entity'|'item' }>}
     */
    _buildRows(state, roomId) {
        const rows = [];
        if (!state || typeof state !== 'object') return rows;

        const entities = (state.entities && typeof state.entities === 'object') ? state.entities : {};
        for (const [id, ent] of Object.entries(entities)) {
            if (!ent || typeof ent !== 'object') continue;
            if (roomId && ent.location !== roomId) continue;
            rows.push({
                id,
                label: (typeof ent.name === 'string' && ent.name) ? ent.name : 'Droid',
                kind: 'entity',
            });
        }

        const dropped = (state.droppedItems && typeof state.droppedItems === 'object') ? state.droppedItems : {};
        for (const [id, item] of Object.entries(dropped)) {
            if (!item || typeof item !== 'object') continue;
            if (roomId && item.roomId !== roomId) continue;
            const label = (typeof item.name === 'string' && item.name)
                ? item.name
                : (typeof item.itemType === 'string' ? item.itemType : 'Item');
            rows.push({ id, label, kind: 'item' });
        }

        rows.sort((a, b) => {
            const order = (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99);
            if (order !== 0) return order;
            return String(a.label).localeCompare(String(b.label));
        });
        return rows;
    }

    /**
     * Renders the list, keeping the currently-displayed id highlighted.
     */
    _renderList() {
        if (!this._listEl) return;
        const rows = this._buildRows(this._lastState, this._lastRoomId);
        this._listEl.replaceChildren();
        for (const row of rows) {
            const li = addEl(this._listEl, 'li',
                'view-list-item' + (row.id === this._detailId ? ' view-list-selected' : ''));
            addEl(li, 'span', 'view-kind-icon', row.kind === 'entity' ? '🟢' : '🟠');
            const nameCell = addEl(li, 'div', '');
            addEl(nameCell, 'div', 'view-list-name', row.label);
            addEl(nameCell, 'div', 'view-list-id', row.id);
            li.addEventListener('click', () => this._select(row.id));
        }
        if (this._countEl) {
            this._countEl.textContent = '(' + rows.length + ')';
        }
    }

    /** Sets the room label in the overlay header. */
    _setRoomLabel() {
        if (!this._roomLabelEl) return;
        const rooms = (this._lastState && typeof this._lastState === 'object')
            ? this._lastState.rooms
            : null;
        const room = (rooms && typeof rooms === 'object') ? rooms[this._lastRoomId] : null;
        const name = (room && typeof room === 'object')
            ? (room.name || this._lastRoomId || null)
            : this._lastRoomId;
        this._roomLabelEl.textContent = (name || null) ? `Room: ${name}` : 'No room (no active droid)';
    }

    /**
     * Fetches the view payload for `id` (live — the payload reflects every
     * turn: inventory, existence, production stats). Only the newest fetch
     * for this id slot renders (stale-response guard).
     */
    _doLoad(id, kindKey) {
        if (!id || typeof id !== 'string' || id.length === 0) return;
        if (this._pendingId === id) return;
        this._pendingId = id;
        this._pendingKindKey = kindKey;
        const token = ++this._viewFetchToken;
        this._renderLoading(id);

        const url = AppConfig.ENDPOINTS.VIEW_LOOKUP + '/' + encodeURIComponent(id);
        fetch(url)
            .then((res) => res.json()
                .then((json) => ({ ok: res.ok, body: json, status: res.status }))
                .catch(() => ({ ok: res.ok, body: null, status: res.status })))
            .then(({ ok, body, status }) => {
                if (token !== this._viewFetchToken) return;
                if (ok) {
                    const node = (body && typeof body === 'object' && 'view' in body) ? body.view : null;
                    this._renderDetail(node, id, kindKey);
                } else {
                    const bodyMsg = (body && typeof body === 'object') ? body : null;
                    const message = (bodyMsg && typeof bodyMsg.error === 'string')
                        ? bodyMsg.error
                        : 'Request failed (non-2xx response)';
                    const details = (bodyMsg && typeof bodyMsg.details === 'string')
                        ? bodyMsg.details
                        : null;
                    const heading = status === 404
                        ? 'Not found'
                        : status === 400
                            ? 'Invalid id'
                            : 'Request failed';
                    this._renderNotFound(id, message, details, heading);
                }
            })
            .catch((error) => {
                if (token !== this._viewFetchToken) return;
                ClientLogger.error('ViewPanel', `failed to fetch view payload for "${id}":`, error);
                this._renderNotFound(id, `Could not reach the server: ${error?.message ?? String(error)}`,
                    null, 'Network error');
            })
            .finally(() => {
                if (token === this._viewFetchToken) {
                    this._pendingId = null;
                    this._pendingKindKey = null;
                }
            });
    }

    /**
     * Renders the payload's kind-specific detail (after the kind badge +
     * name + raw-id header).
     * @param {Object|null} node - The node inside the { view } envelope.
     * @param {string} askedId
     * @param {string|null} kindKey - Kind key from the id prefix (badge).
     */
    _renderDetail(node, askedId, kindKey) {
        this._detailId = askedId;
        this._detailKindKey = kindKey;
        if (!this._detailEl) return;
        this._detailEl.replaceChildren();
        renderDetailHeader(this._detailEl, node, askedId, kindKey === 'EQUIPPED');

        switch (node && typeof node === 'object' ? node.kind : null) {
            case 'entity':
                renderEntity(this._detailEl, node);
                break;
            case 'component':
                renderComponent(this._detailEl, node);
                break;
            case 'clothing':
                renderClothing(this._detailEl, node);
                break;
            case 'item':
                renderItem(this._detailEl, node);
                break;
            default:
                renderUnknown(this._detailEl, node ?? {}, askedId);
                break;
        }
    }

    /** Renders the loading placeholder for the id currently in flight. */
    _renderLoading(id) {
        if (!this._detailEl) return;
        this._detailEl.replaceChildren();
        addEl(this._detailEl, 'p', 'view-detail-title', 'Loading…');
        addBadge(this._detailEl, 'view-badge kind-entity', 'view');
        addEl(this._detailEl, 'p', 'view-raw-id', id);
        addEl(this._detailEl, 'p', 'view-placeholder', 'Fetching the view payload…');
    }

    /**
     * Renders the "not found / invalid id / network" state (404 / 400 /
     * fetch failure).
     * @param {string} id
     * @param {string} message
     * @param {string|null} [details] - Optional second error line from the
     *   server payload (404 `details`).
     * @param {string} [heading='Not found']
     */
    _renderNotFound(id, message, details, heading = 'Not found') {
        if (!this._detailEl) return;
        this._detailId = id;
        this._detailEl.replaceChildren();
        const title = addEl(this._detailEl, 'h3', 'view-detail-title', heading);
        addBadge(title, 'view-badge kind-entity', 'view');
        addEl(this._detailEl, 'p', 'view-error', message);
        if (typeof details === 'string' && details.length > 0) {
            addEl(this._detailEl, 'p', 'view-error', details);
        }
        addEl(this._detailEl, 'p', 'view-raw-id', id);
        addEl(this._detailEl, 'p', 'view-placeholder',
            'Try another id from the list on the left, or paste a new one.');
    }

    /** Renders the initial "pick something to inspect" state. */
    _renderPlaceholder() {
        if (!this._detailEl) return;
        this._detailEl.replaceChildren();
        addEl(this._detailEl, 'p', 'view-placeholder',
            'Pick an object from the list on the left (or paste an id — ent-, comp-, item- or eq- — ' +
            'into the form) to inspect it.');
    }

    /**
     * Sets the input hint (red text below the form). Hidden when empty.
     * @param {string|null} message
     */
    _setHint(message) {
        if (!this._hintEl) return;
        this._hintEl.textContent = message ?? '';
        this._hintEl.hidden = (message ?? '') === '';
    }

    /** Submits the pasted form (Go click or Enter key). */
    _submitInput() {
        const raw = this._inputEl ? (this._inputEl.value ?? '').trim() : '';
        if (!raw) return;
        const kindKey = idKind(raw);
        if (!kindKey) {
            this._setHint('Known id prefixes: ent-  comp-  item-  eq-');
            return;
        }
        this._setHint('');
        this._select(raw, kindKey);
    }

    /**
     * Sets a selected id as the detail target and fetches its payload.
     * @param {string} id
     * @param {string|null} [kindKey] - Kind key (defaults to idKind(id)).
     */
    _select(id, kindKey) {
        if (!id || typeof id !== 'string' || id.length === 0) return;
        this._detailId = id;
        this._detailKindKey = kindKey ?? idKind(id) ?? null;
        this._setHint('');
        this._doLoad(id, this._detailKindKey);
    }
}
