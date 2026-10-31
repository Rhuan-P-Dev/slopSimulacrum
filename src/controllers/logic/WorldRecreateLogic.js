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

export default recreateWorld;
