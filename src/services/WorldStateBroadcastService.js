import Logger from '../utils/Logger.js';
import InternalComponentUtils from '../utils/InternalComponentUtils.js';
// TYPED ID MIGRATION: Import typed ID generators for items and equipped items
import { generateItemId, generateEquippedId } from '../utils/idGenerator.js';
import { SOCKET_EVENTS } from '../../shared/SocketProtocol.js';
import { ID_PREFIXES, isPrefixed } from '../../shared/IdPrefixes.js';

/**
 * WorldStateBroadcastService handles broadcasting world state updates to connected clients.
 * Transforms raw state into typed-ID-safe format before broadcast.
 * Follows the Dependency Injection pattern from controller_patterns.md.
 */

class WorldStateBroadcastService {
	/**
	 * @param {object} io - Socket.IO server instance
	 * @param {object} worldStateController - The root controller for world state management
	 */
	constructor(io, worldStateController) {
		this._io = io;
		this._worldStateController = worldStateController;
	}

	/**
	 * Broadcasts the current world state to all connected clients.
	 * Transforms raw state into typed-ID-safe format before emission.
	 */
	broadcast() {
		try {
			const worldState = this._worldStateController.getAll();
			if (!worldState) {
				Logger.warn('Attempted to broadcast null/undefined world state');
				return;
			}

			// TYPED ID MIGRATION: Transform state to ensure all IDs are typed
			const transformedState = this._transformForBroadcast(worldState);

			const clientCount = this._io.engine.clientsCount;
			this._io.emit(SOCKET_EVENTS.WORLD_STATE_UPDATE, { state: transformedState });
			Logger.info('World state broadcasted', { clientCount, time: new Date().toLocaleTimeString() });
		} catch (error) {
			Logger.error('Failed to broadcast world state', { error: error.message });
		}
	}

	/**
		* Broadcasts the dedicated `turn-round-update` transition event (Feature A,
		* spec §5.7). Fired by the TurnSystemController at the two transition
		* moments (planning start, resolution start) so the phase flip reaches
		* clients the same tick it happens — even when no action (hence no
		* full-state broadcast) occurs. Payload is intentionally small:
		* { roundNumber, phase, currentTick, actorOrder, barrier }
		* (queues ride the full state, not this packet; the barrier object lets
		* clients render the ready status without a full-state round-trip).
		* @param {Object} payload - The transition payload (see above).
		*/
	broadcastTurnUpdate(payload) {
		try {
			this._io.emit(SOCKET_EVENTS.TURN_ROUND_UPDATE, payload);
			Logger.info('Turn round update broadcasted', { roundNumber: payload?.roundNumber, phase: payload?.phase, clientCount: this._io.engine.clientsCount });
		} catch (error) {
			Logger.error('Failed to broadcast turn round update', { error: error.message });
		}
	}

	/**
	 * Broadcasts a per-room chat message (Feature D backend, spec §7.3).
	 * Delivery decision: global emit with the `roomId` IN the payload — the
	 * codebase has zero socket.join usage, and one player + one NPC does not
	 * justify server-side Socket.IO rooms (documented re-evaluation trigger:
	 * many rooms × many players). Clients filter by their focused room.
	 * @param {Object} message - { id, roomId, speakerName, speakerEntityId, text, tick, ts }.
	 */
	broadcastRoomChatMessage(message) {
		try {
			this._io.emit(SOCKET_EVENTS.ROOM_CHAT_MESSAGE, message);
			Logger.info('Room chat message broadcasted', { roomId: message?.roomId, clientCount: this._io.engine.clientsCount });
		} catch (error) {
			Logger.error('Failed to broadcast room chat message', { error: error.message });
		}
	}

	/**
	 * Transforms raw world state into typed-ID-safe format for broadcast.
	 * Ensures all IDs use typed format (ent-, comp-, item-, eq-).
	 * Adds missing typed IDs where needed using generators.
	 *
	 * TYPED ID MIGRATION: This method ensures broadcasted state always contains typed IDs.
	 * @param {Object} worldState - Raw world state from WorldStateController.getAll().
	 * @returns {Object} Transformed state with typed IDs.
	 * @private
	 */
	_transformForBroadcast(worldState) {
		const transformed = structuredClone(worldState);

		// Transform entities — component IDs are already typed from entityController.generateCompId()
		if (transformed.entities && typeof transformed.entities === 'object') {
			for (const [entityId, entity] of Object.entries(transformed.entities)) {
				if (!entity) continue;

				// Ensure entity ID is typed
				if (entity.id && !isPrefixed(entity.id, ID_PREFIXES.ENTITY)) {
					entity.id = `${ID_PREFIXES.ENTITY}${entity.id}`;
				}

				// Transform components — IDs should already be typed (comp-uuid)
				if (Array.isArray(entity.components)) {
					for (const comp of entity.components) {
						if (comp && comp.id && !isPrefixed(comp.id, ID_PREFIXES.COMPONENT)) {
							comp.id = `${ID_PREFIXES.COMPONENT}${comp.id}`;
						}
					}
				}

				// Transform internal components — enrich with descriptions
				if (entity.internalComponents && typeof entity.internalComponents === 'object') {
					for (const [hostId, comps] of Object.entries(entity.internalComponents)) {
						if (Array.isArray(comps)) {
							for (const ic of comps) {
								if (ic && ic.type) {
									ic.description = InternalComponentUtils.generateDescription(this._worldStateController.internalComponentController.registry[ic.type]);
								}
							}
						}
					}
				}

				// Transform inventory items — ensure typed item IDs
				if (Array.isArray(entity.items)) {
					for (const item of entity.items) {
						if (item && item.id && !isPrefixed(item.id, ID_PREFIXES.ITEM)) {
							item.id = `${ID_PREFIXES.ITEM}${item.id}`;
						}
					}
				}
			}
		}

		// Transform equipped items — ensure typed eqId AND attach to entity.equipped
		if (transformed.holdingCost && transformed.holdingCost._equippedItems) {
			const equippedItems = transformed.holdingCost._equippedItems;
			for (const [entityId, items] of Object.entries(equippedItems)) {
				if (!items || typeof items !== 'object') continue;

				// Collect valid equipped items for this entity
				const equippedArray = [];
				for (const [eqId, item] of Object.entries(items)) {
					if (!item) continue;

					// Ensure eqId is typed (eq-uuid)
					if (item.eqId && !isPrefixed(item.eqId, ID_PREFIXES.EQUIPPED)) {
						item.eqId = `${ID_PREFIXES.EQUIPPED}${item.eqId}`;
					}
					if (!isPrefixed(eqId, ID_PREFIXES.EQUIPPED)) {
						// Move item to typed key
						item.eqId = item.eqId || generateEquippedId();
						equippedItems[eqId] = undefined; // Clear old key
						equippedItems[item.eqId] = item;
					}

					// Ensure componentId is typed (comp-uuid)
					if (item.componentId && !isPrefixed(item.componentId, ID_PREFIXES.COMPONENT)) {
						item.componentId = `${ID_PREFIXES.COMPONENT}${item.componentId}`;
					}

					// Attach to entity.equipped for client access
					equippedArray.push({
						eqId: item.eqId,
						itemId: item.itemId,
						itemType: item.itemType,
						componentId: item.componentId
					});
				}

				// Attach equipped items to the entity's equipped array
				if (equippedArray.length > 0) {
					const entity = transformed.entities?.[entityId];
					if (entity) {
						entity.equipped = equippedArray;
					}
				}
			}
		}

		return transformed;
	}
}

export default WorldStateBroadcastService;