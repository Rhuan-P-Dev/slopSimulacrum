/**
 * RangeResolver — regression tests guarding the item drop-range bug.
 *
 * BUG GUARDED: the server-enforced drop range and the client-displayed drop range
 * used to DIVERGE. The client's range indicator (_resolveDropRange in
 * public/js/App.js) parsed range expressions with a broken regex that (1) skipped
 * the trailing `+offset` in expression ranges and (2) let plain-number ranges fall
 * through to the legacy formula `3 + strength*2`. The fix made all three paths
 * (server enforcement, client distance gate, client range indicator) resolve ranges
 * through the SHARED `shared/RangeResolver.js` — the single source of truth.
 *
 * Why the client path is validated without importing public/js/App.js:
 *   App.js bootstraps a full ClientApp at MODULE LOAD time (a module-level
 *   `new ClientApp(); app.init()`), which needs the browser DOM, a live
 *   socket.io connection, and fetch. That is not importable from a node test.
 *   So the client's range semantics are validated by asserting that the shared
 *   RangeResolver — the module _resolveDropRange now delegates to — produces the
 *   EXACT value the client must display, for both the plain-number shape that
 *   actually ships in data/actions.json and the expression shapes the old broken
 *   regex mis-parsed. If _resolveDropRange ever stops delegating to the shared
 *   resolver, these assertions no longer describe the client's behaviour and the
 *   divergence regression re-emerges.
 *
 * These tests FAIL if that divergence is reintroduced:
 *   - TEST 1 (CONTRACT): the range value the SERVER enforces (real
 *     RangeValidator._resolveMaxRange) is EXACTLY the value the CLIENT displays
 *     (shared RangeResolver), for the real data/actions.json dropItem.range.
 *   - TEST 4 (REGRESSION): expression ranges include ALL terms (the old regex
 *     dropped the `+3` offset).
 *   - TEST 5 (REGRESSION): plain-number ranges do NOT fall through to the legacy
 *     `3 + strength*2` formula.
 *
 * @module test/unit/RangeResolver.test
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveRange } from '../../shared/RangeResolver.js';
import RangeValidator from '../../src/controllers/actions/RangeValidator.js';
import { AppConfig } from '../../public/js/Config.js';

// =========================================================================
// Shared fixtures
// =========================================================================

/**
 * Reads the REAL dropItem.range from data/actions.json (never a hardcoded fixture),
 * so the tests keep validating consistency even if the range value in the data file
 * changes.
 */
function readDropItemRange() {
    const dataPath = new URL('../../data/actions.json', import.meta.url);
    const raw = readFileSync(fileURLToPath(dataPath), 'utf8');
    return JSON.parse(raw).dropItem.range;
}

/** The stat map the server/client use to resolve range expressions for the test entity. */
const STAT_MAP = { 'Physical.strength': 25 };

/** Legacy drop-range formula the bug used as a fallback: BASE_RANGE + strength * DROP_RANGE. */
function legacyFormula(strength) {
    return AppConfig.DROP.BASE_RANGE + strength * AppConfig.MULTIPLIERS.DROP_RANGE;
}

/**
 * Minimal mocks mirroring the real WorldStateController / RequirementResolver /
 * ActionController contracts (same shape as test/unit/RangeValidator.test.js).
 * The entity is at the origin (0,0) and carries Physical.strength = 25.
 */
function buildRangeValidator() {
    const entities = {
        'ent-range-test': {
            id: 'ent-range-test',
            components: [{ id: 'comp-range-1' }],
            spatial: { x: 0, y: 0 }
        }
    };
    const componentStats = {
        'comp-range-1': { Physical: { strength: 25, mass: 20, durability: 100 } }
    };

    const mockWSC = {
        getEntity: (id) => entities[id] || null,
        getComponentStats: (compId) => componentStats[compId] || null
    };

    const mockRequirementResolver = {
        resolveEntityRequirementValues: (entityId) => {
            const entity = mockWSC.getEntity(entityId);
            if (!entity || !entity.components) return {};
            const values = {};
            for (const comp of entity.components) {
                const stats = mockWSC.getComponentStats(comp.id);
                if (!stats) continue;
                for (const [traitId, traitData] of Object.entries(stats)) {
                    for (const [statName, statValue] of Object.entries(traitData)) {
                        if (typeof statValue === 'number') {
                            values[`${traitId}.${statName}`] = statValue;
                        }
                    }
                }
            }
            return values;
        }
    };

    const mockAC = { actionRegistry: {}, consequenceHandlers: { get handlers() { return {}; } } };

    const validator = new RangeValidator(mockAC, mockRequirementResolver);
    validator.setWorldStateController(mockWSC);
    return validator;
}

// =========================================================================
// TEST 1 — CONTRACT: server-enforced range matches client-displayed range
// =========================================================================

describe('RangeResolver CONTRACT — server-enforced range matches client-displayed range', () => {
    // The shared resolver WARNs via console.warn on unresolvable expressions; keep
    // the test output clean by silencing it (restored in afterEach).
    let warnSpy;
    afterEach(() => {
        if (warnSpy) {
            warnSpy.mockRestore();
            warnSpy = null;
        }
    });

    it('resolves the real dropItem.range to a finite positive number', () => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const range = readDropItemRange();
        const resolved = resolveRange(range, STAT_MAP, NaN);

        expect(typeof resolved).toBe('number');
        expect(Number.isFinite(resolved)).toBe(true);
        expect(resolved).toBeGreaterThan(0);
    });

    it('server RangeValidator._resolveMaxRange() produces the SAME value as the shared resolver', () => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const range = readDropItemRange();
        const validator = buildRangeValidator();

        const sharedResolved = resolveRange(range, STAT_MAP, NaN);
        const serverResolved = validator._resolveMaxRange('ent-range-test', range);

        // The server's private resolution must equal the shared single source of truth.
        expect(serverResolved.error).toBeUndefined();
        expect(serverResolved.maxRange).toBe(sharedResolved);
        expect(serverResolved.maxRange).toBeGreaterThan(0);
    });

    it('client _resolveDropRange semantics match the shared resolver (the displayed range = enforced range)', () => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const range = readDropItemRange();

        // public/js/App.js cannot be imported from node (module-level ClientApp
        // bootstrap needs DOM/socket/fetch). The client's _resolveDropRange
        // delegates to the shared RangeResolver with statMap { 'Physical.strength':
        // strength } and a legacy-formula fallback; for a RESOLVABLE range (the
        // shipped dropItem.range always is) it returns the resolver's value. Assert
        // that value equals what the server enforces — the key regression guard.
        const clientDisplayed = resolveRange(range, { 'Physical.strength': 25 }, legacyFormula(25));
        const serverEnforced = buildRangeValidator()._resolveMaxRange('ent-range-test', range).maxRange;

        expect(clientDisplayed).toBe(serverEnforced);
        // A resolvable range must never surface the legacy-formula fallback.
        expect(clientDisplayed).toBe(resolveRange(range, STAT_MAP, NaN));
    });

    it('consistency holds for a plain-number range (no legacy-formula fall-through)', () => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // dropItem.range is currently a plain number; assert the contract explicitly
        // for that shape so a future change to an expression does not silently skip it.
        const range = readDropItemRange();
        expect(typeof range).toBe('number');

        const serverEnforced = buildRangeValidator()._resolveMaxRange('ent-range-test', range).maxRange;
        const clientDisplayed = resolveRange(range, { 'Physical.strength': 25 }, legacyFormula(25));

        expect(clientDisplayed).toBe(serverEnforced);
        expect(clientDisplayed).toBe(range);
    });

    it('consistency holds for an EXPRESSION range (old bug: display diverged from enforcement)', () => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // The original bug made the client render a SMALLER circle than the server
        // enforced for expression ranges. Assert the two paths agree for the exact
        // expression shape the broken regex mis-parsed ("+offset" dropped).
        const expression = ':Physical.strength*2+3';
        const serverEnforced = buildRangeValidator()._resolveMaxRange('ent-range-test', expression).maxRange;
        const clientDisplayed = resolveRange(expression, { 'Physical.strength': 25 }, legacyFormula(25));

        expect(clientDisplayed).toBe(53); // 25*2+3, NOT 50 (the old diverged display)
        expect(clientDisplayed).toBe(serverEnforced);
    });
});

// =========================================================================
// TEST 4 — REGRESSION: expression range resolution includes ALL terms
// =========================================================================

describe('RangeResolver REGRESSION — expression ranges include ALL terms', () => {
    // The original bug: the client's regex parser SKIPPED the trailing `+offset`
    // in expression ranges, so ":Physical.strength*2+3" rendered as 50 (25*2)
    // instead of 53. These tests pin the shared resolver's correct behaviour.
    it('resolves ":Physical.strength*2+3" → 53 (NOT 50, which drops the +3)', () => {
        const resolved = resolveRange(':Physical.strength*2+3', STAT_MAP, NaN);
        expect(resolved).toBe(53);
        expect(resolved).not.toBe(50);
    });

    it('resolves ":Physical.strength*2-5" → 45 (subtraction term included)', () => {
        const resolved = resolveRange(':Physical.strength*2-5', STAT_MAP, NaN);
        expect(resolved).toBe(45);
    });

    it('resolves ":Physical.strength+10" → 35 (additive offset included)', () => {
        const resolved = resolveRange(':Physical.strength+10', STAT_MAP, NaN);
        expect(resolved).toBe(35);
    });

    it('resolves a plain number 100 → 100 (NOT the legacy formula 3 + strength*2 = 53)', () => {
        const resolved = resolveRange(100, STAT_MAP, NaN);
        expect(resolved).toBe(100);
        expect(resolved).not.toBe(legacyFormula(25));
    });
});

// =========================================================================
// TEST 5 — REGRESSION: plain-number range does NOT fall through to legacy formula
// =========================================================================

describe('RangeResolver REGRESSION — plain-number range bypasses the legacy formula', () => {
    // The original bug: a plain-number range (e.g. 100) had no ":Placeholder" tokens,
    // so the old client regex found nothing and fell back to `3 + strength*2`,
    // ignoring the actual range value entirely. This pins the correct behaviour.
    it('resolves plain number 100 to exactly 100', () => {
        const resolved = resolveRange(100, STAT_MAP, NaN);
        expect(resolved).toBe(100);
    });

    it('does NOT equal the legacy formula 3 + strength*2 for strength=25 (53)', () => {
        const resolved = resolveRange(100, STAT_MAP, NaN);
        const legacy = legacyFormula(25);
        expect(legacy).toBe(53); // documents the legacy value being guarded against
        expect(resolved).not.toBe(legacy);
    });

    it('resolves a numeric STRING "100" to exactly 100 (not the legacy formula)', () => {
        // data/actions.json may carry a numeric string; the fast path must still win.
        const resolved = resolveRange('100', STAT_MAP, NaN);
        expect(resolved).toBe(100);
        expect(resolved).not.toBe(legacyFormula(25));
    });
});
