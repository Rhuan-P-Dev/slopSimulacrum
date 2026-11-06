/**
 * UNIT TEST — WorldProposalValidator: the rules a wish must pass before it may be written.
 *
 * The controller tests cover the conversational path (a refusal goes back to the model);
 * this file pins the rules themselves, because they are the boundary between "an operator
 * asked" and "bytes land in data/mods/": the id the server owns, the kind allowlist that
 * keeps the map out of it, the caps that keep one proposal from becoming a world dump, the
 * unsafe keys, and the override report that makes shadowing official content visible.
 *
 * The live definition is a `RegistryStore` of a handful of entries, so the composition
 * check runs for real (`TST-3`: no provider, no world boot).
 *
 * @module test/unit/WorldProposalValidator
 */

import { describe, it, expect } from 'vitest';
import validateProposal, {
    ProposalValidationError,
    normalizePackageId,
    AUTHORABLE_KINDS,
    NON_AUTHORABLE_KINDS,
    PROPOSAL_LIMITS
} from '../../src/services/WorldProposalValidator.js';
import RegistryStore from '../../src/services/RegistryStore.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';

function makeStore() {
    return new RegistryStore({
        [REGISTRY_KINDS.MATERIALS]: { steel: { name: 'Steel', density: 7.8, properties: {} } },
        [REGISTRY_KINDS.COMPONENTS]: { hull: { name: 'Hull', form: { volume: 4 }, materials: [{ material: 'steel', fraction: 1 }] } }
    });
}

/** Validate or return the rule list (so a test reads as one expectation). */
function rulesOf(proposal) {
    try {
        validateProposal(proposal, { registryStore: makeStore() });
        return null;
    } catch (error) {
        if (error instanceof ProposalValidationError) return error.errors;
        throw error;
    }
}

function plate() {
    return { name: 'Salvage Plate', form: { volume: 2 }, materials: [{ material: 'steel', fraction: 1 }] };
}

describe('normalizePackageId — the server owns the identity', () => {
    it('prefixes a bare slug and leaves an already-prefixed one alone', () => {
        expect(normalizePackageId('salvage-plate')).toBe(`system-salvage-plate`);
        expect(normalizePackageId('system-salvage-plate')).toBe('system-salvage-plate');
        expect(normalizePackageId('  Salvage-Plate ')).toBe('system-salvage-plate');
    });

    it('refuses a slug that is not a slug, and never rewrites one into a different name', () => {
        expect(() => normalizePackageId('My Cool Droids!!')).toThrow(ProposalValidationError);
        expect(() => normalizePackageId('../escape')).toThrow(ProposalValidationError);
        expect(() => normalizePackageId('')).toThrow(ProposalValidationError);
        expect(() => normalizePackageId(null)).toThrow(ProposalValidationError);
    });
});

describe('validateProposal — the kind allowlist', () => {
    it('refuses every world structure kind, and names it', () => {
        for (const kind of NON_AUTHORABLE_KINDS) {
            const errors = rulesOf({ packageId: 'x', description: 'd', content: { [kind]: { one: {} } } });
            expect(errors?.length).toBeGreaterThan(0);
            expect(errors.join(' ')).toContain('world structure');
        }
    });

    it('refuses a kind the vocabulary does not know', () => {
        expect(rulesOf({ packageId: 'x', description: 'd', content: { dragons: { one: {} } } }).join(' '))
            .toContain('not a registry kind');
    });

    it('accepts an authorable kind', () => {
        const proposal = validateProposal(
            { packageId: 'plate', description: 'A plate.', content: { [REGISTRY_KINDS.COMPONENTS]: { salvagePlate: plate() } } },
            { registryStore: makeStore() }
        );
        expect(proposal.packageId).toBe('system-plate');
        expect(proposal.added).toEqual([{ kind: REGISTRY_KINDS.COMPONENTS, key: 'salvagePlate' }]);
        expect(proposal.overrides).toEqual([]);
        expect(AUTHORABLE_KINDS.length).toBeGreaterThan(0);
    });
});

describe('validateProposal — the caps and the unsafe keys', () => {
    it('refuses no description, no content, and an empty kind', () => {
        expect(rulesOf({ packageId: 'x', content: { [REGISTRY_KINDS.COMPONENTS]: { a: {} } } }).join(' ')).toContain('description');
        expect(rulesOf({ packageId: 'x', description: 'd' }).join(' ')).toContain('content');
        expect(rulesOf({ packageId: 'x', description: 'd', content: { [REGISTRY_KINDS.COMPONENTS]: {} } }).join(' '))
            .toContain('at least one definition');
    });

    it('refuses more kinds, more definitions, deeper nesting and more bytes than the caps', () => {
        const manyKinds = Object.fromEntries(
            AUTHORABLE_KINDS.slice(0, PROPOSAL_LIMITS.MAX_KINDS + 1).map((kind) => [kind, { a: {} }])
        );
        expect(rulesOf({ packageId: 'x', description: 'd', content: manyKinds }).join(' ')).toContain('is the cap');

        const tooManyDefinitions = {};
        for (let i = 0; i <= PROPOSAL_LIMITS.MAX_DEFINITIONS_PER_KIND; i++) tooManyDefinitions[`k${i}`] = {};
        expect(rulesOf({ packageId: 'x', description: 'd', content: { [REGISTRY_KINDS.COMPONENTS]: tooManyDefinitions } }).join(' '))
            .toContain('is the cap');

        let deep = { leaf: 1 };
        for (let i = 0; i < PROPOSAL_LIMITS.MAX_DEFINITION_DEPTH; i++) deep = { n: deep };
        expect(rulesOf({ packageId: 'x', description: 'd', content: { [REGISTRY_KINDS.COMPONENTS]: { deep } } }).join(' '))
            .toContain('nests deeper');

        expect(rulesOf({ packageId: 'x', description: 'x'.repeat(PROPOSAL_LIMITS.MAX_DESCRIPTION_CHARS + 1), content: { [REGISTRY_KINDS.COMPONENTS]: { a: {} } } }).join(' '))
            .toContain('description');
    });

    it('refuses the unsafe keys at any depth, and nothing half-written survives', () => {
        const poisoned = JSON.parse(`{"${REGISTRY_KINDS.COMPONENTS}":{"__proto__":{"bad":true}}}`);
        expect(rulesOf({ packageId: 'x', description: 'd', content: poisoned }).join(' ')).toContain('not a data key');
        expect(rulesOf({
            packageId: 'x',
            description: 'd',
            content: { [REGISTRY_KINDS.COMPONENTS]: { plate: { nested: { prototype: {} } } } }
        }).join(' ')).toContain('not a data key');
        // A definition KEY named for the prototype chain is the same poison, one level up.
        expect(rulesOf({
            packageId: 'x',
            description: 'd',
            content: { [REGISTRY_KINDS.COMPONENTS]: { constructor: { name: 'Anywhere' } } }
        }).join(' ')).toContain('not a data key');
    });
});

describe('validateProposal — against the world the operator is running', () => {
    it('reports a redefinition of shipped content as an override, not as a new key', () => {
        const proposal = validateProposal({
            packageId: 'bigger-hull',
            description: 'A bigger hull.',
            content: { [REGISTRY_KINDS.COMPONENTS]: { hull: { name: 'Hull', form: { volume: 9 }, materials: [{ material: 'steel', fraction: 1 }] } } }
        }, { registryStore: makeStore() });
        expect(proposal.overrides).toEqual([{ kind: REGISTRY_KINDS.COMPONENTS, key: 'hull' }]);
        expect(proposal.added).toEqual([]);
    });

    it('refuses a definition the world\'s own composition rules refuse, quoting the owner\'s reason', () => {
        const errors = rulesOf({
            packageId: 'ghost-plate',
            description: 'A plate of nothing.',
            content: { [REGISTRY_KINDS.COMPONENTS]: { ghostPlate: { name: 'Ghost', materials: [{ material: 'unobtainium', fraction: 1 }] } } }
        });
        expect(errors.join(' ')).toMatch(/Unknown material "unobtainium"/);
    });

    it('returns a frozen, canonical value with kinds in registry order', () => {
        const proposal = validateProposal({
            packageId: 'two',
            description: 'Two kinds.',
            rationale: 'Because.',
            content: {
                [REGISTRY_KINDS.INVENTORY_ITEMS]: {
                    scrapBin: { name: 'Scrap Bin', form: { volume: 1 }, materials: [{ material: 'steel', fraction: 1 }] }
                },
                [REGISTRY_KINDS.COMPONENTS]: { salvagePlate: plate() }
            }
        }, { registryStore: makeStore() });
        expect(Object.isFrozen(proposal)).toBe(true);
        expect(Object.keys(proposal.content)).toEqual([REGISTRY_KINDS.COMPONENTS, REGISTRY_KINDS.INVENTORY_ITEMS]);
        expect(proposal.stats).toEqual({ kinds: 2, definitions: 2 });
        expect(proposal.rationale).toBe('Because.');
        // Frozen content: a caller cannot edit the proposal after it was shown.
        expect(Object.isFrozen(proposal.content[REGISTRY_KINDS.COMPONENTS])).toBe(true);
    });
});
