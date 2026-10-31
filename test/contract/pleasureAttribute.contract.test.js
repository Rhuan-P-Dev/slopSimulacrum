/**
 * CONTRACT TEST — the whole-entity `pleasure` attribute (Pleasure.pleasure).
 *
 * The pleasure stat is a WHOLE-ENTITY meter seeded at spawn from
 * data/mods/core-entity-attributes/entityAttributes.json — like Physical.energy, it is owned by
 * the entity, never by a component. It is declared for the two human droid
 * blueprints (maleDroid, femaleDroid): 0-100 scale, starts at 0, drains 1 per
 * round (floor 0), and is raised when a droid's sensitive part is touched (the
 * touch action; the per-part values live in data/mods/core-sensitive-parts/sensitiveParts.json).
 * The energy-life despawn rule must NOT apply to it: a pleasure of 0 is a
 * state, not a death.
 *
 * Pins:
 *   - data contract: exactly maleDroid and femaleDroid declare the Pleasure
 *     group; each declaration is exactly { value: 0, max: 100, drainPerTurn: 1 }
 *     and its flat key matches the shared vocabulary
 *     (flatKey(TRAIT_GROUPS.PLEASURE, STAT_NAMES.PLEASURE) === 'Pleasure.pleasure');
 *   - spawn seeding: a spawned human droid carries attributes.Pleasure.pleasure
 *     === 0 with its declaration, and carries no energy attribute (the
 *     humanoids are not coal burners);
 *   - clamping: setEntityAttributeDelta keeps the value inside [0, 100];
 *   - lifecycle: the per-turn step drains the meter 1 per round (floor 0) and
 *     never eliminates a human droid (the death check is wired to the energy
 *     attribute, which these blueprints do not declare);
 *   - serialization: the live value rides the world state (getEntities()).
 *
 * Driven the same house way as the coal-generator contract: build the world
 * via buildWorldState(tickSystem) (tick not started) and call the facade
 * directly.
 *
 * @module test/contract/pleasureAttribute
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import DataLoader from '../../src/utils/DataLoader.js';
import { getAttributes } from '../../src/utils/EntityAttributeData.js';
import { TRAIT_GROUPS, STAT_NAMES, flatKey } from '../../shared/StatVocabulary.js';

const PLEASURE_GROUP = TRAIT_GROUPS.PLEASURE;
const PLEASURE_STAT = STAT_NAMES.PLEASURE;
const PLEASURE_KEY = flatKey(PLEASURE_GROUP, PLEASURE_STAT);
const PLEASURE_DECL = { value: 0, max: 100, drainPerTurn: 1 };
const HUMAN_BLUEPRINTS = ['maleDroid', 'femaleDroid'];

/** Builds a fresh world (non-started tick system) and spawns one entity. */
function buildWorldWith(blueprint) {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const world = buildWorldState(tick).worldStateController;
    const startRoomId = world.roomsController.getUidByLogicalId('start_room');
    const entityId = world.stateEntityController.spawnEntity(blueprint, startRoomId);
    return { world, tick, entityId, startRoomId };
}

/** The entity's whole-entity pleasure value (null when absent). */
function pleasureOf(world, entityId) {
    return world.getEntityAttribute(entityId, PLEASURE_GROUP, PLEASURE_STAT);
}

describe('pleasure attribute — whole-entity 0-100 meter (human droids)', () => {
    it('data contract: exactly the two human droids declare Pleasure.pleasure, 0/100/1', () => {
        const file = DataLoader.loadJsonSafe('data/mods/core-entity-attributes/entityAttributes.json', { attributes: {} });
        const declared = Object.entries(file.attributes)
            .filter(([, entry]) => entry && typeof entry === 'object' && PLEASURE_KEY in entry)
            .map(([blueprint]) => blueprint)
            .sort();
        expect(declared, 'only the human droids declare the pleasure meter').toEqual(
            [...HUMAN_BLUEPRINTS].sort()
        );
        for (const blueprint of declared) {
            expect(file.attributes[blueprint][PLEASURE_KEY], `${blueprint} declaration`).toEqual(PLEASURE_DECL);
        }
    });

    it('the data key matches the shared vocabulary (Pleasure.pleasure)', () => {
        expect(PLEASURE_KEY).toBe('Pleasure.pleasure');
        // The seeded-reader path (what spawn uses) validates the declaration.
        for (const blueprint of HUMAN_BLUEPRINTS) {
            expect(getAttributes(blueprint)[PLEASURE_KEY]).toEqual(PLEASURE_DECL);
        }
    });

    for (const blueprint of HUMAN_BLUEPRINTS) {
        it(`spawn: ${blueprint} seeds pleasure at 0 with its declaration (and no energy attribute)`, () => {
            const { world, entityId } = buildWorldWith(blueprint);
            const entity = world.stateEntityController.getEntity(entityId);

            expect(entity.attributes?.[PLEASURE_GROUP]?.[PLEASURE_STAT], 'seeds at 0').toBe(0);
            expect(entity.attributesConfig?.[PLEASURE_GROUP]?.[PLEASURE_STAT]).toEqual(PLEASURE_DECL);
            // The human droids are not coal burners: no energy attribute at all,
            // so the energy-life (drain/despawn) loop has nothing to touch.
            expect(entity.attributes?.[TRAIT_GROUPS.PHYSICAL]?.[STAT_NAMES.ENERGY], 'no energy stat').toBeUndefined();
        });
    }

    it('clamping: deltas keep the value inside [0, 100]', () => {
        const { world, entityId } = buildWorldWith('maleDroid');

        expect(world.setEntityAttributeDelta(entityId, PLEASURE_GROUP, PLEASURE_STAT, 50)).toBe(true);
        expect(pleasureOf(world, entityId)).toBe(50);

        expect(world.setEntityAttributeDelta(entityId, PLEASURE_GROUP, PLEASURE_STAT, 999), 'clamps at max').toBe(true);
        expect(pleasureOf(world, entityId)).toBe(100);

        expect(world.setEntityAttributeDelta(entityId, PLEASURE_GROUP, PLEASURE_STAT, -999), 'clamps at 0').toBe(true);
        expect(pleasureOf(world, entityId)).toBe(0);

        // A delta that would not move the value is a no-op (no broadcast, no change).
        expect(world.setEntityAttributeDelta(entityId, PLEASURE_GROUP, PLEASURE_STAT, -1)).toBe(false);
    });

    it('lifecycle: the per-turn step drains pleasure 1 per round (floor 0) and never eliminates a human droid', () => {
        const { world, entityId } = buildWorldWith('femaleDroid');

        // The per-turn step drains the declared Pleasure.pleasure meter by its
        // drainPerTurn (1): two drain turns take 3 -> 1. The death check is
        // wired to the energy attribute, which these blueprints do not declare
        // — so the droid survives any pleasure value, including the floor.
        world.setEntityAttributeDelta(entityId, PLEASURE_GROUP, PLEASURE_STAT, 3);
        world.entityEnergyController.processEnergyTurn(1);
        world.entityEnergyController.processEnergyTurn(2);

        expect(world.stateEntityController.getEntity(entityId), 'still alive after drain turns').not.toBeNull();
        expect(pleasureOf(world, entityId), 'drained 1 per round').toBe(1);

        // The floor is a state, never a death: drain to 0 and keep draining.
        world.setEntityAttributeDelta(entityId, PLEASURE_GROUP, PLEASURE_STAT, -999); // 1 -> 0 (clamped)
        world.entityEnergyController.processEnergyTurn(3);
        world.entityEnergyController.processEnergyTurn(4);
        expect(world.stateEntityController.getEntity(entityId), 'alive at the floor').not.toBeNull();
        expect(pleasureOf(world, entityId), 'floors at 0').toBe(0);
    });

    it('serialization: the live value rides the world state (getEntities)', () => {
        const { world, entityId } = buildWorldWith('maleDroid');
        world.setEntityAttributeDelta(entityId, PLEASURE_GROUP, PLEASURE_STAT, 42);

        const entity = world.getEntities()[entityId];
        expect(entity?.attributes?.[PLEASURE_GROUP]?.[PLEASURE_STAT], 'live value in the broadcast shape').toBe(42);
        expect(entity?.attributesConfig?.[PLEASURE_GROUP]?.[PLEASURE_STAT]).toEqual(PLEASURE_DECL);
    });
});
