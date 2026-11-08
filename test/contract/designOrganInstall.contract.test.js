/**
 * CONTRACT TEST — a designer's own organ, written by the body Save, installs on the
 * component that names it and grants the stat the organ authored.
 *
 * Two commits write the two halves. `AgentBodyController.saveDesign` writes a
 * designer organ into the package's `internalComponents` kind and a component that
 * declares it into the `components` kind (pinned byte-for-byte in
 * test/unit/AgentBodyController.test.js). This file pins the seam nobody else owns:
 * those two written shapes, read by a real world at spawn, produce the install — the
 * organ lands on the naming component and the component carries the function stat the
 * organ grants, and the sibling that names no organ stays bare. That is the owner's
 * ask: a body designed in the dev tab can carry organs that are its own.
 *
 * The world is built from the SHIPPED registries with exactly three rows layered on, in
 * memory (`RegistryStore` injection, no data file touched): a designer organ in the
 * exact shape `saveDesign` writes, a new root component that declares it, and a leaf
 * component that declares nothing (the control). The blueprint key is a fresh card
 * name, so nothing shipped is redefined.
 *
 * Every expected number is DERIVED from the authored data, never typed twice (`DOC-1`).
 *
 * @module test/contract/designOrganInstall
 */

import { describe, it, expect } from 'vitest';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { RegistryStore } from '../../src/services/RegistryStore.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import DataLoader from '../../src/utils/DataLoader.js';
import { REGISTRY_KINDS, REGISTRY_KIND_LIST } from '../../shared/RegistryKinds.js';

/** The `_`-prefixed file headers are metadata, not definitions (same basis as the loader). */
const stripMetadata = (registry) => Object.fromEntries(
    Object.entries(registry ?? {}).filter(([key]) => !key.startsWith('_'))
);

const BASE_REGISTRIES = Object.fromEntries(
    REGISTRY_KIND_LIST.map((kind) => [kind, stripMetadata(DataLoader.loadRegistry(kind))])
);

/**
 * The designer's own organ, EXACTLY in the shape `saveDesign` writes into the
 * package's `internalComponents` kind: the display name in `name`, the static
 * grants over the closed function-stat vocabulary, a flag, and a volume. No
 * `overTime`, no install gate — the organ installs only where a component names it.
 */
const ORGAN_KEY = 'courierWeb';
const ORGAN_DISPLAY = 'Courier Web';
const GRANTED_STAT = 'Physical.strength';
const GRANTED_VALUE = 70;
const GRANTED_FLAG = 'conductive';
const [GRANTED_TRAIT, GRANTED_NAME] = GRANTED_STAT.split('.');

/**
 * The body this file spawns. The root component declares the designer organ; the
 * leaf child names no organ and is the control (it stays bare).
 */
const BODY = 'courierRunner';
const ROOT_COMPONENT = 'webbedTorso';
const LEAF_COMPONENT = 'plainLimb';
// Fit-semantics fixture: two hosts of the same size (HOST_VOLUME). One names a
// just-fitting organ (BIG_ORGAN, volume == HOST_VOLUME, installs); the other
// names an oversized organ (TINY_ORGAN, volume > HOST_VOLUME, must not install).
const BIG_BODY = 'bigRunner';
const BIG_COMPONENT = 'bigCore';
const SMALL_COMPONENT = 'smallLimb';
const BIG_ORGAN = 'bigWeb';
const TINY_ORGAN = 'tinyCore';
const HOST_VOLUME = 20;
const BIG_ORGAN_VOLUME = 20;
const TINY_ORGAN_VOLUME = 30;
const ORGANS = {
    [ORGAN_KEY]: {
        name: ORGAN_DISPLAY,
        volume: 1,
        grants: { [GRANTED_STAT]: GRANTED_VALUE },
        grantsFlags: [GRANTED_FLAG]
    },
    [BIG_ORGAN]: {
        name: 'Big Web',
        volume: BIG_ORGAN_VOLUME,
        grants: { [GRANTED_STAT]: 5 }
    },
    [TINY_ORGAN]: {
        name: 'Tiny Core',
        volume: TINY_ORGAN_VOLUME,
        grants: { [GRANTED_STAT]: 5 }
    }
};
const COMPONENTS = {
    [ROOT_COMPONENT]: {
        name: 'Webbed Torso',
        form: { volume: 8, position: { x: 0, y: 0 } },
        materials: [{ material: 'iron', fraction: 1.0 }],
        internalComponents: [ORGAN_KEY]
    },
    [LEAF_COMPONENT]: {
        name: 'Plain Limb',
        form: { volume: 4, position: { x: 1, y: 0 } },
        materials: [{ material: 'wood', fraction: 1.0 }],
        internalComponents: []
    },
    [BIG_COMPONENT]: {
        name: 'Big Core',
        form: { volume: HOST_VOLUME, position: { x: 0, y: 0 } },
        materials: [{ material: 'iron', fraction: 1.0 }],
        internalComponents: [BIG_ORGAN]
    },
    [SMALL_COMPONENT]: {
        name: 'Small Limb',
        form: { volume: HOST_VOLUME, position: { x: 1, y: 0 } },
        materials: [{ material: 'iron', fraction: 1.0 }],
        internalComponents: [TINY_ORGAN]
    }
};
const BLUEPRINTS = {
    [BODY]: [ROOT_COMPONENT],
    [ROOT_COMPONENT]: [LEAF_COMPONENT],
    [BIG_BODY]: [BIG_COMPONENT, SMALL_COMPONENT]
};

/**
 * A real world over the shipped registries plus the designed rows. Only the
 * spawn this file makes is inspected.
 * @param {string} [blueprint=BODY] - which blueprint to spawn (default: the designed body).
 * @returns {{ world: Object, actor: string }}
 */
function buildOrgansMatch(blueprint = BODY) {
    const store = new RegistryStore({
        ...BASE_REGISTRIES,
        [REGISTRY_KINDS.INTERNAL_COMPONENTS]: {
            ...BASE_REGISTRIES[REGISTRY_KINDS.INTERNAL_COMPONENTS],
            ...ORGANS
        },
        [REGISTRY_KINDS.COMPONENTS]: {
            ...BASE_REGISTRIES[REGISTRY_KINDS.COMPONENTS],
            ...COMPONENTS
        },
        [REGISTRY_KINDS.BLUEPRINTS]: {
            ...BASE_REGISTRIES[REGISTRY_KINDS.BLUEPRINTS],
            ...BLUEPRINTS
        }
    });
    const tick = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
    const { worldStateController: world } = buildWorldState(tick, store);
    const room = world.roomsController.getUidByLogicalId('start_room');
    const actor = world.stateEntityController.spawnEntity(blueprint, room, { name: 'Runner' });
    return { world, actor };
}

/** Find one component instance of a type from a spawned entity. */
function findComponent(world, entityId, type) {
    return (world.stateEntityController.entities[entityId].components || [])
        .find((comp) => comp.type === type) ?? null;
}

describe('a designer organ installs on the component that names it and grants its stat', () => {
    it('the fixture is honest: the organ grants a function stat, and a sibling names nothing', () => {
        expect(GRANTED_VALUE, 'a grant of zero would be a claim that proves nothing').toBeGreaterThan(0);
        expect(COMPONENTS[ROOT_COMPONENT].internalComponents).toContain(ORGAN_KEY);
        expect(COMPONENTS[LEAF_COMPONENT].internalComponents).toEqual([]);
    });

    it('installs the organ on the naming component at spawn', () => {
        const { world, actor } = buildOrgansMatch();
        const root = findComponent(world, actor, ROOT_COMPONENT);
        expect(root, 'the root component that names the organ exists').not.toBeNull();

        const icOnRoot = (world.stateEntityController.entities[actor].internalComponents || {})[root.id] || [];
        expect(icOnRoot.map((ic) => ic.type), 'the designer organ is present on the naming component')
            .toContain(ORGAN_KEY);
    });

    it('grants the function stat the organ authored onto the naming component, derived not typed', () => {
        const { world, actor } = buildOrgansMatch();
        const root = findComponent(world, actor, ROOT_COMPONENT);
        const stats = world.getComponentStats(root.id) || {};
        expect(stats[GRANTED_TRAIT]?.[GRANTED_NAME],
            'the component carries the stat the organ grants, at the authored value')
            .toBe(GRANTED_VALUE);
    });

    it('marks the flag the organ carries on the naming component', () => {
        const { world, actor } = buildOrgansMatch();
        const root = findComponent(world, actor, ROOT_COMPONENT);
        expect(world.getComponentFlags(root.id),
            'the organ-granted flag is read back on the naming component')
            .toContain(GRANTED_FLAG);
    });

    it('leaves the control component bare: an organ installs only where a component names it', () => {
        const { world, actor } = buildOrgansMatch();
        const leaf = findComponent(world, actor, LEAF_COMPONENT);
        expect(leaf, 'the control component exists').not.toBeNull();

        const icOnLeaf = (world.stateEntityController.entities[actor].internalComponents || {})[leaf.id] || [];
        expect(icOnLeaf.map((ic) => ic.type), 'no organ the control component did not name')
            .not.toContain(ORGAN_KEY);
        const stats = world.getComponentStats(leaf.id) || {};
        expect(stats[GRANTED_TRAIT]?.[GRANTED_NAME], 'the stat the organ grants is not there')
            .not.toBe(GRANTED_VALUE);
        expect(world.getComponentFlags(leaf.id), 'the organ-granted flag is not there')
            .not.toContain(GRANTED_FLAG);
    });

    it('respects fit: an organ installs only where the host component is large enough', () => {
        const { world, actor } = buildOrgansMatch(BIG_BODY);
        const big = findComponent(world, actor, BIG_COMPONENT);
        const small = findComponent(world, actor, SMALL_COMPONENT);
        expect(big, 'the host that names the fitting organ exists').not.toBeNull();
        expect(small, 'the host that names the oversized organ exists').not.toBeNull();

        const icOnBig = (world.stateEntityController.entities[actor].internalComponents || {})[big.id] || [];
        const icOnSmall = (world.stateEntityController.entities[actor].internalComponents || {})[small.id] || [];

        // Host volume HOST_VOLUME >= BIG_ORGAN_VOLUME, so the organ fits and
        // installs at spawn. A flat volume fallback (host always 10) would never
        // have installed a 20-volume organ, so this is the bug's fix in motion.
        expect(icOnBig.map((ic) => ic.type),
            'a fitting organ (vol ' + BIG_ORGAN_VOLUME + ' on a vol ' + HOST_VOLUME + ' host) installs on its component')
            .toContain(BIG_ORGAN);

        // Host volume HOST_VOLUME < TINY_ORGAN_VOLUME, so the organ does not fit
        // and does not install. Fit is preserved for oversized organs too.
        expect(icOnSmall.map((ic) => ic.type),
            'an oversized organ (vol ' + TINY_ORGAN_VOLUME + ' on a vol ' + HOST_VOLUME + ' host) does not install')
            .not.toContain(TINY_ORGAN);
    });
});
