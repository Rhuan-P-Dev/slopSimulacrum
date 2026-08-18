/**
 * CONTRACT TEST — Feature D NPC spawn (spec §7.1 / §7.2 / §7.7).
 *
 * Builds the REAL world via the composition root (buildWorldState) — the
 * same path src/server.js uses — and asserts the acceptance criteria for
 * the data-driven NPC spawn from data/npcs.json:
 *   - a merchantDroid entity exists in the start room, at the room center;
 *   - isNPC === true, name === 'Bolt the Merchant' (the npcs.json
 *     displayName, surfaced on the map label + chat speaker + LLM context);
 *   - 2× powerCell + 1× dataCrystal on a merchantArm (initialItems);
 *   - the declarative world.json initialSpawns are BYPASSED for the NPC
 *     (no player-droid items leaked onto merchant components);
 *   - the turn system's actorOrder includes Bolt with initiative 20,
 *     sorting AFTER the player droids (initiative 40).
 *
 * @module test/contract/NpcSpawn
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import DataLoader from '../../src/utils/DataLoader.js';

let world;
let tick;

beforeAll(() => {
    tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    ({ worldStateController: world } = buildWorldState(tick));
});

/** The spawned Bolt entity (or null). */
function findBolt() {
    return Object.values(world.stateEntityController.entities).find(e => e.blueprint === 'merchantDroid') || null;
}

/** Logical room id → uid. */
function roomUid(logicalId) {
    return world.roomsController.getUidByLogicalId(logicalId);
}

describe('Feature D — NPC spawn contract (data/npcs.json)', () => {
    it('data/npcs.json exists with the spec shape (key = blueprint)', () => {
        const npcs = DataLoader.loadJsonSafe('data/npcs.json', null);
        expect(npcs).toBeTypeOf('object');
        const entry = npcs.merchantDroid;
        expect(entry.displayName).toBe('Bolt the Merchant');
        expect(entry.room).toBe('start_room');
        expect(typeof entry.personality).toBe('string');
        expect(Array.isArray(entry.initialItems)).toBe(true);
        expect(entry.initialItems).toEqual([
            { item: 'powerCell', count: 2 },
            { item: 'dataCrystal', count: 1 }
        ]);
    });

    it('a third entity exists in start_room: isNPC, named, at room center', () => {
        const bolt = findBolt();
        expect(bolt).toBeTruthy();
        expect(bolt.isNPC).toBe(true);
        expect(bolt.name).toBe('Bolt the Merchant');
        expect(bolt.blueprint).toBe('merchantDroid');

        // Located in the start room, positioned at the room center.
        const startRoom = world.roomsController.rooms[roomUid('start_room')];
        expect(bolt.location).toBe(startRoom.id);
        expect(bolt.spatial.x).toBe(startRoom.width / 2);
        expect(bolt.spatial.y).toBe(startRoom.height / 2);

        // All merchant components carry the merchantDroid blueprint types.
        const types = bolt.components.map(c => c.type);
        expect(types).toContain('merchantCore');
        expect(types).toContain('merchantHead');
        expect(types.filter(t => t === 'merchantArm')).toHaveLength(2);
        expect(types.filter(t => t === 'merchantRollingBall')).toHaveLength(2);
    });

    it('initialItems applied: 2× powerCell + 1× dataCrystal on a merchantArm', () => {
        const bolt = findBolt();
        const items = world.getEntityItems(bolt.id) || {};
        const flat = Object.values(items).flat();
        const count = (type) => flat.filter(i => i.type === type).length;

        expect(count('powerCell')).toBe(2);
        expect(count('dataCrystal')).toBe(1);

        // Every item sits on a merchantArm component.
        const armIds = new Set(bolt.components.filter(c => c.type === 'merchantArm').map(c => c.id));
        for (const host of Object.keys(items)) {
            expect(armIds.has(host)).toBe(true);
        }
    });

    it('world.json initialSpawns are bypassed for the NPC (no player-droid items)', () => {
        const bolt = findBolt();
        const items = world.getEntityItems(bolt.id) || {};
        const flat = Object.values(items).flat().map(i => i.type);

        // None of the declarative player-droid spawns leaked onto Bolt.
        for (const type of ['metalBox', 'testItem', 'testItem2', 'knife']) {
            expect(flat).not.toContain(type);
        }
    });

    it('turn system: Bolt (initiative 20) sorts after the player droids (40)', () => {
        const turns = world.turnSystemController;
        tick.currentTick = 0;
        turns.onTick();

        const state = turns.getRoundState();
        const boltActor = state.actorOrder.find(a => a.name === 'Bolt the Merchant');
        expect(boltActor).toBeTruthy();
        expect(boltActor.initiative).toBe(20);

        const droidActors = state.actorOrder.filter(a => a.initiative === 40);
        expect(droidActors.length).toBeGreaterThanOrEqual(2);

        // Bolt must come strictly AFTER every initiative-40 actor.
        const boltIndex = state.actorOrder.findIndex(a => a === boltActor);
        const maxDroidIndex = Math.max(...droidActors.map(a => state.actorOrder.indexOf(a)));
        expect(boltIndex).toBeGreaterThan(maxDroidIndex);
    });
});
