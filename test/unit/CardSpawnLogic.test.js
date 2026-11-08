/**
 * CardSpawnLogic — unit tests (change: a card spawns with its own saved body
 * when a same-named blueprint exists, otherwise the generic M1 blueprint).
 *
 * The readCharaCard reader is stubbed (per TST-2 the seam is tested with a
 * controlled payload) so these tests don't touch a real PNG on disk.
 *
 * @module test/unit/CardSpawnLogic
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readCharaCard } from '../../src/utils/PngCharaReader.js';
import { blueprintForCard, spawnSingleCard, spawnCards } from '../../src/controllers/logic/CardSpawnLogic.js';

// The stub applies to every importer of the reader (including CardSpawnLogic),
// so spawnSingleCard reads the controlled payload instead of a disk PNG.
vi.mock(
    '../../src/utils/PngCharaReader.js',
    () => ({
        readCharaCard: vi.fn()
    })
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
});
