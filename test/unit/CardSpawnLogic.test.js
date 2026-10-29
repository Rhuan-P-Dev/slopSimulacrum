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
import { blueprintForCard, spawnSingleCard } from '../../src/controllers/logic/CardSpawnLogic.js';

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
            spawnEntity: vi.fn(() => 'entity-minako'),
            updateEntitySpatial: vi.fn()
        }
    };
}

// A card payload readCharaCard would return for "Minako".
function minakoCard() {
    return {
        success: true,
        card: {
            name: 'Minako',
            personality: 'friendly',
            description: 'small fox courier'
        }
    };
}

const CARD_FILE = { fullPath: 'data/cards/minako.png', cardId: 'minako' };

describe('CardSpawnLogic', () => {
    describe('blueprintForCard', () => {
        it('returns the card display name when a same-named blueprint exists', () => {
            const facade = {
                entityController: { getBlueprints: vi.fn(() => ({ Minako: ['m1CentralBody'] })) }
            };
            expect(blueprintForCard(facade, 'Minako')).toBe('Minako');
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
            expect(blueprintForCard(facade, 'Minako')).toBe('m1Droid');
        });

        it('falls back when displayName is empty, null, or undefined', () => {
            const facade = {
                entityController: { getBlueprints: vi.fn(() => ({ Minako: ['m1CentralBody'] })) }
            };
            expect(blueprintForCard(facade, '')).toBe('m1Droid');
            expect(blueprintForCard(facade, null)).toBe('m1Droid');
            expect(blueprintForCard(facade, undefined)).toBe('m1Droid');
        });

        it('falls back when the facade has no usable entityController (light test double)', () => {
            expect(blueprintForCard({}, 'Minako')).toBe('m1Droid');
            expect(blueprintForCard({ entityController: {} }, 'Minako')).toBe('m1Droid');
        });

        it('matches by exact name (case-sensitive)', () => {
            const facade = {
                entityController: { getBlueprints: vi.fn(() => ({ Minako: ['m1CentralBody'] })) }
            };
            expect(blueprintForCard(facade, 'minako')).toBe('m1Droid');
        });
    });

    describe('spawnSingleCard', () => {
        afterEach(() => {
            vi.clearAllMocks();
        });

        it('spawns with the card\'s own body when a same-named blueprint exists', async () => {
            readCharaCard.mockReturnValue(minakoCard());
            const facade = makeFacade({ Minako: ['m1CentralBody'], m1Droid: ['m1CentralBody'] });

            const id = await spawnSingleCard(facade, CARD_FILE);

            expect(id).toBe('entity-minako');
            // The entity is spawned with the card-named body, not the generic one.
            expect(facade.stateEntityController.spawnEntity).toHaveBeenCalledWith(
                'Minako',
                'r1',
                expect.anything()
            );
            expect(facade._applyInitialItems).toHaveBeenCalledTimes(1);
            expect(facade._pickFirstSpawnRoom).toHaveBeenCalledTimes(1);
        });

        it('falls back to the generic blueprint when no same-named body exists', async () => {
            readCharaCard.mockReturnValue(minakoCard());
            const facade = makeFacade({ m1Droid: ['m1CentralBody'] });

            const id = await spawnSingleCard(facade, CARD_FILE);

            expect(id).toBe('entity-minako');
            expect(facade.stateEntityController.spawnEntity).toHaveBeenCalledWith(
                'm1Droid',
                'r1',
                expect.anything()
            );
        });

        it('skips the card (returns null) when there is no spawnable room', async () => {
            readCharaCard.mockReturnValue(minakoCard());
            const facade = makeFacade({ m1Droid: ['m1CentralBody'] });
            facade._pickFirstSpawnRoom.mockReturnValue(null);

            const id = await spawnSingleCard(facade, CARD_FILE);

            expect(id).toBe(null);
            expect(facade.stateEntityController.spawnEntity).not.toHaveBeenCalled();
        });
    });
});
