/**
 * UNIT TEST - a socket connecting to a server that is not simulating.
 *
 * The server boots idle now: it holds a world definition but no population and
 * no rounds until `POST /world/create`. A browser on the launcher is connected
 * during that whole time, and the connection used to answer it with an
 * incarnation attempt - which, with no population to place it in, is the
 * `No valid room found` critical and the `World initialization error` the client
 * was shown for no fault of its own.
 *
 * The claim: while no world runs, a connection is a connection and nothing else.
 * Once a world runs, the same connection is incarnated exactly as before.
 *
 * `io` and `socket` are doubles that record what was registered and emitted;
 * the facade answers `isWorldRunning` and would count any spawn (`TST-3`: no
 * real server, no real socket).
 *
 * @module test/unit/SocketLifecycleWorldGate
 */

import { describe, it, expect } from 'vitest';
import SocketLifecycleController from '../../src/controllers/networking/SocketLifecycleController.js';
import { SOCKET_EVENTS } from '../../shared/SocketProtocol.js';

/** A socket double: records the events it was sent. */
function makeSocket(id = 'sock-1') {
    return {
        id,
        /** @type {Array<[string, Object]>} */
        emitted: [],
        on() {},
        emit(event, payload) {
            this.emitted.push([event, payload]);
        }
    };
}

/** An io double: `registerHandlers` attaches the connection handler here. */
function makeIo() {
    return {
        /** @type {((socket: Object) => void)|null} */
        connection: null,
        on(event, handler) {
            if (event === 'connection') this.connection = handler;
        }
    };
}

/**
 * @param {boolean} running - Whether the world is being simulated.
 * @returns {{ facade: Object, spawns: string[] }} the facade and its spawn log.
 */
function makeFacade(running) {
    /** @type {string[]} rooms any spawn was asked for. */
    const spawns = [];
    return {
        spawns,
        isWorldRunning: () => running,
        getRoomUidByLogicalId: () => 'room-start',
        getAll: () => ({ rooms: { 'room-start': { id: 'room-start' } } }),
        spawnEntity: (_blueprint, roomId) => {
            spawns.push(roomId);
            return 'ent-player';
        }
    };
}

/** Connect one socket against a facade in the given state. */
function connect(running) {
    const io = makeIo();
    const facade = makeFacade(running);
    new SocketLifecycleController(facade, io).registerHandlers();
    const socket = makeSocket();
    io.connection(socket);
    return { socket, facade };
}

describe('a connection arriving while no world runs', () => {
    it('incarnates nobody', () => {
        const { socket, facade } = connect(false);

        // Then no entity was created - the room the player would need does not
        // exist yet, and a droid dropped into an unstarted world is a lie about
        // what the operator is looking at.
        expect(facade.spawns).toEqual([]);
        expect(socket.emitted.map(([event]) => event)).not.toContain(SOCKET_EVENTS.INCARNATE);
    });

    it('does not tell the client its own connection failed', () => {
        const { socket } = connect(false);

        // Sitting on the launcher is not an error, so it must not be reported as
        // one: the old path emitted `error` because the spawn found no room.
        expect(socket.emitted.map(([event]) => event)).not.toContain('error');
    });
});

describe('a connection arriving while the world runs', () => {
    it('incarnates the player into the start room', () => {
        const { socket, facade } = connect(true);

        expect(facade.spawns).toEqual(['room-start']);
        expect(socket.emitted).toContainEqual([SOCKET_EVENTS.INCARNATE, { entityId: 'ent-player' }]);
    });
});
