/**
 * app.js — UI logic for the action editor.
 *
 * Holds the in-memory `registry`, syncs the form to it on every change, and
 * renders the list, form, JSON, validation, diff, backups and reference panels.
 * The local store (editor/data/actions.json) is saved on every change (debounced);
 * "apply" is the single deliberate step that copies the store to the game's
 * data/actions.json (with a pre-apply backup).
 */

import { get, post } from './api.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let Vocab = null;        // /api/vocabulary
let registry = {};       // local action registry (editable)
let liveRegistry = {};   // game's current registry (reference/diff)
let activeKey = null;    // key in registry being edited; null = unnamed draft
let rangeTimer = null;
let refreshQueued = false;
const RANGE_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
function el(tag, cls = '', text = '') {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
}
function optList(options, current) {
    const s = el('select');
    for (const o of options) {
        const [v, t] = Array.isArray(o) ? o : [o, o];
        const opt = el('option', '', t);
        opt.value = v;
        if (v === current) opt.selected = true;
        s.appendChild(opt);
    }
    return s;
}
function populateSelect(sel, options, current) {
    sel.innerHTML = '';
    for (const o of options) {
        const [v, t] = Array.isArray(o) ? o : [o, o];
        const opt = el('option', '', t);
        opt.value = v;
        if (v === current) opt.selected = true;
        sel.appendChild(opt);
    }
    if (current !== undefined && ![...sel.options].some((o) => o.value === current)) sel.selectedIndex = 0;
}

const ui = {
    name: $('#name'), nameHint: $('#name-hint'),
    description: $('#description'), targetingType: $('#targetingType'),
    range: $('#range'), rangeHint: $('#range-hint'),
    requirements: $('#requirements'),
    consequences: $('#consequences'),
    failureConsequences: $('#failureConsequences'),
    reqCount: $('#req-count'), conseqCount: $('#conseq-count'), failCount: $('#fail-count'),
    search: $('#search'), list: $('#action-list'),
    jsonView: $('#json-view'),
    validation: $('#validation'), diff: $('#diff'), backups: $('#backups'),
    status: $('#status'), diffBadge: $('#diff-badge'),
    reference: $('#reference'), referenceBody: $('#reference-body'),
    toast: $('#toast'), footLocal: $('#foot-local'),
};

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------
function parseRange(value) {
    const v = String(value ?? '').trim();
    if (v === '') return undefined;
    if (RANGE_RE.test(v)) return Number(v);
    return v;
}
function parseNum(value) {
    const v = String(value ?? '').trim();
    if (v === '') return undefined;
    if (RANGE_RE.test(v)) return Number(v);
    return v;
}
function parseParamValue(value) {
    const v = String(value ?? '').trim();
    if (v === '') return undefined;
    if (v.startsWith('{') || v.startsWith('[')) {
        try { return JSON.parse(v); } catch { /* fall through */ }
    }
    if (RANGE_RE.test(v)) return Number(v);
    return v;
}
function esc(s) {
    return String(s ?? '').replace(/[&<>']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;' }[c]));
}
function toast(message, tone = 'ok') {
    ui.toast.hidden = false;
    ui.toast.textContent = message;
    ui.toast.className = `toast ${tone}`;
    setTimeout(() => (ui.toast.hidden = true), 3000);
}
const PLACEHOLDER_HINTS = {
    speed: ':Movement.move', value: ':Physical.strength', level: 'info|warn|error',
    message: 'text (use :placeholders)', channel: 'cut|impact|wear|heat|electricity|corrosion',
    trait: 'Physical|Movement|…', stat: 'strength|move|…', eventType: 'someEvent',
    damageSource: 'equippedItem.firstChild.volume', data: 'JSON',
};
function hintFor(key) { return PLACEHOLDER_HINTS[key] ?? ':placeholder'; }

// ---------------------------------------------------------------------------
// Vocab-driven option sets
// ---------------------------------------------------------------------------
const consequenceTypeOptions = () => Vocab.consequenceTypes.map((c) => [c.type, c.type]);
const consequenceTargetOptions = () => Vocab.consequenceTargets.map((t) => [t, t]);
const traitOptions = () => Vocab.traitGroups.map((t) => [t, t]);
const statOptions = () => Vocab.statNames.map((s) => [s, s]);
function specFor(type) {
    return Vocab.consequenceTypes.find((c) => c.type === type) ?? { params: { required: [], optional: [], desc: '' } };
}
function paramKeysFor(type, existingParams = {}) {
    const s = specFor(type).params;
    const keys = new Set(s.required);
    for (const k of s.optional) keys.add(k);
    for (const k of Object.keys(existingParams || {})) keys.add(k);
    return [...keys].sort();
}

// ---------------------------------------------------------------------------
// Reference panel (how actions execute)
// ---------------------------------------------------------------------------
function populateReference() {
    const steps = Vocab.pipeline
        .map((s) => `<div class="rf-step"><span class="step">${s.step}. ${esc(s.title)}</span> — <span class="det">${esc(s.detail)}</span></div>`)
        .join('');
    const types = Vocab.consequenceTypes
        .map((c) => `<div class="rf-step"><span class="step">${esc(c.type)}</span> — <span class="det">${esc(c.params.desc)}</span></div>`)
        .join('');
    ui.referenceBody.innerHTML = `
        <div class="rf-head">Execution pipeline</div>
        ${steps}
        <div class="rf-head" style="margin-top:16px">Range — grammar</div>
        <pre class="rf-gram" style="margin:0;background:var(--bg);padding:10px;border-radius:8px;font-family:var(--mono);font-size:12px;color:var(--muted);white-space:pre-wrap">${Vocab.rangeGrammar.rules
            .map((r) => `${r.name} = ${r.desc}`)
            .join('\n')}</pre>
        <div class="rf-head" style="margin-top:12px">Effects (consequences)</div>
        ${types}
        <p class="det" style="margin-top:10px">${esc(Vocab.pipelineNote)}</p>`;
}

// ---------------------------------------------------------------------------
// Sidebar list
// ---------------------------------------------------------------------------
function clientDiff(local, live) {
    const L = new Set(Object.keys(local ?? {}));
    const R = new Set(Object.keys(live ?? {}));
    const added = [...L].filter((k) => !R.has(k));
    const removed = [...R].filter((k) => !L.has(k));
    const changed = [...L].filter((k) => R.has(k) && JSON.stringify(local[k], undefined, 2) !== JSON.stringify(live[k], undefined, 2));
    return { added, removed, changed, same: added.length + removed.length + changed.length === 0 };
}
function isModified(key) {
    if (!Object.keys(liveRegistry).includes(key)) return true;
    return JSON.stringify(registry[key], undefined, 2) !== JSON.stringify(liveRegistry[key], undefined, 2);
}
function renderList() {
    const q = ui.search.value.toLowerCase();
    ui.list.innerHTML = '';
    const keys = Object.keys(registry).filter((k) => !q || k.toLowerCase().includes(q));
    const hasDraft = activeKey === null;
    const items = keys.map((k) => ({ key: k, label: k, draft: false }));
    if (hasDraft) items.push({ key: '____DRAFT____', label: '(unnamed draft)', draft: true });

    for (const item of items) {
        const li = el('li');
        if (item.key === activeKey || (item.draft && hasDraft)) li.classList.add('active');
        if (!item.draft && isModified(item.key)) {
            const m = el('span', 'a-mod'); m.textContent = '·'; li.appendChild(m);
        }
        const name = el('span', 'a-name'); name.textContent = item.label;
        const rm = el('button', 'a-remove', '×');
        rm.title = `Remove "${item.label}"`;
        rm.addEventListener('click', (e) => { e.stopPropagation(); if (!item.draft) removeAction(item.key); });
        li.append(name, rm);
        li.addEventListener('click', () => selectAction(item.draft ? null : item.key));
        ui.list.appendChild(li);
    }
}
function selectAction(key) {
    activeKey = key;
    renderForm();
    queueRefresh();
}
function removeAction(key) {
    delete registry[key];
    if (key === activeKey) activeKey = Object.keys(registry).length > 0 ? Object.keys(registry)[0] : null;
    renderForm();
    queueRefresh();
    toast(`Action "${key}" removed from the local store.`, 'ok');
}

// ---------------------------------------------------------------------------
// Form ↔ registry
// ---------------------------------------------------------------------------
function readCurrentAction() {
    return {
        name: ui.name.value.trim(),
        action: {
            description: ui.description.value,
            targetingType: ui.targetingType.value,
            range: parseRange(ui.range.value),
            requirements: readRequirements(),
            consequences: readConsequenceList(ui.consequences),
            failureConsequences: readConsequenceList(ui.failureConsequences),
        },
    };
}
function readRequirements() {
    return [...ui.requirements.querySelectorAll('.req')].map((row) => ({
        trait: row.querySelector('[data-k=trait]')?.value ?? '',
        stat: row.querySelector('[data-k=stat]')?.value ?? '',
        minValue: parseNum(row.querySelector('[data-k=minValue]')?.value),
    }));
}
function readRowParams(container) {
    const out = {};
    for (const row of container.querySelectorAll('.p-row')) {
        let key = '';
        const label = row.querySelector('.p-label');
        const keyInput = row.querySelector('.p-key');
        const valInput = row.querySelector('.p-value');
        if (label) key = label.textContent.trim();
        else if (keyInput) key = keyInput.value.trim();
        if (!key && valInput) continue;
        const v = valInput ? parseParamValue(valInput.value) : undefined;
        if (key && v !== undefined) out[key] = v;
    }
    return out;
}
function readConsequenceList(containerEl) {
    return [...containerEl.querySelectorAll('.conseq')].map((li) => ({
        type: li.querySelector('.c-type')?.value ?? '',
        target: li.querySelector('.c-target')?.value ?? '',
        params: readRowParams(li),
    }));
}
function commitCurrentToRegistry() {
    const { name, action } = readCurrentAction();
    if (activeKey) delete registry[activeKey];
    if (name) { registry[name] = action; activeKey = name; } else { activeKey = null; }
    return registry;
}
async function saveLocal() {
    const reg = commitCurrentToRegistry();
    await post('/api/store', { registry: reg }).catch(() => ({}));
    ui.footLocal.textContent = `local store: ${Object.keys(registry).length} actions · game: ${Object.keys(liveRegistry).length}`;
}
function buildRequirementRow(req = {}) {
    const row = el('div', 'req');
    const trait = optList(traitOptions(), req.trait); trait.dataset.k = 'trait';
    const stat = optList(statOptions(), req.stat); stat.dataset.k = 'stat';
    const mn = el('input'); mn.type = 'number'; mn.dataset.k = 'minValue';
    mn.style.padding = '5px 7px'; mn.style.border = '1px solid var(--line)'; mn.style.borderRadius = '6px';
    mn.style.background = 'var(--bg2)'; mn.style.color = 'var(--txt)'; mn.style.fontSize = '12.5px'; mn.style.minWidth = '90px';
    const rm = el('button', 'p-remove', '×');
    rm.title = 'Remove requirement';
    rm.style.background = 'none'; rm.style.border = '0'; rm.style.color = 'var(--muted)';
    rm.style.cursor = 'pointer'; rm.style.fontSize = '18px'; rm.style.lineHeight = '1'; rm.style.padding = '0 2px';
    rm.addEventListener('click', () => { row.remove(); queueRefresh(); });
    row.append(trait, stat, mn, rm);
    return row;
}
function buildConseqRow(conseq = {}) {
    const li = el('li'); li.className = 'conseq';
    const head = el('div', 'conseq__head');
    const typeSel = optList(consequenceTypeOptions(), conseq.type); typeSel.className = 'c-type';
    const targetSel = optList(consequenceTargetOptions(), conseq.target); targetSel.className = 'c-target';
    const hint = el('span', 'conseq__type-hint');
    const rm = el('button', 'c-remove', '×'); rm.title = 'Remove effect';
    const paramsEl = el('div', 'conseq__params');

    const syncType = () => {
        const t = typeSel.value;
        hint.textContent = specFor(t).params.desc || '';
        writeParamRows(paramsEl, readRowParams(paramsEl), t);
        queueRefresh();
    };
    typeSel.addEventListener('change', syncType);
    rm.addEventListener('click', () => { li.remove(); queueRefresh(); });

    writeParamRows(paramsEl, conseq.params ?? {}, conseq.type ?? '');
    syncType();

    head.append(typeSel, targetSel, hint, rm);
    li.append(head, paramsEl);
    return li;
}
function writeParamRows(container, existingParams = {}, type = '') {
    container.innerHTML = '';
    const keys = paramKeysFor(type, existingParams || {});
    if (keys.length === 0) {
        container.appendChild(el('span', 'hint', 'No parameters defined for this effect'));
    }
    for (const key of keys) {
        const row = el('div', 'p-row');
        const label = el('span', 'p-label', key);
        const value = el('input', 'p-value'); value.value = existingParams[key] !== undefined ? String(existingParams[key]) : '';
        value.placeholder = hintFor(key);
        const rm = el('button', 'p-remove', '×'); rm.title = `Remove ${key}`;
        rm.addEventListener('click', () => { row.remove(); queueRefresh(); });
        row.append(label, value, rm);
        container.appendChild(row);
    }
    const extra = el('button', 'btn-sm', '+ custom parameter');
    extra.title = 'Add a parameter with a custom key';
    extra.addEventListener('click', () => {
        const row = el('div', 'p-row');
        const k = el('input', 'p-key'); k.placeholder = 'key';
        const v = el('input', 'p-value'); v.placeholder = 'value';
        const rm = el('button', 'p-remove', '×');
        rm.addEventListener('click', () => { row.remove(); queueRefresh(); });
        row.append(k, v, rm);
        container.appendChild(row);
        refreshAll();
    });
    container.appendChild(extra);
}
function renderConsequenceRepeater(containerEl, items) {
    const arr = Array.isArray(items) ? items : [];
    containerEl.innerHTML = '';
    for (const c of arr) containerEl.appendChild(buildConseqRow(c));
}
function renderForm() {
    const action = activeKey ? (registry[activeKey] ?? {}) : {};
    ui.name.value = activeKey ?? '';
    ui.name.disabled = false;
    ui.nameHint.textContent = '';
    ui.description.value = action.description ?? '';
    ui.targetingType.value = action.targetingType || 'component';
    ui.range.value = action.range !== undefined ? String(action.range) : '';
    ui.rangeHint.textContent = '';
    ui.rangeHint.className = 'hint';
    ui.requirements.innerHTML = '';
    for (const r of action.requirements || []) ui.requirements.appendChild(buildRequirementRow(r));
    renderConsequenceRepeater(ui.consequences, action.consequences || []);
    renderConsequenceRepeater(ui.failureConsequences, action.failureConsequences || []);
    ui.reqCount.textContent = `(${ui.requirements.children.length})`;
    ui.conseqCount.textContent = `(${ui.consequences.children.length})`;
    ui.failCount.textContent = `(${ui.failureConsequences.children.length})`;
}

// ---------------------------------------------------------------------------
// Preview / JSON / validation / diff / status
// ---------------------------------------------------------------------------
function renderJson() {
    commitCurrentToRegistry();
    ui.jsonView.textContent = JSON.stringify(registry, undefined, 2);
}
function renderStatus() {
    const diff = clientDiff(registry, liveRegistry);
    let text;
    if (Object.keys(registry).length === 0) text = 'No actions';
    else if (diff.same) text = 'Local ↔ game: in sync';
    else text = `Local ↔ game: +${diff.added.length} −${diff.removed.length} ~${diff.changed.length}`;
    ui.status.textContent = text;
    ui.status.className = 'status';
    ui.status.dataset.state = diff.same ? 'ok' : 'diverged';
    const total = diff.added.length + diff.removed.length + diff.changed.length;
    ui.diffBadge.textContent = total > 0 ? `${total} pending` : '—';
    ui.diffBadge.classList.toggle('has', total > 0);
}
async function renderDiff() {
    ui.diff.innerHTML = '';
    if (clientDiff(registry, liveRegistry).same) {
        ui.diff.appendChild(el('div', 'd-block none', '✓ Local store and game are identical.'));
        return;
    }
    const diff = clientDiff(registry, liveRegistry);
    for (const [label, list, cls] of [
        ['Added (in local, not in game)', diff.added, 'added'],
        ['Removed (in game, not in local)', diff.removed, 'removed'],
        ['Changed', diff.changed, 'changed'],
    ]) {
        if (list.length === 0) continue;
        const block = el('div', 'd-block');
        block.appendChild(el('span', 'd-label', `${label}:`));
        const items = el('div', `d-items ${cls}`);
        for (const x of list) items.appendChild(el('span', '', esc(x)));
        block.append(items);
        ui.diff.appendChild(block);
    }
}
async function renderValidation() {
    const res = await post('/api/validate', { registry }).catch(() => ({ validation: { valid: false, count: 0, issues: [] } }));
    const validation = res?.validation || { valid: false, count: 0, issues: [] };
    ui.validation.innerHTML = '';
    if (validation.valid) {
        ui.validation.appendChild(el('li', 'ok', `✓ ${validation.count} actions — all valid`));
        return;
    }
    const issues = validation.issues || [];
    if (issues.length === 0) {
        ui.validation.appendChild(el('li', 'warn', '⚠ No issues.'));
        return;
    }
    const byAction = {};
    for (const i of issues) {
        const key = i.action ?? '(general)';
        if (!byAction[key]) byAction[key] = [];
        byAction[key].push(i);
    }
    for (const key of Object.keys(byAction).sort()) {
        const group = byAction[key];
        const li = el('li', group.some((x) => x.type === 'error') ? 'err' : 'warn');
        let html = `<strong>${esc(key)} — ${group.length}</strong><br>`;
        for (const i of group) html += `· <code>${esc(i.field)}</code> ${esc(i.message)}${i.type === 'warning' ? '<em>(suggestion)</em>' : ''}<br>`;
        li.innerHTML = html;
        ui.validation.appendChild(li);
    }
}
async function renderBackups() {
    const list = await get('/api/backups').catch(() => ({}));
    ui.backups.innerHTML = '';
    if (!Array.isArray(list) || list.length === 0) {
        ui.backups.appendChild(el('li', '', list ? 'no backups yet' : 'nothing yet'));
        return;
    }
    for (const b of list) {
        const li = el('li');
        const time = new Date(b.mtime).toLocaleString();
        li.append(el('span', 'bk-name', b.name), el('span', 'bk-time', ` · ${time}`));
        ui.backups.appendChild(li);
    }
}

// ---------------------------------------------------------------------------
// Refresh orchestration
// ---------------------------------------------------------------------------
async function refreshAll() {
    commitCurrentToRegistry();
    renderJson();
    renderStatus();
    renderList();
    await renderDiff();
    await renderValidation();
    await saveLocal();
}
function queueRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    setTimeout(async () => {
        refreshQueued = false;
        await refreshAll();
    }, 180);
}
async function loadStoreAndLive() {
    const [store, live] = await Promise.all([get('/api/store'), get('/api/live')]);
    registry = store ?? {};
    liveRegistry = live ?? {};
    ui.footLocal.textContent = `local store: ${Object.keys(registry).length} actions · game: ${Object.keys(liveRegistry).length}`;
}

// ---------------------------------------------------------------------------
// Range hint (live, via the engine's RangeResolver)
// ---------------------------------------------------------------------------
function scheduleRangeHint() {
    clearTimeout(rangeTimer);
    rangeTimer = setTimeout(async () => {
        const v = ui.range.value.trim();
        if (v === '') {
            ui.rangeHint.textContent = 'Empty (no limit).';
            ui.rangeHint.className = 'hint';
            return;
        }
        try {
            const res = await post('/api/validate-range', { range: v }).catch(() => ({}));
            const result = res.result ?? {};
            if (result.ok) {
                ui.rangeHint.textContent = `✓ ${result.value ?? v}${result.expression ? ' (expression)' : ''}`;
                ui.rangeHint.className = 'hint ok';
            } else {
                ui.rangeHint.textContent = `✗ ${result.note || 'invalid expression'}`;
                ui.rangeHint.className = 'hint err';
            }
        } catch {
            ui.rangeHint.textContent = '⚠ could not be validated';
            ui.rangeHint.className = 'hint warn';
        }
    }, 250);
}

// ---------------------------------------------------------------------------
// Wire + actions
// ---------------------------------------------------------------------------
function wire() {
    ui.search.addEventListener('input', queueRefresh);
    ui.name.addEventListener('input', queueRefresh);
    ui.description.addEventListener('input', queueRefresh);
    ui.targetingType.addEventListener('change', queueRefresh);
    ui.range.addEventListener('input', () => { queueRefresh(); scheduleRangeHint(); });
    for (const c of [ui.requirements, ui.consequences, ui.failureConsequences]) {
        c.addEventListener('input', queueRefresh);
        c.addEventListener('change', queueRefresh);
    }

    $('#btn-new').addEventListener('click', newAction);
    $('#add-requirement').addEventListener('click', () => { ui.requirements.appendChild(buildRequirementRow()); queueRefresh(); });
    $('#add-consequence').addEventListener('click', () => { ui.consequences.appendChild(buildConseqRow({ type: 'updateStat', target: 'target', params: {} })); queueRefresh(); });
    $('#add-failure-consequence').addEventListener('click', () => { ui.failureConsequences.appendChild(buildConseqRow({ type: 'updateStat', target: 'self', params: {} })); queueRefresh(); });

    $('#btn-reference').addEventListener('click', () => { ui.reference.hidden = !ui.reference.hidden; });
    $('#btn-reload-local').addEventListener('click', reloadFromLive);
    $('#btn-apply').addEventListener('click', applyToGame);
    $('#btn-revert').addEventListener('click', revertLive);

    document.querySelectorAll('.tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');
            const formPanel = document.querySelector('#tab-form');
            const jsonPanel = document.querySelector('#tab-json');
            if (formPanel) formPanel.hidden = tab.dataset.tab === 'json';
            if (jsonPanel) jsonPanel.hidden = tab.dataset.tab !== 'json';
        });
    });
}
async function newAction() {
    activeKey = null;
    ui.name.value = '';
    ui.name.disabled = false;
    ui.nameHint.textContent = '';
    ui.description.value = '';
    ui.targetingType.value = 'component';
    ui.range.value = '';
    ui.rangeHint.textContent = '';
    ui.rangeHint.className = 'hint';
    ui.requirements.innerHTML = '';
    renderConsequenceRepeater(ui.consequences, []);
    renderConsequenceRepeater(ui.failureConsequences, []);
    renderForm();
    ui.status.textContent = 'New action (draft) — give it a name to save it';
    ui.status.className = 'status';
    ui.status.dataset.state = 'loading';
    scheduleRangeHint();
    await queueRefresh();
}
async function applyToGame() {
    if (Object.keys(registry).length === 0) return toast('No actions in the local store.', 'err');
    const res = await post('/api/apply', { registry }).catch(() => ({}));
    if (res?.ok) {
        toast(`✓ Applied to game. Backup: ${res.result?.backupPath ?? ''}.`, 'ok');
        liveRegistry = await (get('/api/live').catch(() => ({})) ?? {});
    } else {
        toast(res?.error ?? 'Failed to apply.', 'err');
    }
    ui.status.textContent = res?.ok ? '✓ Applied to game' : 'Failed to apply';
    ui.status.className = 'status';
    ui.status.dataset.state = res?.ok ? 'ok' : 'error';
    renderBackups();
    queueRefresh();
}
async function reloadFromLive() {
    if (!confirm('Discard local edits and reload the game registry?')) return;
    const res = await post('/api/reload-local', {}).catch(() => ({}));
    registry = res?.local ?? await (get('/api/store').catch(() => ({})) ?? {});
    liveRegistry = await (get('/api/live').catch(() => ({})) ?? {});
    renderForm();
    toast('✓ Local store reloaded from game.', 'ok');
    queueRefresh();
}
async function revertLive() {
    if (!confirm('Restore the latest backup over data/actions.json?')) return;
    const res = await post('/api/revert', { backupPath: 'latest' }).catch(() => ({}));
    liveRegistry = await (get('/api/live').catch(() => ({})) ?? {});
    toast(res?.ok ? `✓ Restored from ${res.result?.backupPath ?? 'latest backup'}.` : (res?.error ?? 'Failed to restore.'), res?.ok ? 'ok' : 'err');
    renderForm();
    queueRefresh();
}

// ---------------------------------------------------------------------------
// Kick off
// ---------------------------------------------------------------------------
async function init() {
    ui.status.textContent = 'Loading…';
    ui.status.className = 'status';
    ui.status.dataset.state = 'loading';
    const voc = await get('/api/vocabulary');
    Vocab = voc;
    await loadStoreAndLive();
    populateSelect(ui.targetingType, Vocab.targetingTypes, 'component');
    populateReference();
    wire();
    renderBackups();
    if (Object.keys(registry).length > 0) {
        activeKey = Object.keys(registry)[0];
        renderForm();
        scheduleRangeHint();
    }
    await refreshAll();
}
init();
