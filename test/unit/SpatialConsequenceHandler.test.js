/**
 * SpatialConsequenceHandler — move attribution records the *specific component*
 * that powered the move (`lastMoveAction.componentId`), not just the action +
 * tick. That component is the one the requirement resolver selected to satisfy
 * `Movement.move` (the consequence context's `fulfillingComponents`), i.e. the
 * exact part that did the moving.
 *
 * @module test/unit/SpatialConsequenceHandler
 */

import { describe, it, expect } from 'vitest';
import SpatialConsequenceHandler from '../../src/controllers/consequences/SpatialConsequenceHandler.js';

/**
 * A minimal fake worldStateController exposing just what
 * _recordMoveAttribution reads: stateEntityController.getEntity(id) and
 * tickSystem.currentTick.
 */
function makeWorld(entityMap) {
    const entities = { ...entityMap };
    return {
        stateEntityController: {
            getEntity: (id) => entities[id] ?? null
        },
        tickSystem: { currentTick: 42 }
    };
}

function makeHandler(entityMap) {
    const wsc = makeWorld(entityMap);
    return new SpatialConsequenceHandler({ worldStateController: wsc });
}

describe('SpatialConsequenceHandler — move attribution (lastMoveAction.componentId)', () => {
    it('records the action, tick, and the fulfillment component that powered the move', () => {
        const entity = { id: 'e1', name: 'Rover', spatial: { x: 0, y: 0 } };
        const handler = makeHandler({ e1: entity });
        handler._recordMoveAttribution('e1', {
            actionName: 'move',
            fulfillingComponents: { 'Movement.move': 'c-leg1' }
        });
        expect(entity.lastMoveAction).toEqual({
            action: 'move',
            tick: 42,
            componentId: 'c-leg1'
        });
    });

    it('prefers the Movement.move fulfillment key over other fulfillment entries', () => {
        const entity = { id: 'e1', name: 'Rover' };
        const handler = makeHandler({ e1: entity });
        handler._recordMoveAttribution('e1', {
            actionName: 'move',
            fulfillingComponents: {
                Physical: { strength: 40 },   // other trait (group-keyed, not flat)
                'Physical.strength': 'c-fist',
                'Movement.move': 'c-runner'
            }
        });
        // The movement requirement's fulfilling component wins.
        expect(entity.lastMoveAction.componentId).toBe('c-runner');
    });

    it('falls back to the first fulfillment component when the movement key is absent', () => {
        const entity = { id: 'e1', name: 'Rover' };
        const handler = makeHandler({ e1: entity });
        handler._recordMoveAttribution('e1', {
            actionName: 'move',
            fulfillingComponents: { 'Physical.strength': 'c-fist' }
        });
        // No Movement.move key → the sole (first) fulfillment component is used.
        expect(entity.lastMoveAction.componentId).toBe('c-fist');
    });

    it('records componentId as null when no fulfillment components are carried', () => {
        const entity = { id: 'e1', name: 'Rover' };
        const handler = makeHandler({ e1: entity });
        handler._recordMoveAttribution('e1', { actionName: 'move' });
        expect(entity.lastMoveAction).toEqual({
            action: 'move',
            tick: 42,
            componentId: null
        });
    });

    it('is a no-op (leaves the tag untouched) when the context carries no action name', () => {
        const entity = { id: 'e1', name: 'Rover', lastMoveAction: { action: 'move', tick: 99, componentId: 'c-old' } };
        const handler = makeHandler({ e1: entity });
        handler._recordMoveAttribution('e1', { fulfillingComponents: { 'Movement.move': 'c-new' } });
        // No actionName → non-action spatial change → the previous tag is left as-is.
        expect(entity.lastMoveAction).toEqual({ action: 'move', tick: 99, componentId: 'c-old' });
    });
});

/**
 * A fake world that supports the full `_handleDeltaSpatial` path: a live
 * entity reference, an `updateEntitySpatial` that mutates it, and a
 * perception-dirty recorder.
 */
function makeSpatialWorld(position) {
    const entity = {
        id: 'e1',
        name: 'Rover',
        location: 'room1',
        spatial: { x: position.x, y: position.y }
    };
    const dirtyRooms = [];
    const wsc = {
        stateEntityController: {
            getEntity: (id) => (id === 'e1' ? entity : null),
            updateEntitySpatial: (id, upd) => {
                if (id !== 'e1' || !entity.spatial) return false;
                if (upd?.x !== undefined) entity.spatial.x = upd.x;
                if (upd?.y !== undefined) entity.spatial.y = upd.y;
                return true;
            }
        },
        tickSystem: { currentTick: 7 },
        _markPerceptionDirty: (roomId) => dirtyRooms.push(roomId)
    };
    return { entity, dirtyRooms, handler: new SpatialConsequenceHandler({ worldStateController: wsc }) };
}

describe('SpatialConsequenceHandler — target movement at the display resolution', () => {
    it('a target within one display step (0.01) is a no-op: no position change, no dirty mark, no attribution', () => {
        const { entity, dirtyRooms, handler } = makeSpatialWorld({ x: 35.85, y: -17.73 });
        const result = handler._handleDeltaSpatial('e1', { speed: 20 }, {
            actionName: 'dash',
            // A 1e-14 residual target (what an agent brain re-dashes at each round).
            actionParams: { targetX: 35.85000000000001, targetY: -17.73 }
        });
        expect(result.success).toBe(true);
        expect(entity.spatial.x).toBe(35.85); // untouched — the write was skipped
        expect(entity.spatial.y).toBe(-17.73);
        expect(dirtyRooms).toEqual([]); // the room never woke the perception stream
        expect(entity.lastMoveAction).toBeUndefined();
    });

    it('a target within speed snaps EXACTLY to it, and re-dashing at the same target changes nothing (no ±1 ulp oscillation)', () => {
        const { entity, dirtyRooms, handler } = makeSpatialWorld({ x: 35.85, y: -17.73 });
        const target = { targetX: 35.9, targetY: -17.7 };
        handler._handleDeltaSpatial('e1', { speed: 10 }, { actionName: 'dash', actionParams: target });
        // The stored position IS the target — no float residual left behind.
        expect(entity.spatial.x).toBe(target.targetX);
        expect(entity.spatial.y).toBe(target.targetY);
        expect(dirtyRooms).toEqual(['room1']);
        expect(entity.lastMoveAction?.action).toBe('dash');
        // The same target again: the old `x += (target - x)` form would have
        // oscillated around the target by 1 ulp on every call.
        const before = { x: entity.spatial.x, y: entity.spatial.y };
        handler._handleDeltaSpatial('e1', { speed: 10 }, { actionName: 'dash', actionParams: target });
        expect(entity.spatial).toEqual(before); // still exact — it converged
        expect(dirtyRooms).toEqual(['room1']); // no second dirty mark → no phantom "moved"
    });

    it('a target beyond speed moves exactly `speed` units toward it (behavior unchanged)', () => {
        const { entity, dirtyRooms, handler } = makeSpatialWorld({ x: 0, y: 0 });
        handler._handleDeltaSpatial('e1', { speed: 10 }, { actionName: 'move', actionParams: { targetX: 30, targetY: 0 } });
        expect(entity.spatial.x).toBe(10);
        expect(entity.spatial.y).toBe(0);
        expect(dirtyRooms).toEqual(['room1']);
        expect(entity.lastMoveAction?.action).toBe('move');
    });

    it('a plain (no-target) delta still moves by the given amount and attributes the move', () => {
        const { entity, dirtyRooms, handler } = makeSpatialWorld({ x: 1, y: 2 });
        handler._handleDeltaSpatial('e1', { x: 3, y: -1 }, { actionName: 'crawl' });
        expect(entity.spatial).toEqual({ x: 4, y: 1 });
        expect(dirtyRooms).toEqual(['room1']);
        expect(entity.lastMoveAction?.action).toBe('crawl');
    });

    it('a requested non-zero delta that float arithmetic cancels is not credited (no phantom move)', () => {
        // At 1e18 the double ulp is 128 — adding 0.5 changes nothing in storage,
        // even though the requested delta was non-zero.
        const { entity, dirtyRooms, handler } = makeSpatialWorld({ x: 1e18, y: 0 });
        handler._handleDeltaSpatial('e1', { x: 0.5 }, { actionName: 'crawl' });
        expect(entity.spatial.x).toBe(1e18);
        expect(dirtyRooms).toEqual([]);
        expect(entity.lastMoveAction).toBeUndefined();
    });
});
