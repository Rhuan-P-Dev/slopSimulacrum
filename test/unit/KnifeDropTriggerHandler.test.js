/**
 * KnifeDropTriggerHandler — unit tests (B1-M3: missing-entry Logger.error guard).
 *
 * Tests the fix:
 *  When itemRegistry[KNIFE_TYPE] is missing/nullish, Logger.error MUST be called
 *  and the handler completes gracefully with a `{}` fallback (no throw).
 *
 * @module test/unit/KnifeDropTriggerHandler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import KnifeDropTriggerHandler from '../../src/controllers/triggers/KnifeDropTriggerHandler.js';
import Logger from '../../src/utils/Logger.js';

// =========================================================================
// Helpers
// =========================================================================

/**
 * Build a minimal WorldStateController stub matching the contract used by
 * KnifeDropTriggerHandler:
 *   - getEntity(id) → entity or undefined
 *   - getItemRegistry() → object mapping item keys to definitions
 *   - getDroppedItems() → object (the dropped-items map)
 *   - setDroppedItems(items) → merges via Object.assign
 */
function buildWSCStub(options = {}) {
    const {
        entity = { id: options.entityId || 'entity-1' },
        registry = { knife: { name: 'Knife', volume: 1, traits: { Physical: { durability: 30 } } } },
        returnEntity = true,
    } = options;

    const droppedItemsMap = {};

    return {
        getEntity: vi.fn((id) => {
            if (returnEntity) return entity;
            return undefined;
        }),
        getItemRegistry: () => registry,
        getDroppedItems: () => droppedItemsMap,
        setDroppedItems: (items) => { Object.assign(droppedItemsMap, items); },
    };
}

const KNIFE_TYPE = 'knife';
const KNIFE_DEF = { name: 'Knife', description: 'A sharp blade.', volume: 1, traits: { Physical: { durability: 30, sharpness: 50 } } };
const PAYLOAD = { position: { x: 10, y: 20 }, roomId: 'room-1', entityId: 'entity-1' };

// =========================================================================
// B1-M3 — Missing-entry case: Logger.error + graceful fallback
// =========================================================================

describe('KnifeDropTriggerHandler — B1-M3 missing-entry guard', () => {
    it('calls Logger.error when knife entry is missing from registry (undefined)', () => {
        const spy = vi.spyOn(Logger, 'error');
        const wsc = buildWSCStub({ registry: {} }); // no knife key
        const handler = new KnifeDropTriggerHandler({ worldStateController: wsc });

        expect(() => handler.handle(PAYLOAD)).not.toThrow();
        expect(spy).toHaveBeenCalledWith(
            expect.stringContaining('[KnifeDropTrigger] Missing knife definition in item registry')
        );
        expect(spy).toHaveBeenCalledWith(
            expect.stringContaining(KNIFE_TYPE)
        );
        spy.mockRestore();
    });

    it('calls Logger.error when knife entry is null in registry', () => {
        const spy = vi.spyOn(Logger, 'error');
        const wsc = buildWSCStub({ registry: { knife: null } });
        const handler = new KnifeDropTriggerHandler({ worldStateController: wsc });

        expect(() => handler.handle(PAYLOAD)).not.toThrow();
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    it('calls Logger.error when knife entry is undefined in registry', () => {
        const spy = vi.spyOn(Logger, 'error');
        const wsc = buildWSCStub({ registry: { knife: undefined } });
        const handler = new KnifeDropTriggerHandler({ worldStateController: wsc });

        expect(() => handler.handle(PAYLOAD)).not.toThrow();
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    it('completes without throwing even when knife entry is missing (graceful degradation)', () => {
        const wsc = buildWSCStub({ registry: {} });
        const handler = new KnifeDropTriggerHandler({ worldStateController: wsc });

        // Should NOT throw — the `{}` fallback ensures graceful degradation
        expect(() => handler.handle(PAYLOAD)).not.toThrow();
    });
});

// =========================================================================
// Happy-path case: knife entry present, Logger.error NOT called
// =========================================================================

describe('KnifeDropTriggerHandler — happy path (knife entry present)', () => {
    it('does NOT call Logger.error when knife entry exists in registry', () => {
        const spy = vi.spyOn(Logger, 'error');
        const wsc = buildWSCStub({ registry: { knife: KNIFE_DEF } });
        const handler = new KnifeDropTriggerHandler({ worldStateController: wsc });

        expect(() => handler.handle(PAYLOAD)).not.toThrow();
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('produces knife drops with expected fields when registry has knife entry', () => {
        const errorSpy = vi.spyOn(Logger, 'error');
        const wsc = buildWSCStub({ registry: { knife: KNIFE_DEF } });
        const handler = new KnifeDropTriggerHandler({ worldStateController: wsc });

        expect(() => handler.handle(PAYLOAD)).not.toThrow();

        // Verify Logger.error was NOT called in happy path
        expect(errorSpy).not.toHaveBeenCalled();

        errorSpy.mockRestore();
    });
});

// =========================================================================
// Despawned entity case (existing behavior — no regression)
// =========================================================================

describe('KnifeDropTriggerHandler — despawned entity skip', () => {
    it('returns early without dropping when entity is not found', () => {
        const wsc = buildWSCStub({ returnEntity: false });
        const handler = new KnifeDropTriggerHandler({ worldStateController: wsc });

        expect(() => handler.handle(PAYLOAD)).not.toThrow();
    });
});
