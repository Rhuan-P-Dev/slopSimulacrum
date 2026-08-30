/**
 * SocketProtocol — Shared, environment-agnostic Socket.IO event-name contract.
 *
 * Wire contract — values must stay byte-identical; do not rename without a
 * protocol-version bump. Both the server emitters and the browser listeners
 * match on these exact strings, and an unhandled event name fails silently
 * in both directions (no error is ever raised), so a rename on one side
 * alone breaks the other invisibly.
 *
 * It intentionally has NO Node.js APIs and NO DOM APIs, so the same
 * ES module can be imported by:
 *   - the Node server (relative file path import) and
 *   - the browser (served as a module via the `/shared/` static route).
 *
 * @module SocketProtocol
 */

/**
 * The Socket.IO event names used between the server and the clients.
 * @type {Object.<string, string>}
 */
export const SOCKET_EVENTS = {
    WORLD_STATE_UPDATE: 'world-state-update',
    TURN_ROUND_UPDATE: 'turn-round-update',
    ROOM_CHAT_MESSAGE: 'room-chat-message',
    INCARNATE: 'incarnate',
    COMPONENT_BROKE: 'component:broke',
};
