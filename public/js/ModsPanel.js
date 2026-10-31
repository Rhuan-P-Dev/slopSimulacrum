/**
 * ModsPanel - see the packages, manage them.
 *
 * The view behind the menu's **Mods**. It renders what the server says about the
 * install (`GET /mods`) and offers the four things an operator can actually do:
 *
 *   - **Rescan** - read the package directory again (a package was added, edited
 *     or deleted on disk since the last look).
 *   - **Plan** - diff the packages against the live world definition, per kind,
 *     including what the world would quarantine and why (`POST /mods/plan`).
 *   - **Enable / Disable** - flip one package. The answer is `pending`, and the
 *     panel shows it as what it is: a change that takes effect at the next round
 *     boundary. Nothing here pretends the world changed the moment the box moved.
 *   - **Apply now** - ask for that boundary instead of waiting for it
 *     (`POST /mods/apply`). If a round is open the server says so and the change
 *     still lands at the boundary that was already coming; `applied: false` is a
 *     deferral with a named moment, and the panel says which.
 *
 * Why the panel reports rather than tracks. A mod change lands at a round
 * boundary, in a process that has no idea which browser is open. So there is no
 * subscription to "did my change apply": the panel re-reads `GET /mods` and shows
 * `pending` until the server stops reporting it. That is one truth, twice a click,
 * instead of a client that believes it knows.
 *
 * Every string that came from a package (id, description, an error message) is
 * escaped on the way in - those files are written by people this server does not
 * know.
 *
 * @module public/js/ModsPanel
 */
import ClientLogger from '/utils/ClientLogger.js';
import { escapeText } from '/utils/EscapeHtml.js';

/** How many quarantined definitions to list before "+N more". */
const LIST_CAP = 15;
/** How many JSON lines of a package file to show inline. */
const FILE_LINE_CAP = 200;

export class ModsPanel {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.contentEl - Where the view is rendered.
     * @param {HTMLElement} options.statusEl - One-line status (actions, errors).
     * @param {HTMLElement} [options.rescanEl] - Rescan button.
     * @param {HTMLElement} [options.planEl] - Plan button.
     * @param {HTMLElement} [options.applyEl] - Apply now button.
     */
    constructor({ contentEl, statusEl, rescanEl, planEl, applyEl }) {
        if (!contentEl || !statusEl) {
            throw new Error('ModsPanel: contentEl and statusEl are required.');
        }
        this._content = contentEl;
        this._status = statusEl;
        /** @private the last `GET /mods` answer, which is what the view renders */
        this._view = null;
        /** @private the last plan answer, kept so a re-render can show it again */
        this._plan = null;
        /** @private id of the package whose files are open, if any */
        this._openFiles = null;
        /** @private */
        this._busy = false;

        for (const [el, fn] of [[rescanEl, 'refresh'], [planEl, 'plan'], [applyEl, 'apply']]) {
            if (el) el.addEventListener('click', () => this[fn]());
        }
    }

    /**
     * Re-read the install. Called on open, after rescan, and after any toggle,
     * because the server is the one that knows whether a change has landed.
     * @param {boolean} [rescan=false] - Ask the server to re-read the directory first.
     * @returns {Promise<void>}
     */
    async refresh(rescan = false) {
        await this._run(() => this._load(rescan));
    }

    /**
     * Read the install and redraw. The unguarded half of `refresh()`, and the half
     * an action calls when it wants the rows to agree with the answer it just got.
     *
     * Why the split: `_run()` ignores a call while one is in flight, so an action
     * that re-reads the list through `refresh()` from inside its own `_run()` was
     * silently doing nothing - the button flipped its label on the server and the
     * row on screen kept saying the opposite until the next click. A real bug, found
     * by clicking.
     * @param {boolean} [rescan=false] - Ask the server to re-read the directory first.
     * @returns {Promise<void>}
     * @private
     */
    async _load(rescan = false) {
        const res = await fetch(rescan ? '/mods/rescan' : '/mods', { method: rescan ? 'POST' : 'GET' });
        const payload = await readJson(res);
        if (!res.ok) throw new Error(messageOf(payload, res.status));
        this._view = payload;
        this._render();
        if (rescan) this._setStatus('Package directory re-read.', 'dim');
    }

    /**
     * Diff the packages against the live definition and show the answer, including
     * the quarantine - a plan that would drop a definition is the reason to look
     * before applying.
     * @returns {Promise<void>}
     */
    async plan() {
        await this._run(async () => {
            const res = await fetch('/mods/plan', { method: 'POST' });
            const payload = await readJson(res);
            if (!res.ok) throw new Error(messageOf(payload, res.status));
            const plan = payload.plan || payload;
            this._plan = plan;
            this._render();
            // The server counts per kind; this only adds the counts up. It never
            // recomputes the diff, which is the whole point of asking for a plan.
            const changed = (plan.kinds || [])
                .reduce((sum, kind) => sum + (kind.addedCount ?? 0) + (kind.removedCount ?? 0) + (kind.changedCount ?? 0), 0);
            const quarantined = (plan.quarantine || []).length;
            this._setStatus(
                `Plan: ${changed} definition(s) would change against v${plan.fromVersion}, ${quarantined} would be refused.` +
                ((plan.kinds || []).some((kind) => kind.truncated) ? ' (some kinds truncated)' : ''),
                quarantined ? 'error' : 'ok'
            );
        });
    }

    /**
     * Ask for the change to land now. The server gates this on a round being open
     * and says which of the two happened.
     * @returns {Promise<void>}
     */
    async apply() {
        await this._run(async () => {
            const res = await fetch('/mods/apply', { method: 'POST' });
            const payload = await readJson(res);
            if (!res.ok) throw new Error(messageOf(payload, res.status));
            await this._load();
            if (payload.applied) {
                const report = payload.report || {};
                this._setStatus(
                    `Applied: definition v${report.version}${report.ok === false ? ' (some kinds failed - see the list)' : ''}.`,
                    report.ok === false ? 'error' : 'ok'
                );
            } else {
                this._setStatus(`A round is open. The change lands at the ${payload.appliesAt}.`, 'warn');
            }
        });
    }

    /**
     * Enable or disable one package.
     * @param {string} id
     * @param {boolean} enabled
     * @returns {Promise<void>}
     */
    async toggle(id, enabled) {
        await this._run(async () => {
            const res = await fetch(`/mods/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, {
                method: 'POST'
            });
            const payload = await readJson(res);
            if (!res.ok) throw new Error(messageOf(payload, res.status));
            // Re-read first, then say what happened. The row is the control: if the
            // line appears before the row has been redrawn, the operator reads "off"
            // while still looking at a button that says "Disable", and the next click
            // does the opposite of what they meant. `refresh()` re-renders from the
            // server's answer, so the row and the line arrive together.
            await this._load();
            this._setStatus(
                `${id} ${payload.enabled ? 'enabled' : 'disabled'} - ` +
                (payload.pending ? `takes effect at the ${payload.appliesAt}` : 'the world already matches'),
                'ok'
            );
        });
    }

    /**
     * Open a package's own files (manifest + every JSON file, each tagged with the
     * registry kind it feeds). This is the "why is my definition quarantined" view.
     * @param {string} id
     * @returns {Promise<void>}
     */
    async showFiles(id) {
        if (this._openFiles === id) {
            this._openFiles = null;
            this._render();
            return;
        }
        await this._run(async () => {
            const res = await fetch(`/mods/${encodeURIComponent(id)}/files`);
            const payload = await readJson(res);
            if (!res.ok) throw new Error(messageOf(payload, res.status));
            this._openFiles = id;
            this._filesPayload = payload;
            this._render();
        });
    }

    // ---------------------------------------------------------------- rendering

    /** @private Draw the whole view from the last server answer. */
    _render() {
        const view = this._view;
        if (!view) {
            this._content.innerHTML = '<p class="mods-empty">Loading...</p>';
            return;
        }
        const parts = [this._renderSummary(view), this._renderPackages(view)];
        const problem = this._renderProblems(view);
        if (problem) parts.push(problem);
        if (this._plan) parts.push(this._renderPlan());
        if (this._openFiles) parts.push(this._renderFiles());
        this._content.innerHTML = parts.join('');
        this._wireClicks();
    }

    /** @private The live definition, and whether a change is waiting. */
    _renderSummary(view) {
        const live = view.live || {};
        const counts = Object.entries(live.definitionCounts || {});
        const pending = view.pending
            ? `<p class="mods-pending">A change is waiting for the ${escapeText(view.appliesAt || 'next round boundary')}.</p>`
            : '';
        const failed = view.lastApply && view.lastApply.ok === false
            ? `<p class="mods-pending mods-pending--bad">The last apply did not fully land. ${escapeText(view.lastApply.error || '')}</p>`
            : '';
        return '<div class="mods-summary">' +
            `<p class="mods-live">Live definition <strong>v${escapeText(live.version ?? '?')}</strong>` +
            ` from <strong>${escapeText(counts.length)}</strong> kinds.</p>` +
            `<p class="mods-counts">${counts.map(([kind, n]) => `<span class="mods-chip">${escapeText(kind)} ${escapeText(n)}</span>`).join('')}</p>` +
            pending + failed +
            '</div>';
    }

    /** @private One row per package: what it is, what it feeds, whether it is on. */
    _renderPackages(view) {
        const rows = (view.mods || []).map((mod) => {
            const state = mod.blocked
                ? '<span class="mods-flag mods-flag--bad" title="installed, enabled, contributing nothing">blocked</span>'
                : (mod.enabled === false ? '<span class="mods-flag">off</span>' : '<span class="mods-flag mods-flag--on">on</span>');
            const official = mod.official ? '<span class="mods-flag mods-flag--official" title="Ships with the server (core- prefix)">official</span>' : '';
            const kinds = (mod.content || []).map((kind) => `<span class="mods-chip">${escapeText(kind)}</span>`).join('')
                || '<span class="mods-chip mods-chip--none">no definitions</span>';
            const requires = (mod.requires || []).length
                ? `<span class="mods-requires">requires ${escapeText(mod.requires.join(', '))}</span>` : '';
            const blocked = mod.blocked
                ? `<div class="mods-blocked">${escapeText(mod.blocked.message || '')}</div>` : '';
            return '<div class="mods-row">' +
                '<div class="mods-row-main">' +
                `<span class="mods-id">${escapeText(mod.id)}</span>` +
                `<span class="mods-version">v${escapeText(mod.version)}</span>` + official + state +
                `<div class="mods-kinds">${kinds}${requires}` +
                `<span class="mods-order" title="Load order: lower composes first, higher shadows it">order ${escapeText(mod.loadOrder)}</span></div>` + blocked +
                '</div>' +
                '<div class="mods-row-actions">' +
                `<button type="button" class="sim-btn sim-btn-small" data-toggle="${escapeText(mod.id)}" data-enabled="${mod.enabled === false ? '1' : '0'}">` +
                `${mod.enabled === false ? 'Enable' : 'Disable'}</button>` +
                `<button type="button" class="sim-btn sim-btn-small" data-files="${escapeText(mod.id)}">Files</button>` +
                '</div>' +
                '</div>';
        });
        return '<div class="mods-packages"><h3 class="mods-h">Packages (' + (view.mods || []).length + ')</h3>' +
            (rows.length ? rows.join('') : '<p class="mods-empty">No package in <code>data/mods/</code>.</p>') +
            '</div>';
    }

    /**
     * @private Packages that would not load, and packages that contribute nothing.
     *
     * Both come from the scan the server just did. A definition that a package
     * contributes but the world refuses is not here: it surfaces in the plan, next
     * to the kind it would have gone into.
     */
    _renderProblems(view) {
        const invalid = view.invalid || [];
        const blocked = view.blocked || [];
        if (!invalid.length && !blocked.length) return '';
        const cap = (list, render) => list.slice(0, LIST_CAP).map(render).join('') +
            (list.length > LIST_CAP ? `<p class="mods-more">+${list.length - LIST_CAP} more</p>` : '');
        return '<div class="mods-problems">' +
            (invalid.length
                ? `<h3 class="mods-h mods-h--bad">Packages that would not load (${invalid.length})</h3>` +
                  cap(invalid, (e) => `<div class="mods-bad"><strong>${escapeText(e.dir)}</strong>` +
                      (e.kind ? ` <span class="mods-chip">${escapeText(e.kind)}</span>` : '') +
                      ` - ${escapeText(e.code)}: ${escapeText(e.message)}</div>`)
                : '') +
            (blocked.length
                ? `<h3 class="mods-h mods-h--bad">Packages contributing nothing (${blocked.length})</h3>` +
                  cap(blocked, (b) => `<div class="mods-bad"><strong>${escapeText(b.id)}</strong> - ${escapeText(b.message)}</div>`)
                : '') +
            '</div>';
    }

    /** @private The last plan: the per-kind diff, then what would be refused. */
    _renderPlan() {
        const kinds = this._plan.kinds || [];
        const rows = kinds.filter((diff) => (diff.addedCount ?? diff.added?.length ?? 0)
            || (diff.removedCount ?? diff.removed?.length ?? 0)
            || (diff.changedCount ?? diff.changed?.length ?? 0)).map((diff) => {
            const bits = [
                diff.addedCount ? `+${diff.addedCount}` : '',
                diff.removedCount ? `-${diff.removedCount}` : '',
                diff.changedCount ? `~${diff.changedCount}` : ''
            ].filter(Boolean).join(' ');
            const names = [...(diff.added || []), ...(diff.removed || []), ...(diff.changed || [])]
                .slice(0, 8).join(', ');
            return `<div class="mods-plan-row"><span class="mods-plan-kind">${escapeText(diff.kind)}</span>` +
                `<span class="mods-plan-diff">${escapeText(bits)}</span>` +
                `<span class="mods-plan-names">${escapeText(names)}</span></div>`;
        });
        const quarantine = (this._plan.quarantine || []).map((q) =>
            `<div class="mods-bad"><strong>${escapeText(q.kind)}/${escapeText(q.key)}</strong>` +
            (q.scope ? ` <span class="mods-chip">${escapeText(q.scope)}</span>` : '') +
            ` - ${escapeText(q.reason)}</div>`);
        return '<div class="mods-plan"><h3 class="mods-h">Last plan (against v' + escapeText(this._plan.fromVersion) + ')</h3>' +
            (rows.length ? rows.join('') : '<p class="mods-empty">Nothing would change: the packages describe the definition the world runs.</p>') +
            (quarantine.length
                ? `<h3 class="mods-h mods-h--bad">Definitions the world refuses (${quarantine.length})</h3>` +
                  quarantine.slice(0, LIST_CAP).join('') +
                  (quarantine.length > LIST_CAP ? `<p class="mods-more">+${quarantine.length - LIST_CAP} more</p>` : '')
                : '') +
            '</div>';
    }

    /** @private The open package's files, with the JSON inline. */
    _renderFiles() {
        const payload = this._filesPayload;
        if (!payload || payload.id !== this._openFiles) return '';
        const rows = (payload.files || []).map((file) => {
            const head = `<div class="mods-file-head"><strong>${escapeText(file.name)}</strong>` +
                (file.kind ? `<span class="mods-chip">feeds ${escapeText(file.kind)}</span>` : '') +
                (file.json ? '' : '<span class="mods-chip mods-chip--none">not JSON</span>') + '</div>';
            if (!file.json || !file.content) return `<div class="mods-file">${head}</div>`;
            const lines = JSON.stringify(file.content, null, 2).split('\n');
            const body = lines.slice(0, FILE_LINE_CAP).join('\n') +
                (lines.length > FILE_LINE_CAP ? `\n... ${lines.length - FILE_LINE_CAP} more line(s)` : '');
            return `<div class="mods-file">${head}<pre class="mods-pre">${escapeText(body)}</pre></div>`;
        });
        return '<div class="mods-files"><h3 class="mods-h">Files of ' + escapeText(this._openFiles) +
            ' <span class="mods-dir">' + escapeText(payload.dir) + '</span></h3>' + rows.join('') + '</div>';
    }

    /** @private Delegate the buttons of the last render (the DOM is rebuilt each time). */
    _wireClicks() {
        for (const button of this._content.querySelectorAll('[data-toggle]')) {
            button.addEventListener('click', () => {
                this.toggle(button.dataset.toggle, button.dataset.enabled === '1');
            });
        }
        for (const button of this._content.querySelectorAll('[data-files]')) {
            button.addEventListener('click', () => {
                this.showFiles(button.dataset.files);
            });
        }
    }

    /**
     * Run an action with a single in-flight guard and one error path.
     *
     * Not reentrant: a call made while one is in flight is ignored, which is what
     * keeps a double-click from sending two requests. An action that needs to re-read
     * the list therefore goes through `_load()`, not through `refresh()`.
     * @private
     */
    async _run(action) {
        if (this._busy) return;
        this._busy = true;
        try {
            await action();
        } catch (error) {
            ClientLogger.error('ModsPanel', 'mod action failed', error);
            this._setStatus(error.message, 'error');
        } finally {
            this._busy = false;
        }
    }

    /** @private */
    _setStatus(text, tone) {
        this._status.textContent = text || '';
        this._status.className = `sim-status sim-status--${text ? tone : 'dim'}`;
    }
}

/**
 * The message a route error body carries, with the status as the fallback.
 * @param {Object|null} payload
 * @param {number} status
 * @returns {string}
 */
function messageOf(payload, status) {
    if (!payload) return `Request failed (${status})`;
    const nested = typeof payload.error === 'object' && payload.error ? payload.error.message : null;
    return nested || payload.message || `Request failed (${status})`;
}

async function readJson(res) {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

export default ModsPanel;
