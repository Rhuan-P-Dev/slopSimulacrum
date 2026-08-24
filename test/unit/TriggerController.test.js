/**
 * TriggerController — unit tests (B1-M1: fractional-crossing semantics).
 *
 * Builds the TriggerController directly (without heavy WorldComposition / facade),
 * with spy handlers to capture emissions. Follows convention of `test/unit/DiskSampler.test.js`.
 *
 * Scope B1-M1: spec §3.1 — crossing is oldValue > 0 && newValue <= 0 (threshold = 0).
 * FRACTIONAL values (e.g. 2 → 0.5) DO NOT trigger break.
 *
 * @module test/unit/TriggerController
 */

import { describe, it, expect, vi } from 'vitest';
import TriggerController from '../../src/controllers/triggers/TriggerController.js';
import Logger from '../../src/utils/Logger.js';

// =========================================================================
// Helpers
// =========================================================================

/**
 * Creates a controller with a spy handler registered for 'component:broke'.
 */
function buildWithSpy() {
    const controller = new TriggerController();
    const spy = vi.fn();
    controller.on('component:broke', spy);
    return { controller, spy };
}

// =========================================================================
// B1-M1: fractional-crossing semantics — component entry point
// =========================================================================

describe('TriggerController — B1-M1 fractional-crossing (component entry point)', () => {

    it('(a) 2 → 0.5 emits NO break event (fractional, both-positive)', () => {
        const { controller, spy } = buildWithSpy();
        controller.onComponentBrokeCheck('comp-1', 'entity-1', 2, 0.5, {
            roomId: 'room-1',
            position: { x: 0, y: 0 },
            tick: 1
        });
        expect(spy).not.toHaveBeenCalled();
    });

    it('(d) 0.5 → 0.2 emits NO break event (both-positive, no crossing)', () => {
        const { controller, spy } = buildWithSpy();
        controller.onComponentBrokeCheck('comp-1', 'entity-1', 0.5, 0.2, {
            roomId: 'room-1',
            position: { x: 0, y: 0 },
            tick: 1
        });
        expect(spy).not.toHaveBeenCalled();
    });

    it('(b) 0.5 → 0 emits exactly ONE break event (crossing from positive to zero)', () => {
        const { controller, spy } = buildWithSpy();
        controller.onComponentBrokeCheck('comp-1', 'entity-1', 0.5, 0, {
            roomId: 'room-1',
            position: { x: 1, y: 2 },
            componentId: 'comp-1',
            componentType: 'testComponent',
            componentIdentifier: 'left',
            tick: 42
        });
        expect(spy).toHaveBeenCalledTimes(1);
        const payload = spy.mock.calls[0][0];
        expect(payload.event).toBe('component:broke');
        expect(payload).toMatchObject({
            entityId: 'entity-1',
            componentId: 'comp-1',
            kind: 'component',
            prevValue: 0.5,
            value: 0,
            tick: 42
        });
    });

    it('(c) 1 → 0 emits exactly ONE break event (canonical integer crossing)', () => {
        const { controller, spy } = buildWithSpy();
        controller.onComponentBrokeCheck('comp-1', 'entity-1', 1, 0, {
            roomId: 'room-1',
            position: { x: 0, y: 0 },
            tick: 7
        });
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('Regression: 10 → -5 emits exactly ONE break event (large negative crossing)', () => {
        const { controller, spy } = buildWithSpy();
        controller.onComponentBrokeCheck('comp-1', 'entity-1', 10, -5, {
            roomId: 'room-1',
            position: { x: 0, y: 0 },
            tick: 3
        });
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('No false positive: 0 → -1 (already at threshold, no crossing from positive)', () => {
        const { controller, spy } = buildWithSpy();
        controller.onComponentBrokeCheck('comp-1', 'entity-1', 0, -1, {
            roomId: 'room-1',
            position: { x: 0, y: 0 },
            tick: 3
        });
        expect(spy).not.toHaveBeenCalled();
    });

    it('No false positive: -1 → -5 (already broken, no crossing from positive)', () => {
        const { controller, spy } = buildWithSpy();
        controller.onComponentBrokeCheck('comp-1', 'entity-1', -1, -5, {
            roomId: 'room-1',
            position: { x: 0, y: 0 },
            tick: 3
        });
        expect(spy).not.toHaveBeenCalled();
    });

    it('No false positive: 0 → 0 (no change at threshold)', () => {
        const { controller, spy } = buildWithSpy();
        controller.onComponentBrokeCheck('comp-1', 'entity-1', 0, 0, {
            roomId: 'room-1',
            position: { x: 0, y: 0 },
            tick: 3
        });
        expect(spy).not.toHaveBeenCalled();
    });

    it('No false positive: 0.001 → 0.0005 (both-positive, tiny fractional drop)', () => {
        const { controller, spy } = buildWithSpy();
        controller.onComponentBrokeCheck('comp-1', 'entity-1', 0.001, 0.0005, {
            roomId: 'room-1',
            position: { x: 0, y: 0 },
            tick: 3
        });
        expect(spy).not.toHaveBeenCalled();
    });
});

// =========================================================================
// B1-M1: fractional-crossing semantics — equipped-item entry point
// =========================================================================

describe('TriggerController — B1-M1 fractional-crossing (equipped-item entry point)', () => {

    it('(a) 2 → 0.5 emits NO break event (fractional, both-positive)', () => {
        const { controller, spy } = buildWithSpy();
        controller.onEquippedItemBrokeCheck('eq-1', 'entity-1', 'comp-1', 2, 0.5, {
            roomId: 'room-1',
            position: { x: 0, y: 0 },
            tick: 1
        });
        expect(spy).not.toHaveBeenCalled();
    });

    it('(b) 0.5 → 0 emits exactly ONE break event (crossing from positive to zero)', () => {
        const { controller, spy } = buildWithSpy();
        controller.onEquippedItemBrokeCheck('eq-1', 'entity-1', 'comp-1', 0.5, 0, {
            roomId: 'room-1',
            position: { x: 1, y: 2 },
            itemType: 'knife',
            tick: 42
        });
        expect(spy).toHaveBeenCalledTimes(1);
        const payload = spy.mock.calls[0][0];
        expect(payload.event).toBe('component:broke');
        expect(payload.kind).toBe('equipped-item');
        expect(payload.eqId).toBe('eq-1');
        expect(payload.prevValue).toBe(0.5);
        expect(payload.value).toBe(0);
    });

    it('(c) 1 → 0 emits exactly ONE break event (canonical integer crossing)', () => {
        const { controller, spy } = buildWithSpy();
        controller.onEquippedItemBrokeCheck('eq-1', 'entity-1', 'comp-1', 1, 0, {
            roomId: 'room-1',
            position: { x: 0, y: 0 },
            tick: 7
        });
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('(d) 0.5 → 0.2 emits NO break event (both-positive, no crossing)', () => {
        const { controller, spy } = buildWithSpy();
        controller.onEquippedItemBrokeCheck('eq-1', 'entity-1', 'comp-1', 0.5, 0.2, {
            roomId: 'room-1',
            position: { x: 0, y: 0 },
            tick: 1
        });
        expect(spy).not.toHaveBeenCalled();
    });

    it('No false positive: 0 → -1 (already at threshold, no crossing from positive)', () => {
        const { controller, spy } = buildWithSpy();
        controller.onEquippedItemBrokeCheck('eq-1', 'entity-1', 'comp-1', 0, -1, {
            roomId: 'room-1',
            position: { x: 0, y: 0 },
            tick: 3
        });
        expect(spy).not.toHaveBeenCalled();
    });

    it('No false positive: -2 → -5 (already broken)', () => {
        const { controller, spy } = buildWithSpy();
        controller.onEquippedItemBrokeCheck('eq-1', 'entity-1', 'comp-1', -2, -5, {
            roomId: 'room-1',
            position: { x: 0, y: 0 },
            tick: 3
        });
        expect(spy).not.toHaveBeenCalled();
    });
});

// =========================================================================
// Edge: no handlers registered (fallback to broadcaster)
// =========================================================================

describe('TriggerController — no-handler fallback', () => {
    it('emit() calls _broadcaster when no handlers registered', () => {
        const controller = new TriggerController();
        const broadcasterSpy = vi.fn();
        controller.setBroadcaster(broadcasterSpy);
        controller.emit('component:broke', { test: true });
        expect(broadcasterSpy).toHaveBeenCalledTimes(1);
    });

    it('emit() does NOT call _broadcaster when handlers ARE registered (even if empty spy)', () => {
        const { controller, spy } = buildWithSpy();
        const broadcasterSpy = vi.fn();
        controller.setBroadcaster(broadcasterSpy);
        controller.emit('component:broke', { test: true });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(broadcasterSpy).not.toHaveBeenCalled();
    });
});

// =========================================================================
// B1-M2: nullish coalescing (??) vs logical OR (||) — falsy preservation + Logger.warn
// =========================================================================

describe('TriggerController — B1-M2 nullish coalescing (??) regression tests', () => {

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    // --- roomId: '' preservation (the || → ?? regression) ---

    it('roomId: "" (falsy but defined) is preserved in payload (NOT replaced by default)', () => {
        const spy = vi.fn();
        const controller = new TriggerController();
        controller.on('component:broke', spy);

        controller.onComponentBrokeCheck('comp-1', 'entity-1', 1, 0, {
            roomId: '',
            position: { x: 5, y: 10 },
            tick: 1
        });

        expect(spy).toHaveBeenCalledTimes(1);
        const payload = spy.mock.calls[0][0];
        expect(payload.roomId).toBe('');
    });

    it('roomId: undefined → default null AND Logger.warn called', () => {
        const warnSpy = vi.spyOn(Logger, 'warn').mockReturnThis();
        const spy = vi.fn();
        const controller = new TriggerController();
        controller.on('component:broke', spy);

        controller.onComponentBrokeCheck('comp-1', 'entity-1', 1, 0, {
            position: { x: 0, y: 0 },
            tick: 1
        });

        expect(spy).toHaveBeenCalledTimes(1);
        const payload = spy.mock.calls[0][0];
        expect(payload.roomId).toBe(null);
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('[TriggerController] Missing roomId anchor'),
            expect.objectContaining({ componentId: 'comp-1', entityId: 'entity-1' })
        );
        warnSpy.mockRestore();
    });

    // --- position preservation ---

    it('A defined position object is preserved in payload', () => {
        const spy = vi.fn();
        const controller = new TriggerController();
        controller.on('component:broke', spy);

        controller.onComponentBrokeCheck('comp-1', 'entity-1', 1, 0, {
            roomId: 'room-x',
            position: { x: 42, y: 99 },
            tick: 1
        });

        expect(spy).toHaveBeenCalledTimes(1);
        const payload = spy.mock.calls[0][0];
        expect(payload.position).toEqual({ x: 42, y: 99 });
    });

    it('position: undefined → default {x:0,y:0} AND Logger.warn called', () => {
        const warnSpy = vi.spyOn(Logger, 'warn').mockReturnThis();
        const spy = vi.fn();
        const controller = new TriggerController();
        controller.on('component:broke', spy);

        controller.onComponentBrokeCheck('comp-1', 'entity-1', 1, 0, {
            roomId: 'room-x',
            tick: 1
        });

        expect(spy).toHaveBeenCalledTimes(1);
        const payload = spy.mock.calls[0][0];
        expect(payload.position).toEqual({ x: 0, y: 0 });
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('[TriggerController] Missing position anchor'),
            expect.objectContaining({ componentId: 'comp-1', entityId: 'entity-1' })
        );
        warnSpy.mockRestore();
    });

    // --- equipped-item variants ---

    it('equipped-item: roomId: "" (falsy but defined) is preserved', () => {
        const spy = vi.fn();
        const controller = new TriggerController();
        controller.on('component:broke', spy);

        controller.onEquippedItemBrokeCheck('eq-1', 'entity-1', 'comp-1', 1, 0, {
            roomId: '',
            position: { x: 1, y: 1 },
            tick: 1
        });

        expect(spy).toHaveBeenCalledTimes(1);
        const payload = spy.mock.calls[0][0];
        expect(payload.roomId).toBe('');
    });

    it('equipped-item: position: undefined → default {x:0,y:0} AND Logger.warn called', () => {
        const warnSpy = vi.spyOn(Logger, 'warn').mockReturnThis();
        const spy = vi.fn();
        const controller = new TriggerController();
        controller.on('component:broke', spy);

        controller.onEquippedItemBrokeCheck('eq-1', 'entity-1', 'comp-1', 1, 0, {
            roomId: 'room-y',
            tick: 1
        });

        expect(spy).toHaveBeenCalledTimes(1);
        const payload = spy.mock.calls[0][0];
        expect(payload.position).toEqual({ x: 0, y: 0 });
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('[TriggerController] Missing position anchor'),
            expect.objectContaining({ entityId: 'entity-1' })
        );
        warnSpy.mockRestore();
    });
});
