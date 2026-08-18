/**
 * roomChatRoutes — REST surface for the per-room chat backend (Feature D,
 * spec §7.3 — backend only; the client UI is a later step).
 *
 * Follows the standard `register(router, { deps })` shape (BUG-069): deps
 * are injected, no request-scope side channels. All world access goes
 * through the facade's public API (`sendRoomChat` / `getRoomChatMessages`),
 * never into the sub-controller directly.
 *
 * Endpoints:
 *   POST /rooms/:roomId/chat
 *     body: { message: string (required, ≤200 chars), speakerName?: string }
 *     → 200 { success: true, message: {…} }
 *     → 400 { error }  (missing/empty/too long — the cap is shared with the LLM)
 *     → 404 { error }  (unknown room)
 *     → 429            (per-IP limiter, same 20/60s policy as /chat)
 *   GET /rooms/:roomId/chat?limit=50
 *     → 200 { roomId, messages: [ …oldest → newest… ] }
 *
 * Rate limiting reuses `createRateLimiter` with the /chat policy (20 req /
 * 60s per IP) — player and NPC share the chat store, the throttle is the
 * player's hammer, not the agent's (the agent never hits this endpoint).
 *
 * @module roomChatRoutes
 */

import Logger from '../utils/Logger.js';
import { createRateLimiter } from '../utils/rateLimiter.js';

/** Maps a controller failure code to an HTTP status (spec §7.3). */
const CODE_TO_STATUS = {
    ROOM_NOT_FOUND: 404,
    EMPTY_MESSAGE: 400,
    MESSAGE_TOO_LONG: 400,
    ROOM_CHAT_UNAVAILABLE: 503
};

/**
 * Registers room chat routes with the given Express router.
 * @param {import('express').Router} router - Express router instance.
 * @param {Object} deps - Dependencies.
 * @param {Object} deps.worldStateController - World state controller instance.
 */
export function register(router, { worldStateController }) {
	// Same policy as /chat: 20 requests per 60s per client IP.
	const roomChatRateLimiter = createRateLimiter({ windowMs: 60_000, max: 20, name: 'room-chat-route' });

	/**
	 * POST /rooms/:roomId/chat
	 * Sends one message to a room's chat ring + global `room-chat-message`
	 * broadcast. `speakerName` defaults to 'Player' (REST has no socket
	 * identity by design — local dev tool behind the shared auth gate).
	 */
	router.post('/rooms/:roomId/chat', roomChatRateLimiter, (req, res) => {
		const { roomId } = req.params;
		const { message, speakerName } = req.body || {};

		try {
			const result = worldStateController.sendRoomChat({
				roomId,
				speakerName: typeof speakerName === 'string' ? speakerName : 'Player',
				speakerEntityId: null, // REST speakers are humans, not world entities
				text: message
			});

			if (!result.success) {
				const status = CODE_TO_STATUS[result.code] || 400;
				return res.status(status).json({ error: result.error, code: result.code });
			}

			res.json({ success: true, message: result.message });
		} catch (error) {
			Logger.error('/rooms/:roomId/chat endpoint error', { error: error.message });
			res.status(500).json({ error: 'Internal Server Error', details: error.message });
		}
	});

	/**
	 * GET /rooms/:roomId/chat?limit=50
	 * Returns the room's chat history, oldest → newest (for room focus /
	 * page load). Unknown rooms return an empty list, not a 404 — the room
	 * may simply never have been talked in, and the client already knows
	 * the room exists (it is the focused one).
	 */
	router.get('/rooms/:roomId/chat', (req, res) => {
		const { roomId } = req.params;
		const limitParam = Number.parseInt(req.query.limit, 10);
		const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 50) : 50;

		try {
			// Spec §7.3: GET always 200 — unknown rooms simply have no history
			// (the client already knows the room exists: it is the focused one).
			res.json({ roomId, messages: worldStateController.getRoomChatMessages(roomId, limit) });
		} catch (error) {
			Logger.error('GET /rooms/:roomId/chat endpoint error', { error: error.message });
			res.status(500).json({ error: 'Internal Server Error', details: error.message });
		}
	});
}

export default register;
