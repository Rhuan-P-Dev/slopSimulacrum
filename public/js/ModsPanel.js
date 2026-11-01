/**
 * ModsPanel - see the packages, manage them.
 *
 * The view behind the menu's **Mods**. It renders what the server says about the
 * install (`GET /mods`) and offers the five things an operator can actually do:
 *
 *   - **Rescan** - read the package directory again (a package was added, edited
 *     or deleted on disk since the last look).
 *   - **Plan** - diff the packages against the live world definition, per kind,
 *     including what the world would quarantine and why (`POST /mods/plan`).
 *   - **Enable / Disable** - flip one package. The answer is `pending`, and the
 *     panel shows it as what it is: a change that takes effect at the next round
 *     boundary. Nothing here pretends the world changed the moment the box moved.
 *   - **Move up / down** - one slot in the stack. `up` composes earlier and so LOSES a shared
 *     key, `down` composes last and wins it. The answer names the keys whose owner the move
 *     changed, because that is the only visible consequence of a reorder.
 *   - **Apply now** - ask for that boundary instead of waiting for it
 *     (`POST /mods/apply`). If a round is open the server says so and the change
 *     still lands at the boundary that was already coming; `applied: false` is a
 *     deferral with a named moment, and the panel says which.
 *
 * How the list is laid out, and why. A package means nothing on its own: what it
 * does depends on its **place in the stack** (the last package that ships a key is the
 * one the world runs) and on the packages it **requires** (an off or absent one makes
 * it inert). So the list is a stack, not a table:
 *
 *   - an ordinal gutter carries `loadOrder`, the number that decides who wins a shared
 *     key, and the legend says which way the stack composes;
 *   - a requirement is a chip, not a comma-separated sentence, and the chip carries its
 *     state: enabled, disabled, or not installed at all - read off the same answer,
 *     so "requires core-materials" is green or grey before an enable is refused;
 *   - clicking a chip walks to that package's row rather than leaving the name behind;
 *   - the manifest's description sits under the id, clamped to two lines, and expands
 *     in place. Twenty-odd packages of full prose would push the stack off the screen.
 *
 * Why the pure functions are module-level and exported. The ordering, the requirement
 * states and the shadow markers are the parts a reader can get wrong; building them
 * outside the class means `test/unit/ModsPanel.client.test.js` pins them without a DOM,
 * which this suite does not have.
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
/** Order by `loadOrder`: the stack itself, which is what decides a shared key. */
export const SORT_STACK = 'stack';
/** Order by id, for the operator who is looking for one name and not for a position. */
export const SORT_NAME = 'name';
/** How long a jumped-to row stays lit (the row is replaced by the next render anyway). */
const FLASH_MS = 900;
/** How many keys a move's status line names before "+N more". */
const MOVE_KEY_CAP = 6;

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
        /** @private which order the package list is drawn in (`SORT_STACK` | `SORT_NAME`) */
        this._sortMode = SORT_STACK;
        /** @private ids whose description is expanded past the clamp */
        this._expanded = new Set();

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
     * Move one package one slot in the stack.
     *
     * `up` composes earlier and so LOSES a shared key; `down` composes last and wins it. The
     * legend says which way the stack runs and the status line repeats it, because the
     * direction is the opposite of the "top of the list wins" intuition - a move that reads
     * like a promotion is a demotion.
     *
     * Like enable/disable the answer is `pending`, and the list is re-read before the line is
     * written for the same reason (`toggle`): the ranks on screen must be the server's, not
     * the ones this click assumed.
     * @param {string} id
     * @param {'up'|'down'} direction
     * @returns {Promise<void>}
     */
    async move(id, direction) {
        await this._run(async () => {
            const res = await fetch(`/mods/${encodeURIComponent(id)}/move`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ direction })
            });
            const payload = await readJson(res);
            if (!res.ok) throw new Error(messageOf(payload, res.status));
            await this._load();
            this._setStatus(moveSummary(id, payload), 'ok');
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

    /**
     * @private One row per package: its place in the stack, what it is, what it
     * feeds, what it needs, and whether it is on. The layout itself is
     * `renderPackageList()`, which is pure and therefore tested.
     */
    _renderPackages(view) {
        return renderPackageList({
            mods: view.mods,
            plan: this._plan,
            sortMode: this._sortMode,
            expanded: this._expanded
        });
    }

    /**
     * @private Flip between the stack and the alphabet. No request: the server's
     * answer is already in hand, and an order is not a fact about the world.
     * @private
     */
    _toggleSort() {
        this._sortMode = this._sortMode === SORT_STACK ? SORT_NAME : SORT_STACK;
        this._render();
    }

    /**
     * @private Expand or collapse one package's description.
     * @param {string} id
     * @private
     */
    _toggleDescription(id) {
        if (this._expanded.has(id)) this._expanded.delete(id);
        else this._expanded.add(id);
        this._render();
    }

    /**
     * @private Walk to another package's row: a requirement is something to look at,
     * not a name to remember.
     * @param {string} id
     * @private
     */
    _jumpTo(id) {
        const row = [...this._content.querySelectorAll('[data-row]')].find((el) => el.dataset.row === id);
        if (!row) {
            this._setStatus(`${id} is not in the installed list.`, 'warn');
            return;
        }
        if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
        row.classList.add('mods-row--flash');
        setTimeout(() => row.classList.remove('mods-row--flash'), FLASH_MS);
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
        for (const button of this._content.querySelectorAll('[data-move]')) {
            button.addEventListener('click', () => {
                this.move(button.dataset.move, button.dataset.direction);
            });
        }
        for (const button of this._content.querySelectorAll('[data-files]')) {
            button.addEventListener('click', () => {
                this.showFiles(button.dataset.files);
            });
        }
        for (const chip of this._content.querySelectorAll('[data-jump]')) {
            chip.addEventListener('click', () => {
                this._jumpTo(chip.dataset.jump);
            });
        }
        for (const line of this._content.querySelectorAll('[data-desc]')) {
            line.addEventListener('click', () => {
                this._toggleDescription(line.dataset.desc);
            });
        }
        const sortButton = this._content.querySelector('[data-sort]');
        if (sortButton) sortButton.addEventListener('click', () => this._toggleSort());
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

// ==========================================================================
// The package list, as pure functions of the server's answer
// ==========================================================================

/**
 * Order the packages. `stack` is the default because a package's meaning IS its
 * position: two packages shipping the same key do not both win, and `loadOrder`
 * decides which one the world runs. `name` exists for the operator hunting one id.
 * @param {Array<Object>} mods - rows from `GET /mods`
 * @param {string} [sortMode]
 * @returns {Array<Object>} a new array, never the caller's
 */
export function sortMods(mods, sortMode = SORT_STACK) {
    const rows = [...(mods ?? [])];
    if (sortMode === SORT_NAME) return rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return rows.sort((a, b) => (Number(a.loadOrder) - Number(b.loadOrder))
        || String(a.id).localeCompare(String(b.id)));
}

/**
 * Is a requirement met? Read off the install the server just described, so the chip
 * is true before an enable is refused rather than after.
 * @param {string} requiredId
 * @param {Map<string, Object>} byId - installed packages, by id
 * @returns {'on'|'off'|'missing'}
 */
export function requirementState(requiredId, byId) {
    const target = byId.get(requiredId);
    if (!target) return 'missing';
    return target.enabled === false ? 'off' : 'on';
}

/**
 * Group the shadow facts a plan carries, per package: `over` counts the keys a
 * package took from others, `under` names who took keys from it.
 *
 * Only a plan knows this. `GET /mods` never composes the packages, so before the
 * operator clicks Plan the stack shows positions and no markers, and the legend
 * says so instead of leaving the absence to be guessed at.
 * @param {Object|null} plan
 * @returns {{ over: Map<string, number>, under: Map<string, Set<string>> }}
 */
export function shadowIndex(plan) {
    const over = new Map();
    const under = new Map();
    for (const entry of plan?.shadowed ?? []) {
        over.set(entry.to, (over.get(entry.to) ?? 0) + 1);
        if (!under.has(entry.from)) under.set(entry.from, new Set());
        under.get(entry.from).add(entry.to);
    }
    return { over, under };
}

/** One requirement chip: the id, its state, and the jump. */
function renderRequirement(requiredId, byId) {
    const state = requirementState(requiredId, byId);
    const title = (state === 'missing'
        ? `${requiredId} is not installed here - this package cannot load`
        : state === 'off'
            ? `${requiredId} is installed but disabled - this package contributes nothing until it is on`
            : `${requiredId} is enabled`) + ' - click to jump to it';
    const caption = state === 'on' ? '' : `<span class="mods-req-state">${state}</span>`;
    return `<button type="button" class="mods-req mods-req--${state}" data-jump="${escapeText(requiredId)}"` +
        ` title="${escapeText(title)}">${escapeText(requiredId)}${caption}</button>`;
}

/** The two shadow markers of one row (both empty when no plan has been read). */
function renderShadow(mod, shadows) {
    const over = shadows.over.get(mod.id) ?? 0;
    const under = [...(shadows.under.get(mod.id) ?? [])];
    const took = over
        ? `<span class="mods-shadow mods-shadow--over" title="This package is the one the world runs for ${over} key(s) another package also ships">wins ${over} shared key(s)</span>`
        : '';
    const lost = under.length
        ? `<span class="mods-shadow mods-shadow--under" title="Another package ships these keys later in the stack, so theirs is the definition the world runs">overlaid by ${escapeText(under.join(', '))}</span>`
        : '';
    return took + lost;
}

/**
 * The two position buttons, in the ordinal gutter. They belong to the rank rather than to
 * the actions column: an operator aiming a package aims at its number.
 *
 * The glyphs are ASCII (`^`, `v`) because the committed tree is ASCII, which is exactly why
 * the direction has to be said in the title instead of drawn - `^` composes EARLIER and so
 * loses a shared key, which is not what an upward arrow suggests. An edge keeps its button
 * and disables it, because "already at the top" is a fact about the stack the control should
 * show rather than a control that quietly disappeared.
 * @param {Object} mod
 * @param {number} rank - 1-based position in the stack.
 * @param {number} total - Installed packages, so the same counting.
 * @returns {string} HTML
 */
function renderMove(mod, rank, total) {
    const id = escapeText(mod.id);
    const at = (direction, glyph, words, enabled) => `<button type="button" class="mods-move"`
        + (enabled ? '' : ' disabled')
        + ` data-move="${id}" data-direction="${direction}"`
        + ` title="${escapeText(enabled
            ? `Move ${mod.id} ${direction} in the stack: ${words}`
            : `${mod.id} is already at the ${direction === 'up' ? 'top' : 'bottom'} of the stack`)}`
        + ` aria-label="${escapeText(`Move ${mod.id} ${direction}`)}">${glyph}</button>`;
    return '<span class="mods-move-group">'
        + at('up', '^', 'it composes one package earlier, so it loses a shared key to anything above it', rank > 1)
        + at('down', 'v', 'it composes one package later, so it wins any shared key it ships', rank < total)
        + '</span>';
}

/**
 * What a move did, in one line: where the package landed, when it takes effect, and which
 * keys changed owner. The last part is the reason the endpoint composes the stack twice -
 * without it, a reorder is a number moving and nothing else the operator can check.
 * @param {string} id
 * @param {Object} payload - the `POST /mods/:id/move` answer
 * @returns {string}
 */
export function moveSummary(id, payload) {
    const landed = `moved ${payload.direction} to position ${payload.rank} of ${payload.total}`;
    const when = payload.pending
        ? `takes effect at the ${payload.appliesAt}`
        : 'the world already matches';
    const changed = payload.shadowChanged ?? [];
    if (changed.length === 0) return `${id} ${landed} - ${when}. No shared key changed hands.`;
    const names = changed.slice(0, MOVE_KEY_CAP)
        .map((entry) => `${entry.kind}/${entry.key} now ${entry.now ?? 'nobody'}`);
    const more = changed.length > names.length ? ` (+${changed.length - names.length} more)` : '';
    return `${id} ${landed} - ${when}. Owner changed: ${names.join(', ')}${more}.`;
}

/** One package: ordinal, identity, description, what it feeds and needs. */
function renderPackage(mod, { byId, shadows, expanded, rank, total, explicit, movable }) {
    const state = mod.blocked
        ? '<span class="mods-flag mods-flag--bad" title="installed, enabled, contributing nothing">blocked</span>'
        : (mod.enabled === false ? '<span class="mods-flag mods-flag--off">off</span>' : '<span class="mods-flag mods-flag--on">on</span>');
    const official = mod.official
        ? '<span class="mods-flag mods-flag--official" title="Ships with the server (core- prefix)">official</span>'
        : '<span class="mods-flag mods-flag--third" title="Not shipped with the server - somebody else\'s package">third-party</span>';
    const kinds = (mod.content || []).map((kind) => `<span class="mods-chip">${escapeText(kind)}</span>`).join('')
        || '<span class="mods-chip mods-chip--none">no definitions</span>';
    const requires = (mod.requires || []).length
        ? `<span class="mods-reqs"><span class="mods-req-label">requires</span>` +
          `${(mod.requires || []).map((r) => renderRequirement(r, byId)).join('')}</span>`
        : '';
    const open = expanded.has(mod.id);
    // The absence is said too: a row with nothing under the id looks like a panel that
    // ignored the field, when the truth is that nobody wrote the sentence.
    const description = mod.description
        ? `<p class="mods-desc${open ? '' : ' mods-desc--clamped'}" data-desc="${escapeText(mod.id)}"` +
          ` title="${open ? 'Collapse' : 'Expand'} this description">${escapeText(mod.description)}</p>`
        : '<p class="mods-desc mods-desc--none">This package declares no description in its manifest.</p>';
    const level = explicit
        ? `<span class="mods-shadow mods-shadow--level" title="This package was given a load order of ${escapeText(mod.loadOrder)}, so it composes at that level rather than with the rest">load order ${escapeText(mod.loadOrder)}</span>`
        : '';
    return `<div class="mods-row${mod.enabled === false ? ' mods-row--off' : ''}" data-row="${escapeText(mod.id)}">` +
        `<div class="mods-ordinal" title="Stack position ${escapeText(rank)} of ${escapeText(total)} (load order ${escapeText(mod.loadOrder)}): the stack composes top to bottom, and the last package that ships a key is the definition the world runs">` 
        + `${escapeText(String(rank ?? '?').padStart(2, '0'))}${movable ? renderMove(mod, rank, total) : ''}</div>` +
        '<div class="mods-row-main">' +
        `<div class="mods-row-head"><span class="mods-id">${escapeText(mod.id)}</span>` +
        `<span class="mods-version">v${escapeText(mod.version)}</span>${official}${state}${level}${renderShadow(mod, shadows)}</div>` +
        description +
        `<div class="mods-kinds">${kinds}${requires}</div>` +
        (mod.blocked ? `<div class="mods-blocked">${escapeText(mod.blocked.message || '')}</div>` : '') +
        '</div>' +
        '<div class="mods-row-actions">' +
        `<button type="button" class="sim-btn sim-btn-small" data-toggle="${escapeText(mod.id)}" data-enabled="${mod.enabled === false ? '1' : '0'}">` +
        `${mod.enabled === false ? 'Enable' : 'Disable'}</button>` +
        `<button type="button" class="sim-btn sim-btn-small" data-files="${escapeText(mod.id)}">Files</button>` +
        '</div>' +
        '</div>';
}

/**
 * The stack as the loader sees it: the effective order, and who is out of level.
 *
 * `loadOrder` defaults to one number for every package, so on an install nobody has
 * tuned it the order is decided by the id: a gutter of identical raw numbers would
 * say nothing. The rank is what the merge actually did; a package off the common level
 * is the one somebody moved, which is the fact worth marking.
 * @param {Array<Object>} mods
 * @returns {{ ordered: Array<Object>, total: number, levels: Map<unknown, number>, common: unknown }}
 */
export function stackModel(mods) {
    const ordered = sortMods(mods, SORT_STACK);
    const levels = new Map();
    for (const mod of ordered) levels.set(mod.loadOrder, (levels.get(mod.loadOrder) ?? 0) + 1);
    let common;
    for (const [order, count] of levels) {
        if (common === undefined || count > levels.get(common)) common = order;
    }
    return { ordered, total: ordered.length, levels, common };
}

/**
 * Is this package out of the level the install mostly sits at?
 * @param {Object} mod
 * @param {{ levels: Map<unknown, number>, common: unknown }} model - from `stackModel`
 * @returns {boolean}
 */
export function outOfLevel(mod, model) {
    return model.levels.size > 1 && model.levels.get(model.common) > 1 && mod.loadOrder !== model.common;
}

/**
 * The whole package list: heading, sort control, the legend that explains which way
 * the stack runs, then one row per package.
 * @param {Object} options
 * @param {Array<Object>} [options.mods] - rows from `GET /mods`
 * @param {Object|null} [options.plan] - the last plan, if one has been read
 * @param {string} [options.sortMode]
 * @param {Set<string>} [options.expanded] - ids with an open description
 * @returns {string} HTML
 */
export function renderPackageList({ mods = [], plan = null, sortMode = SORT_STACK, expanded = new Set() } = {}) {
    const byId = new Map(mods.map((mod) => [mod.id, mod]));
    const shadows = shadowIndex(plan);
    const model = stackModel(mods);
    const ordered = sortMode === SORT_NAME ? sortMods(mods, SORT_NAME) : model.ordered;
    const rankOf = new Map(model.ordered.map((mod, index) => [mod.id, index + 1]));
    // Exceptional means "not the level most packages sit at", and only when most
    // packages DO sit at one level. When every package carries its own order, nothing is
    // out of place and marking all of them would mark nothing.
    const majority = model.levels.get(model.common) > 1;
    const levelNote = model.levels.size > 1
        ? `Levels in use: ${escapeText([...model.levels.keys()].join(', '))}` +
          (majority ? ' - the package off the common level is marked.'
              : ' - every package sits at its own level, so none is out of place.')
        : `Every package sits at load order ${escapeText(model.common)}: an untuned install, where the id is what decides the stack today.`;
    const legend = '<p class="mods-legend">Number = position in the stack: packages compose top to bottom and the last one that ships a key is the definition the world runs. '
        + 'Ties in <code>loadOrder</code> break by id. ' + levelNote + ' '
        + (plan
            ? `Markers from the plan against v${escapeText(plan.fromVersion)}.`
            : 'Read the plan to see which package takes a key from which.') + '</p>';
    const rows = ordered.map((mod) => renderPackage(mod, {
        byId,
        shadows,
        expanded,
        rank: rankOf.get(mod.id),
        total: model.total,
        explicit: outOfLevel(mod, model),
        // Position controls only where position is what the list shows. In alphabetical order
        // the rows are drawn one way and ranked another, and an arrow there would move a
        // package relative to neighbours that are not its neighbours in the stack.
        movable: sortMode !== SORT_NAME
    }));
    return '<div class="mods-packages"><h3 class="mods-h mods-h--stack">Packages (' + mods.length + ')' +
        `<button type="button" class="mods-sort" data-sort="1" title="Switch between the stack (load order) and the alphabet">` +
        `${sortMode === SORT_STACK ? 'in stack order' : 'in alphabetical order'}</button></h3>` +
        legend +
        (rows.length ? `<div class="mods-stack">${rows.join('')}</div>`
            : '<p class="mods-empty">No package in <code>data/mods/</code>.</p>') +
        '</div>';
}

export default ModsPanel;
