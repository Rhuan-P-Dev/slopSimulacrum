/**
 * Player initial-spawn loadout contract — full real world (data files + composition
 * root), no network, no mocks.
 *
 * Regression guard for the "player droid spawns with 0 items" defect. The player
 * (a non-NPC smallBallDroid incarnated on the socket-connect path) is supposed to
 * receive the declarative loadout from data/world.json's `initialSpawns`:
 *
 *     SocketLifecycleController._incarnatePlayer
 *       → WorldStateController.spawnEntity('smallBallDroid', roomId)
 *         → spawn observer → _applyInitialSpawns
 *           → _resolveInitialSpawnSlot (per entry) + InventoryManager.addItem
 *
 * The historical bug (one un-migrated line): `_resolveInitialSpawnSlot` computed the
 * host footprint from the LEGACY top-level fields
 * (`itemDef.externalVolume ?? itemDef.volume`). The recipe→derivation migration moved
 * every item volume under `form.volume` / `form.externalVolume`, so the footprint
 * resolved to `undefined`; each slot check `getAvailableVolume(...) >= hostFootprint`
 * became `number >= undefined` (always false); the resolver returned `null` for every
 * entry; each was WARN-logged ("no valid slot") and skipped — the player spawned empty.
 *
 * The footprint read now uses the single source of truth, `getDefinitionFootprint`
 * (src/utils/definitionVolume.js), shared with `InventoryManager.addItem`, so the
 * resolver and the capacity path agree on what an item's footprint is.
 *
 * @module test/contract/playerInitialSpawns.contract
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import DataLoader from '../../src/utils/DataLoader.js';
import Logger from '../../src/utils/Logger.js';

describe('Player initial-spawn loadout (real world, data-driven)', () => {
    let wsc;
    let spawnWarnSpy;

    beforeAll(() => {
        // Mirror src/server.js: build the world via the composition root. buildWorldState
        // performs world init + initial capability scan (spawning the NPCs from
        // data/npcs.json). The PLAYER is not an NPC — it is incarnated on the
        // socket-connect path, which we replicate with spawnEntity exactly as
        // SocketLifecycleController._incarnatePlayer does.
        const tickSystem = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
        ({ worldStateController: wsc } = buildWorldState(tickSystem));
    });

    afterAll(() => {
        spawnWarnSpy?.mockRestore();
    });

    /**
     * Incarnates a fresh player droid exactly as the socket-connect path does,
     * returns the server-side entity record plus the Logger.warn calls emitted
     * during the spawn (so tests can assert on the "no valid slot" contract).
     * @returns {{ entity: Object, entityId: string, warnings: string[] }}
     */
    function incarnatePlayer() {
        const warnings = [];
        spawnWarnSpy = vi.spyOn(Logger, 'warn').mockImplementation((msg) => {
            warnings.push(String(msg));
        });
        const startRoomId = wsc.getRoomUidByLogicalId('start_room');
        const entityId = wsc.spawnEntity('smallBallDroid', startRoomId);
        const entity = wsc.getEntity(entityId);
        return { entity, entityId, warnings };
    }

    it('applies the full data/world.json loadout to the incarnated player with no "no valid slot" warnings', () => {
        const { entity, warnings } = incarnatePlayer();
        const items = entity.items;
        expect(Array.isArray(items)).toBe(true);

        // coal x10 (centralBall, volume 1 each — fills the ball exactly).
        const coals = items.filter(i => i.type === 'coal');
        expect(coals.length).toBe(10);

        // t1 (bestAvailable:hand → a droidHand).
        const t1 = items.find(i => i.type === 't1');
        expect(t1).toBeDefined();

        // t1 ammo: 1 knife projectile loaded into the weapon.
        const t1Ammo = items.filter(i => i.type === 'knife' && i.hostComponentId === t1.id);
        expect(t1Ammo.length).toBe(1);

        // Standalone knives (droidArm, not the one inside t1).
        const standaloneKnives = items.filter(i => i.type === 'knife' && i.hostComponentId !== t1.id);
        expect(standaloneKnives.length).toBe(5);

        // Full expected count: coal(10) + t1(1) + t1 ammo(1) + knives(5) = 17.
        expect(items.length).toBe(17);

        // CORE REGRESSION ASSERTION: no initial-spawn entry was skipped for lack
        // of a valid slot. (Other startup warnings are allowed; only "no valid slot"
        // indicates the footprint resolver regressed.)
        const invalidSlotWarnings = warnings.filter(w => w.includes('no valid slot'));
        expect(invalidSlotWarnings).toEqual([]);
    });

    it('resolves a valid slot for every data/world.json entry against a fresh smallBallDroid (unit-level)', () => {
        // Take the incarnated player and reset its items to [] so each entry is
        // resolved against the FRESH (empty) component capacities — the exact state
        // _applyInitialSpawns sees on first spawn. _resolveInitialSpawnSlot is a pure
        // read of entity.components + available volume, so the shallow-cleared copy is
        // sufficient and does not mutate internal world state.
        const { entity } = incarnatePlayer();
        const freshEntity = { ...entity, items: [] };

        const config = DataLoader.loadJsonSafe('data/world.json', {});
        const entries = config?.initialSpawns;
        expect(Array.isArray(entries)).toBe(true);
        expect(entries.length).toBeGreaterThan(0);

        for (const entry of entries) {
            const resolved = wsc._resolveInitialSpawnSlot(freshEntity, entry);
            expect(
                resolved,
                `entry "${entry.item}" (slot "${entry.slot}") should resolve a component`
            ).not.toBeNull();
            expect(resolved.component).toBeTypeOf('object');
            expect(resolved.component.id).toBeTypeOf('string');
        }
    });
});
