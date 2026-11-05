/**
 * CONTRACT TEST — the flesh material, and the humanoid bodies built out of it.
 *
 * The world derives every stat from matter: a recipe declares a FORM and a
 * COMPOSITION, and mass, the six channel resistances and the derived flags fall out
 * of the materials it names (data/mods/core-materials/materials.json through
 * data/mods/core-property-trait-mapping/propertyTraitMapping.json). "Humans are made of
 * flesh" is therefore not a label but a composition claim, and this file pins its
 * shipped consequences:
 *
 *   - data: `flesh` is a full material definition (density + the seven properties every
 *     other material declares), so no derived resistance can silently fall to 0;
 *   - derivation: a pure-flesh recipe yields the flesh resistances, mass = 1.05 x volume,
 *     the `conductive` flag (wet tissue: 70 >= the 60 threshold) and NOT `flammable`
 *     (55 < 60 — a body is not a torch);
 *   - anatomy: every humanoid body recipe (male*, female*, minako*) is 100% flesh,
 *     except the hard parts (hair, eyebrows, eyes, teeth, nails) and Minako's choker,
 *     which are not flesh tissue and keep their shipped matter;
 *   - scope: nothing that is not a humanoid body became flesh (droids, the tree, items);
 *   - wiring: flesh carries BOTH derived per-material entries — a damage-type split
 *     summing to 100 and a chunk-drop balance — so a bare fist delivers blunt trauma
 *     plus abrasion (no cut channel), and a wounded body actually sheds matter;
 *   - world: punching a human torso leaves `chunk_flesh` on the ground beside it.
 *
 * Values are read from the same files the server reads, so the pins track the data and
 * not a copy of it.
 *
 * @module test/contract/fleshAnatomy
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import DataLoader from '../../src/utils/DataLoader.js';
import MaterialController from '../../src/controllers/materials/MaterialController.js';

const FLESH = 'flesh';

/** The seven properties every material definition carries (plus `density`). */
const MATERIAL_PROPERTIES = [
    'flammability',
    'electricalConduction',
    'moistureRetention',
    'cutResistance',
    'impactResistance',
    'wearResistance',
    'heatConduction',
];

/** The blueprint families that make up a humanoid body in the shipped world. */
const HUMANOID_PREFIXES = ['male', 'female', 'minako'];

/**
 * Humanoid recipes that are deliberately NOT flesh: keratin (hair, eyebrows, nails),
 * enamel (teeth), the eyeballs, and one worn accessory. They keep the matter they
 * shipped with — this change is about the body's soft tissue, not about renaming bone.
 */
const HARD_PARTS = [
    'maleHair', 'maleEyebrow', 'maleEye', 'maleTooth', 'maleNail',
    'femaleHair', 'femaleEyebrow', 'femaleEye', 'femaleTooth', 'femaleNail',
    'minakohair', 'minakoeyes', 'minakochoker',
];

const recipes = DataLoader.loadJsonSafe('data/mods/core-components/components.json', {});
const materialsRegistry = DataLoader.loadJsonSafe('data/mods/core-materials/materials.json', {});
const mappingRegistry = DataLoader.loadJsonSafe('data/mods/core-property-trait-mapping/propertyTraitMapping.json', {});
const damageTypes = DataLoader.loadJsonSafe('data/mods/core-material-damage-types/materialDamageTypes.json', {});
const dropRates = DataLoader.loadJsonSafe('data/mods/core-material-drop-rates/materialDropRates.json', {});

const isHumanoid = (type) => type !== '_comment' && HUMANOID_PREFIXES.some((prefix) => type.startsWith(prefix));
const humanoidRecipes = Object.keys(recipes).filter(isHumanoid);
const fleshRecipes = humanoidRecipes.filter((type) => !HARD_PARTS.includes(type));
const compositionOf = (type) => (recipes[type]?.materials || []).map((m) => `${m.material}:${m.fraction}`);

/** A fresh, not-started world with the shipped data. */
function buildWorld() {
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const world = buildWorldState(tick).worldStateController;
    // Pin the onDamage Bernoulli stream off, as the chunk-drop contract does: this file
    // asserts exact ground-record identities, and the shipped 5% rule would otherwise
    // add a second probabilistic flesh stream to the same worlds.
    world.onDamageDropListener._randomFn = () => 1;
    return world;
}

describe('flesh - the material', () => {
    it('is defined with the full definition shape every material carries', () => {
        const entry = materialsRegistry[FLESH];
        expect(entry, 'flesh is a registered material').toBeDefined();
        expect(entry.name).toBe('Flesh');
        expect(typeof entry.density).toBe('number');
        for (const property of MATERIAL_PROPERTIES) {
            expect(typeof entry.properties?.[property], `flesh declares "${property}" (a missing property derives 0)`).toBe('number');
        }
    });

    it('derives its resistances, its mass and its flags from a pure-flesh recipe', () => {
        const controller = new MaterialController(materialsRegistry, mappingRegistry);
        const derived = controller.derive({ form: { volume: 10 }, materials: [{ material: FLESH, fraction: 1 }] }).Physical;

        // Three resistances read the property directly; three invert a susceptibility at 100.
        expect(derived.cut_resistance).toBe(15);
        expect(derived.impact_resistance).toBe(35);
        expect(derived.wear_resistance).toBe(25);
        expect(derived.heat_resistance).toBe(55);          // 100 - heatConduction 45
        expect(derived.electricity_resistance).toBe(30);   // 100 - electricalConduction 70
        expect(derived.corrosion_resistance).toBe(20);     // 100 - moistureRetention 80

        // Mass is matter x form: 1.05 x 10.
        expect(derived.mass).toBeCloseTo(10.5, 6);

        // Wet tissue conducts (70 >= the 60 threshold); a body is not a torch (55 < 60).
        expect(derived.derivedFlags).toContain('conductive');
        expect(derived.derivedFlags, 'flesh is below the flammable threshold').not.toContain('flammable');
    });
});

describe('flesh - the humanoid bodies built out of it', () => {
    it('makes every soft part of every humanoid recipe 100% flesh', () => {
        // A typo in HARD_PARTS would quietly move a hard part into the flesh set below.
        for (const type of HARD_PARTS) {
            expect(recipes[type], `"${type}" is a shipped recipe`).toBeDefined();
        }
        expect(fleshRecipes.length, 'the humanoid families hold more than just their hard parts').toBeGreaterThan(HARD_PARTS.length);

        for (const type of fleshRecipes) {
            expect(compositionOf(type), `${type} is flesh and nothing else`).toEqual(['flesh:1']);
        }
    });

    it('leaves the hard parts and the worn choker their own matter', () => {
        for (const type of HARD_PARTS) {
            const composition = recipes[type].materials.map((m) => m.material);
            expect(composition, `${type} is not flesh tissue`).not.toContain(FLESH);
        }
    });

    it('does not reach outside the humanoid bodies', () => {
        const elsewhere = Object.keys(recipes)
            .filter((type) => type !== '_comment' && !isHumanoid(type))
            .filter((type) => (recipes[type]?.materials || []).some((m) => m.material === FLESH));
        expect(elsewhere, 'droids, props and the tree keep their shipped matter').toEqual([]);
    });
});

describe('flesh - wired into both derived per-material registries', () => {
    it('carries a damage-type split summing to 100, with no cut channel', () => {
        const split = damageTypes[FLESH];
        expect(split, 'a bare limb must declare how it delivers a hit').toBeDefined();
        const sum = Object.values(split).reduce((total, pct) => total + pct, 0);
        expect(sum, 'a damage split is a percentage distribution').toBeCloseTo(100, 2);
        expect(split.impact).toBe(80);
        expect(split.wear).toBe(20);
        expect(split.cut, 'flesh does not cut').toBeUndefined();
    });

    it('carries a chunk-drop balance, so a wounded body sheds matter', () => {
        const entry = dropRates.materials?.[FLESH];
        expect(entry, 'flesh without a drop entry never sheds a chunk').toBeDefined();
        expect(entry.dropRate).toBeGreaterThanOrEqual(0);
        expect(entry.dropRate).toBeLessThanOrEqual(1);
        expect(entry.chunkFraction).toBeGreaterThanOrEqual(0);
        expect(entry.chunkFraction).toBeLessThanOrEqual(1);
    });
});

describe('flesh - in the running world', () => {
    it('a human fist delivers blunt trauma plus abrasion, not a cut', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const humanId = world.stateEntityController.spawnEntity('maleDroid', roomId);
        const hand = world.getEntity(humanId).components.find((c) => c.type === 'maleHand');

        expect(hand, 'the male humanoid spawns a hand').toBeDefined();
        const split = world.materialController.getBlendedDamageTypeSplit(
            world.componentController.getComponentMaterialsByType()[hand.type],
            'impact'
        );
        expect(split).toEqual({ impact: 80, wear: 20 });
    });

    it('punching a human torso leaves chunk_flesh on the ground beside the body', () => {
        const world = buildWorld();
        const roomId = world.roomsController.getUidByLogicalId('start_room');
        const attackerId = world.stateEntityController.spawnEntity('smallBallDroid', roomId);
        const victimId = world.stateEntityController.spawnEntity('maleDroid', roomId);
        world.stateEntityController.updateEntitySpatial(attackerId, { x: 0, y: 0 });
        world.stateEntityController.updateEntitySpatial(victimId, { x: 50, y: 0 });

        const torso = world.getEntity(victimId).components.find((c) => c.type === 'maleTorso');
        expect(torso, 'the male humanoid spawns a torso').toBeDefined();

        const result = world.actionController.executeAction('droid punch', attackerId, {
            targetEntityId: victimId,
            targetComponentId: torso.id,
        });
        expect(result.success, `punch should succeed: ${JSON.stringify(result)}`).toBe(true);

        const fleshChunks = Object.values(world.getDroppedItems()).filter((d) => d.itemType === 'chunk_flesh');
        expect(fleshChunks.length, 'a wounded body sheds flesh').toBeGreaterThan(0);
        expect(fleshChunks[0].name).toMatch(/flesh chunk/i);
        expect(fleshChunks[0].roomId).toBe(roomId);
    });
});
