/**
 * CardSpawnLogic — unit tests (change: a card spawns with its own saved body
 * when a same-named blueprint exists, otherwise the generic M1 blueprint).
 *
 * The readCharaCard reader is stubbed (per TST-2 the seam is tested with a
 * controlled payload) so these tests don't touch a real PNG on disk.
 *
 * @module test/unit/CardSpawnLogic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readCharaCard } from '../../src/utils/PngCharaReader.js';
import { readFreshCardUserRelationship } from '../../src/utils/CardRelationshipStore.js';
import { blueprintForCard, spawnSingleCard, spawnCards } from '../../src/controllers/logic/CardSpawnLogic.js';

// The stub applies to every importer of the reader (including CardSpawnLogic),
// so spawnSingleCard reads the controlled payload instead of a disk PNG.
vi.mock(
    '../../src/utils/PngCharaReader.js',
    () => ({
        readCharaCard: vi.fn()
    })
);

// The seam's freshness read is the one outside this file's scope: it returns
// "no fresh judgment" by default (the normal state), so every pre-existing
// test in this file runs with the attachment feature byte-identically off.
vi.mock(
    '../../src/utils/CardRelationshipStore.js',
    async (importOriginal) => {
        const actual = await importOriginal();
        return { ...actual, readFreshCardUserRelationship: vi.fn(() => null) };
    }
);

/**
 * A light facade double that exposes just what spawnSingleCard / blueprintForCard
 * reach into.
 * @param {Object<string, *>} [blueprints] - value returned by entityController.getBlueprints.
 */
function makeFacade(blueprints) {
    return {
        entityController: {
            getBlueprints: vi.fn(() => blueprints)
        },
        _buildCardProfile: vi.fn(() => ({
            personality: 'friendly',
            maxWorldActionsPerRound: 2,
            maxChatMessagesPerRound: 1,
            initialItems: []
        })),
        _pickFirstSpawnRoom: vi.fn(() => ({ uid: 'r1', name: 'Hub', width: 10, height: 10 })),
        _roomRandomPoint: vi.fn(() => ({ x: 1, y: 1 })),
        _applyInitialItems: vi.fn(),
        stateEntityController: {
            spawnEntity: vi.fn(() => 'entity-nova'),
            updateEntitySpatial: vi.fn()
        }
    };
}

// A card payload readCharaCard would return for "Nova".
function novaCard() {
    return {
        success: true,
        card: {
            name: 'Nova',
            personality: 'friendly',
            description: 'small fox courier'
        }
    };
}

const CARD_FILE = { fullPath: 'data/cards/nova.png', cardId: 'nova' };

describe('CardSpawnLogic', () => {
    describe('blueprintForCard', () => {
        it('returns the card display name when a same-named blueprint exists', () => {
            const facade = {
                entityController: { getBlueprints: vi.fn(() => ({ Nova: ['m1CentralBody'] })) }
            };
            expect(blueprintForCard(facade, 'Nova')).toBe('Nova');
        });

        it('falls back to the generic blueprint when no same-named blueprint exists', () => {
            const facade = {
                entityController: {
                    getBlueprints: vi.fn(() => ({
                        m1Droid: ['m1CentralBody'],
                        m1CentralBody: ['m1Head']
                    }))
                }
            };
            expect(blueprintForCard(facade, 'Nova')).toBe('m1Droid');
        });

        it('falls back when displayName is empty, null, or undefined', () => {
            const facade = {
                entityController: { getBlueprints: vi.fn(() => ({ Nova: ['m1CentralBody'] })) }
            };
            expect(blueprintForCard(facade, '')).toBe('m1Droid');
            expect(blueprintForCard(facade, null)).toBe('m1Droid');
            expect(blueprintForCard(facade, undefined)).toBe('m1Droid');
        });

        it('falls back when the facade has no usable entityController (light test double)', () => {
            expect(blueprintForCard({}, 'Nova')).toBe('m1Droid');
            expect(blueprintForCard({ entityController: {} }, 'Nova')).toBe('m1Droid');
        });

        it('matches by exact name (case-sensitive)', () => {
            const facade = {
                entityController: { getBlueprints: vi.fn(() => ({ Nova: ['m1CentralBody'] })) }
            };
            expect(blueprintForCard(facade, 'nova')).toBe('m1Droid');
        });
    });

    describe('spawnSingleCard', () => {
        afterEach(() => {
            vi.clearAllMocks();
        });

        it('spawns with the card\'s own body when a same-named blueprint exists', async () => {
            readCharaCard.mockReturnValue(novaCard());
            const facade = makeFacade({ Nova: ['m1CentralBody'], m1Droid: ['m1CentralBody'] });

            const id = await spawnSingleCard(facade, CARD_FILE);

            expect(id).toBe('entity-nova');
            // The entity is spawned with the card-named body, not the generic one.
            expect(facade.stateEntityController.spawnEntity).toHaveBeenCalledWith(
                'Nova',
                'r1',
                expect.anything()
            );
            expect(facade._applyInitialItems).toHaveBeenCalledTimes(1);
            expect(facade._pickFirstSpawnRoom).toHaveBeenCalledTimes(1);
        });

        it('falls back to the generic blueprint when no same-named body exists', async () => {
            readCharaCard.mockReturnValue(novaCard());
            const facade = makeFacade({ m1Droid: ['m1CentralBody'] });

            const id = await spawnSingleCard(facade, CARD_FILE);

            expect(id).toBe('entity-nova');
            expect(facade.stateEntityController.spawnEntity).toHaveBeenCalledWith(
                'm1Droid',
                'r1',
                expect.anything()
            );
        });

        it('skips the card (returns null) when there is no spawnable room', async () => {
            readCharaCard.mockReturnValue(novaCard());
            const facade = makeFacade({ m1Droid: ['m1CentralBody'] });
            facade._pickFirstSpawnRoom.mockReturnValue(null);

            const id = await spawnSingleCard(facade, CARD_FILE);

            expect(id).toBe(null);
            expect(facade.stateEntityController.spawnEntity).not.toHaveBeenCalled();
        });

        it('spawns a bound card with the resolved user in its npcConfig', async () => {
            readCharaCard.mockReturnValue(novaCard());
            const facade = makeFacade({ Nova: ['m1CentralBody'] });

            await spawnSingleCard(facade, CARD_FILE, { cardId: 'Rin', name: 'Rin' });

            const profile = facade.stateEntityController.spawnEntity.mock.calls[0][2];
            expect(profile.npcConfig.userCardId).toBe('Rin');
            expect(profile.npcConfig.userName).toBe('Rin');
        });

        it('spawns an unbound card with no user fields in its npcConfig', async () => {
            readCharaCard.mockReturnValue(novaCard());
            const facade = makeFacade({ Nova: ['m1CentralBody'] });

            await spawnSingleCard(facade, CARD_FILE);

            const profile = facade.stateEntityController.spawnEntity.mock.calls[0][2];
            expect(profile.npcConfig.userCardId).toBeUndefined();
            expect(profile.npcConfig.userName).toBeUndefined();
        });
    });

    /**
     * The subset a "create world" request chooses.
     *
     * The claim worth pinning is not that filtering works but *where* it happens:
     * the chosen ids narrow the listing, so the spawn order stays the card-file
     * order and never the order the browser sent its checkboxes (`CR D-1`). A
     * request that names nothing is not a filter, it is "every card" - boot's
     * behavior - and `[]` is its opposite, not the same thing.
     */
    describe('spawnCards with a chosen subset', () => {
        /** A facade whose only job is the listing and the spawn spy. */
        function listingFacade(cardIds) {
            const spawned = [];
            return {
                spawned,
                _readCardFiles: () => cardIds.map((cardId) => ({ cardId, fullPath: `data/cards/${cardId}.png` })),
                _spawnSingleCard: (cardFile) => {
                    spawned.push(cardFile.cardId);
                    return `entity-${cardFile.cardId}`;
                }
            };
        }

        it('spawns only the chosen cards, in card-file order whatever the request order was', () => {
            const facade = listingFacade(['a', 'b', 'c']);
            const report = spawnCards(facade, { only: ['c', 'a'] });

            expect(facade.spawned).toEqual(['a', 'c']);
            expect(report).toEqual({ total: 2, spawned: 2, entities: [{ cardId: 'a', entityId: 'entity-a' }, { cardId: 'c', entityId: 'entity-c' }] });
        });

        it('spawns every card file when no subset was given (boot)', () => {
            const facade = listingFacade(['a', 'b']);
            expect(spawnCards(facade).total).toBe(2);
            expect(facade.spawned).toEqual(['a', 'b']);
        });

        it('spawns nothing when the subset is empty, and says so with zeroes', () => {
            const facade = listingFacade(['a', 'b']);
            const report = spawnCards(facade, { only: [] });

            expect(facade.spawned).toEqual([]);
            expect(report).toEqual({ total: 0, spawned: 0, entities: [] });
        });

        it('reports the cards it tried, not the ones it skipped: a null spawn is counted, not listed', () => {
            const facade = listingFacade(['a', 'b']);
            facade._spawnSingleCard = (cardFile) => (cardFile.cardId === 'a' ? null : `entity-${cardFile.cardId}`);

            const report = spawnCards(facade);
            expect(report.total).toBe(2);
            expect(report.entities).toEqual([{ cardId: 'b', entityId: 'entity-b' }]);
        });
    });

    describe('spawnCards with a user mapping ({{user}} -> another card)', () => {
        /**
         * A facade whose spawn spy records the user handed to each card, and
         * whose listing is the ids we name.
         * @param {string[]} cardIds
         */
        function bindingFacade(cardIds) {
            const seen = [];
            return {
                seen,
                _readCardFiles: () => cardIds.map((cardId) => ({ cardId, fullPath: `data/cards/${cardId}.png` })),
                _spawnSingleCard: (cardFile, user) => {
                    seen.push({ cardId: cardFile.cardId, user });
                    return `entity-${cardFile.cardId}`;
                }
            };
        }

        /** Resolve a target's display name from the controlled reader. */
        function mockTargetNames() {
            readCharaCard.mockImplementation((fullPath) => {
                const id = String(fullPath).split('/').pop().replace(/\.png$/, '');
                return { success: true, card: { name: `Name-${id}`, personality: 'p', description: 'd' } };
            });
        }

        it('hands each bound card its resolved target name and reports the applied bindings', () => {
            mockTargetNames();
            const facade = bindingFacade(['a', 'b']);

            const report = spawnCards(facade, { only: ['a', 'b'], users: { a: 'b' } });

            expect(facade.seen).toEqual([
                { cardId: 'a', user: { cardId: 'b', name: 'Name-b' } },
                { cardId: 'b', user: null }
            ]);
            expect(report.users).toEqual({ a: { cardId: 'b', name: 'Name-b' } });
        });

        it('leaves the report without a users key when nothing was bound', () => {
            const facade = bindingFacade(['a', 'b']);

            const report = spawnCards(facade, { only: ['a', 'b'] });

            expect(report.users).toBeUndefined();
        });

        it('resolves a shared target once, even when several cards bind to it', () => {
            mockTargetNames();
            const facade = bindingFacade(['a', 'b', 'c']);

            const report = spawnCards(facade, { only: ['a', 'b', 'c'], users: { a: 'c', b: 'c' } });

            const readsOfC = readCharaCard.mock.calls.filter(([p]) => String(p).endsWith('c.png')).length;
            expect(readsOfC).toBe(1);
            expect(report.users).toEqual({ a: { cardId: 'c', name: 'Name-c' }, b: { cardId: 'c', name: 'Name-c' } });
        });
    });

    // =========================================================================
    // The judged {{user}} relationship of a bound source attaches to the
    // target card at world create (wiki/decisions/card-user-relationship-context.md).
    // =========================================================================
    describe('spawnCards with the judged relationship of the bound source', () => {
        beforeEach(() => {
            readFreshCardUserRelationship.mockReset();
            readFreshCardUserRelationship.mockReturnValue(null);
            readCharaCard.mockImplementation((fullPath) => {
                const id = String(fullPath).split('/').pop().replace(/\.png$/, '');
                return { success: true, card: { name: `Name-${id}`, personality: 'p', description: 'd' } };
            });
        });

        afterEach(() => {
            readFreshCardUserRelationship.mockReset();
        });

        /** A facade that holds the spawned entities in a mutable npcConfig map. */
        function relationshipFacade(cardIds) {
            const entities = {};
            for (const cardId of cardIds) {
                entities[`entity-${cardId}`] = { id: `entity-${cardId}`, name: `Name-${cardId}`, npcConfig: {} };
            }
            return {
                _readCardFiles: () => cardIds.map((cardId) => ({ cardId, fullPath: `data/cards/${cardId}.png` })),
                _spawnSingleCard: (cardFile) => `entity-${cardFile.cardId}`,
                stateEntityController: { getEntity: (id) => entities[id] || null },
                _entities: entities
            };
        }

        it('the fresh verdict of the bound source is attached to the target\'s npcConfig (the target is the card the source\'s {{user}} became)', () => {
            readFreshCardUserRelationship.mockReturnValue({
                cardId: 'nova',
                name: 'Nova (card payload name)',
                label: 'devoted partner',
                summary: 'Nova adores you.',
                judgedAt: '2026-07-20T12:00:00.000Z'
            });
            const facade = relationshipFacade(['nova', 'rin']);

            const report = spawnCards(facade, { users: { nova: 'rin' } });

            // the TARGET ("rin") carries the source's verdict; the name is the
            // source's WORLD name (the spawned entity's), not the card payload's
            expect(facade._entities['entity-rin'].npcConfig.userRelationships).toEqual([
                { cardId: 'nova', name: 'Name-nova', label: 'devoted partner', summary: 'Nova adores you.' }
            ]);
            // the source itself carries no relationship fact (it has the binding,
            // not the relationship)
            expect(facade._entities['entity-nova'].npcConfig.userRelationships).toBeUndefined();
            // the report keeps the users shape this feature was built on
            expect(report.users).toEqual({ nova: { cardId: 'rin', name: 'Name-rin' } });
            // one freshness read per bound source, with that source's payload
            expect(readFreshCardUserRelationship).toHaveBeenCalledTimes(1);
            expect(readFreshCardUserRelationship).toHaveBeenCalledWith(
                expect.anything(),
                'nova',
                { name: 'Name-nova', personality: 'p', description: 'd' }
            );
        });

        it('a never-judged (or stale) source attaches nothing: the target stays byte-identical to before', () => {
            const facade = relationshipFacade(['nova', 'rin']);

            spawnCards(facade, { users: { nova: 'rin' } });

            expect('userRelationships' in facade._entities['entity-rin'].npcConfig).toBe(false);
            expect(readFreshCardUserRelationship).toHaveBeenCalledTimes(1); // it was read, and rejected
        });

        it('two bound sources to one target: both verdicts attach, in binding order', () => {
            readFreshCardUserRelationship.mockImplementation((_dir, id) => (id === 'nova'
                ? { cardId: 'nova', name: 'N', label: 'devoted partner', summary: 'a.' }
                : { cardId: 'yui', name: 'Y', label: 'rival', summary: 'b.' }));
            const facade = relationshipFacade(['nova', 'yui', 'rin']);

            spawnCards(facade, { users: { nova: 'rin', yui: 'rin' } });

            expect(facade._entities['entity-rin'].npcConfig.userRelationships).toEqual([
                { cardId: 'nova', name: 'Name-nova', label: 'devoted partner', summary: 'a.' },
                { cardId: 'yui', name: 'Name-yui', label: 'rival', summary: 'b.' }
            ]);
        });

        it('a bound source that did not spawn attaches nothing and is never read', () => {
            readFreshCardUserRelationship.mockReturnValue({ cardId: 'nova', name: 'N', label: 'l', summary: 's' });
            const facade = relationshipFacade(['rin']); // only the target spawned

            spawnCards(facade, { users: { nova: 'rin' } });

            expect('userRelationships' in facade._entities['entity-rin'].npcConfig).toBe(false);
            expect(readFreshCardUserRelationship).not.toHaveBeenCalled();
        });

        it('a bound target that did not spawn attaches nothing and the source is never read', () => {
            readFreshCardUserRelationship.mockReturnValue({ cardId: 'nova', name: 'N', label: 'l', summary: 's' });
            const facade = relationshipFacade(['nova']); // only the source spawned

            spawnCards(facade, { users: { nova: 'rin' } });

            expect('userRelationships' in facade._entities['entity-nova'].npcConfig).toBe(false);
            expect(readFreshCardUserRelationship).not.toHaveBeenCalled();
        });

        it('a facade without a state entity store (a light double) does not attach and does not throw', () => {
            readFreshCardUserRelationship.mockReturnValue({ cardId: 'nova', name: 'N', label: 'l', summary: 's' });
            const facade = {
                _readCardFiles: () => [
                    { cardId: 'nova', fullPath: 'data/cards/nova.png' },
                    { cardId: 'rin', fullPath: 'data/cards/rin.png' }
                ],
                _spawnSingleCard: (cardFile) => `entity-${cardFile.cardId}`
            };

            const report = spawnCards(facade, { users: { nova: 'rin' } });

            expect(report.users).toEqual({ nova: { cardId: 'rin', name: 'Name-rin' } });
            expect(readFreshCardUserRelationship).not.toHaveBeenCalled();
        });

        it('without a user mapping the attachment path is never entered', () => {
            const facade = relationshipFacade(['nova', 'rin']);

            spawnCards(facade);

            expect(readFreshCardUserRelationship).not.toHaveBeenCalled();
            expect('userRelationships' in facade._entities['entity-nova'].npcConfig).toBe(false);
        });
    });
});
