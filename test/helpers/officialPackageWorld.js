/**
 * TEST HELPER — a world built from the SHIPPED package set only.
 *
 * WHY THIS EXISTS. `data/mods/` is not a fixture, it is an install directory: the
 * tree is gitignored and only the `core-` packages are re-included (`.gitignore`),
 * so the machine running the suite may hold third-party overlays that CI never
 * sees. A contract pin written over the whole directory therefore says something
 * about one laptop, and an installed mod — the product's central feature, applied
 * at runtime — turns the gate red. `wiki/decisions/contract-test-scope.md` records
 * that decision and its boundary.
 *
 * WHAT IT SCOPES, and what it deliberately does not. `ModService`'s job IS the
 * install directory: never scope a service view with this loader, or the test
 * stops testing the thing the service does. Scope only the assertions that speak
 * for the shipped content — registry allowlists, per-kind counts, prose wording.
 * Everything here goes through the existing seam (`buildWorldState`'s `modLoader`
 * option), so no production code knows a test exists (`TST-1`, `B-1`).
 *
 * The filter is the loader's OWN `official` flag — derived from the reserved
 * `core-` prefix (`isOfficialModId`), never read from a manifest — so an overlay
 * cannot claim its way into the shipped set, and a new `core-` package joins this
 * scope by existing, with no list here to update.
 *
 * @module test/helpers/officialPackageWorld
 */

import ModLoader, { isOfficialModId } from '../../src/services/ModLoader.js';
import DataLoader from '../../src/utils/DataLoader.js';
import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';

/**
 * `ModLoader` over the same directory as production, contributing only the
 * packages that carry the reserved prefix.
 *
 * Only `discover()` is narrowed, so manifests, requirements, unsafe-key refusal,
 * shadowing and the load-order sort all stay the production code paths — a double
 * that reimplemented them would test the double.
 */
export class OfficialPackageModLoader extends ModLoader {
    /**
     * @returns {{ discovered: Array<Object>, invalid: Array<Object> }} the loader's
     *   result with `discovered` reduced to the official packages. `invalid` is
     *   passed through untouched: an overlay's own rejection is not shipped
     *   content's, and callers that report it filter by the prefix themselves.
     */
    discover() {
        const result = super.discover();
        return { ...result, discovered: officialOnly(result.discovered) };
    }
}

/**
 * The one implementation of "shipped content", shared by the loader above and by
 * any double that needs the same rule (`TST-8`: a fake is a module, not a private
 * re-derivation). Exported so the contract test can prove a scoped and an unscoped
 * build differ by exactly this filter and nothing else.
 * @param {Array<Object>} discovered - loader discovery entries
 * @returns {Array<Object>} the entries whose id carries the reserved prefix
 */
export function officialOnly(discovered) {
    return discovered.filter((mod) => isOfficialModId(mod.manifest.id));
}

/**
 * A scoped loader reading the same state file boot reads
 * (`data/mods/loadorder.json`), so an `enabled: false` the operator wrote applies
 * here exactly as it does at boot.
 * @returns {OfficialPackageModLoader}
 */
export function officialPackageLoader() {
    return new OfficialPackageModLoader({ state: DataLoader.loadModState() });
}

/**
 * The shipped world: the composition root, the real packages, the reserved prefix
 * only.
 *
 * The tick system is created but NOT started, matching every other contract test;
 * a caller that drives rounds passes its own so it can advance `currentTick`.
 * @param {UniversalTickSystem} [tickSystem]
 * @returns {ReturnType<typeof buildWorldState>}
 */
export function buildOfficialWorld(tickSystem = new UniversalTickSystem(MAX_TICKS_PER_SECOND)) {
    return buildWorldState(tickSystem, null, { modLoader: officialPackageLoader() });
}
