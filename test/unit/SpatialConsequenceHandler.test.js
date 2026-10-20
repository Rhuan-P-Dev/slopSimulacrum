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
