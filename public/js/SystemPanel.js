/**
 * SystemPanel — the "System" tab: a chat with the thing that authors the world.
 *
 * Owns the DOM of #system-overlay and nothing else:
 *   - init/show/hide/toggle/isVisible (wired by OverlayManager via App.js)
 *   - the composer (Enter sends, Shift+Enter is a newline) and the transcript
 *   - POST /system/chat — one turn, one in-flight guard
 *   - the proposal card the server returned, with the one Write mod click (POST
 *     /system/write), enabled only while a proposal is on the table
 *   - the session id, kept in sessionStorage so a reload continues the conversation
 *     the operator was reading (GET /system/history/:sessionId), and dropped by New chat
 *
 * WHAT THIS DOES NOT DO. It judges nothing. Whether a proposal is legal is decided
 * server-side twice (when the model proposes, and again on Write), and what the world
 * does with a package is decided at the round boundary by the mod system — so this panel
 * never says "applied", it says where to apply (the Mods panel). The client is disposable
 * by design, and this file is no exception.
 *
 * NO MODEL TEXT BECOMES MARKUP. Every string the server returns — the reply, the rule
 * list, a definition value — is written with `textContent`, never as `innerHTML`
 * (`SEC-4` in its UI form: model output is data). Only the fixed structure below is
 * built from literals.
 *
 * @module public/js/SystemPanel
 */

import ClientLogger from '/utils/ClientLogger.js';

/** The three endpoints this panel speaks to. Everything about what they mean is the server's. */
const ENDPOINTS = {
    chat: '/system/chat',
    write: '/system/write',
    history: (sessionId) => `/system/history/${encodeURIComponent(sessionId)}`
};

/** Where the session id survives a reload (`sessionStorage`, not `localStorage`: a new tab is a new conversation). */
const SESSION_STORAGE_KEY = 'system.sessionId';

/** Labels for the tool log, so a dev read needs no server knowledge. */
const TOOL_LABELS = Object.freeze({
    list_registries: 'list registries',
    read_registry: 'read registry',
    find_definitions: 'search definitions',
    propose_mod: 'propose package'
});

export class SystemPanel {
    constructor() {
        this._initialized = false;
        this._overlay = null;
        this._transcript = null;
        this._status = null;
        this._input = null;
        this._sendButton = null;
        this._newButton = null;
        /**
         * @private {Object|null} the Write mod button of the current paint, if any. Held
         * because its enabled state depends on `_inFlight`, which outlives the paint that
         * created it.
         */
        this._writeButton = null;
        /** @private {string|null} the session this conversation belongs to */
        this._sessionId = null;
        /** @private {Array<{role: string, text: string}>} what to paint in the transcript */
        this._entries = [];
        /** @private {Object|null} the proposal on the table (server-validated) */
        this._proposal = null;
        /** @private {boolean} one request at a time; a second click is a double LLM turn */
        this._inFlight = false;
        /** @private {boolean} the package for the current proposal is already written */
        this._written = false;
        /** @private {boolean} the stored session has been restored once */
        this._restored = false;
    }

    // ---------------------------------------------------------------- init

    init() {
        if (this._initialized) {
            return;
        }
        this._overlay = document.getElementById('system-overlay');
        this._transcript = document.getElementById('system-transcript');
        this._status = document.getElementById('system-status');
        this._input = document.getElementById('system-input');
        this._sendButton = document.getElementById('system-send');
        this._newButton = document.getElementById('system-new');
        if (!this._overlay || !this._transcript || !this._input || !this._sendButton) {
            throw new Error('SystemPanel: #system-overlay / #system-transcript / #system-input / #system-send not found.');
        }

        this._sendButton.addEventListener('click', () => void this._send());
        this._input.addEventListener('keydown', (event) => {
            // Enter sends, Shift+Enter is a newline — the convention the rest of the chat
            // surfaces in this app already use.
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void this._send();
            }
        });
        if (this._newButton) {
            this._newButton.addEventListener('click', () => this._newChat());
        }
        if (this._status) this._status.textContent = '';

        this._sessionId = this._readStoredSessionId();
        this._initialized = true;
        this._overlay.style.display = 'none';
        this._render();
        ClientLogger.info('SystemPanel', 'ready; session:', this._sessionId ?? '(new)');
    }

    // ---------------------------------------------------------------- show / hide

    /**
     * Called by OverlayManager.open(). Restores the stored conversation once — a reload
     * should not cost the operator the thread they were reading, and a session the server
     * does not know (it restarted, or the session was evicted) simply starts empty.
     */
    show(data) {
        void data;
        this.init();
        if (!this._overlay) return;
        this._overlay.style.display = 'block';
        if (!this._restored) {
            this._restored = true;
            if (this._sessionId && this._entries.length === 0) void this._restoreHistory();
        }
    }

    hide() {
        if (this._overlay) this._overlay.style.display = 'none';
    }

    toggle() {
        if (this._overlay && this._overlay.style.display === 'block') {
            this.hide();
        } else {
            this.show();
        }
    }

    isVisible() {
        return !!this._overlay && this._overlay.style.display === 'block';
    }

    refresh() {
        if (!this._initialized) return;
        void this._restoreHistory();
    }

    // ---------------------------------------------------------------- data

    /**
     * Send the composer's text as one wish. The wish is painted before the request, so the
     * operator sees what they asked while the model reads the world.
     * @private
     */
    async _send() {
        if (this._inFlight) return;
        const message = (this._input?.value ?? '').trim();
        if (message.length === 0) {
            this._setStatus('Say something first.');
            return;
        }
        this._inFlight = true;
        this._input.value = '';
        this._entries.push({ role: 'user', text: message });
        this._render();
        this._setBusy(true);
        this._setStatus('The System is reading the world…');

        try {
            const payload = await this._post(ENDPOINTS.chat, { sessionId: this._sessionId, message });
            this._sessionId = payload.sessionId ?? this._sessionId;
            this._storeSessionId(this._sessionId);
            // "no answer" is two different news: the model chose silence, or it ran out of
            // its call budget while reading. The operator should not have to diff a tool log
            // to find out which.
            const reply = typeof payload.reply === 'string' && payload.reply.length > 0
                ? payload.reply
                : (payload.meta?.stoppedAtToolCap
                    ? 'The System used its whole call budget reading the world and never proposed. Ask again, a bit narrower.'
                    : '(no answer this turn — see the tool log)');
            this._entries.push({
                role: 'system',
                text: reply,
                toolLog: Array.isArray(payload.toolLog) ? payload.toolLog : [],
                meta: payload.meta ?? null
            });
            this._proposal = payload.proposal ?? null;
            this._written = false;
            this._render();
            this._setStatus(this._proposal
                ? `Proposal on the table: ${this._proposal.packageId}. Nothing written yet.`
                : 'No proposal this turn.');
        } catch (error) {
            this._entries.push({ role: 'error', text: error?.message ?? 'The System call failed.' });
            this._render();
            this._setStatus(error?.message ?? 'The System call failed.', true);
        } finally {
            this._inFlight = false;
            this._setBusy(false);
        }
    }

    /**
     * Write the session's proposal as a package. The body is the session id only: the
     * server writes what it validated, not what a client holds.
     * @private
     */
    async _write() {
        if (this._inFlight) return;
        if (!this._sessionId || !this._proposal) {
            // Speak, do not swallow. A silent early return is precisely what made a frozen
            // Write button look like a server bug: no request, no console line, no clue.
            this._setStatus('No proposal on the table in this conversation — there is nothing to write.', true);
            return;
        }
        this._inFlight = true;
        this._setBusy(true);
        this._setStatus('Writing the package…');
        try {
            const payload = await this._post(ENDPOINTS.write, { sessionId: this._sessionId });
            this._written = true;
            const overrides = Array.isArray(payload.overrides) ? payload.overrides.length : 0;
            this._setStatus(
                `Wrote ${payload.packageId} (${payload.dir}). `
                + `${overrides} overriding. Not applied — apply it in Mods (round boundary).`
            );
            this._entries.push({
                role: 'system',
                text: `Written: ${payload.packageId}\n`
                    + `Directory: ${payload.dir}\n`
                    + `Files: ${(payload.files ?? []).join(', ')}\n`
                    + `Added: ${(payload.added ?? []).map((a) => `${a.kind}/${a.key}`).join(', ') || 'nothing'}\n`
                    + `Overrides: ${(payload.overrides ?? []).map((a) => `${a.kind}/${a.key}`).join(', ') || 'nothing'}\n`
                    + 'The world has NOT taken it. Open Mods and apply — the swap happens at the round boundary.'
            });
            this._render();
        } catch (error) {
            this._setStatus(error?.message ?? 'The write failed.', true);
        } finally {
            this._inFlight = false;
            this._setBusy(false);
        }
    }

    /**
     * Forget the conversation: a new session, an empty transcript. The packages already
     * written stay on disk — they were the operator's decision, not part of this chat.
     * @private
     */
    _newChat() {
        this._sessionId = null;
        this._entries = [];
        this._proposal = null;
        this._written = false;
        this._restored = true;
        try {
            sessionStorage.removeItem(SESSION_STORAGE_KEY);
        } catch (error) {
            ClientLogger.warn('SystemPanel', 'could not clear the stored session id', error?.message ?? error);
        }
        this._render();
        this._setStatus('New conversation.');
    }

    /** @private Re-read the server's view of this session (a reload, or a refresh click). */
    async _restoreHistory() {
        if (!this._sessionId) return;
        try {
            const resp = await fetch(ENDPOINTS.history(this._sessionId));
            if (!resp.ok) return; // unknown session after a restart: start empty, say nothing loud
            const payload = await resp.json();
            const messages = Array.isArray(payload.messages) ? payload.messages : [];
            this._entries = messages.map((entry) => ({
                role: entry.role === 'user' ? 'user' : 'system',
                text: typeof entry.content === 'string' ? entry.content : ''
            }));
            this._proposal = payload.proposal ?? null;
            this._written = false;
            this._render();
            this._setStatus(this._proposal
                ? `Session restored. Proposal on the table: ${this._proposal.packageId}.`
                : 'Session restored.');
        } catch (error) {
            ClientLogger.warn('SystemPanel', 'history restore failed', error?.message ?? error);
        }
    }

    /**
     * One POST, one parsed body, one error type: the server's `{ error: { code, message } }`
     * envelope becomes an Error carrying the code, and nothing else does.
     * @private
     * @param {string} url
     * @param {Object} body
     * @returns {Promise<Object>}
     */
    async _post(url, body) {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        let payload;
        try {
            payload = await resp.json();
        } catch (error) {
            payload = null;
        }
        if (!resp.ok) {
            const detail = payload?.error?.message ?? `HTTP ${resp.status}`;
            const code = payload?.error?.code ? ` (${payload.error.code})` : '';
            const error = new Error(`${detail}${code}`);
            error.code = payload?.error?.code ?? 'HTTP_ERROR';
            throw error;
        }
        return payload ?? {};
    }

    // ---------------------------------------------------------------- render

    /** @private Repaint the whole transcript. Cheap, and it keeps one truth on screen. */
    _render() {
        // The repaint throws every node away, so the reference to the current Write button
        // dies with them. `_refreshWriteButton` must never drive a detached node.
        this._writeButton = null;
        if (!this._transcript) return;
        this._transcript.textContent = '';
        if (this._entries.length === 0) {
            const placeholder = document.createElement('p');
            placeholder.className = 'system-placeholder';
            placeholder.textContent = 'Say what you want the world to contain. The System reads the live definition through its own tools, then puts a data-only mod package on the table — nothing is written until you press Write mod.';
            this._transcript.appendChild(placeholder);
            return;
        }
        for (const entry of this._entries) {
            this._transcript.appendChild(this._renderMessage(entry));
        }
        const proposal = this._renderProposalCard();
        if (proposal) this._transcript.appendChild(proposal);
        this._transcript.scrollTop = this._transcript.scrollHeight;
    }

    /**
     * @private
     * @param {{ role: 'user'|'system'|'error', text: string, toolLog?: Array, meta?: Object }} entry
     * @returns {HTMLElement}
     */
    _renderMessage(entry) {
        const wrap = document.createElement('div');
        wrap.className = `system-message system-message-${entry.role === 'user' ? 'user' : 'system'}${entry.role === 'error' ? ' system-message-error' : ''}`;
        const role = document.createElement('span');
        role.className = 'system-message-role';
        role.textContent = entry.role === 'user' ? 'You' : (entry.role === 'error' ? 'Error' : 'System');
        const body = document.createElement('div');
        body.textContent = entry.text;
        wrap.append(role, body);
        if (Array.isArray(entry.toolLog) && entry.toolLog.length > 0) {
            wrap.appendChild(this._renderToolLog(entry.toolLog, entry.meta));
        }
        return wrap;
    }

    /**
     * @private
     * @param {Array<Object>} toolLog
     * @param {Object|null} meta
     * @returns {HTMLElement}
     */
    _renderToolLog(toolLog, meta) {
        const details = document.createElement('details');
        details.className = 'system-tool-log';
        const summary = document.createElement('summary');
        const model = typeof meta?.model === 'string' ? meta.model : 'model';
        summary.textContent = `read ${toolLog.length} tool call(s) — ${model}, ${meta?.iterations ?? '?'} provider call(s)`;
        details.appendChild(summary);
        for (const call of toolLog) {
            const line = document.createElement('div');
            line.className = `system-tool-line${call.ok ? '' : ' system-tool-fail'}`;
            const name = document.createElement('span');
            name.className = 'system-tool-name';
            name.textContent = TOOL_LABELS[call.name] ?? call.name ?? '?';
            const detail = document.createElement('span');
            detail.textContent = call.ok ? `${call.resultChars ?? 0} chars` : (call.detail || 'refused');
            line.append(name, detail);
            details.appendChild(line);
            // A failed call's `detail` line is its message; only successful calls get a
            // result block, since their bounded answer is what the operator reads.
            const resultBlock = this._toolResultBlock(call);
            if (resultBlock) details.appendChild(resultBlock);
        }
        return details;
    }

    /**
     * One result block under a successful call: the bounded JSON answer the server
     * gave the model, shown so the operator reads what the System actually read, not
     * just "N chars". Collapsed: the call line remains the log, the block is the
     * detail. A payload that fails to parse (a server bug) renders raw — display
     * data, never executed (no model text becomes markup, module header).
     * @private
     * @param {Object} call - one toolLog entry
     * @returns {HTMLElement|null}
     */
    _toolResultBlock(call) {
        const result = (call && typeof call.result === 'string' && call.result.length > 0) ? call.result : null;
        if (!result) return null;
        const block = document.createElement('details');
        block.className = 'system-tool-result';
        const summary = document.createElement('summary');
        const charsText = (call.resultChars ?? result.length) + ' chars';
        let bodyText = result;
        let summaryText;
        try {
            const parsed = JSON.parse(result);
            if (parsed && typeof parsed === 'object') {
                bodyText = JSON.stringify(parsed, null, 1);
                summaryText = (parsed.truncated === true)
                    ? 'result — truncated (head kept)'
                    : 'result (' + charsText + ')';
            } else {
                bodyText = String(parsed);
                summaryText = 'result (' + charsText + ')';
            }
        } catch {
            summaryText = 'result (' + charsText + ')';
        }
        summary.textContent = summaryText;
        const pre = document.createElement('pre');
        pre.textContent = bodyText;
        block.append(summary, pre);
        return block;
    }

    /**
     * @private The card the Write mod button belongs to — what the operator decides on.
     * @returns {HTMLElement|null}
     */
    _renderProposalCard() {
        if (!this._proposal) return null;
        const card = document.createElement('div');
        card.className = 'system-proposal';

        const header = document.createElement('div');
        header.className = 'system-proposal-header';
        const id = document.createElement('span');
        id.className = 'system-proposal-id';
        id.textContent = this._proposal.packageId;
        const writeButton = document.createElement('button');
        writeButton.type = 'button';
        writeButton.className = 'system-btn system-btn-primary';
        writeButton.textContent = this._written ? 'Written' : 'Write mod';
        writeButton.addEventListener('click', () => void this._write());
        // The enabled state is NOT baked in here. The transcript is repainted while the turn
        // is still in flight (`_send` renders, then clears the busy flag), so a `disabled`
        // computed once at paint time freezes the button disabled — and a click on a disabled
        // button fires no event, which is a panel that does nothing with no error anywhere.
        this._writeButton = writeButton;
        this._refreshWriteButton();
        header.append(id, writeButton);

        const note = document.createElement('p');
        note.className = 'system-proposal-note';
        note.textContent = this._proposal.description
            + (this._proposal.rationale ? ` — ${this._proposal.rationale}` : '')
            + '. Writes a package under data/mods/ only; the world takes it at the next round boundary (Mods → Apply).';

        const keys = document.createElement('div');
        keys.className = 'system-proposal-keys';
        const added = document.createElement('div');
        added.textContent = `adds: ${(this._proposal.added ?? []).map((a) => `${a.kind}/${a.key}`).join(', ') || 'nothing'}`;
        keys.appendChild(added);
        const overrides = (this._proposal.overrides ?? []);
        if (overrides.length > 0) {
            const line = document.createElement('div');
            line.className = 'system-proposal-override';
            line.textContent = `overrides official content: ${overrides.map((a) => `${a.kind}/${a.key}`).join(', ')}`;
            keys.appendChild(line);
        }

        const pre = document.createElement('pre');
        pre.className = 'system-proposal-json';
        pre.textContent = JSON.stringify(this._proposal.content, null, 2);

        card.append(header, note, keys, pre);
        return card;
    }

    /**
     * @private
     * @param {string} text
     * @param {boolean} [isError=false]
     */
    _setStatus(text, isError = false) {
        if (!this._status) return;
        this._status.textContent = text;
        this._status.className = isError ? 'system-status system-status-error' : 'system-status';
    }

    /** @private */
    _setBusy(busy) {
        if (this._sendButton) this._sendButton.disabled = busy;
        if (this._newButton) this._newButton.disabled = busy;
        this._refreshWriteButton();
    }

    /**
     * One rule, called from every place that changes the facts behind it: the Write mod
     * button is clickable when a proposal is on the table, nothing was written yet, and no
     * request is in flight.
     * @private
     */
    _refreshWriteButton() {
        if (this._writeButton) this._writeButton.disabled = this._written || this._inFlight;
    }

    // ---------------------------------------------------------------- session id

    /** @private @returns {string|null} */
    _readStoredSessionId() {
        try {
            const value = sessionStorage.getItem(SESSION_STORAGE_KEY);
            return typeof value === 'string' && value.length > 0 ? value : null;
        } catch (error) {
            ClientLogger.warn('SystemPanel', 'sessionStorage unavailable', error?.message ?? error);
            return null;
        }
    }

    /** @private @param {string|null} sessionId */
    _storeSessionId(sessionId) {
        if (!sessionId) return;
        try {
            sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
        } catch (error) {
            ClientLogger.warn('SystemPanel', 'could not store the session id', error?.message ?? error);
        }
    }
}
