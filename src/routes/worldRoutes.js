import express from 'express';
import { sendRouteError, sendRouteErrorBody } from '../utils/routeError.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';
import { handlePlaceMachine } from '../controllers/core/PlaceMachineHandler.js';
import { handleRetrieveMachine } from '../controllers/core/RetrieveMachineHandler.js';
import { createRateLimiter } from '../utils/rateLimiter.js';
import { WORLD_CREATE_ERROR_CODES } from '../controllers/logic/WorldRecreateLogic.js';

/**
 * Creating a world destroys the one that is running, so the route is rate limited
 * like the other writes (`CR SEC-2`). Five per minute is an operator rebuilding a
 * world by hand; anything above that is a script, and a script that wipes the world
 * in a loop should be stopped by the server, not by the client.
 */
const createWorldLimiter = createRateLimiter({ windowMs: 60000, max: 5, name: 'world-create-route' });

/**
 * Stopping a world destroys as much as creating one does, so it gets the same
 * budget as its own limiter - a shared counter would let an operator who has
 * been rebuilding a world be refused for asking to stop one.
 */
const stopWorldLimiter = createRateLimiter({ windowMs: 60000, max: 5, name: 'world-stop-route' });

/**
 * Every refusal `recreateWorld()` raises is about the requested cards (or the
 * user bindings) before anything was destroyed - so all of them are a 400
 * about the body, not a conflict with the world.
 */
const WORLD_CREATE_STATUS = Object.fromEntries(
    Object.values(WORLD_CREATE_ERROR_CODES).map((code) => [code, 400])
);

/**
 * Registers world state-related routes with the given Express router.
 * @param {import('express').Router} router - Express router instance
 * @param {Object} deps - Dependencies
 * @param {Object} deps.worldStateController - World state controller instance
 * @param {Object} deps.broadcastService - Broadcast service instance
 */
export function register(router, { worldStateController, broadcastService }) {
	/**
	 * GET /world-state
	 * Returns the current state of the world (with typed-ID transformation applied)
	 * plus `running` — whether the server is simulating it.
	 *
	 * On an idle server (no world created yet, or one that was stopped) the state is
	 * simply empty and `running` is false: no error, no separate "no world" endpoint.
	 * `running` is the tick system's own state, so the launcher can say "no world
	 * running" without inferring it from an empty entity map (`README §World
	 * lifecycle`). Additive field: every existing reader reads `state`.
	 */
	router.get('/world-state', (req, res) => {
		try {
			const worldState = worldStateController.getAll();
			// Apply the same transformation used by broadcast to ensure entity.equipped is populated
			const transformedState = broadcastService._transformForBroadcast(worldState);
			res.json({ state: transformedState, running: worldStateController.isWorldRunning() });
		} catch (error) {
			sendRouteError(error, res, '/world-state');
		}
	});

	/**
	 * GET /rooms
	 * Returns all rooms with their coordinates.
	 */
	router.get('/rooms', (req, res) => {
		try {
			const rooms = worldStateController.getRooms();
			res.json({ rooms });
		} catch (error) {
			sendRouteError(error, res, '/rooms');
		}
	});

	/**
	 * GET /world-map
	 * Returns the world graph with resolved room names for all connections
	 * and dropped items for spatial map rendering.
	 */
	router.get('/world-map', (req, res) => {
		try {
			const graph = worldStateController.getWorldGraph();
			const droppedItems = worldStateController.getDroppedItems() || {};

			// Transform dropped items into a flat array with item type info
			const droppedItemsArray = [];
			const itemDefinitions = worldStateController.getRegistry(REGISTRY_KINDS.INVENTORY_ITEMS);

			for (const [id, item] of Object.entries(droppedItems)) {
				const itemDef = itemDefinitions[item.itemType];
				droppedItemsArray.push({
					id,
					itemType: item.itemType,
					name: itemDef?.name || item.itemType,
					description: itemDef?.description || '',
					volume: itemDef?.volume || 1,
					x: item.x,
					y: item.y
				});
			}

			res.json({
				...graph,
				droppedItems: droppedItemsArray
			});
		} catch (error) {
			sendRouteError(error, res, '/world-map');
		}
	});

	/**
	 * GET /world-map-with-items
	 * Returns the world graph with resolved room names and dropped items for map rendering.
	 */
	router.get('/world-map-with-items', (req, res) => {
		try {
			const graph = worldStateController.getWorldGraph();
			const droppedItems = worldStateController.getDroppedItems() || {};

			// Transform dropped items into a flat array with item type info
			const droppedItemsArray = [];
			const itemDefinitions = worldStateController.getRegistry(REGISTRY_KINDS.INVENTORY_ITEMS);

			for (const [id, item] of Object.entries(droppedItems)) {
				const itemDef = itemDefinitions[item.itemType];
				droppedItemsArray.push({
					id,
					itemType: item.itemType,
					name: itemDef?.name || item.itemType,
					description: itemDef?.description || '',
					volume: itemDef?.volume || 1,
					x: item.x,
					y: item.y
				});
			}

			res.json({
				rooms: graph.rooms || [],
				droppedItems: droppedItemsArray
			});
		} catch (error) {
			sendRouteError(error, res, '/world-map-with-items');
		}
	});

	/**
	 * POST /pick-up-item
	 * Picks up a dropped item from the map and adds it to an entity's inventory.
	 */
	router.post('/pick-up-item', (req, res) => {
		const { entityId, droppedItemId, componentId } = req.body;

		if (!entityId || !droppedItemId || !componentId) {
			return res.status(400).json({
				error: 'Invalid request. "entityId", "droppedItemId", and "componentId" are required.',
			});
		}

		try {
			// Use the public API method on WorldStateController (avoids direct access to internal properties)
			const result = worldStateController.executePickUpItem(entityId, droppedItemId, componentId);

			if (result.success) {
				broadcastService.broadcast();
				res.json({ message: result.message, pickedUpItem: result.pickedUpItem });
			} else {
				res.status(400).json({ error: result.message });
			}
		} catch (error) {
			sendRouteError(error, res, '/pick-up-item');
		}
	});

	/**
	 * POST /place-machine
	 * Materialize a carried machine item (e.g. a Knife Generator) as a functional world
	 * entity at a chosen position. The item is consumed; the machine runs (its organ is
	 * ticked each round) and can later be retrieved. Immediate (same synchronous path as
	 * /pick-up-item).
	 */
	router.post('/place-machine', (req, res) => {
		const { entityId, itemId, itemType, targetX, targetY } = req.body;
		if (!entityId || !itemId) {
			return res.status(400).json({
				error: 'Invalid request. "entityId" and "itemId" are required.',
			});
		}
		if (!worldStateController.machineRegistry) {
			return res.status(503).json({ error: 'Machine registry not available.' });
		}
		try {
			const result = handlePlaceMachine(
				{ worldStateController, machineRegistry: worldStateController.machineRegistry },
				{ entityId, itemId, itemType, targetX, targetY }
			);
			if (result.success) {
				broadcastService.broadcast();
				res.json({ success: true, message: result.message || 'Machine placed.', machineEntityId: result.machineEntityId, position: result.position });
			} else {
				res.status(400).json({ error: result.message });
			}
		} catch (error) {
			sendRouteError(error, res, '/place-machine');
		}
	});

	/**
	 * POST /retrieve-machine
	 * Retrieve a placed machine back into the player's inventory. Its stored contents
	 * (e.g. forged knives) spill to the floor at the machine's position first, so nothing
	 * is lost. Immediate (same synchronous path as /pick-up-item).
	 */
	router.post('/retrieve-machine', (req, res) => {
		const { entityId, targetEntityId } = req.body;
		if (!entityId || !targetEntityId) {
			return res.status(400).json({
				error: 'Invalid request. "entityId" and "targetEntityId" are required.',
			});
		}
		if (!worldStateController.machineRegistry) {
			return res.status(503).json({ error: 'Machine registry not available.' });
		}
		try {
			const result = handleRetrieveMachine(
				{ worldStateController, machineRegistry: worldStateController.machineRegistry },
				{ entityId, targetEntityId }
			);
			if (result.success) {
				broadcastService.broadcast();
				res.json({ success: true, message: result.message, retrieved: result.retrieved, spilled: result.spilled });
			} else {
				res.status(400).json({ error: result.message });
			}
		} catch (error) {
			sendRouteError(error, res, '/retrieve-machine');
		}
	});

	/**
	 * POST /move-entity
	 * Moves an entity to a different room.
	 * Optionally accepts `sourceDoor` to calculate spawn position at the opposite door.
	 */
	router.post('/move-entity', (req, res) => {
	    const { entityId, targetRoomId, sourceDoor } = req.body;

	    if (!entityId || !targetRoomId) {
	        return res.status(400).json({
	            error: 'Invalid request. "entityId" and "targetRoomId" are required.',
	        });
	    }

	    try {
	        const moveOptions = sourceDoor ? { sourceDoor } : {};
	        const success = worldStateController.moveEntity(entityId, targetRoomId, moveOptions);
	        if (success) {
	            broadcastService.broadcast();
	            res.json({ message: 'Entity moved successfully.' });
	        } else {
	            res.status(404).json({ error: 'Entity not found.' });
	        }
	    } catch (error) {
	        sendRouteError(error, res, '/move-entity');
	    }
	});

	// =========================================================================
	// CREATE WORLD - populate a fresh world from chosen cards
	// =========================================================================

	/**
	 * POST /world/create
	 * Build a new world inside the running server: every live entity is despawned,
	 * the previous world's runtime memory (dropped items, room chat, world-event
	 * log) is cleared, and the map is seeded again the way boot seeds it - static
	 * props, data-driven NPCs, then the cards named in the request.
	 *
	 * Body: `{ cardIds?: string[], users?: { [cardId]: cardId } }`.
	 * `cardIds` - absent or null means every card in `data/cards/` (the boot
	 * behavior); an array means exactly those card ids, and `[]` means an
	 * unpopulated world.
	 * `users` - the card user mapping (`wiki/decisions/card-user-mapping.md`):
	 * bind a card's `{{user}}` placeholder to another card so that card's agent
	 * thinks its user is the target. The key is the bound card, the value the
	 * target; both must name a card file in `data/cards/` (the target need not
	 * be among the spawned cards). Absent or null means no binding.
	 *
	 * What it is NOT: not a mod change (the world definition in the store is
	 * untouched - that is `/mods/apply`), and not a round reset. The round counter
	 * never goes backwards (`CR D-6`); the new world inherits the round it was
	 * created in, which is also why the response names it.
	 *
	 * This is also the ONLY thing that starts a world. The server boots idle - it
	 * loads the definition and stands the population down - so until this request
	 * succeeds nothing ticks, no round runs and the LLM provider is never called.
	 * `POST /world/stop` returns the process to that state.
	 *
	 * Response: `{ success: true, despawned, cards: { total, spawned, entities,
	 * users? }, round, running }`. `cards.entities` maps each spawned card id to
	 * its entity id, so the operator can find the droid they just chose; `cards.users`
	 * (present only when a binding landed on a spawned card) maps each bound card id
	 * to the `{ cardId, name }` of the card its `{{user}}` now is, so the operator can
	 * confirm what was applied. `running: true` is the tick actually going. Unknown
	 * card ids - in `cardIds` or in either end of a `users` binding - are refused
	 * with a 400 naming them - before anything is destroyed and before the tick is
	 * started, so a typo cannot empty a running world on its way to an error message.
	 */
	router.post('/world/create', createWorldLimiter, (req, res) => {
		try {
			const body = req.body || {};
			const cardIds = Object.hasOwn(body, 'cardIds') ? body.cardIds : null;
			const users = Object.hasOwn(body, 'users') ? body.users : null;
			const result = worldStateController.startWorld({ cardIds, users });
			if (broadcastService) broadcastService.broadcast();
			res.json({ success: true, ...result });
		} catch (error) {
			const status = WORLD_CREATE_STATUS[error?.code];
			if (status) {
				sendRouteErrorBody(
					error,
					res,
					'POST /world/create',
					{ success: false, error: { code: error.code, message: error.message } },
					status
				);
				return;
			}
			sendRouteError(error, res, '/world/create');
		}
	});

	/**
	 * POST /world/stop — stand the world down.
	 *
	 * The tick halts first (so no round advances into the teardown), then every
	 * entity is despawned and the runtime memory of the world is dropped: items on
	 * the floor, room chat, the event log. The map, the mod definition and this
	 * process survive — reads keep answering 200 with an empty world and
	 * `running: false`, and `POST /world/create` starts another one.
	 *
	 * No body. Idempotent: stopping a stopped world is a no-op that answers the same
	 * thing, which is deliberate — the launcher offers it without knowing, from the
	 * client side, what the last click did.
	 *
	 * In-flight LLM rounds are not awaited. A round that resolves over a despawned
	 * population is the case `WorldRecreateLogic` documents as tolerated for
	 * mid-round despawns; the log names each entity that could not be removed.
	 *
	 * Response: `{ success: true, despawned, running: false }`.
	 */
	router.post('/world/stop', stopWorldLimiter, (req, res) => {
		try {
			const result = worldStateController.stopWorld();
			if (broadcastService) broadcastService.broadcast();
			res.json({ success: true, ...result });
		} catch (error) {
			sendRouteError(error, res, '/world/stop');
		}
	});

	// =========================================================================
	// PERSISTENCE — save/load endpoints (PHASE 3)
	// =========================================================================

	/**
	 * Sub-router mounted at /api/world (this router itself is mounted at / by
	 * src/routes/index.js), so the public paths are POST /api/world/save and
	 * POST /api/world/load. Both are covered by the global auth middleware.
	 */
	const persistenceRouter = express.Router();

	/**
	 * POST /api/world/save
	 * Returns a full, JSON-serializable snapshot of the world state
	 * (WorldStateController.serialize()). The client/operator persists the
	 * returned snapshot (e.g., to a file) for later /load.
	 */
	persistenceRouter.post('/save', (req, res) => {
	    try {
	        const snapshot = worldStateController.serialize();
	        res.json({ success: true, snapshot });
	    } catch (error) {
	        sendRouteErrorBody(error, res, '/api/world/save', {
	            success: false,
	            error: { code: 'SAVE_FAILED', message: 'Internal Server Error' },
	        });
	    }
	});

	/**
	 * POST /api/world/load
	 * Restores the world state from a previously saved snapshot
	 * (WorldStateController.restore()). Accepts { snapshot: <serialize() output> }.
	 * Broadcasts the restored state on success so all clients resync.
	 */
	persistenceRouter.post('/load', (req, res) => {
	    const { snapshot } = req.body || {};

	    if (!snapshot || typeof snapshot !== 'object') {
	        return res.status(400).json({
	            success: false,
	            error: { code: 'INVALID_PAYLOAD', message: 'Invalid request. A "snapshot" object (from POST /api/world/save) is required.' },
	        });
	    }

	    try {
	        const result = worldStateController.restore(snapshot);
	        if (result.success) {
	            broadcastService.broadcast();
	            res.json({ success: true, message: 'World state restored from snapshot.' });
	        } else {
	            // Structured error from restore() (e.g. SCHEMA_VERSION_MISMATCH)
	            const status = result.error?.code === 'SCHEMA_VERSION_MISMATCH' ? 409 : 400;
	            res.status(status).json({ success: false, error: result.error });
	        }
	    } catch (error) {
	        sendRouteErrorBody(error, res, '/api/world/load', {
	            success: false,
	            error: { code: 'LOAD_FAILED', message: 'Internal Server Error' },
	        });
	    }
	});

	router.use('/api/world', persistenceRouter);
}