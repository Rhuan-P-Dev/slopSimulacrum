/**
 * ModLineViewer - the asset-lines submenu of the Mods menu tab.
 *
 * Renders as a floating veil over the Mods screen: a semi-transparent overlay that
 * covers the package list without pushing it down. The operator clicks "Assets" on
 * a package row and the submenu opens above the list, showing every asset the
 * package ships, organized per registry kind (actions, components, outfits, ...).
 *
 *   - its package's load order (#N);
 *   - who later in the stack shadows it, and whom it shadows;
 *   - which copy the world runs (self, the other package, or not in the world at all);
 *   - expanding "Diff" gives a top-level comparison of the two copies (same /
 *     differs / only in one side);
 *   - expanding "Final copy" gives the full JSON of the definition the world runs.
 *
 * WHAT THIS DOES NOT DO. It writes nothing and judges nothing: the shadow facts and
 * the winner are the server's (`ModService.linesForMod` - load order IS the world's
 * rule). The bytes a line expands come from `GET /mods/:id/files`, the same read-only
 * surface the Mods panel uses for its Files section. Server values are escaped with
 * `escapeText` before they become HTML; nothing fetched is ever markup.
 *
 * The render functions are module-level string builders, exported for
 * `test/unit/ModsPanel.client.test.js` to pin them without a DOM (the same
 * arrangement as `renderPackageList` in `ModsPanel.js`).
 *
 * @module public/js/ModLineViewer
 */
import ClientLogger from '/utils/ClientLogger.js';
import { escapeText } from '/utils/EscapeHtml.js';

const ENDPOINTS = {
    lines: (id) => `/mods/${encodeURIComponent(id)}/lines`,
    files: (id) => `/mods/${encodeURIComponent(id)}/files`
};

/** @param {*} value @returns {boolean} */
function isPlain(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Compact JSON of one value for a diff line.
 * @param {*} value
 * @returns {string}
 */
function stringifyCompact(value) {
    try {
        const raw = JSON.stringify(value);
        return typeof raw === 'string' && raw.length > 140
            ? raw.slice(0, 137) + '...'
            : raw;
    } catch {
        return String(value);
    }
}

/**
 * One entry set (a mod id and its load order) into the context line, or "none".
 * @param {Array<{modId: string, loadOrder: number}>} entries
 * @returns {string}
 */
function listMods(entries) {
    if (!entries || !entries.length) return 'none';
    return entries.map((entry) => `${entry.modId}#${entry.loadOrder}`).join(', ');
}

/**
 * The asset-lines section for one package. One `<div class="mod-lines">`, one
 * section per shipped kind, one line per definition key, then the expanded
 * diff and final-copy blocks for the keys the operator opened.
 * @param {Object|null} state - `ModLineViewer.state()`
 * @returns {string} HTML, or '' when the section is closed
 */
export function renderLinesSection(state) {
    if (!state || !state.payload) return '';
    const payload = state.payload;
    const parts = ['<div class="mod-lines">'];
    parts.push(
        '<h3 class="mods-h mod-lines-h">Assets of <code>' + escapeText(state.modId) + '</code> ' +
        '<button type="button" class="mod-lines-close" title="Close the asset lines for this package">Close</button>'
    );
    const note = !payload.contributes
        ? '<p class="mod-lines-note">This package does not contribute to the live world; the lines below show only where ' +
        + 'its keys sit in the stack. Use "Final copy" on a shared key to see the copy the world runs.</p>'
        : '';
    if (payload.blocked) {
        parts.push(
            '<p class="mod-lines-note mod-lines-note--bad">Blocked: ' +
            escapeText(payload.blocked.message ?? payload.blocked.code ?? '') + '</p>'
        );
    }
    const kinds = Object.keys(payload.lines ?? {});
    for (const kind of kinds) {
        const rows = Array.isArray(payload.lines[kind]) ? payload.lines[kind] : [];
        parts.push(
            '<div class="mod-line-section">' +
            '<h4 class="mod-line-section-title">' + escapeText(kind) + ' - ' + rows.length +
            '</h4><ul class="mod-line-list">' +
            rows.map((row) => renderLinesRow(payload, kind, row, state)).join('') +
            '</ul></div>'
        );
    }
    parts.push(note || '');
    parts.push('</div>');
    return parts.join('');
}

/** @private One `<li>` for one key of one kind. */
function renderLinesRow(payload, kind, row, state) {
    const key = escapeText(row.key);
    const winner = row.winner ?? null;
    const badge = winner == null
        ? '<span class="mod-line-winner not-in-world">not in the world</span>'
        : winner.modId === payload.id
            ? '<span class="mod-line-winner self">live: this package</span>'
            : '<span class="mod-line-winner shadowed">live: ' + escapeText(winner.modId) + '#' +
              escapeText(winner.loadOrder) + '</span>';
    const context =
        'overridden by: ' + listMods(row.overriddenBy) +
        '  -  overrides: ' + listMods(row.overrides);
    const diffBtn = payload.contributes && winner
        ? '<button type="button" class="mod-line-toggle" data-lines-diff data-kind="' +
          escapeText(kind) + '" data-key="' + escapeText(row.key) + '">' +
          'Diff vs the winning copy</button>'
        : '';
    const finalBtn = winner
        ? '<button type="button" class="mod-line-toggle" data-lines-final data-kind="' +
          escapeText(kind) + '" data-key="' + escapeText(row.key) + '">' +
          'Final copy (' + escapeText(winner.modId) + '#' + escapeText(winner.loadOrder) +
          (winner.modId === payload.id ? ' - this package' : '') + ')</button>'
        : '';
    const expanded = (which) =>
        state[which] && state[which].kind === kind && state[which].key === row.key;
    return '<li class="mod-line-row">' +
        '<div class="mod-line-head">' +
        '<span class="mod-line-key">' + key + '</span>' +
        '<span class="mod-line-loadorder">#' + escapeText(String(payload.loadOrder ?? '?')) + '</span>' +
        badge + '</div>' +
        '<div class="mod-line-context">' + context + '</div>' +
        '<div class="mod-line-actions">' + diffBtn + finalBtn + '</div>' +
        (expanded('diff') && winner ? renderLinesDiff(payload, row, state.diff) : '') +
        (expanded('final') ? renderLinesFinal(winner, state.final) : '') +
        '</li>';
}

/**
 * The diff of the package's own copy against the winning copy. Both sides plain
 * objects: top-level keys with same/differs/only-in-one-side. Otherwise: a note
 * and the compact values it can show.
 * @private
 */
function renderLinesDiff(payload, row, d) {
    const selfId = payload.id;
    const self = d.self;
    const otherId = d.otherId;
    const other = d.other;
    const title = isPlain(self) && isPlain(other)
        ? 'Diff: ' + selfId + ' vs ' + otherId + ' (live copy) - top-level keys'
        : otherId
            ? otherId + ' ships this kind, but one of the two copies did not come back ' +
              'as an object; see the "Files" button for the raw bytes'
            : 'No diff: this package\'s copy is the one the world runs';
    let body;
    if (isPlain(self) && isPlain(other)) {
        const selfKeys = Object.keys(self);
        const otherKeys = Object.keys(other);
        const allKeys = Array.from(new Set([...selfKeys, ...otherKeys]));
        body = '<ul class="mod-line-diff-list">' +
            allKeys.map((key) => {
                const inSelf = selfKeys.includes(key);
                const inOther = otherKeys.includes(key);
                let status;
                let value;
                if (inSelf && inOther) {
                    const a = stringifyCompact(self[key]);
                    const b = stringifyCompact(other[key]);
                    if (a === b) {
                        status = 'same';
                        value = a;
                    } else {
                        status = 'differs';
                        value = a + ' \u2192 ' + b;
                    }
                } else if (inSelf) {
                    status = 'self-only';
                    value = stringifyCompact(self[key]);
                } else {
                    status = 'other-only';
                    value = stringifyCompact(other[key]);
                }
                return '<li class="mod-line-diff-item">' +
                    '<span class="diff-key">' + escapeText(key) + '</span>' +
                    '<span class="diff-status ' + status + '">' + status + '</span>' +
                    '<span class="diff-value">' + escapeText(value) + '</span></li>';
            }).join('') +
            '</ul>';
    } else {
        body =
            '<p class="mod-line-diff-value">' + escapeText(selfId) + ': ' +
            escapeText(stringifyCompact(self)) + '</p>' +
            (otherId
                ? '<p class="mod-line-diff-value">' + escapeText(otherId) +
                ' (live): ' + escapeText(stringifyCompact(other)) + '</p>'
                : '');
    }
    return '<div class="mod-line-diff">' +
        '<p class="mod-line-diff-title">' + escapeText(title) + '</p>' +
        body + '</div>';
}

/**
 * The full definition the world runs, as JSON, taken from the winning package's
 * files. Shows the value of the asset's key when the winning kind file has it;
 * when it does not, shows the whole kind file and says so.
 * @private
 */
function renderLinesFinal(winner, f) {
    const file = f?.content ?? null;
    const hasKey = file != null
        && isPlain(file)
        && f?.key != null
        && Object.prototype.hasOwnProperty.call(file, f.key);
    const value = hasKey ? file[f.key] : file;
    let json;
    try {
        json = JSON.stringify(value, null, 2);
    } catch {
        json = stringifyCompact(value);
    }
    return '<div class="mod-line-diff mod-line-final">' +
        '<p class="mod-line-diff-title">Final copy - the definition the world runs</p>' +
        '<p class="mod-line-diff-status">winner: ' + escapeText(winner.modId) + '#' +
        escapeText(winner.loadOrder) +
        (winner.modId === f.from ? ' (this package)' : '') + '</p>' +
        (hasKey ? ''
            : '<p class="mod-line-diff-status">the key was not in the winning file; '
            + 'showing the whole kind file instead</p>') +
        '<pre class="mod-lines-json">' + escapeText(json) + '</pre>' +
        '</div>';
}

/**
 * State and fetching for the asset-lines section. The DOM is always rebuilt by the
 * panel from this state, which is why the fetches re-render on completion: a click
 * may be in flight while the operator toggles or moves a package, and the section
 * must never show a snapshot from an older scan.
 *
 * @class ModLineViewer
 * @param {Object} options
 * @param {() => void} options.render - what the panel must re-render when this
 *                                     viewer's state changes.
 */
export class ModLineViewer {
    constructor({ render }) {
        if (!render || typeof render !== 'function') {
            throw new Error('ModLineViewer: render callback required');
        }
        this._render = render;
        /**
         * @private the open section. Shape: `{ modId, payload,
         * diff: { kind, key, self, other, otherId } | null,
         * final: { kind, key, content, from } | null }` - or null when closed.
         */
        this._lines = null;
        /**
         * @private package files by registry kind, per package. Cached for the
         * session; `rebase()` (the install re-read) and `reset()` drop it,
         * because a diff against a copy from the previous scan would be a lie.
         */
        this._filesCache = new Map();
        /** @private latest in-flight request; the stale-response guard. */
        this._gen = 0;
    }

    /**
     * @private read the body of an answer only when there is one.
     */
    async _json(resp) {
        try {
            return await resp.json();
        } catch {
            return null;
        }
    }

    /**
     * @public the state the pure render function reads (no copy; render never
     * mutates it).
     */
    state() {
        return this._lines;
    }

    /**
     * Open the asset lines of a package: fetch, then replace whatever section was
     * open (the previous expansions are gone by construction).
     * @param {string} modId
     * @returns {Promise<{ok: boolean, message?: string}>}
     */
    async show(modId) {
        const gen = ++this._gen;
        try {
            const resp = await fetch(ENDPOINTS.lines(modId));
            if (!resp.ok) {
                const body = await this._json(resp);
                throw new Error((body?.message ?? body?.error?.message) ??
                    `lines for ${modId} unavailable (HTTP ${resp.status})`);
            }
            const payload = await this._json(resp);
            if (!payload || typeof payload !== 'object' || !('lines' in payload)) {
                throw new Error('unexpected answer from GET /mods/:id/lines');
            }
            if (gen === this._gen) {
                this._lines = {
                    modId: payload.id ?? modId,
                    payload,
                    diff: null,
                    final: null
                };
            }
        } catch (error) {
            if (gen === this._gen) {
                this._lines = null;
                this._render();
            }
            return gen === this._gen ? { ok: false, message: error.message } : { ok: true };
        }
        if (gen === this._gen) this._render();
        return { ok: true };
    }

    /**
     * Re-fetch the lines of the currently open package after the install changed
     * on the server (rescan / toggle / move / apply). Keeps the section open,
     * drops the expanded diff and final copy, no-op when nothing is open.
     */
    async rebase() {
        if (!this._lines) return;
        // The bytes behind an open Diff/Final are the previous scan's until the
        // cache is dropped with the lines; clear it so a rescan re-fetches fresh
        // bytes for the next expansion.
        this._filesCache.clear();
        const gen = ++this._gen;
        try {
            const resp = await fetch(ENDPOINTS.lines(this._lines.modId));
            if (resp.ok) {
                const payload = await this._json(resp);
                if (payload && typeof payload === 'object' && 'lines' in payload) {
                    if (gen !== this._gen) return;
                    this._lines = {
                        ...this._lines,
                        payload,
                        diff: null,
                        final: null
                    };
                    this._render();
                }
            }
        } catch (error) {
            if (gen === this._gen) {
                ClientLogger.warn('ModLineViewer', `rebase failed for ${this._lines.modId}`,
                    error?.message ?? error);
            }
        }
    }

    /**
     * Expand the diff of one asset of the open package. The two copies are read
     * through the files cache; only the winning copy is fetched when it is not
     * this package.
     * @param {string} kind
     * @param {string} key
     */
    async openDiff(kind, key) {
        const gen = ++this._gen;
        if (!this._lines) return;
        const rows = this._lines.payload.lines?.[kind] ?? [];
        const row = rows.find((entry) => entry.key === key);
        if (!row) return;
        const otherId = row.winner && row.winner.modId !== this._lines.modId
            ? row.winner.modId
            : null;
        const self = (await this._filesFor(this._lines.modId)).get(kind);
        const other = otherId ? (await this._filesFor(otherId)).get(kind) : undefined;
        // A close()/show()/rebase() may have run while the bytes were in flight;
        // only the latest request may write state, so the veil never renders a
        // snapshot from a closed or moved section.
        if (gen !== this._gen || !this._lines) return;
        this._lines = {
            ...this._lines,
            diff: { kind, key, self, other, otherId }
        };
        this._render();
    }

    /**
     * Expand the final copy (the winning one) of one asset of the open package.
     * @param {string} kind
     * @param {string} key
     */
    async openFinal(kind, key) {
        const gen = ++this._gen;
        if (!this._lines) return;
        const rows = this._lines.payload.lines?.[kind] ?? [];
        const row = rows.find((entry) => entry.key === key);
        if (!row?.winner) return;
        // Fetch the bytes from the winning package, but "from" is the package
        // being viewed: the "(this package)" tag is true only when the viewed
        // package is the copy the world runs.
        const content = (await this._filesFor(row.winner.modId)).get(kind);
        if (gen !== this._gen || !this._lines) return;
        this._lines = {
            ...this._lines,
            final: { kind, key, content, from: this._lines.modId }
        };
        this._render();
    }

    /** Close the section (and whatever diff or final copy was expanded). */
    close() {
        this._lines = null;
        this._render();
    }

    /**
     * Forget everything: open section and the whole files cache. A full teardown -
     * the panel clears the cache on re-read through rebase(), and this stays
     * available to close the section outright.
     */
    reset() {
        this._filesCache.clear();
        this._lines = null;
        this._render();
    }

    /**
     * @private one package's files, keyed by registry kind, fetched once and
     * cached in the session.
     */
    async _filesFor(id) {
        const cached = this._filesCache.get(id);
        if (cached) return cached;
        const byKind = new Map();
        try {
            const resp = await fetch(ENDPOINTS.files(id));
            if (resp.ok) {
                const payload = await this._json(resp);
                for (const file of payload?.files ?? []) {
                    if (file?.kind == null || file?.json === false || file?.content == null) continue;
                    byKind.set(file.kind, file.content);
                }
            } else {
                ClientLogger.warn('ModLineViewer',
                    `files for ${id} unavailable (HTTP ${resp.status})`);
            }
        } catch (error) {
            ClientLogger.warn('ModLineViewer', `could not read the files of ${id}`,
                error?.message ?? error);
        }
        this._filesCache.set(id, byKind);
        return byKind;
    }
}
