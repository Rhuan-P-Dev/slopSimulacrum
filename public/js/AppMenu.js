/**
 * AppMenu - the top menu bar and the two full-screen views behind it.
 *
 * The bar carries the brand and the two entry points the world is managed from:
 * **Create world** (choose the cards that populate it) and **Mods** (see and
 * manage the installed packages). The views are full-screen: this is a launcher,
 * not a settings drawer - you come here to decide something about the world, and
 * you leave by entering it.
 *
 * WHAT THIS DOES NOT DO. It runs no rules. "Create world" is one POST to
 * `/world/create` and "apply a mod" is one POST to `/mods/apply`; the server
 * decides what either means and what it refuses (`wiki/decisions/mod-system.md`).
 * The client is disposable by design - this file is no exception, and nothing in
 * it computes anything the server has not already answered.
 *
 * WHY THE WORLD ONLY RUNS WHEN IT WAS ASKED FOR. The server boots idle: it loads
 * the world definition and stands the population down, so no round runs and no
 * model is called until `POST /world/create`. This menu is therefore not a cover
 * over a simulation that was already running - it is the front door. It reads
 * `running` from `GET /world-state` and says out loud which of the two states the
 * server is in: "Enter world" is disabled while nothing runs, "Stop world"
 * appears while something does.
 *
 * WHY THE WORLD DOES NOT PAUSE BEHIND THE LAUNCHER. Once it is running, the
 * server is the product: the simulation does not stop because a browser is
 * looking at a menu. Closing a view removes the cover; only "Stop world" ends it.
 * The brand at the left of the bar opens the launcher again from inside the
 * world, which is how you reach "Stop world" without reloading.
 *
 * Escape closes the open view. No other keyboard shortcuts are claimed here:
 * 1-4 already belong to the overlay windows (OverlayManager).
 *
 * @module public/js/AppMenu
 */
import ClientLogger from '/utils/ClientLogger.js';
import { CreateWorldPanel } from './CreateWorldPanel.js';
import { ModsPanel } from './ModsPanel.js';

/** The views this menu knows, in the order the launcher offers them. */
const SCREENS = {
    launcher: 'launcher-screen',
    'create-world': 'create-world-screen',
    mods: 'mods-screen'
};

/**
 * The two endpoints this menu speaks to. Reading the world is a GET of the state
 * the client will read anyway; stopping it is one POST. Everything about what
 * either means is the server's (`src/routes/worldRoutes.js`).
 */
const ENDPOINTS = {
    worldState: '/world-state',
    worldStop: '/world/stop'
};

/** The launcher's own copy of the truth, in the two states there are. */
const STATUS_TEXT = {
    running: (entities, round) => `World running: ${entities} entit${entities === 1 ? 'y' : 'ies'}, round ${round}. Closing this menu does not pause it.`,
    idle: 'No world running. The server is idle - nothing is simulated and no model is called until you create one.',
    // A restored world (`POST /api/world/load`) has entities but no rounds.
    stopped: (entities) => `Nothing is running, and ${entities} entit${entities === 1 ? 'y' : 'ies'} stand in the restored world. Create a world to start rounds.`,
    unknown: 'Could not read the world status from the server.'
};

export class AppMenu {
    constructor() {
        /** @private */
        this._initialized = false;
        /** @private {string|null} the view currently covering the game */
        this._openScreen = null;
        /** @private {Object<string, HTMLElement>} */
        this._els = {};
        /** @private */
        this._createWorld = null;
        /** @private */
        this._mods = null;
        /** @private {boolean} whether there is something to look at. */
        this._canEnter = false;
        /** @private {number} counts status reads so a late answer cannot repaint. */
        this._statusToken = 0;
        /** @private {HTMLElement|null} the launcher's status line. */
        this._statusEl = null;
        /** @private {HTMLElement|null} */
        this._enterEl = null;
        /** @private {HTMLElement|null} */
        this._stopEl = null;
    }

    /**
     * Wire the bar, the launcher's buttons, and the close controls.
     *
     * Reads the DOM instead of building it: the screens are in `index.html`
     * because a launcher that is not in the HTML is a launcher that appears
     * one fetch after the page does.
     */
    init() {
        if (this._initialized) return;
        for (const [name, id] of Object.entries(SCREENS)) {
            const el = document.getElementById(id);
            if (!el) throw new Error(`AppMenu: #${id} not found.`);
            this._els[name] = el;
        }

        // Not in `_els`: that map is the set of full-screen views, and `open()`
        // shows and hides everything in it. These three live inside the launcher.
        this._statusEl = document.getElementById('launcher-status');
        this._enterEl = document.getElementById('btn-launcher-enter');
        this._stopEl = document.getElementById('btn-launcher-stop');

        this._bind('menu-brand', () => this.open('launcher'));
        this._bind('btn-menu-create-world', () => this.open('create-world'));
        this._bind('btn-menu-mods', () => this.open('mods'));
        this._bind('btn-launcher-create', () => this.open('create-world'));
        this._bind('btn-launcher-mods', () => this.open('mods'));
        this._bind('btn-launcher-enter', () => this.close());
        this._bind('btn-launcher-stop', () => this._stopWorld());
        this._bind('btn-create-world-close', () => this.close());
        this._bind('btn-mods-close', () => this.close());

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this._openScreen && this._openScreen !== 'launcher') {
                this.close();
            }
        });

        this._initialized = true;
        ClientLogger.info('AppMenu', 'ready; screens:', Object.keys(SCREENS).join(', '));
        // The page loads on the launcher, and the launcher's whole job is to say
        // what the server is doing. Asking here is what makes "no world running"
        // a fact on the screen instead of a guess about it.
        this._refreshWorldStatus();
    }

    /**
     * Show one view, hiding the others. `null` (or an unknown name) shows none,
     * which is the game.
     * @param {string|null} name - `launcher` | `create-world` | `mods` | null.
     */
    open(name) {
        for (const [key, el] of Object.entries(this._els)) {
            el.style.display = key === name ? 'flex' : 'none';
        }
        this._openScreen = this._els[name] ? name : null;
        if (!this._openScreen) return;

        // A view is only built the first time it is opened, and it refreshes
        // every time: the world and the package directory are things an operator
        // changes from outside this page, so a cached render is a lie about now.
        if (name === 'create-world') {
            this._ensureCreateWorld().refresh();
        } else if (name === 'mods') {
            this._ensureMods().refresh();
        } else if (name === 'launcher') {
            // Re-ask, never reuse: another tab, another operator or a POST from
            // outside this page can have started or stopped the world since.
            this._refreshWorldStatus();
        }
    }

    /**
     * Leave the launcher: show the world underneath.
     *
     * With nothing to look at there is nothing to show, so this returns to the
     * launcher instead of to an empty canvas - the button that does this is
     * disabled by the same rule, and this is the same rule for the paths that
     * reach it by other means (Escape, a view's Close).
     */
    close() {
        this.open(this._canEnter ? null : 'launcher');
    }

    /** @returns {boolean} whether a view is covering the game. */
    isOpen() {
        return !!this._openScreen;
    }

    /** @private Lazily build the create-world view (its own module). */
    _ensureCreateWorld() {
        if (!this._createWorld) {
            this._createWorld = new CreateWorldPanel({
                contentEl: document.getElementById('create-world-content'),
                statusEl: document.getElementById('create-world-status'),
                submitEl: document.getElementById('btn-create-world-go'),
                // A created world is a different world. Every client cache -
                // world state, inventory, chat, capability views - belongs to the
                // one that just ended, so the page reloads instead of trying to
                // reconcile them. The server has already broadcast the new state.
                onCreated: () => window.location.reload()
            });
        }
        return this._createWorld;
    }

    /** @private Lazily build the mod-manager view (its own module). */
    _ensureMods() {
        if (!this._mods) {
            this._mods = new ModsPanel({
                contentEl: document.getElementById('mods-content'),
                statusEl: document.getElementById('mods-status'),
                rescanEl: document.getElementById('btn-mods-rescan'),
                planEl: document.getElementById('btn-mods-plan'),
                applyEl: document.getElementById('btn-mods-apply')
            });
        }
        return this._mods;
    }

    /**
     * Ask the server whether a world runs, and paint that answer.
     *
     * Reads the state the client is going to fetch anyway (`GET /world-state`)
     * rather than inventing a status endpoint: `running` travels with it.
     * Tokened, because two reads can answer out of order and the older one must
     * not repaint a newer truth.
     * @private
     */
    async _refreshWorldStatus() {
        const token = ++this._statusToken;
        try {
            const response = await fetch(ENDPOINTS.worldState);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            if (token !== this._statusToken) return;
            this._renderWorldStatus(payload.running === true, payload.state || null, null);
        } catch (error) {
            if (token !== this._statusToken) return;
            ClientLogger.warn('AppMenu', 'world status read failed:', error.message);
            // Unknown is not running: "Enter world" over an answer we do not have
            // is a blank canvas, and "Stop world" is a guess.
            this._renderWorldStatus(false, null, STATUS_TEXT.unknown);
        }
    }

    /**
     * Stop the world, then reload. Like creating one: every cache the client
     * holds - entities, inventory, chat, views - belongs to the world that just
     * ended, and reconciling them is more work than not having them.
     * @private
     */
    async _stopWorld() {
        if (this._stopEl) this._stopEl.disabled = true;
        this._setStatus('Stopping the world...');
        try {
            const response = await fetch(ENDPOINTS.worldStop, { method: 'POST' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            window.location.reload();
        } catch (error) {
            ClientLogger.warn('AppMenu', 'stop world failed:', error.message);
            this._setStatus(`${STATUS_TEXT.unknown} (${error.message})`);
            if (this._stopEl) this._stopEl.disabled = false;
        }
    }

    /**
     * @param {boolean} running - what the server says about rounds.
     * @param {Object|null} state - the world state the same answer carried.
     * @param {string|null} override - the message when there is no answer to describe.
     * @private
     */
    _renderWorldStatus(running, state, override) {
        const entities = state ? Object.keys(state.entities || {}).length : 0;
        // Two different questions, so two different answers. `running` is whether
        // rounds advance; entering is whether there is anything to look at. A
        // world restored by `POST /api/world/load` has entities and no rounds, and
        // the operator should still be able to walk into it - while "Stop world"
        // is offered only to a world that is actually being simulated.
        this._canEnter = running === true || entities > 0;
        if (this._enterEl) this._enterEl.disabled = !this._canEnter;
        if (this._stopEl) this._stopEl.style.display = running ? '' : 'none';
        if (override) {
            this._setStatus(override);
            return;
        }
        if (running) {
            const round = state.turns && typeof state.turns.roundNumber === 'number' ? state.turns.roundNumber : 0;
            this._setStatus(STATUS_TEXT.running(entities, round));
            return;
        }
        this._setStatus(entities > 0 ? STATUS_TEXT.stopped(entities) : STATUS_TEXT.idle);
    }

    /** @private Write the launcher's status line. */
    _setStatus(text) {
        if (this._statusEl) this._statusEl.textContent = text;
    }

    /** @private Bind a click by element id; a missing element is not fatal. */
    _bind(id, handler) {
        const el = document.getElementById(id);
        if (!el) {
            ClientLogger.warn('AppMenu', `#${id} not found - that control is missing from index.html.`);
            return;
        }
        el.addEventListener('click', handler);
    }
}

export default AppMenu;
