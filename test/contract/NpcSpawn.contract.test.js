/**
 * CONTRACT TEST — Feature D NPC spawn (spec §7.1 / §7.2 / §7.7).
 *
 * Builds the REAL world via the composition root (buildWorldState) — the
 * same path src/server.js uses — and asserts the acceptance criteria for
 * the data-driven NPC spawn from data/npcs.json:
 *   - a llmKillerDroid entity exists in the start room, at the room center;
 *   - isNPC === true, name === 'LLM Killer' (the npcs.json
 *     displayName, surfaced on the map label + chat speaker + LLM context);
 *   - NO initialItems declared → NPC spawns with an empty inventory;
 *   - the declarative world.json initialSpawns are BYPASSED for the NPC
 *     (no player-droid items leaked onto killer components);
 *   - the turn system's actorOrder includes LLM Killer with initiative 50,
 *     sorting BEFORE the player droids (initiative 40).
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

/** The spawned LLM Killer entity (or null). */
function findBolt() {
    return Object.values(world.stateEntityController.entities).find(e => e.blueprint === 'llmKillerDroid') || null;
}

/** Logical room id → uid. */
function roomUid(logicalId) {
    return world.roomsController.getUidByLogicalId(logicalId);
}

describe('Feature D — NPC spawn contract (data/npcs.json)', () => {
    it('data/npcs.json exists with the spec shape (key = blueprint)', () => {
        const npcs = DataLoader.loadJsonSafe('data/npcs.json', null);
        expect(npcs).toBeTypeOf('object');
        const entry = npcs.llmKillerDroid;
        expect(entry.displayName).toBe('LLM Killer');
        expect(entry.room).toBe('start_room');
        expect(typeof entry.personality).toBe('string');
        expect(entry.initialItems).toBeUndefined();
    });

    it('a third entity exists in start_room: isNPC, named, at room center', () => {
        const bolt = findBolt();
        expect(bolt).toBeTruthy();
        expect(bolt.isNPC).toBe(true);
        expect(bolt.name).toBe('LLM Killer');
        expect(bolt.blueprint).toBe('llmKillerDroid');

        // Located in the start room, positioned at the room center.
        const startRoom = world.roomsController.rooms[roomUid('start_room')];
        expect(bolt.location).toBe(startRoom.id);
        expect(bolt.spatial.x).toBe(startRoom.width / 2);
        expect(bolt.spatial.y).toBe(startRoom.height / 2);

        // All killer components carry the llmKillerDroid blueprint types.
        const types = bolt.components.map(c => c.type);
        expect(types).toContain('killerCore');
        expect(types).toContain('killerHead');
        expect(types.filter(t => t === 'killerArm')).toHaveLength(2);
        expect(types.filter(t => t === 'killerRollingBall')).toHaveLength(2);
    });

    it('no initialItems declared → NPC spawns with an empty inventory', () => {
        const bolt = findBolt();
        // LLM Killer has no initialItems in npcs.json → inventory should be empty.
        const items = world.getEntityItems(bolt.id) || {};
        const flat = Object.values(items).flat();
        const count = (type) => flat.filter(i => i.type === type).length;

        expect(count('powerCell')).toBe(0);
        expect(count('dataCrystal')).toBe(0);
        expect(flat.length).toBe(0);
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

    it('turn system: LLM Killer (initiative 50) sorts before the player droids (40)', () => {
        const turns = world.turnSystemController;
        tick.currentTick = 0;
        turns.onTick();

        const state = turns.getRoundState();
        const killerActor = state.actorOrder.find(a => a.name === 'LLM Killer');
        expect(killerActor).toBeTruthy();
        expect(killerActor.initiative).toBe(50);

        const droidActors = state.actorOrder.filter(a => a.initiative === 40);
        expect(droidActors.length).toBeGreaterThanOrEqual(2);

        // LLM Killer must come strictly BEFORE every initiative-40 actor.
        const killerIndex = state.actorOrder.findIndex(a => a === killerActor);
        const minDroidIndex = Math.min(...droidActors.map(a => state.actorOrder.indexOf(a)));
        expect(killerIndex).toBeLessThan(minDroidIndex);
    });
});
