/**
 * CONTRACT TEST — sensitive parts: the sensitiveNerve organ and the
 * per-part sensitivity values.
 *
 * A "sensitive part" is a body-part recipe that declares the sensitiveNerve
 * internal component (data/components/internalComponents.json) — a SENSORY
 * organ that grants no function stat and has no overTime effect; it only
 * marks its host with the `sensitive` flag (stored in the component's
 * Physical.grantedFlags), which the world — and the NPC LLM context — can
 * query via getComponentFlags. The per-part sensitivity value (0-100) that
 * the pleasure mechanic will consume to raise the owner's Pleasure.pleasure
 * whole-entity attribute lives in data/components/sensitiveParts.json —
 * data, not a stat.
 *
 * Pins:
 *   - data: the sensitiveNerve definition is sensory (no grants, no overTime,
 *     grantsFlags exactly ['sensitive']) and the flag name is in the shared
 *     vocabulary (FLAG_NAMES.SENSITIVE);
 *   - data: exactly the seven classic zones declare the organ (male: glans,
 *     penis, testicle, nipple; female: clitoris, vulva, nipple), and
 *     sensitiveParts.json carries exactly those keys with the expected 0-100
 *     values — the two data files cannot drift apart;
 *   - spawn: a male droid spawns with 6 flagged instances (glans 1, penis 1,
 *     testicles 2, nipples 2) and a female droid with 4 (clitoris 1, vulva 1,
 *     nipples 2) — every flagged instance carries an installed sensitiveNerve
 *     IC, and a non-sensitive part (head) carries no sensitive flag;
 *   - renderer: the data-driven organ description reads "Marks the host as
 *     sensitive." (the description renderer is data-only; a new organ type
 *     needs zero code).
 *
 * @module test/contract/sensitiveParts
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import DataLoader from '../../src/utils/DataLoader.js';
import InternalComponentUtils from '../../src/utils/InternalComponentUtils.js';
import { FLAG_NAMES } from '../../shared/StatVocabulary.js';

const SENSITIVE_NERVE = 'sensitiveNerve';
const SENSITIVE_FLAG = 'sensitive';

/** The expected classic zones: part type -> sensitivity value (0-100). */
const EXPECTED_SENSITIVE_PARTS = {
    maleGlans: 100,
    malePenis: 80,
    maleTesticle: 60,
    maleNipple: 40,
    femaleClitoris: 100,
    femaleVulva: 80,
    femaleNipple: 40,
};

/** Builds a fresh world (non-started tick system) and spawns one entity. */
function buildWorldWith(blueprint) {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const world = buildWorldState(tick).worldStateController;
    const startRoomId = world.roomsController.getUidByLogicalId('start_room');
    const entityId = world.stateEntityController.spawnEntity(blueprint, startRoomId);
    return { world, tick, entityId, startRoomId };
}

/** Counts the flagged (sensitive) instances per component type on an entity. */
function sensitiveInstancesByType(world, entityId) {
    const counts = {};
    for (const comp of world.stateEntityController.getEntity(entityId).components) {
        if (world.getComponentFlags(comp.id).includes(SENSITIVE_FLAG)) {
            counts[comp.type] = (counts[comp.type] ?? 0) + 1;
        }
    }
    return counts;
}

describe('sensitive parts — sensitiveNerve organ + per-part sensitivity', () => {
    it('data: sensitiveNerve is a sensory organ (no grants, no overTime, only the sensitive flag)', () => {
        const registry = DataLoader.loadJsonSafe('data/components/internalComponents.json', {});
        const def = registry[SENSITIVE_NERVE];
        expect(def, 'sensitiveNerve is a registered organ type').toBeDefined();
        expect(def.grants, 'a sensory organ grants no function stat').toEqual({});
        expect(def.grantsFlags, 'marks the host as sensitive').toEqual([SENSITIVE_FLAG]);
        expect(def.overTime, 'a sensory organ has no periodic effect').toEqual([]);
        // The flag is part of the shared wire vocabulary (not a free string).
        expect(FLAG_NAMES.SENSITIVE).toBe(SENSITIVE_FLAG);
    });

    it('data: exactly the seven classic zones declare the organ, and sensitiveParts.json matches 1:1', () => {
        const recipes = DataLoader.loadJsonSafe('data/components/components.json', {});
        const declaring = Object.entries(recipes)
            .filter(([type, def]) =>
                type !== '_comment'
                && Array.isArray(def?.internalComponents)
                && def.internalComponents.some(e => (typeof e === 'string' ? e : e?.type) === SENSITIVE_NERVE)
            )
            .map(([type]) => type)
            .sort();

        expect(declaring, 'exactly the classic zones declare the organ').toEqual(
            Object.keys(EXPECTED_SENSITIVE_PARTS).sort()
        );

        const sensitivity = DataLoader.loadJsonSafe('data/components/sensitiveParts.json', {});
        const entries = Object.entries(sensitivity).filter(([key]) => key !== '_comment');
        for (const [type, value] of entries) {
            expect(value, `${type}: sensitivity is a 0-100 number`).toBeGreaterThanOrEqual(0);
            expect(value, `${type}: sensitivity is a 0-100 number`).toBeLessThanOrEqual(100);
        }
        expect(Object.fromEntries(entries), 'sensitiveParts.json is exactly the declaring set').toEqual(EXPECTED_SENSITIVE_PARTS);
    });

    it('spawn: the male droid has 6 sensitive instances (glans, penis, 2 testicles, 2 nipples), each carrying the IC', () => {
        const { world, entityId } = buildWorldWith('maleDroid');

        expect(sensitiveInstancesByType(world, entityId)).toEqual({
            maleGlans: 1,
            malePenis: 1,
            maleTesticle: 2,
            maleNipple: 2,
        });

        for (const comp of world.stateEntityController.getEntity(entityId).components) {
            if (world.getComponentFlags(comp.id).includes(SENSITIVE_FLAG)) {
                expect(
                    world.hasInternalComponent(entityId, comp.id, SENSITIVE_NERVE),
                    `${comp.type} instance carries the sensitiveNerve IC`
                ).toBe(true);
            }
        }

        // Negative control: a non-sensitive part carries no sensitive flag.
        const head = world.stateEntityController.getEntity(entityId).components.find(c => c.type === 'maleHead');
        expect(world.getComponentFlags(head.id), 'head is not sensitive').not.toContain(SENSITIVE_FLAG);
    });

    it('spawn: the female droid has 4 sensitive instances (clitoris, vulva, 2 nipples), each carrying the IC', () => {
        const { world, entityId } = buildWorldWith('femaleDroid');

        expect(sensitiveInstancesByType(world, entityId)).toEqual({
            femaleClitoris: 1,
            femaleVulva: 1,
            femaleNipple: 2,
        });

        for (const comp of world.stateEntityController.getEntity(entityId).components) {
            if (world.getComponentFlags(comp.id).includes(SENSITIVE_FLAG)) {
                expect(
                    world.hasInternalComponent(entityId, comp.id, SENSITIVE_NERVE),
                    `${comp.type} instance carries the sensitiveNerve IC`
                ).toBe(true);
            }
        }

        // Negative control: a non-sensitive part carries no sensitive flag.
        const head = world.stateEntityController.getEntity(entityId).components.find(c => c.type === 'femaleHead');
        expect(world.getComponentFlags(head.id), 'head is not sensitive').not.toContain(SENSITIVE_FLAG);
    });

    it('renderer: the data-driven organ description reads "Marks the host as sensitive."', () => {
        const registry = DataLoader.loadJsonSafe('data/components/internalComponents.json', {});
        expect(InternalComponentUtils.generateDescription(registry[SENSITIVE_NERVE])).toBe(
            'Marks the host as sensitive.'
        );
    });
});
