/**
 * UNIT TEST - WorldRecreateLogic: building a new world inside a running server.
 *
 * The claims here are about ORDER and about REFUSAL, because those are the two
 * ways this operation can be expensive:
 *
 *   - a request naming a card that does not exist must not empty a running world
 *     on its way to an error message, so validation runs before the first
 *     despawn (pinned by asserting the facade was never asked to remove anything);
 *   - a new world is seeded by the one seeding order boot uses, with the chosen
 *     cards handed down to it - this module does not reimplement population;
 *   - the memory of the world that is ending goes with it: the floor, the room
 *     chat, the event log. An operator must not be shown the dead world's
 *     transcript in the new one;
 *   - the round number is inherited, never reset (`CR D-6`), and a controller
 *     that was never wired (a partial fixture) must not fail a create.
 *
 * The facade is a light double: this module's job is orchestration, so the
 * double records the calls and their order. The card listing comes in through
 * `facade._readCardFiles()`, which is what keeps the test off the disk.
 *
 * @module test/unit/WorldRecreateLogic
 */

import { describe, it, expect } from 'vitest';
import {
    recreateWorld,
    WORLD_CREATE_ERROR_CODES,
    MAX_CARDS_PER_WORLD
} from '../../src/controllers/logic/WorldRecreateLogic.js';

/**
 * A facade double that records every call, in order.
 * @param {Object} [options]
 * @param {string[]} [options.onDisk] - The card ids the seam would list.
 * @param {string[]} [options.entities] - The entity ids currently alive.
 * @param {boolean} [options.partial] - A world built without chat / events / actions.
 */
function makeFacade({ onDisk = ['Nova', 'Rin'], entities = ['ent-1', 'ent-2'], partial = false } = {}) {
    const calls = [];
    const record = (...args) => calls.push(args);
    const facade = {
        calls,
        _readCardFiles: () => onDisk.map((cardId) => ({ cardId, fullPath: `data/cards/${cardId}.png` })),
        getEntities: () => Object.fromEntries(entities.map((id) => [id, { id }])),
        despawnEntity: (id) => { record('despawn', id); return true; },
        setDroppedItems: (items) => record('dropped', Object.keys(items).length),
        initializeWorld: (options) => {
            const ids = options?.cardIds;
            record('initializeWorld', ids === undefined ? 'all' : ids.join('+'));
            const list = ids === undefined ? onDisk : ids;
            return { total: list.length, spawned: list.length, entities: list.map((cardId) => ({ cardId, entityId: `entity-${cardId}` })) };
        },
        // What the capability scan is handed. The double does not model a re-seeded
        // population, so the scan is recorded without a count - the claim here is that
        // the scan runs, not what it saw.
        getAll: () => ({ entities: {} }),
        turnSystemController: { getRoundState: () => ({ roundNumber: 42 }) }
    };
    if (!partial) {
        facade.roomChatController = { clear: () => record('clearChat') };
        facade.worldEventLogController = { clear: () => record('clearEvents') };
        facade.actionController = { scanAllCapabilities: () => record('rescan') };
    }
    return facade;
}

/** Run `fn` and return the thrown error, or null. */
function thrown(fn) {
    try {
        fn();
        return null;
    } catch (error) {
        return error;
    }
}

describe('recreateWorld: the order a new world is built in', () => {
    it('despawns, clears the old world, seeds, and rescans - in that order', () => {
        const facade = makeFacade();
        const result = recreateWorld(facade, { cardIds: ['Nova'] });

        expect(facade.calls).toEqual([
            ['despawn', 'ent-1'],
            ['despawn', 'ent-2'],
            ['dropped', 0],
            ['clearChat'],
            ['clearEvents'],
            ['initializeWorld', 'Nova'],
            ['rescan']
        ]);
        expect(result.despawned).toBe(2);
        expect(result.cards).toMatchObject({ total: 1, spawned: 1 });
        expect(result.cards.entities).toEqual([{ cardId: 'Nova', entityId: 'entity-Nova' }]);
    });

    it('hands the seeding the whole set when the request named no cards', () => {
        const facade = makeFacade();
        const result = recreateWorld(facade, {});

        expect(facade.calls).toContainEqual(['initializeWorld', 'all']);
        expect(result.cards.total).toBe(2);
    });

    it('treats a null cardIds the same as an absent one (boot behavior)', () => {
        const facade = makeFacade();
        recreateWorld(facade, { cardIds: null });
        expect(facade.calls).toContainEqual(['initializeWorld', 'all']);
    });

    it('honours an empty selection: a world with props and nobody in it', () => {
        const facade = makeFacade();
        const result = recreateWorld(facade, { cardIds: [] });

        expect(facade.calls).toContainEqual(['initializeWorld', '']);
        expect(result.cards).toEqual({ total: 0, spawned: 0, entities: [] });
    });

    it('inherits the round it was created in, and reports it', () => {
        const facade = makeFacade();
        expect(recreateWorld(facade, { cardIds: [] }).round).toBe(42);
    });

    it('reports a round of null when no turn system is wired, instead of inventing one', () => {
        const facade = makeFacade();
        delete facade.turnSystemController;
        expect(recreateWorld(facade, { cardIds: [] }).round).toBeNull();
    });

    it('survives a world whose chat, event log or action controller was never wired', () => {
        const facade = makeFacade({ partial: true });
        const result = recreateWorld(facade, { cardIds: [] });

        expect(result.cards.spawned).toBe(0);
        expect(facade.calls.filter((call) => call[0] === 'initializeWorld')).toHaveLength(1);
    });
});

describe('recreateWorld: refusing before anything is destroyed', () => {
    it('refuses a card id with no file, naming it, and despawns nothing', () => {
        const facade = makeFacade();
        const error = thrown(() => recreateWorld(facade, { cardIds: ['Nova', 'Ghost'] }));

        expect(error.code).toBe(WORLD_CREATE_ERROR_CODES.CARD_UNKNOWN);
        expect(error.message).toContain('Ghost');
        expect(facade.calls).toEqual([]);
    });

    it('refuses a cardIds that is not a list', () => {
        const facade = makeFacade();
        const error = thrown(() => recreateWorld(facade, { cardIds: 'Nova' }));

        expect(error.code).toBe(WORLD_CREATE_ERROR_CODES.CARD_ID_INVALID);
        expect(facade.calls).toEqual([]);
    });

    it('refuses an id that is empty, blank, over-long, or a path', () => {
        for (const bad of ['', '   ', '../etc/passwd', 'a'.repeat(129), 42, null]) {
            const facade = makeFacade();
            const error = thrown(() => recreateWorld(facade, { cardIds: [bad] }));
            expect(error.code, `for ${JSON.stringify(bad)}`).toBe(WORLD_CREATE_ERROR_CODES.CARD_ID_INVALID);
            expect(facade.calls).toEqual([]);
        }
    });

    it('refuses more cards than a world takes', () => {
        const many = Array.from({ length: MAX_CARDS_PER_WORLD + 1 }, (_, i) => `card-${i}`);
        const facade = makeFacade({ onDisk: many });
        const error = thrown(() => recreateWorld(facade, { cardIds: many }));

        expect(error.code).toBe(WORLD_CREATE_ERROR_CODES.TOO_MANY_CARDS);
        expect(facade.calls).toEqual([]);
    });

    it('sends a repeated card once: the same card twice is one card', () => {
        const facade = makeFacade();
        const result = recreateWorld(facade, { cardIds: ['Nova', 'Nova', 'Nova'] });

        expect(facade.calls).toContainEqual(['initializeWorld', 'Nova']);
        expect(result.cards.total).toBe(1);
    });
});

describe('recreateWorld: the default is the whole world', () => {
    it('runs with no options argument at all', () => {
        const facade = makeFacade();
        const result = recreateWorld(facade);

        expect(result.despawned).toBe(2);
        expect(result.cards.total).toBe(2);
    });
});
