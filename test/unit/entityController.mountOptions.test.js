/**
 * UNIT TEST — a blueprint mount may declare options about itself.
 *
 * `["maleBreast", "left", { "hidesWithParent": true }]`: the third element belongs
 * to the MOUNT, not to the component type, because which part hangs under whose
 * cloth is a fact about this joint in this body (`wiki/decisions/visual-stats.md`).
 * `EntityController` reads it once, at expansion, and carries it onto the instance,
 * so a reader of a live body never re-opens a blueprint to learn what a part is
 * under.
 *
 * The backwards half is pinned too, and it is the bigger half: a mount that authored
 * nothing expands to the `[name, slot, parentIndex]` row it always was and yields an
 * instance with no new key. Every blueprint in this world that was not marked is
 * byte-identical to yesterday's.
 *
 * @module test/unit/entityController.mountOptions
 */

import { describe, it, expect } from 'vitest';
import ComponentStatsController from '../../src/controllers/core/componentStatsController.js';
import TraitsController from '../../src/controllers/traits/TraitsController.js';
import ComponentController from '../../src/controllers/core/componentController.js';
import EntityController from '../../src/controllers/core/entityController.js';
import DataLoader from '../../src/utils/DataLoader.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';

/**
 * The component recipes the fixtures mount. A recipe is needed only so the
 * instantiation recognises the type; these parts declare no matter and no stats,
 * which is exactly what this file is not about.
 */
const COMPONENTS = {
    chest: { name: 'Chest' },
    breast: { name: 'Breast' },
    leg: { name: 'Leg' }
};

/** An EntityController over hand-written blueprints (no registry file). */
const withBlueprints = (blueprints) => new EntityController(
    new ComponentController(new ComponentStatsController(), new TraitsController({}), COMPONENTS),
    blueprints
);

/** The marked mounts of one blueprint tree, as `<blueprint>/<componentType>`. */
const markedMounts = (tree) => (Array.isArray(tree) ? tree : [])
    .filter((entry) => Array.isArray(entry) && entry[2]?.hidesWithParent === true)
    .map((entry) => entry[0]);

describe('blueprint mount options', () => {
    it('marks the instance a marked mount produced', () => {
        const entity = withBlueprints({ body: [['chest', 'core', { hidesWithParent: true }]] })
            .createEntityFromBlueprint('body');
        const [chest] = entity.components;
        expect(chest.type).toBe('chest');
        expect(chest.hidesWithParent, 'the mark is on the instance, not only in the blueprint')
            .toBe(true);
    });

    it('leaves an unmarked mount alone — absent, not false', () => {
        const [chest] = withBlueprints({ body: [['chest', 'core']] })
            .createEntityFromBlueprint('body').components;
        // The instance carries exactly the keys it has always carried: the mark is
        // absent, not false — the same answer a reader got before this option existed.
        expect(Object.keys(chest).sort()).toEqual(['dependsOn', 'id', 'identifier', 'type']);
    });

    it('keeps the mark through the identifier rename a nested parent applies', () => {
        // The rename (`left` -> `left_core`) rewrites every row under a parent; the
        // mount's own declaration is not a slot and must survive it.
        const controller = withBlueprints({
            body: [['chest', 'core']],
            chest: [['breast', 'left', { hidesWithParent: true }]]
        });
        const breast = controller.createEntityFromBlueprint('body').components
            .find((comp) => comp.type === 'breast');
        expect(breast.identifier).toBe('left_core');
        expect(breast.hidesWithParent).toBe(true);
    });

    it('marks one mount without marking the same type mounted elsewhere', () => {
        // The option is per mount: a breast hung on this body hides with it, a breast
        // hung on a body that authored nothing does not.
        const controller = withBlueprints({
            marked: [['chest', 'core', { hidesWithParent: true }]],
            bare: [['chest', 'core']]
        });
        expect(controller.createEntityFromBlueprint('marked').components[0].hidesWithParent).toBe(true);
        expect(controller.createEntityFromBlueprint('bare').components[0].hidesWithParent).toBeUndefined();
    });

    it('reads a third element that is not an object as no options', () => {
        // A string or an array here is not a declaration of anything this module
        // knows; it must not become a mark, and must not break the row.
        const controller = withBlueprints({
            body: [['chest', 'core', 'yes'], ['leg', 'left', ['hidesWithParent']]]
        });
        const rows = controller.expandBlueprint('body');
        expect(rows.map((row) => row.length)).toEqual([3, 3]);
        controller.createEntityFromBlueprint('body').components
            .forEach((comp) => expect(comp.hidesWithParent).toBeUndefined());
    });

    it('is the shipped mark, and only it: the male breasts on the male central body', () => {
        // Authored world data, pinned as a list. A silent second mark would hide a
        // body part the prose was never asked to hide; a lost one would uncover a
        // part this data says is under cloth.
        const blueprints = DataLoader.loadRegistry(REGISTRY_KINDS.BLUEPRINTS);
        const marked = Object.entries(blueprints)
            .filter(([name]) => !name.startsWith('_'))
            .flatMap(([name, tree]) => markedMounts(tree).map((type) => `${name}/${type}`));
        expect(marked).toEqual([
            'maleCentralBody/maleBreast',
            'maleCentralBody/maleBreast'
        ]);
    });
});
