/**
 * KnifeDropTriggerHandler — test trigger, always active (§4.6, §3.5.3).
 *
 * Upon receiving `component:broke`, drops 3× `knife` items at independent
 * positions via the SAME disk sampler (radius 5, center `payload.position`,
 * no clamp). Reuses the write helper from DropItemHandler.
 *
 * Registered 2nd (after BrokenComponentRemovalHandler) at the composition root.
 *
 * @module KnifeDropTriggerHandler
 */

import Logger from '../../utils/Logger.js';
import { sampleDiskPoint, DEFAULT_TRIGGER_RADIUS } from '../../utils/DiskSampler.js';
import { writeDroppedItem } from '../consequences/DropItemHandler.js';

/** Sampling radius in space units (exported as a constant). */
const RADIUS = DEFAULT_TRIGGER_RADIUS;

/** Item type to drop. */
const KNIFE_TYPE = 'knife';

/** Number of knives per event. */
const KNIFE_COUNT = 3;

class KnifeDropTriggerHandler {
    /**
     * @param {Object} deps
     * @param {import('../WorldStateController.js').default} deps.worldStateController
     */
    constructor(deps) {
        this._wsc = deps.worldStateController;
    }

    /**
     * Handler for `component:broke` event.
     * @param {Object} payload - Event payload (§3.3).
     */
    handle(payload) {
        const { position, roomId, entityId } = payload;
        
        // Check if entity exists before dropping knives (§3.5: skip if despawned)
        const entity = this._wsc.getEntity(entityId);
        if (!entity) {
            Logger.info(`[KnifeDropTrigger] Entity ${entityId} not found — skipping knife drop (despawned).`);
            return;
        }
        
        Logger.info(`[KnifeDropTrigger] component:broke at (${position.x}, ${position.y}) in room ${roomId} — dropping ${KNIFE_COUNT} knives.`);

        // Fetch knife definition from registry
        const itemRegistry = this._wsc.getItemRegistry();
        const rawEntry = itemRegistry[KNIFE_TYPE];
        let knifeDef;
        if (rawEntry == null) {
            Logger.error(`[KnifeDropTrigger] Missing knife definition in item registry for key "${KNIFE_TYPE}". The knife item definition is expected in data/inventoryItems.json.`);
            knifeDef = {};
        } else {
            knifeDef = rawEntry;
        }

        for (let i = 0; i < KNIFE_COUNT; i++) {
            // Item isolation (§3.5: failure logged + continues)
            try {
                const point = sampleDiskPoint(position.x, position.y, RADIUS);
                writeDroppedItem(
                    this._wsc,
                    KNIFE_TYPE,
                    point.x,
                    point.y,
                    roomId,
                    entityId,
                    knifeDef,
                    [] // knives have no nestedItems
                );
            } catch (error) {
                Logger.error(`[KnifeDropTrigger] Error dropping knife ${i + 1}: ${error.message}`);
            }
        }

        Logger.info(`[KnifeDropTrigger] Dropped ${KNIFE_COUNT} knives in disk around (${position.x},${position.y}), radius ${RADIUS}.`); // FASE 10: log distinto
    }
}

export default KnifeDropTriggerHandler;
