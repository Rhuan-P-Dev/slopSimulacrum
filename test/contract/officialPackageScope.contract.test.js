/**
 * CONTRACT TEST — an installed mod must not be able to break a contract pin.
 *
 * The bug this reproduces (`TST-5`): three tests were red on a developer machine
 * and green in CI, because they pinned the *shipped* content while reading the
 * *install* directory. `data/mods/` is gitignored with only `core-*` re-included
 * (`.gitignore`), so one locally authored package — `system-fire-punch`, adding an
 * action with an instrumental form — landed inside an allowlist of shipped
 * wording. An installed mod breaking the gate is the failure mode this file owns:
 * installing content is the product's central feature
 * (`wiki/decisions/mod-system.md`), so a pin that breaks when it happens is wrong,
 * not the install.
 *
 * Everything is decided with a FABRICATED overlay, never by writing into
 * `data/mods/`: a fixture written into the real install directory would be
 * invisible in CI (the directory is gitignored) and would leave residue in a
 * user's world if the run died mid-way. Fabricated instead, the same assertion
 * runs identically on every machine (`TST-2`), and the proof does not depend on
 * anyone's laptop holding a mod.
 *
 * What is pinned, in order:
 *   - the overlay really does reach an unscoped build — the pin was at risk, not
 *     vacuously safe;
 *   - the official scope drops it: same loader, same disk, one filter wider
 *     (`officialOnly`), and neither the definition nor the composed world carries
 *     the overlay's action;
 *   - an overlay that SHADOWS an official key cannot move a shipped value into a
 *     scoped world;
 *   - the loader's order promise is `(loadOrder, id)`, and it is NOT the alphabet —
 *     pinned where it can be, with a package whose loadOrder makes the two
 *     disagree (`sortModsForLoad`).
 *
 * @module test/contract/officialPackageScope
 */

import { describe, it, expect, beforeAll } from 'vitest';
import ModLoader, { sortModsForLoad, DEFAULT_LOAD_ORDER } from '../../src/services/ModLoader.js';
import DataLoader from '../../src/utils/DataLoader.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { officialOnly, officialPackageLoader } from '../helpers/officialPackageWorld.js';

const OVERLAY_ID = 'overlay-prose-proof';
const OVERLAY_ACTION = 'wrench swing';
const OVERLAY_WORDS = 'swung a wrench at';
/** An overlay overwriting a shipped key: the shadow the scoped world must not inherit. */
const SHADOWED_WORDS = 'OVERLAY TOUCH WORDS';

/**
 * The shipped `touch` entry, cloned as the base for both overlay edits. Cloned
 * rather than invented so the injected action is a definition the world's own
 * composition rules accept: this file is about scope, not about half-written data.
 */
// Scoped, like every other shipped-content baseline in this repository. Read through
// the plain loader here and this file would inherit whatever the machine has
// installed and call it shipped - the exact bug it exists to pin.
const shippedActions = officialPackageLoader().build().registries[REGISTRY_KINDS.ACTIONS];
const shippedTouch = shippedActions.touch;
const OVERLAY_PATCH = {
    [REGISTRY_KINDS.ACTIONS]: {
        [OVERLAY_ACTION]: {
            ...shippedTouch,
            prose: { ...shippedTouch.prose, verbPhrase: OVERLAY_WORDS }
        },
        touch: { ...shippedTouch, prose: { ...shippedTouch.prose, verbPhrase: SHADOWED_WORDS } }
    }
};

/**
 * A `ModLoader` over the real packages plus one in-memory package.
 *
 * `discover()` appends the fabricated entry and re-sorts with the loader's own
 * comparator; `_readPackage()` answers for it. Everything else — manifest parsing,
 * requirements, unsafe-key refusal, the merge — stays production code, because a
 * double that reimplemented them would be testing the double (`TST-1`).
 */
class ScriptedOverlayLoader extends ModLoader {
    /**
     * @param {{ scope?: boolean, loadOrder?: number }} [options] - `scope` applies the
     *   helper's `officialOnly`; `loadOrder` is what the overlay gets (defaults to the
     *   loader's own fallback, the ordinary case for a package nobody ordered).
     */
    constructor({ scope = false, loadOrder = DEFAULT_LOAD_ORDER } = {}) {
        super({ state: DataLoader.loadModState() });
        this.scope = scope;
        this.overlayLoadOrder = loadOrder;
    }

    discover() {
        const result = super.discover();
        const overlay = {
            manifest: {
                id: OVERLAY_ID,
                version: '1.0.0',
                content: [REGISTRY_KINDS.ACTIONS],
                requires: [],
                description: 'fabricated by test/contract/officialPackageScope',
                official: false
            },
            dir: OVERLAY_ID,
            enabled: true,
            loadOrder: this.overlayLoadOrder,
            blocked: null
        };
        const discovered = sortModsForLoad([...result.discovered, overlay]);
        return {
            ...result,
            discovered: this.scope ? officialOnly(discovered) : discovered
        };
    }

    _readPackage(mod) {
        if (mod.manifest.id === OVERLAY_ID) {
            return Object.entries(OVERLAY_PATCH).map(([kind, patch]) => ({ kind, patch }));
        }
        return super._readPackage(mod);
    }
}

describe('an installed overlay and the shipped package set', () => {
    /** One fabricated overlay, read twice: scoped and not. Nothing is written to disk. */
    let unscoped;
    let scoped;

    beforeAll(() => {
        unscoped = new ScriptedOverlayLoader().build();
        scoped = new ScriptedOverlayLoader({ scope: true }).build();
    });

    it('reaches a definition built over the whole install directory', () => {
        // Non-vacuity: if the unscoped build did not carry the overlay, every scoped
        // assertion below would pass with no filter at all.
        expect(unscoped.registries[REGISTRY_KINDS.ACTIONS][OVERLAY_ACTION],
            'an installed package contributes its action').toBeTruthy();
        expect(unscoped.registries[REGISTRY_KINDS.ACTIONS].touch.prose.verbPhrase,
            'and an overlay over a shipped key wins the merge, by design')
            .toBe(SHADOWED_WORDS);
        expect(unscoped.shadowed.find((entry) => entry.key === 'touch'),
            'shadowing is reported, never silent - so a pin could always have named the overlay')
            .toMatchObject({ kind: REGISTRY_KINDS.ACTIONS, key: 'touch', to: OVERLAY_ID });
    });

    it('is dropped whole from a world scoped to the shipped packages', () => {
        const actions = scoped.registries[REGISTRY_KINDS.ACTIONS];
        expect(actions[OVERLAY_ACTION], 'the overlay action is not shipped content').toBeUndefined();
        expect(actions.touch.prose.verbPhrase, 'a shipped word stays the shipped word')
            .toBe(shippedTouch.prose.verbPhrase);
        expect(Object.keys(actions).sort()).toEqual(Object.keys(shippedActions).sort());
        expect(scoped.shadowed.filter((entry) => entry.to === OVERLAY_ID),
            'the scoped report does not even mention a package it excluded')
            .toEqual([]);
    });

    it('is excluded by the reserved prefix, the same rule the loader derives', () => {
        // The helper is the filter and nothing else: a scoped discovery equals the real
        // one with officialOnly applied, so no scope lives in a hardcoded id list.
        const loader = officialPackageLoader();
        const { discovered } = loader.discover();
        const everything = new ModLoader({ state: DataLoader.loadModState() }).discover().discovered;
        expect(discovered.map((mod) => mod.manifest.id))
            .toEqual(officialOnly(everything).map((mod) => mod.manifest.id));
        expect(discovered.length, 'the scope is not empty, or it would filter anything').toBeGreaterThan(0);
        expect(discovered.every((mod) => mod.manifest.id.startsWith('core-'))).toBe(true);
        expect(everything.some((mod) => mod.manifest.id === OVERLAY_ID),
            'the fabricated package is not on disk - it is injected, so the real set is untouched')
            .toBe(false);
    });
});

describe('the composition root honors the scoped package set', () => {
    /** The live action registry of each of the two worlds, built once. */
    let registrySeen;

    beforeAll(() => {
        const scopedWorld = buildWorldState(new UniversalTickSystem(MAX_TICKS_PER_SECOND), null, {
            modLoader: new ScriptedOverlayLoader({ scope: true })
        });
        registrySeen = scopedWorld.worldStateController.getActionRegistry();
    });

    it('keeps an installed overlay out of the live action registry', () => {
        expect(registrySeen[OVERLAY_ACTION], 'the overlay never reached the composed world').toBeUndefined();
        expect(registrySeen['droid punch'], 'and the shipped action is still there').toBeTruthy();
        expect(registrySeen.touch.prose.verbPhrase).toBe(shippedTouch.prose.verbPhrase);
    });
});

describe('the loader order promise', () => {
    it('sorts by loadOrder then id, and that is not the alphabet', () => {
        // The case that broke the old assertion: an overlay nobody ordered takes
        // DEFAULT_LOAD_ORDER, ties with a shipped package, and loads near the FRONT -
        // while a string sort buries it last. The two orders are different promises and
        // cannot stand in for one another.
        const ordered = sortModsForLoad(new ScriptedOverlayLoader().discover().discovered);
        const ids = ordered.map((mod) => mod.manifest.id);
        const positions = ordered.map((mod) => mod.loadOrder);

        expect(positions, 'ascending loadOrder is the primary key').toEqual(
            [...positions].sort((a, b) => a - b)
        );
        expect(ids.indexOf(OVERLAY_ID), 'the alphabet would have put it last').not.toBe(
            [...ids].sort().indexOf(OVERLAY_ID)
        );

        const tied = ordered
            .filter((mod) => mod.loadOrder === DEFAULT_LOAD_ORDER)
            .map((mod) => mod.manifest.id);
        expect(tied.length, 'the overlay ties with shipped packages, so the tiebreak is exercised')
            .toBeGreaterThan(1);
        expect(tied, 'ties break by id, so the order stays total (D-2)').toEqual([...tied].sort());
    });

    it('holds whatever order the overlay carries', () => {
        const installed = new ScriptedOverlayLoader().discover().discovered
            .filter((mod) => mod.manifest.id !== OVERLAY_ID);
        const aheadOfEverything = Math.min(...installed.map((mod) => mod.loadOrder)) - 1;
        const ordered = sortModsForLoad(
            new ScriptedOverlayLoader({ loadOrder: aheadOfEverything }).discover().discovered
        ).map((mod) => mod.manifest.id);

        expect(ordered[0], 'a lower loadOrder loads first, whoever it belongs to').toBe(OVERLAY_ID);
        expect(ordered.slice(1), 'and everything else keeps its place')
            .toEqual(sortModsForLoad(installed).map((mod) => mod.manifest.id));
    });
});
