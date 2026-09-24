/**
 * Unit tests for InventoryManager.transferItem() — the cross-entity item
 * transfer (world object → another entity's component, e.g. the player's
 * droid) that backs the Object Viewer's take picker (wiki/subMDs/frontend/
 * object_viewer.md §7) and the POST /inventory/:entityId/take/:itemId route.
 *
 * Mirrors the moveItem contract (wiki/subMDs/data/inventory_system.md
 * "Move Item Rules" / "Item Transfer Between Components" semantics):
 *   - the SAME instance object moves (no re-create, no new id);
 *   - the destination capacity is checked BEFORE the source is mutated
 *     (capacity null / 0 = unbounded → always fits);
 *   - a container's whole subtree moves with it (children follow the
 *     container, child host references preserved);
 *   - non-member targets, missing items and same-entity calls are rejected
 *     with a message, never a partial state.
 *
 * Plain entities are used (the manager API operates on entity objects
 * {id, components, items} — the facade passes its live clones).
 *
 * @module test/unit/InventoryManager.transfer
 */

import { describe, it, expect } from 'vitest';
import InventoryManager from '../../src/utils/InventoryManager.js';

// testHost is a synthetic bounded type (traits.Physical.volume 10) installed
// into the manager's definitions below — the manager's capacity check reads
// traits.Physical.volume (not form.volume), so real types like centralBall
// (form-only volume) read as unbounded and can't exercise the rejection.
const TEST_HOST = { id: 'host-1', type: 'testHost' };

// centralBall has form.volume 10 in data/components.json (bounded host).
const CENTRAL_BALL = { id: 'droid-comp-1', type: 'centralBall' };
// The generator host in the boot world (only referenced for the knife's
// original hostComponentId; the transfer itself is source-entity-agnostic).
const GEN_COMP = { id: 'gen-comp-1', type: 'generatorCore' };

function makeKnife(id = 'knife-1', hostId = GEN_COMP.id) {
    return {
        id,
        type: 'knife',
        name: 'Knife',
        description: 'A simple knife.',
        volume: 1,
        hostComponentId: hostId
    };
}

/** A container (t1) holding a knife as its child item (host = the t1 id). */
function makeT1WithKnife(t1Id, knifeId, hostId = GEN_COMP.id) {
    return {
        container: {
            id: t1Id,
            type: 't1',
            name: 'T1',
            description: 'A container.',
            volume: 1,
            hostComponentId: hostId
        },
        child: makeKnife(knifeId, t1Id)
    };
}

function makeDroid(components = [CENTRAL_BALL]) {
    return { id: 'droid-1', name: 'Small Ball Droid', isStatic: false, components, items: [] };
}

function makeBoundedDroid() {
    return { id: 'droid-1', name: 'Small Ball Droid', isStatic: false, components: [TEST_HOST], items: [] };
}

function makeSource(items) {
    return { id: 'gen-1', name: 'Knife Generator', isStatic: true, components: [GEN_COMP], items };
}

describe('InventoryManager.transferItem() — cross-entity transfer', () => {
    let manager;

    beforeEach(() => {
        manager = new InventoryManager();
        manager._componentDefinitions.testHost = { traits: { Physical: { volume: 10 } } };
    });

    it('moves the same instance (no re-create) into the target component', () => {
        const knife = makeKnife();
        const source = makeSource([knife]);
        const target = makeDroid();

        const result = manager.transferItem(source, knife.id, target, CENTRAL_BALL.id);
        expect(result.success, result.message).toBe(true);

        // Instance identity: the SAME object id lands on the target (no
        // re-create with a fresh id), now hosted by the target component.
        expect(source.items).toEqual([]);
        expect(target.items).toHaveLength(1);
        expect(target.items[0].id).toBe(knife.id);
        expect(target.items[0].hostComponentId).toBe(CENTRAL_BALL.id);
        // Manager bookkeeping (getItem through the live inventory map).
        expect(manager.getItem(target, knife.id).id).toBe(knife.id);
        expect(manager.getItem(source, knife.id)).toBeFalsy();
    });

    it('preserves a depletable stat attached to the instance', () => {
        const knife = makeKnife();
        knife.equippedItemStats = { Physical: { existence: 3 } };
        const source = makeSource([knife]);
        const target = makeDroid();

        const result = manager.transferItem(source, knife.id, target, CENTRAL_BALL.id);
        expect(result.success, result.message).toBe(true);
        expect(target.items[0].equippedItemStats).toEqual({ Physical: { existence: 3 } });
    });

    it('moves a container with its whole subtree (child hosts preserved)', () => {
        const { container: t1, child: knife } = makeT1WithKnife('t1-1', 'knife-2');
        const source = makeSource([t1, knife]);
        const target = makeDroid();

        const result = manager.transferItem(source, t1.id, target, CENTRAL_BALL.id);
        expect(result.success, result.message).toBe(true);

        // Both the container and its child travel; the child keeps pointing
        // at the container (the manager's item-tree invariant).
        expect(source.items).toEqual([]);
        const moved = target.items;
        expect(moved.map(i => i.id).sort()).toEqual(['knife-2', 't1-1'].sort());
        expect(moved.find(i => i.id === 't1-1').hostComponentId).toBe(CENTRAL_BALL.id);
        expect(moved.find(i => i.id === 'knife-2').hostComponentId).toBe('t1-1');
    });

    it('rejects when the target component is full (source untouched)', () => {
        const knife = makeKnife();
        const source = makeSource([knife]);
        const target = makeBoundedDroid();
        // Fill the testHost (capacity 10) with ten 1-volume items hosted ON
        // the target component (the used-volume filter is host-based).
        for (let i = 0; i < 10; i++) {
            target.items.push(makeKnife(`fill-${i}`, TEST_HOST.id));
        }

        const result = manager.transferItem(source, knife.id, target, TEST_HOST.id);
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/does not have enough volume/);
        expect(result.message).toMatch(/Available: 0, Item needs: 1/);
        // Rejection before mutation: the source still holds the knife, the
        // target still holds exactly its ten.
        expect(source.items.map(i => i.id)).toEqual(['knife-1']);
        expect(target.items).toHaveLength(10);
    });

    it('accepts into an unbounded component (definition has no volume form)', () => {
        const unbounded = { id: 'void-comp-1', type: 'undefinedHostType' };
        const knife = makeKnife();
        const source = makeSource([knife]);
        const target = makeDroid([unbounded]);

        const result = manager.transferItem(source, knife.id, target, unbounded.id);
        expect(result.success, result.message).toBe(true);
        expect(target.items.map(i => i.id)).toEqual(['knife-1']);
    });

    it('rejects a target component that is not part of the target entity', () => {
        const knife = makeKnife();
        const source = makeSource([knife]);
        const target = makeDroid();

        const result = manager.transferItem(source, knife.id, target, GEN_COMP.id);
        expect(result.success).toBe(false);
        expect(result.message).toBe(`Component "${GEN_COMP.id}" is not part of entity "${target.id}".`);
        expect(source.items).toHaveLength(1);
        expect(target.items).toEqual([]);
    });

    it('rejects a nonexistent item (no partial state)', () => {
        const source = makeSource([makeKnife()]);
        const target = makeDroid();

        const result = manager.transferItem(source, 'no-such-item', target, CENTRAL_BALL.id);
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/Item not found/);
        expect(source.items).toHaveLength(1);
    });

    it('rejects taking from an entity into itself (same entity)', () => {
        const knife = makeKnife();
        const entity = makeDroid([CENTRAL_BALL]);
        entity.items.push(knife);

        const result = manager.transferItem(entity, knife.id, entity, CENTRAL_BALL.id);
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/two distinct entities/);
        expect(entity.items.map(i => i.id)).toEqual(['knife-1']);
    });
});
