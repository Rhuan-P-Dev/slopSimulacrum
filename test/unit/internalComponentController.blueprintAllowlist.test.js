/**
 * Spawn-time organ gate — `targetBlueprintTypes` (data/components/internalComponents.json).
 *
 * Pins which entity blueprints an organ may install on, and reproduces the
 * "humanoid droid is born paralyzed" defect: the humanoid recipes declare their
 * function organs (`maleArm: ["strengthCore"]`, `maleLeg: ["moveCore"]`, same for
 * the female body and for the card body `minakoarm`/`minakoleg`), but the organ
 * definitions carried an allowlist of blueprint keys that stopped at the older
 * bodies. The gate in `autoInstallOnEntitySpawn` compares the entity's TOP-LEVEL
 * blueprint key, so a recipe declaration with a missing key is silently vetoed —
 * and in the recipe→derivation model a component with matter but no organs has no
 * function stats at all: `Physical.strength` and `Movement.move` never exist, so
 * every strength- or movement-gated action (move, dash, selfHeal, grab, punch,
 * pickUpItem, dropItem) resolves to zero capable components while the
 * material-derived ones (cut, shootT1, touch) keep working.
 *
 * The negative control is part of the contract: the gate must keep vetoing a
 * blueprint key that no recipe of that body was written for. Deleting
 * `targetBlueprintTypes` to "fix" the paralysis is not what this test asks for.
 *
 * @module test/unit/internalComponentController.blueprintAllowlist
 */

import { describe, it, expect } from 'vitest';
import InternalComponentController from '../../src/controllers/core/InternalComponentController.js';

/** Every organ here has volume 1-2; any host bigger than that satisfies the check. */
const HOST_VOLUME = 10;

/**
 * Runs the spawn-time auto-install for one entity type against a hand-built
 * component list and returns the organ types that actually installed.
 *
 * The controller reads a recipe's organ declarations through
 * `worldStateController.componentController.componentRegistry` and fails closed
 * when it is unwired, so the double below is what makes this a unit test instead
 * of a whole-world run: the registry it exposes is the real
 * `data/components/components.json` map the controller already loaded, and the two
 * stat writers are recorded-and-ignored (the stat side of the contract is covered
 * by test/contract/humanoidSpawnCapabilities.contract.test.js).
 *
 * @param {string} entityType - The blueprint key the entity was spawned from.
 * @param {Array<{id: string, type: string, identifier: string}>} components
 * @returns {string[]} Sorted organ types installed by this call.
 */
function installedOrganTypes(entityType, components) {
    const controller = new InternalComponentController();
    controller.setWorldStateController({
        componentController: {
            componentRegistry: controller.componentDefinitions,
            updateComponentStat: () => true,
            addGrantedFlag: () => true,
        },
    });
    const installed = controller.autoInstallOnEntitySpawn(
        `ent-${entityType}`,
        components,
        entityType,
        () => HOST_VOLUME
    );
    return Object.keys(installed).sort();
}

const humanoidLimbs = () => ([
    { id: 'comp-arm-left', type: 'maleArm', identifier: 'left' },
    { id: 'comp-leg-left', type: 'maleLeg', identifier: 'left' },
]);

const m1Limbs = () => ([
    { id: 'comp-hand-left', type: 'm1ArticulatedHand', identifier: 'left' },
    { id: 'comp-leg-left', type: 'm1Leg', identifier: 'left' },
]);

const cardLimbs = () => ([
    { id: 'comp-arm-left', type: 'minakoarm', identifier: 'left' },
    { id: 'comp-leg-left', type: 'minakoleg', identifier: 'left' },
]);

describe('InternalComponentController organ install gate (targetBlueprintTypes)', () => {
    it('installs the strength and locomotion organs the humanoid recipes declare', () => {
        expect(installedOrganTypes('maleDroid', humanoidLimbs())).toEqual(['moveCore', 'strengthCore']);
    });

    it('installs the strength and locomotion organs the female humanoid recipes declare', () => {
        const femaleLimbs = () => ([
            { id: 'comp-arm-left', type: 'femaleArm', identifier: 'left' },
            { id: 'comp-leg-left', type: 'femaleLeg', identifier: 'left' },
        ]);
        expect(installedOrganTypes('femaleDroid', femaleLimbs())).toEqual(['moveCore', 'strengthCore']);
    });

    it('installs them for a card body blueprint, keyed by the card display name', () => {
        // Card bodies are registered under the card's display name (see
        // CardSpawnLogic.blueprintForCard), so the allowlist has to name that key
        // too, or every designed body spawns without strength or movement.
        expect(installedOrganTypes('Minako', cardLimbs())).toEqual(['moveCore', 'strengthCore']);
    });

    it('still installs them for the legacy m1Droid blueprint key', () => {
        expect(installedOrganTypes('m1Droid', m1Limbs())).toContain('strengthCore');
        expect(installedOrganTypes('m1Droid', m1Limbs())).toContain('moveCore');
    });

    it('keeps vetoing a blueprint key the organ was not written for', () => {
        // Given the same humanoid limbs, When the entity was spawned from an
        // unrelated blueprint, Then no function organ installs (the gate is real).
        expect(installedOrganTypes('tree', humanoidLimbs())).toEqual([]);
    });
});
