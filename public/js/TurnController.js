/**
 * TurnController
 * Client-side controller for the turn system (Feature A, spec §5).
 * Owns: the HUD in the config-bar center slot, the active targeting mode
 * (🕒 Turn | ⚡ Immediate), and queue list/cancel for the active entity.
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
     */
    constructor({ worldState, getMyEntityId = null, onModeChange = null, onCancelQueued = null } = {}) {
        /** @private */
        this._worldState = worldState;
        /** @private */
        this._getMyEntityId = getMyEntityId;
        /** @private */
        this._onModeChange = onModeChange;
        /** @private */
        this._onCancelQueued = onCancelQueued;
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
     * @param {Object} payload - { roundNumber, phase, currentTick, planningDeadlineTick, actorOrder }
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
                <div class="turn-hud-progress" title="Round progress"><div class="turn-hud-progress-fill" id="turn-hud-progress"></div></div>
                <span class="turn-hud-initiative" id="turn-hud-initiative"></span>
                <div class="turn-hud-queue" id="turn-hud-queue"></div>
                <div class="turn-hud-mode">
                    <button class="turn-mode-btn" id="turn-mode-toggle" title="Toggle targeting mode"></button>
                </div>
            </div>`;
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
     * Renders the dynamic HUD parts from a state.turns object.
     * @private
     */
    _render(turns) {
        const roundEl = this._root.querySelector('#turn-hud-round');
        const phaseEl = this._root.querySelector('#turn-hud-phase');
        const progressEl = this._root.querySelector('#turn-hud-progress');
        const initiativeEl = this._root.querySelector('#turn-hud-initiative');
        const queueEl = this._root.querySelector('#turn-hud-queue');
        if (!roundEl) return;

        roundEl.textContent = `Round ${turns.roundNumber ?? '?'}`;

        const isPlanning = turns.phase === TURN_PHASES.PLANNING;
        phaseEl.textContent = isPlanning ? '🕒 Planning' : '⚔️ Resolution';
        phaseEl.classList.toggle('turn-phase-planning', isPlanning);
        phaseEl.classList.toggle('turn-phase-resolution', !isPlanning);

        // Progress: local tick within the 360-tick round.
        const roundStart = (turns.roundNumber ?? 0) * AppConfig.TURN.ROUND_TICKS;
        const local = Math.max(0, (turns.currentTick ?? 0) - roundStart);
        const pct = Math.min(100, Math.max(0, (local / AppConfig.TURN.ROUND_TICKS) * 100));
        if (progressEl) progressEl.style.width = `${pct.toFixed(1)}%`;

        // Initiative order (compact: #1 name(init) · #2 name(init) …).
        const order = Array.isArray(turns.actorOrder) ? turns.actorOrder : [];
        initiativeEl.textContent = order
            .slice(0, 6)
            .map((a, i) => `#${i + 1} ${a.name}(${a.initiative})${a.queuedCount > 0 ? `🕒${a.queuedCount}` : ''}`)
            .join('  ·  ');
        initiativeEl.title = order.map((a, i) => `#${i + 1} ${a.name} — initiative ${a.initiative}${a.queuedCount ? `, queued: ${a.queuedCount}` : ''}`).join('\n');

        this._renderQueue(queueEl, turns);
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
