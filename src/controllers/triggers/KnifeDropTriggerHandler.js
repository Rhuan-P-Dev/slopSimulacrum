/**
 * KnifeDropTriggerHandler — gatilho de teste, sempre ativo (§4.6, §3.5.3).
 * 
 * Ao receber `component:broke`, dropa 3× item `knife` em posições
 * independentes via o MESMO sampler de disco (raio 5, centro `payload.position`,
 * sem clamp). Reusa o helper de gravação do DropItemHandler.
 * 
 * Registrado 2º (após BrokenComponentRemovalHandler) na composition root.
 * 
 * @module KnifeDropTriggerHandler
 */

import Logger from '../../utils/Logger.js';
import { sampleDiskPoint, DEFAULT_TRIGGER_RADIUS } from '../../utils/DiskSampler.js';
import { writeDroppedItem } from '../consequences/DropItemHandler.js';

/** Raio de amostragem em unidades do espaço (exportado como constante). */
const RADIUS = DEFAULT_TRIGGER_RADIUS;

/** Tipo de item a dropar. */
const KNIFE_TYPE = 'knife';

/** Quantidade de facas por evento. */
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
     * Handler para evento `component:broke`.
     * @param {Object} payload - Payload do evento (§3.3).
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
            // Isolamento por item (§3.5: falha logada + continua)
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
                    [] // facas não têm nestedItems
                );
            } catch (error) {
                Logger.error(`[KnifeDropTrigger] Error dropping knife ${i + 1}: ${error.message}`);
            }
        }

        Logger.info(`[KnifeDropTrigger] Dropped ${KNIFE_COUNT} knives in disk around (${position.x},${position.y}), radius ${RADIUS}.`); // FASE 10: log distinto
    }
}

export default KnifeDropTriggerHandler;
