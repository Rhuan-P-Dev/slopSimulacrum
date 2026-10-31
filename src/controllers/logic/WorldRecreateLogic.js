/**
 * WorldRecreateLogic - building a *new* world inside the running server.
 *
 * "Create world" (the launcher's first menu entry) is neither a boot nor a
 * restore. The process keeps running, the round counter keeps counting
 * (`CR D-6`: a round number never goes backwards, and a new world inherits the
 * round it was created in), and the world *definition* stays whatever the
 * `RegistryStore` already holds - mod packages are a different verb with their
 * own rules (`wiki/decisions/mod-system.md`). What changes is the population:
 * every live entity is despawned, the runtime residue of the old world is
 * cleared, and the world is seeded again exactly the way boot seeds it - static
 * props, data-driven NPCs, and then only the cards the operator chose.
 *
 * WHY in-place on the same facade. Every sub-controller, every route and every
 * live socket holds a reference to the one `WorldStateController` built at
 * boot. Constructing a second one would strand all of them (routes capture the
 * instance at registration time), so the world is cleared and re-seeded rather
 * than replaced. That is also what keeps the mod pipeline honest: the store
 * being read by the round boundary is the same store after the create.
 *
 * WHY the map survives. Rooms and their connections are definition, not runtime
 * state - they come from the mod packages. A new world is a new population on
 * the same map; changing the map means enabling or disabling a package, which
 * is refused or accepted by the composition rules, not by this file.
 *
 * WHAT IS CLEARED, and why those three: entities (the actors), dropped items
 * (the floor), room chat and the world-event log (what the previous world
 * *said*). The first two are world state in `getAll()`; the last two are
 * memory the client reads back, and an operator who has just created a world
 * must not be shown the dead one's transcript. The turn system needs nothing:
 * removals are vacuously complete and stale queues are discarded by it, which
 * is its documented tolerance for despawns mid-round.
 *
 * Validation happens BEFORE anything is destroyed. A request naming a card that
 * does not exist must not empty a running world on its way to an error
 * message.
 *
 * RUNNING AND STANDING DOWN (`startWorld` / `stopWorld`). The world runs only
 * while the operator has asked for one: the server boots, builds its definition
 * (mod packages, map, controllers) and immediately stands the population down,
 * so a fresh process simulates nothing and spends no provider call until
 * `POST /world/create`. `POST /world/stop` returns it to that state. The boot
 * path reaches the stopped state through the same door as the button, which is
 * why "a world that is not running" has exactly one definition here.
 *
 * WHY "running" IS THE TICK AND NOT A FLAG. `UniversalTickSystem.isRunning` is
 * already the single fact that decides whether rounds advance, and the turn
 * system's job is the only thing registered on it (`grep tickSystem.register`).
 * A second boolean for "world active" would be a second truth to keep in sync
 * with the first (`CR NAME-6`). `isWorldRunning()` reads the tick.
 *
 * WHY NOTHING IS PERSISTED. The world has never been persisted (`src/` writes
 * no world state to disk); a restart already rebuilt it from the data files.
 * With the gate in place, a restart lands on the launcher instead - the
 * operator decides again. Decision record: README §World lifecycle.
 *
 * WHAT "NO WORLD" LOOKS LIKE ON THE WIRE. Empty, not an error: every read
 * answers 200 with an empty population and `GET /world-state` says
 * `running: false`. No new endpoint, no new error code was judged worth it
 * (`README §World lifecycle`).
 *
 * A stop does not wait for in-flight LLM rounds. A round whose entity list has
 * been despawned underneath it is the case `recreateWorld` already documents as
 * tolerated (mid-round despawn); stopping is that, once, deliberately.
 *
 * @module controllers/logic/WorldRecreateLogic
 */
import Logger from '../../utils/Logger.js';
import { GameError } from '../../utils/CustomErrors.js';

/** A card id longer than this is a mistake or an attack, never a card stem. */
export const MAX_CARD_ID_LENGTH = 128;

/** How many cards one create request may name. */
export const MAX_CARDS_PER_WORLD = 100;

/** Domain error codes this module owns. */
export const WORLD_CREATE_ERROR_CODES = {
    CARD_ID_INVALID: 'WORLD_CREATE_CARD_ID_INVALID',
    CARD_UNKNOWN: 'WORLD_CREATE_CARD_UNKNOWN',
    TOO_MANY_CARDS: 'WORLD_CREATE_TOO_MANY_CARDS'
};

/** How many unknown ids an error names before saying "and N more". */
const MAX_UNKNOWN_NAMED = 6;

/**
 * Turn the request's `cardIds` into a validated selection.
 *
 * `null` (absent or not a list) means "every card in `data/cards/`", which is
 * what boot does; a list means exactly those ids, and an empty list means an
 * unpopulated world. Every entry must be a usable id, and every id must match a
 * file on disk - otherwise the caller is told which ones did not match, before
 * the world is touched.
 *
 * @param {Function} listCardFiles - `() => Array<{cardId: string}>` (the seam's
 *   card listing, injected so this stays about selection, not about files).
 * @param {*} cardIds - The request value.
 * @returns {{ all: boolean, ids: string[] }} `all: true` when nothing was asked for.
 * @throws {GameError} WORLD_CREATE_CARD_ID_INVALID | WORLD_CREATE_CARD_UNKNOWN
 *   | WORLD_CREATE_TOO_MANY_CARDS
 */
function resolveSelection(listCardFiles, cardIds) {
    if (cardIds === undefined || cardIds === null) return { all: true, ids: [] };
    if (!Array.isArray(cardIds)) {
        throw new GameError('"cardIds" must be an array of card ids (or absent for every card)', WORLD_CREATE_ERROR_CODES.CARD_ID_INVALID);
    }
    const ids = [];
    for (const raw of cardIds) {
        const id = typeof raw === 'string' ? raw.trim() : '';
        if (!id || id.length > MAX_CARD_ID_LENGTH || id.includes('/') || id.includes('\\')) {
            throw new GameError(
                `"${String(raw).slice(0, 40)}" is not a card id (1-${MAX_CARD_ID_LENGTH} characters, no path separator)`,
                WORLD_CREATE_ERROR_CODES.CARD_ID_INVALID
            );
        }
        if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length > MAX_CARDS_PER_WORLD) {
        throw new GameError(
            `a world takes at most ${MAX_CARDS_PER_WORLD} cards (${ids.length} requested)`,
            WORLD_CREATE_ERROR_CODES.TOO_MANY_CARDS
        );
    }
    if (ids.length === 0) return { all: false, ids };

    const onDisk = new Set(listCardFiles().map((file) => file.cardId));
    const unknown = ids.filter((id) => !onDisk.has(id));
    if (unknown.length > 0) {
        const named = unknown.slice(0, MAX_UNKNOWN_NAMED).join(', ');
        const more = unknown.length > MAX_UNKNOWN_NAMED ? ` (+${unknown.length - MAX_UNKNOWN_NAMED} more)` : '';
        throw new GameError(
            `no card file in data/cards/ for: ${named}${more}`,
            WORLD_CREATE_ERROR_CODES.CARD_UNKNOWN
        );
    }
    return { all: false, ids };
}

/**
 * Despawn every entity, one at a time, each guarded.
 *
 * The entity map is read as a snapshot (`getEntities()` clones), so the id list
 * cannot shift under the loop. One despawn failing is logged and the loop
 * continues - a world that ends up with one stubborn entity is a smaller
 * failure than a create request that half-ran and threw.
 * @param {Object} facade
 * @returns {number} how many entities were removed
 */
function despawnAllEntities(facade) {
    const entities = facade.getEntities() || {};
    let removed = 0;
    for (const entityId of Object.keys(entities)) {
        try {
            if (facade.despawnEntity(entityId)) removed++;
        } catch (error) {
            Logger.warn(`[WorldRecreate] entity ${entityId} could not be despawned: ${error.message}`);
        }
    }
    return removed;
}

/**
 * Drop the runtime memory of the world that is ending: what was on the floor,
 * what was said in the rooms, what happened. Each is absent-safe - a partial
 * world (a test fixture, a controller that was never wired) must not fail a
 * create over a store that does not exist.
 * @param {Object} facade
 */
function clearRuntimeResidue(facade) {
    try {
        facade.setDroppedItems({});
    } catch (error) {
        Logger.warn(`[WorldRecreate] dropped items could not be cleared: ${error.message}`);
    }
    try {
        facade.roomChatController?.clear?.();
    } catch (error) {
        Logger.warn(`[WorldRecreate] room chat could not be cleared: ${error.message}`);
    }
    try {
        facade.worldEventLogController?.clear?.();
    } catch (error) {
        Logger.warn(`[WorldRecreate] world events could not be cleared: ${error.message}`);
    }
}

/**
 * Re-run the capability scan the boot sequence runs after world init.
 *
 * A freshly populated world has entities whose capabilities nobody has
 * enumerated yet; without this the first `canExecuteAction` of the new world
 * would answer from an empty cache.
 * @param {Object} facade
 */
function rescanCapabilities(facade) {
    try {
        facade.actionController?.scanAllCapabilities?.(facade.getAll());
    } catch (error) {
        Logger.warn(`[WorldRecreate] capability rescan failed: ${error.message}`);
    }
}

/**
 * Create a new world in place.
 *
 * @param {Object} facade - The `WorldStateController` (the one the server runs).
 * @param {Object} [options]
 * @param {string[]} [options.cardIds] - Cards to populate the world with.
 *   Absent or null: every card in `data/cards/` (the boot behavior). An empty
 *   array: no cards at all.
 * @returns {{ despawned: number, cards: {total: number, spawned: number, entities: Array<{cardId: string, entityId: string}>}, round: number|null }}
 * @throws {GameError} WORLD_CREATE_CARD_ID_INVALID | WORLD_CREATE_CARD_UNKNOWN
 *   | WORLD_CREATE_TOO_MANY_CARDS - always before any mutation.
 */
export function recreateWorld(facade, options = {}) {
    const selection = resolveSelection(() => facade._readCardFiles(), options.cardIds);

    const despawned = despawnAllEntities(facade);
    clearRuntimeResidue(facade);

    // One seeding order for a world, boot and create both. `cardIds: null`
    // re-seeds every card; a list seeds the chosen ones.
    const seeded = facade.initializeWorld(selection.all ? {} : { cardIds: selection.ids });
    rescanCapabilities(facade);

    const round = facade.turnSystemController?.getRoundState?.()?.roundNumber ?? null;
    Logger.info(
        `[WorldRecreate] new world: ${despawned} entity(ies) removed, `
        + `${seeded?.spawned ?? 0}/${seeded?.total ?? 0} card(s) spawned (round ${round ?? 'not started'}).`
    );
    return { despawned, cards: seeded, round };
}

/**
 * Whether this server is simulating: true while the tick system is running.
 *
 * @param {Object} facade - The `WorldStateController`.
 * @returns {boolean}
 */
export function isWorldRunning(facade) {
    return facade?.tickSystem?.isRunning === true;
}

/**
 * Create a world and run it: `recreateWorld` (validate, clear, seed), then start
 * the tick that drives the turn rounds. Starting an already-running world is a
 * rebuild of the population, not a second loop - `UniversalTickSystem.start()`
 * is a no-op while running, so the call is safe to repeat.
 *
 * @param {Object} facade - The `WorldStateController` (the one the server runs).
 * @param {Object} [options] - Passed through to `recreateWorld`.
 * @param {string[]} [options.cardIds] - Cards to populate the world with.
 * @returns {{ despawned: number, cards: Object, round: number|null, running: boolean }}
 * @throws {GameError} the `WORLD_CREATE_ERROR_CODES` of `recreateWorld`, before
 *   anything is destroyed and before the tick is started.
 */
export function startWorld(facade, options = {}) {
    const created = recreateWorld(facade, options);
    if (!facade.tickSystem) {
        // A facade without a tick system is the test mode of the turn system
        // (`TurnSystemController.initialize` warns about exactly this). The
        // population is created and readable; nobody will advance rounds.
        Logger.warn('[WorldRecreate] no tick system injected: the world was created but no round will run.');
    } else {
        facade.tickSystem.start();
    }
    const running = isWorldRunning(facade);
    Logger.info(`[WorldRecreate] world running: ${running}; rounds advance on the tick.`);
    return { ...created, running };
}

/**
 * Stand the world down: stop the tick first (so no round advances into the
 * teardown), then remove the population and the memory of what it did. The map
 * stays - rooms are definition, not runtime (`wiki/decisions/mod-system.md`).
 *
 * Idempotent: stopping a stopped world stops nothing, despawns nothing and
 * answers `running: false`, which is what makes the boot sequence able to call
 * it on a world that never started.
 *
 * @param {Object} facade - The `WorldStateController` (the one the server runs).
 * @returns {{ despawned: number, running: false }}
 */
export function stopWorld(facade) {
    // Only a running tick has something to stop: boot calls this on a server that
    // never started ticking, and a stop that logs "System stopped" on a process
    // that never ran is a line that misleads the next reader.
    if (isWorldRunning(facade)) facade.tickSystem.stop();

    const despawned = despawnAllEntities(facade);
    clearRuntimeResidue(facade);
    // The observer's per-room snapshots describe the population that is gone;
    // `initializeWorld` resets them for the next world, and a stopped world must
    // not answer "since last observation" from the dead one.
    try {
        facade.perceptionController?.reset?.();
    } catch (error) {
        Logger.warn(`[WorldRecreate] perception reset failed: ${error.message}`);
    }

    Logger.info(`[WorldRecreate] world stopped: ${despawned} entity(ies) removed; rounds suspended.`);
    return { despawned, running: false };
}

export default recreateWorld;
