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
 * WHY THE WORLD KEEPS RUNNING BEHIND THE LAUNCHER. The server is the product:
 * the simulation does not pause because a browser is looking at a menu. The
 * launcher covers the game; it does not suspend it. "Enter world" only removes
 * the cover - which is also why creating a world from here cannot deadlock: the
 * create is a request like any other.
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

        this._bind('btn-menu-create-world', () => this.open('create-world'));
        this._bind('btn-menu-mods', () => this.open('mods'));
        this._bind('btn-launcher-create', () => this.open('create-world'));
        this._bind('btn-launcher-mods', () => this.open('mods'));
        this._bind('btn-launcher-enter', () => this.close());
        this._bind('btn-create-world-close', () => this.close());
        this._bind('btn-mods-close', () => this.close());

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this._openScreen && this._openScreen !== 'launcher') {
                this.close();
            }
        });

        this._initialized = true;
        ClientLogger.info('AppMenu', 'ready; screens:', Object.keys(SCREENS).join(', '));
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
        }
    }

    /** Hide every view - the game underneath is what is left. */
    close() {
        this.open(null);
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
