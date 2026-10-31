/**
 * UNIT TEST - the world's lifecycle inside one process: create + run, stop, and
 * what "running" means.
 *
 * The server boots idle now, so the claims worth pinning are the ones the
 * operator's two buttons rest on:
 *
 *   - `startWorld` seeds AND asks for the tick. A world that was created but
 *     never started is the bug this file exists to prevent;
 *   - a refusal (`WORLD_CREATE_ERROR_CODES`) must not start anything either -
 *     an invalid request cannot leave a running world behind it;
 *   - `stopWorld` stops the tick BEFORE removing the population, so no round
 *     advances into the teardown;
 *   - `stopWorld` is idempotent and does not log a stop for a tick that never
 *     ran, which is what lets `server.js` use it as the boot state;
 *   - `isWorldRunning` is the tick's own state, not a remembered boolean - a
 *     second truth about running would drift from the first (`CR NAME-6`).
 *
 * The tick double records start/stop and carries `isRunning` the way
 * `UniversalTickSystem` does; the facade double records call order. Nothing
 * here touches the disk, a socket or the provider (`TST-2`, `TST-3`).
 *
 * @module test/unit/worldLifecycle
 */

import { describe, it, expect } from 'vitest';
import {
    startWorld,
    stopWorld,
    isWorldRunning,
    WORLD_CREATE_ERROR_CODES
} from '../../src/controllers/logic/WorldRecreateLogic.js';

/**
 * A tick double that behaves like `UniversalTickSystem` on the two points that
 * matter: `isRunning` is the fact, and `start`/`stop` are what change it.
 * @param {boolean} [running] - Whether the world is already simulating.
 */
function makeTick(running = false) {
    return {
        /** @type {string[]} the order of start/stop calls, for ordering claims. */
        events: [],
        isRunning: running,
        start() {
            this.events.push('start');
            this.isRunning = true;
        },
        stop() {
            this.events.push('stop');
            this.isRunning = false;
        }
    };
}

/**
 * A facade double that records calls in order, including the tick's.
 * @param {Object} [options]
 * @param {string[]} [options.onDisk] - Card ids the seam would list.
 * @param {string[]} [options.entities] - Entity ids currently alive.
 * @param {Object} [options.tick] - The tick double to mount (`null` = no tick at all).
 */
function makeWorld({ onDisk = ['Minako'], entities = ['ent-1', 'ent-2'], tick = makeTick() } = {}) {
    /** @type {string[]} every call, in order; tick calls are prefixed `tick.`. */
    const calls = [];
    const record = (...args) => calls.push(args.join(' '));
    const facade = {
        calls,
        tickSystem: tick,
        _readCardFiles: () => onDisk.map((cardId) => ({ cardId, fullPath: `data/cards/${cardId}.png` })),
        getEntities: () => Object.fromEntries(entities.map((id) => [id, { id }])),
        despawnEntity: (id) => { record('despawn', id); return true; },
        setDroppedItems: (items) => record('dropped', Object.keys(items).length),
        initializeWorld: (options) => {
            const ids = options?.cardIds;
            record('seed', ids === undefined ? 'all' : ids.join('+'));
            const list = ids === undefined ? onDisk : ids;
            return { total: list.length, spawned: list.length, entities: list.map((cardId) => ({ cardId, entityId: `entity-${cardId}` })) };
        },
        getAll: () => ({ entities: {} }),
        turnSystemController: { getRoundState: () => ({ roundNumber: 7 }) },
        roomChatController: { clear: () => record('clearChat') },
        worldEventLogController: { clear: () => record('clearEvents') },
        actionController: { scanAllCapabilities: () => record('rescan') },
        perceptionController: { reset: () => record('perceptionReset') }
    };
    if (tick) {
        const mounted = tick;
        mounted.events = [];
        tick.start = () => { record('tick.start'); mounted.events.push('start'); mounted.isRunning = true; };
        tick.stop = () => { record('tick.stop'); mounted.events.push('stop'); mounted.isRunning = false; };
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

describe('startWorld', () => {
    it('creates the population and starts the tick that advances rounds', () => {
        // Given an idle server with two entities left over and no tick running.
        const facade = makeWorld();

        // When the operator creates a world.
        const result = startWorld(facade, { cardIds: ['Minako'] });

        // Then the old population and the dead world's memory go first, the world
        // is seeded, its capabilities rescanned, and only then is the tick started.
        expect(facade.calls).toEqual([
            'despawn ent-1',
            'despawn ent-2',
            'dropped 0',
            'clearChat',
            'clearEvents',
            'seed Minako',
            'rescan',
            'tick.start'
        ]);
        expect(result.running).toBe(true);
        expect(result.cards.spawned).toBe(1);
        expect(result.round).toBe(7);
    });

    it('refuses an unknown card without starting anything at all', () => {
        // Given a request that names a card the seam does not have.
        const facade = makeWorld({ onDisk: ['Minako'] });

        const error = thrown(() => startWorld(facade, { cardIds: ['Nobody'] }));

        // Then the refusal is the domain code and neither the population nor the
        // tick was touched: a typo cannot start a world, let alone empty one.
        expect(error?.code).toBe(WORLD_CREATE_ERROR_CODES.CARD_UNKNOWN);
        expect(facade.calls).toEqual([]);
        expect(facade.tickSystem.isRunning).toBe(false);
    });

    it('does not start a second loop on a world that is already running', () => {
        // Given a world mid-flight.
        const facade = makeWorld({ tick: makeTick(true) });

        // When it is rebuilt in place.
        const result = startWorld(facade, { cardIds: [] });

        // Then the tick is asked to start again - `UniversalTickSystem.start()` is
        // a no-op while running, so asking is how "one loop only" stays true.
        expect(facade.calls.filter((entry) => entry === 'tick.start')).toHaveLength(1);
        expect(result.running).toBe(true);
    });

    it('creates the world anyway when no tick system was injected', () => {
        // Given the test mode of the turn system: a facade without a tick.
        const facade = makeWorld({ tick: null });

        // When a world is created.
        const result = startWorld(facade, { cardIds: ['Minako'] });

        // Then the population exists and `running` is honestly false - nobody will
        // advance rounds, and saying otherwise would be a lie about the world.
        expect(facade.calls).toContain('seed Minako');
        expect(result.running).toBe(false);
    });
});

describe('stopWorld', () => {
    it('stops the tick before removing the population', () => {
        // Given a running world with two entities in it.
        const facade = makeWorld({ tick: makeTick(true) });

        // When the world is stopped.
        const result = stopWorld(facade);

        // Then the tick halts first, so no round advances into the teardown, and
        // the memory of the world goes with the entities.
        expect(facade.calls).toEqual([
            'tick.stop',
            'despawn ent-1',
            'despawn ent-2',
            'dropped 0',
            'clearChat',
            'clearEvents',
            'perceptionReset'
        ]);
        expect(result).toEqual({ despawned: 2, running: false });
    });

    it('leaves a tick that never ran alone', () => {
        // Given the boot state: nothing has ever ticked.
        const facade = makeWorld({ entities: ['ent-boot'], tick: makeTick(false) });

        const result = stopWorld(facade);

        // Then `stop()` is not called - a stop logged for a process that never ran
        // is a line that misleads the next reader - and the stand-down still happens.
        expect(facade.calls).not.toContain('tick.stop');
        expect(facade.calls).toContain('despawn ent-boot');
        expect(result.running).toBe(false);
    });

    it('is idempotent: stopping a stopped world asks for the same answer', () => {
        const facade = makeWorld({ entities: [] });

        const twice = [stopWorld(facade), stopWorld(facade)];

        expect(twice).toEqual([
            { despawned: 0, running: false },
            { despawned: 0, running: false }
        ]);
    });
});

describe('isWorldRunning', () => {
    it('answers from the tick, not from a remembered value', () => {
        // Given a facade the module has never been told anything about.
        const facade = makeWorld({ tick: makeTick(false) });

        expect(isWorldRunning(facade)).toBe(false);

        // When the tick itself moves - a start from anywhere, not only from here.
        facade.tickSystem.start();

        expect(isWorldRunning(facade)).toBe(true);

        facade.tickSystem.stop();
        expect(isWorldRunning(facade)).toBe(false);
    });

    it('answers false for a facade with no tick at all', () => {
        expect(isWorldRunning({})).toBe(false);
        expect(isWorldRunning(null)).toBe(false);
    });
});
