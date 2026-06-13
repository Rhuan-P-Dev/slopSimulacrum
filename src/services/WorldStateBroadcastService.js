import Logger from '../utils/Logger.js';
import InternalComponentUtils from '../utils/InternalComponentUtils.js';
// TYPED ID MIGRATION: Import typed ID generators for items and equipped items
import { generateItemId, generateEquippedId } from '../utils/idGenerator.js';

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
			this._io.emit('world-state-update', { state: transformedState });
			Logger.info('World state broadcasted', { clientCount, time: new Date().toLocaleTimeString() });
		} catch (error) {
			Logger.error('Failed to broadcast world state', { error: error.message });
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
				if (entity.id && !entity.id.startsWith('ent-')) {
					entity.id = `ent-${entity.id}`;
				}

				// Transform components — IDs should already be typed (comp-uuid)
				if (Array.isArray(entity.components)) {
					for (const comp of entity.components) {
						if (comp && comp.id && !comp.id.startsWith('comp-')) {
							comp.id = `comp-${comp.id}`;
						}
					}
				}

				// Transform internal components — enrich with descriptions
				if (entity.internalComponents && typeof entity.internalComponents === 'object') {
					for (const [hostId, comps] of Object.entries(entity.internalComponents)) {
						if (Array.isArray(comps)) {
							for (const ic of comps) {
								if (ic && ic.type) {
									ic.description = InternalComponentUtils.generateDescription(ic.type);
								}
							}
						}
					}
				}

				// Transform inventory items — ensure typed item IDs
				if (Array.isArray(entity.items)) {
					for (const item of entity.items) {
						if (item && item.id && !item.id.startsWith('item-')) {
							item.id = `item-${item.id}`;
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
					if (item.eqId && !item.eqId.startsWith('eq-')) {
						item.eqId = `eq-${item.eqId}`;
					}
					if (eqId && !eqId.startsWith('eq-')) {
						// Move item to typed key
						item.eqId = item.eqId || generateEquippedId();
						equippedItems[eqId] = undefined; // Clear old key
						equippedItems[item.eqId] = item;
					}

					// Ensure componentId is typed (comp-uuid)
					if (item.componentId && !item.componentId.startsWith('comp-')) {
						item.componentId = `comp-${item.componentId}`;
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