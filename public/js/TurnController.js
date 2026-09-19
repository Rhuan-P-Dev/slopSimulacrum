/**
 * TurnController
 * Client-side controller for the turn system (Feature A, spec §5).
 * Owns: the HUD in the config-bar center slot, the active targeting mode
 * (🕒 Turn | ⚡ Immediate), queue list/cancel for the active entity, and the
 * Space (␣) lock-in: pressing the Space key on the keyboard signals plan-complete,
 * identical to the ✅ Lock in button (same injected onReady callback, same
 * server-derived rules).
 *
 * Data flow (single source of truth — the server):
 *   - state.turns arrives inside every `world-state-update` (full state) and
 *     is re-read from WorldStateManager on each refresh.
 *   - `turn-round-update` (dedicated Socket.IO event) is a fast path for
 *     phase/round transitions; it does NOT carry queues (those ride the full
 *     state), so we just re-read the latest full state.
 *
 * Mode policy (spec §10.1): turns are always active on the server; the UI
 * defaults to 🕒 Turn mode (clicks ENQUEUE with queueForRound:true) but
 * ⚡ Immediate preserves the legacy behavior (clicks execute right away).
 *
 * Logging: ClientLogger ONLY — never console.* (BUG-123).
 *
 * @module TurnController
 */
import { AppConfig } from './Config.js';
import { TURN_PHASES } from '../../shared/TurnPhases.js';
import ClientLogger from '/utils/ClientLogger.js';

/**
 * TurnController class.
 */
export class TurnController {
    /**
     * @param {Object} deps
     * @param {Function} deps.worldState - Getter for the current world state (with .turns).
     * @param {Function} [deps.getMyEntityId] - Returns the client's own entity ID (from WorldStateManager).
     * @param {Function} [deps.onModeChange] - Called with the new mode ('turn'|'immediate') when the toggle flips.
     * @param {Function} [deps.onCancelQueued] - Called with (entityId, queueId) when a queue entry is cancelled.
     * @param {Function} [deps.onReady] - Called with (entityId) when the player
     *   signals plan-complete. Used by the ✅ Lock in button and the Space (␣)
     *   keyboard shortcut — both fire the same request.
     */
    constructor({ worldState, getMyEntityId = null, onModeChange = null, onCancelQueued = null, onReady = null } = {}) {
        /** @private */
        this._worldState = worldState;
        /** @private */
        this._getMyEntityId = getMyEntityId;
        /** @private */
        this._onModeChange = onModeChange;
        /** @private */
        this._onCancelQueued = onCancelQueued;
        /** @private */
        this._onReady = onReady;
        /** @private {'turn'|'immediate'} */
        this._mode = 'turn';
        /** @private {HTMLElement|null} */
        this._root = null;
    }

    /**
     * Binds the controller to its DOM slot (the config-bar center).
     * Safe no-op if the slot is missing (UI never breaks — spec: HUD must not
     * break the existing UI).
     */
    init() {
        this._root = document.getElementById('turn-hud');
        if (!this._root) {
            ClientLogger.warn('TurnController', 'HUD slot #turn-hud not found — turn HUD disabled.');
            return;
        }
        this._root.innerHTML = this._buildHtml();
        this._bindModeToggle();
        this._bindReadyButton();
        this._bindSpaceKey();
    }

    /**
     * Returns the active targeting mode.
     * @returns {'turn'|'immediate'}
     */
    getMode() {
        return this._mode;
    }

    /**
     * True when action clicks should be ENQUEUED for the round (Turn mode)
     * rather than executed immediately. Returns false when:
     *   - the UI is in ⚡ Immediate mode, OR
     *   - the round is not in the planning window (resolution/settle), so the
     *     server would reject the queue anyway (PLANNING_CLOSED).
     * This is the lazy gate consumed by ActionManager at request time.
     * @returns {boolean}
     */
    shouldQueueForRound() {
        if (this._mode !== 'turn') return false;
        try {
            const turns = this._worldState()?.turns;
            return !!turns && turns.phase === TURN_PHASES.PLANNING;
        } catch {
            return false;
        }
    }

    /**
     * Renders the HUD from the current world state. No-op when no state.turns
     * is available yet (server pre-Feature-A / not connected) — the slot stays
     * empty and the UI is unaffected.
     */
    update() {
        if (!this._root) return;
        const state = this._worldState();
        const turns = state?.turns;
        if (!turns || typeof turns !== 'object') return;
        this._render(turns);
    }

    /**
     * Fast path for the `turn-round-update` transition event: log + re-render
     * from the (possibly just-arrived) full state. The event payload itself is
     * logged for the console trail but NOT rendered directly — queues must
     * always come from the full state.
     * @param {Object} payload - { roundNumber, phase, currentTick, actorOrder, barrier }
     */
    onTransition(payload) {
        if (!payload) return;
        ClientLogger.info('TurnController', `Turn transition: round ${payload.roundNumber} → ${payload.phase}`, { payload });
        this.update();
    }

    // =========================================================================
    // INTERNALS
    // =========================================================================

    /**
     * Builds the static HUD markup (mode toggle + dynamic containers).
     * @private
     */
    _buildHtml() {
        return `
            <div class="turn-hud">
                <span class="turn-hud-round" id="turn-hud-round"></span>
                <span class="turn-hud-phase" id="turn-hud-phase"></span>
                <span class="turn-hud-initiative" id="turn-hud-initiative"></span>
                <span class="turn-hud-barrier" id="turn-hud-barrier"></span>
                <div class="turn-hud-queue" id="turn-hud-queue"></div>
                <div class="turn-hud-ready">
                    <!-- Default hidden: only _renderBarrier() opts it in, while
                         planning is open (and only for the player's own entity).
                         Space on the keyboard does the same action — see
                         _bindSpaceKey(). -->
                    <button class="turn-ready-btn" id="turn-ready-btn" style="display: none;"></button>
                </div>
                <div class="turn-hud-mode">
                    <button class="turn-mode-btn" id="turn-mode-toggle" title="Toggle targeting mode"></button>
                </div>
            </div>`;
    }

    /**
     * Wires the ready (plan-complete) button. The click only fires the
     * injected onReady callback — the HTTP call lives in App (same pattern as
     * onCancelQueued → _cancelQueuedAction).
     * @private
     */
    _bindReadyButton() {
        const btn = this._root?.querySelector('#turn-ready-btn');
        if (!btn) return;
        btn.addEventListener('click', () => {
            const myEntityId = this._myEntityId();
            if (!myEntityId || !this._onReady) return;
            ClientLogger.info('TurnController', `Signaling plan-complete for ${myEntityId}`);
            this._onReady(myEntityId);
        });
    }

    /**
     * Wires the Space (␣) keyboard shortcut — the same lock-in the ✅ button
     * does. Fires ONLY when the server state would show the lock-in button
     * (planning open AND the player is still the pending planner): the guard
     * re-derives from the latest full state on every press, so it agrees with
     * the HUD on every render cycle (no local flag). While typing (input/
     * textarea/select/content-editable) or on a focusable widget (button,
     * select, tabindex, role=button — e.g. crafting cards, stat selects), the
     * key does nothing, so Space in chat, a card or a dropdown never commits a
     * plan. ClientLogger ONLY, same as everywhere else.
     * @private
     */
    _bindSpaceKey() {
        document.addEventListener('keydown', (event) => {
            // Anything that isn't a bare Space gesture is page scrolling or a
            // widget shortcut (card select, form focus) — let it happen.
            if (event.code !== 'Space') return;
            if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
            const target = event.target;
            if (target instanceof HTMLElement && (target.isContentEditable ||
                    target.closest('input, textarea, select, button, [tabindex], [role="button"]'))) {
                return;
            }
            if (!this._canLockInNow()) return;
            if (!this._onReady) return; // parity with the ✅ button handler (onReady is optional)
            event.preventDefault(); // commit press must not scroll the page
            const myEntityId = this._myEntityId();
            ClientLogger.info('TurnController', `Space key: signaling plan-complete for ${myEntityId}`);
            this._onReady(myEntityId);
        });
    }

    /**
     * True when lock-in is available right now: planning phase open and this
     * client's entity is still listed as a pending planner in the barrier. Same
     * derivation the HUD uses to show the ✅ Lock in button, so the Space key
     * and the ✅ button never disagree. No local state.
     * @private
     * @returns {boolean}
     */
    _canLockInNow() {
        try {
            const turns = this._worldState()?.turns;
            if (!turns || turns.phase !== TURN_PHASES.PLANNING) return false;
            const barrier = turns.barrier;
            if (!barrier || typeof barrier !== 'object') return false;
            const myEntityId = this._myEntityId();
            const pending = Array.isArray(barrier.pendingEntityIds) ? barrier.pendingEntityIds : [];
            return !!myEntityId && pending.includes(myEntityId);
        } catch {
            return false;
        }
    }

    /**
     * Wires the mode toggle button.
     * @private
     */
    _bindModeToggle() {
        const btn = this._root.querySelector('#turn-mode-toggle');
        if (!btn) return;
        btn.addEventListener('click', () => {
            this._mode = this._mode === 'turn' ? 'immediate' : 'turn';
            ClientLogger.info('TurnController', `Mode switched to ${this._mode}`);
            this._renderMode();
            if (this._onModeChange) this._onModeChange(this._mode);
        });
        this._renderMode();
    }

    /**
     * Updates the mode toggle label.
     * @private
     */
    _renderMode() {
        const btn = this._root?.querySelector('#turn-mode-toggle');
        if (!btn) return;
        if (this._mode === 'turn') {
            btn.textContent = '🕒 Turn';
            btn.classList.add('turn-mode-active');
            btn.classList.remove('turn-mode-immediate');
        } else {
            btn.textContent = '⚡ Immediate';
            btn.classList.remove('turn-mode-active');
            btn.classList.add('turn-mode-immediate');
        }
    }

    /**
     * Renders the two-phase barrier status line + the ready/lock-in button.
     * The button state is derived PURELY from the server barrier (is my
     * entity still pending? already signaled? planning closed?) — there is no
     * local flag, so it resets itself every round when the server rebuilds the
     * roster. An absent barrier (older server) hides the button.
     *
     * Spec v2 status line: while planning — the ready count plus the NAMES
     * of the pending planners (the wait is unbounded by design, so the HUD
     * must make visible WHO the round is waiting on); when closed — the
     * close info (reason as plain text + closedAtTick). A legacy 'deadline'
     * reason from a v1-era save still displays sensibly because the reason
     * renders as text, not as a branch.
     * @private
     */
    _renderBarrier(turns) {
        const statusEl = this._root?.querySelector('#turn-hud-barrier');
        const btn = this._root?.querySelector('#turn-ready-btn');
        if (!statusEl || !btn) return;
        const barrier = turns.barrier;
        if (!barrier || typeof barrier !== 'object') {
            statusEl.textContent = '';
            btn.style.display = 'none';
            return;
        }
        const myEntityId = this._myEntityId();
        const pending = Array.isArray(barrier.pendingEntityIds) ? barrier.pendingEntityIds : [];
        const total = (barrier.readyCount ?? 0) + pending.length;
        const iAmPending = !!myEntityId && pending.includes(myEntityId);
        const isPlanning = turns.phase === TURN_PHASES.PLANNING;

        statusEl.textContent = barrier.closed
            ? `Planning closed (${barrier.closeReason ?? 'unknown'}) @ tick ${barrier.closedAtTick ?? '?'}`
            : `Ready ${barrier.readyCount ?? 0}/${total}`;
        statusEl.classList.toggle('turn-barrier-closed', !!barrier.closed);

        statusEl.title = barrier.closed
            ? `Close reason: ${barrier.closeReason ?? 'unknown'} (tick ${barrier.closedAtTick ?? '?'})`
            : 'Planning is unlimited — the round executes the moment every planner is ready';

        if (!isPlanning) {
            btn.style.display = 'none';
            return;
        }
        btn.style.display = '';
        if (iAmPending) {
            btn.textContent = '✅ Lock in';
            btn.classList.remove('turn-ready-locked');
            btn.disabled = false;
            btn.title = 'Signal plan-complete: your plans are locked in for this round';
        } else if (myEntityId) {
            btn.textContent = '🔒 Locked in';
            btn.classList.add('turn-ready-locked');
            btn.disabled = true;
            btn.title = 'Your plans are locked in; waiting for the other planners';
        } else {
            // No local entity id → plan-complete cannot be claimed; show a
            // neutral disabled state instead of a false "Locked in".
            btn.textContent = 'Planning';
            btn.classList.remove('turn-ready-locked');
            btn.disabled = true;
            btn.title = 'Local entity unknown — plan-complete signaling unavailable';
        }
    }

    /**
     * Best-effort { entityId: name } map for barrier tooltips.
     * @private
     */
    _entityNames() {
        try {
            const entities = this._worldState()?.entities;
            if (!entities || typeof entities !== 'object') return {};
            const names = {};
            for (const [id, entity] of Object.entries(entities)) {
                names[id] = (entity && entity.name) || id;
            }
            return names;
        } catch {
            return {};
        }
    }

    /**
     * Renders the dynamic HUD parts from a state.turns object.
     * @private
     */
    _render(turns) {
        const roundEl = this._root.querySelector('#turn-hud-round');
        const phaseEl = this._root.querySelector('#turn-hud-phase');
        const initiativeEl = this._root.querySelector('#turn-hud-initiative');
        const queueEl = this._root.querySelector('#turn-hud-queue');
        if (!roundEl) return;

        roundEl.textContent = `Round ${turns.roundNumber ?? '?'}`;

        const isPlanning = turns.phase === TURN_PHASES.PLANNING;
        phaseEl.textContent = isPlanning ? '🕒 Planning' : '⚔️ Resolution';
        phaseEl.classList.toggle('turn-phase-planning', isPlanning);
        phaseEl.classList.toggle('turn-phase-resolution', !isPlanning);

        // Initiative order (compact: #1 name(init) · #2 name(init) …).
        const order = Array.isArray(turns.actorOrder) ? turns.actorOrder : [];
        initiativeEl.textContent = order
            .slice(0, 6)
            .map((a, i) => `#${i + 1} ${a.name}(${a.initiative})${a.queuedCount > 0 ? `🕒${a.queuedCount}` : ''}`)
            .join('  ·  ');
        initiativeEl.title = order.map((a, i) => `#${i + 1} ${a.name} — initiative ${a.initiative}${a.queuedCount ? `, queued: ${a.queuedCount}` : ''}`).join('\n');

        this._renderQueue(queueEl, turns);
        this._renderBarrier(turns);
    }

    /**
     * Renders the active entity's queued entries with cancel buttons.
     * @private
     */
    _renderQueue(queueEl, turns) {
        if (!queueEl) return;
        const myEntityId = this._myEntityId();
        const entries = myEntityId ? ((turns.queues && turns.queues[myEntityId]) || []) : [];
        // Clear previous chips — DOM nodes only, no innerHTML with user data.
        while (queueEl.firstChild) queueEl.removeChild(queueEl.firstChild);
        if (!myEntityId || entries.length === 0) return;

        // Build the chips via createElement/textContent (same pattern as
        // RoomChatController): no string interpolation of user-visible
        // values, so there is no HTML-escaping class of bug at all.
        for (const entry of entries) {
            const chip = document.createElement('span');
            chip.className = 'turn-queue-chip';
            chip.title = `Queued at tick ${entry.queuedAtTick} (${entry.source})`;

            const label = document.createElement('span');
            label.className = 'turn-queue-label';
            label.textContent = `🕒 ${entry.actionName}`;

            const btn = document.createElement('button');
            btn.className = 'turn-queue-cancel';
            btn.dataset.queueId = entry.queueId;
            btn.title = 'Cancel queued action';
            btn.textContent = '✕';
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                ClientLogger.info('TurnController', `Cancelling queued action ${entry.queueId}`);
                if (this._onCancelQueued) this._onCancelQueued(myEntityId, entry.queueId);
            });

            chip.appendChild(label);
            chip.appendChild(btn);
            queueEl.appendChild(chip);
        }
    }

    /**
     * The client's own entity ID (WorldStateManager via injected getter).
     * @private
     */
    _myEntityId() {
        if (!this._getMyEntityId) return null;
        try {
            return this._getMyEntityId();
        } catch {
            return null;
        }
    }

}
