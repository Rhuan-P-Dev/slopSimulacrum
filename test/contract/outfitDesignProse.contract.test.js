/**
 * CONTRACT TEST — a designed garment, worn where the design said, speaks in the prose
 * and hides what hangs behind it.
 *
 * Two commits wrote two halves of this. `AgentBodyController.saveDesign` writes a
 * designed garment into the item registry and the outfit into the outfit registry
 * (pinned byte-for-byte in test/unit/AgentBodyController.test.js); `OutfitLogic` puts
 * them on at spawn (pinned in test/contract/outfitSpawn.contract.test.js). What is
 * pinned HERE is the seam nobody owns: those two written shapes, read by a real world,
 * produce the sentence the feature exists to produce — and the marked mounts go quiet
 * under the designed cloth, which is the other half of the owner's ask.
 *
 * The world is built from the SHIPPED registries with exactly two rows layered on, in
 * memory (`RegistryStore` injection, no data file touched): a garment in the shape
 * `saveDesign` writes, and an outfit for `maleDroid` wearing it on `maleCentralBody` —
 * the same component the shipped male breasts hang behind (`hidesWithParent`, the
 * mount mark). So the only new facts are the designed ones.
 *
 * Every expected word is DERIVED from the authored data, never typed by hand (`DOC-1`).
 *
 * @module test/contract/outfitDesignProse
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { RegistryStore } from '../../src/services/RegistryStore.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import DataLoader from '../../src/utils/DataLoader.js';
import { REGISTRY_KINDS, REGISTRY_KIND_LIST } from '../../shared/RegistryKinds.js';
import { describeVisual } from '../../src/utils/materialLook.js';

/** The `_`-prefixed file headers are metadata, not definitions (same basis as the loader). */
const stripMetadata = (registry) => Object.fromEntries(
    Object.entries(registry ?? {}).filter(([key]) => !key.startsWith('_'))
);

const BASE_REGISTRIES = Object.fromEntries(
    REGISTRY_KIND_LIST.map((kind) => [kind, stripMetadata(DataLoader.loadRegistry(kind))])
);

/**
 * A garment exactly in the shape `saveDesign` writes into `core-inventory-items`, and
 * the outfit it writes into `core-outfits` for the body this file spawns.
 */
const GARMENT_KEY = 'courierCloak';
const CLOAK = {
    name: 'Ash-Cloaked Courier Mantle',
    description: 'A garment authored from a character card in the Create Agent Body dev tab.',
    form: { volume: 4 },
    materials: [{ material: 'wood', fraction: 1.0 }],
    internalComponents: [],
    wear: { minVolume: 2 },
    visual: { hue: 210, saturation: 40, lightness: 22, metalness: 0, roughness: 80 }
};
const CLOAK_LOOK = describeVisual(CLOAK.visual)?.phrase ?? '';
const CLOAK_NAME = CLOAK.name;
/** The body the outfit dresses, and the part its cloth is in front of. */
const BODY = 'maleDroid';
const CLOTHED_COMPONENT = 'maleCentralBody';
const MARKED_TYPE = 'maleBreast';
const MARKED_NAME = BASE_REGISTRIES[REGISTRY_KINDS.COMPONENTS]?.[MARKED_TYPE]?.name ?? '';
const FLESH_LOOK = describeVisual(BASE_REGISTRIES[REGISTRY_KINDS.MATERIALS]?.flesh?.visual)?.phrase ?? '';

/**
 * A real world over the shipped registries plus the two designed rows. The server's own
 * cast walks in with every world; this file speaks only about spawns it made.
 * @returns {{ world: Object, actor: string, victim: string, advance: (ticks: number) => void }}
 */
function buildDressedMatch() {
    const store = new RegistryStore({
        ...BASE_REGISTRIES,
        [REGISTRY_KINDS.INVENTORY_ITEMS]: {
            ...BASE_REGISTRIES[REGISTRY_KINDS.INVENTORY_ITEMS],
            [GARMENT_KEY]: CLOAK
        },
        [REGISTRY_KINDS.OUTFITS]: {
            ...BASE_REGISTRIES[REGISTRY_KINDS.OUTFITS],
            [BODY]: [{ item: GARMENT_KEY, component: CLOTHED_COMPONENT }]
        }
    });
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world } = buildWorldState(tick, store);
    const room = world.roomsController.getUidByLogicalId('start_room');
    const actor = world.stateEntityController.spawnEntity(BODY, room, { name: 'Adam' });
    const victim = world.stateEntityController.spawnEntity('smallBallDroid', room, { name: 'Ball' });
    world.stateEntityController.updateEntitySpatial(actor, { x: 0, y: 0 });
    world.stateEntityController.updateEntitySpatial(victim, { x: 30, y: 0 });
    // The drop rolls are the one random voice in a round; pinned so the paragraph this
    // file pins cannot vary (TST-2).
    world.onDamageDropListener._randomFn = () => 1;
    Object.values(world.stateEntityController.entities)
        .filter((entity) => entity.isNPC === true)
        .forEach((entity) => world.despawnEntity(entity.id));

    // Round 0 opens with the two spawns in its roster, then the punch is queued and the
    // round is closed — the same recipe `proseClothingLook.contract.test.js` drives.
    tick.currentTick = 0;
    world.turnSystemController.onTick();
    world.turnSystemController.queueAction(actor, 'droid punch', { targetEntityId: victim }, 'player');
    world.turnSystemController.signalPlanComplete(actor, 'player');
    world.turnSystemController.signalPlanComplete(victim, 'player');
    for (let i = 0; i < 4; i += 1) {
        tick.currentTick += 1;
        world.turnSystemController.onTick();
    }
    return { world, actor, victim };
}

/**
 * The paragraph that narrates the punch, searched across the early rounds (which round
 * carries it is the turn system's business; what is pinned is what it says).
 * @param {Object} world
 * @returns {string}
 */
function punchParagraph(world) {
    for (let round = 0; round <= 6; round += 1) {
        const prose = world.roundProseController.getRoundProse(round);
        for (const info of Object.values(prose?.rooms || {})) {
            if (/used .+ to throw a punch/.test(info.text)) return info.text;
        }
    }
    return '';
}

describe('a designed garment is worn, spoken, and hides what hangs behind it', () => {
    it('the fixture is honest: the garment has a look, and the shipped mark is still there', () => {
        expect(CLOAK_LOOK, 'a garment with no authored look would say nothing about itself').not.toBe('');
        expect(MARKED_NAME, 'the part this file expects to disappear has a name').not.toBe('');
        const mounted = BASE_REGISTRIES[REGISTRY_KINDS.BLUEPRINTS][CLOTHED_COMPONENT] ?? [];
        expect(mounted.some((entry) => Array.isArray(entry) && entry[0] === MARKED_TYPE && entry[2]?.hidesWithParent === true),
            'the shipped body marks the part as hiding behind its parent').toBe(true);
    });

    it('the body is born wearing the designed garment, and only it', () => {
        const { world, actor } = buildDressedMatch();
        const worn = world.getWornItems(actor) ?? [];
        expect(worn).toHaveLength(1);
        expect(worn[0]).toMatchObject({ itemType: GARMENT_KEY, componentType: CLOTHED_COMPONENT });
    });

    it('the prose says the designed garment, not the world default, and not the skin under it', () => {
        const { world } = buildDressedMatch();
        const text = punchParagraph(world);
        expect(text, 'a real round narrated the punch').not.toBe('');
        expect(text).toContain('Male Central Body wearing');
        expect(text).toContain(CLOAK_NAME);
        expect(text).toContain(`(${CLOAK_LOOK})`);
        expect(text, 'the outfit replaced the default shirt rather than stacking under it')
            .not.toContain('T-Shirt');
        expect(text, 'a clothed part does not also reveal the matter under it')
            .not.toContain(`Male Central Body (${FLESH_LOOK})`);
    });

    it('the marked part is silent under the designed cloth, and its unmarked sibling is not', () => {
        const { world } = buildDressedMatch();
        const text = punchParagraph(world);
        expect(text, 'the cloth the design chose hides what hangs behind it').not.toContain(MARKED_NAME);
        expect(text, 'only the marked joint hides: the head hangs on the same parent and says so')
            .toContain(`Male Head (top, ${FLESH_LOOK})`);
    });

    it('is a pure function of the data: two identically built worlds say the same sentence', () => {
        const first = punchParagraph(buildDressedMatch().world);
        const second = punchParagraph(buildDressedMatch().world);
        expect(first, 'a real round narrated the punch').not.toBe('');
        expect(first, 'the verbs came from the registry, not a fallback').not.toContain('did droid punch');
        expect(second).toBe(first);
    });
});
