/**
 * Smoke test — perception system end-to-end (not a vitest test; run via `node`).
 *
 * Builds a real world, performs concrete mutations through the *public* WSC
 * facade (spawn / move / despawn / dropped-item / attribute), and asserts that
 * each mutation surfaces in the room- and agent-scoped perception delta streams.
 *
 * Run:  node test/unit/perceptionSmoke.mjs
 */

import { buildWorldState } from '../../src/composition/WorldComposition.js';
import { UniversalTickSystem } from '../../src/utils/UniversalTickSystem.js';
import { MAX_TICKS_PER_SECOND } from '../../src/utils/Constants.js';
import { truncateCoord } from '../../shared/CoordFormat.js';

let passed = 0;
let failed = 0;

function assert(cond, label) {
    if (cond) {
        passed++;
        console.log('  [PASS]', label);
    } else {
        failed++;
        console.error('  [FAIL]', label);
    }
}

function lastEntry(list) {
    return list?.length ? list[list.length - 1] : null;
}

// The delta rows (`entities.appeared`, etc.) are arrays of { id, ... } objects.
function rowHas(list, id) {
    return (list ?? []).some((e) => (e?.id ?? e?.itemId) === id);
}

console.log('Building world…');
const tickSystem = new UniversalTickSystem(MAX_TICKS_PER_SECOND);
const { worldStateController: wsc } = buildWorldState(tickSystem);
wsc.setBroadcastService({ broadcast: () => {} });

const startRoomId = wsc.roomsController.getUidByLogicalId('start_room');
const rightRoomId = wsc.roomsController.getUidByLogicalId('right_room');
console.log('  rooms:', { startRoomId, rightRoomId });

// ---------------------------------------------------------------------------
// 0. Establish baselines for the two rooms we work in (first reads = baseline)
// ---------------------------------------------------------------------------
console.log('\n[0] First reads (expect: baseline for any non-empty room)');
// A non-empty room yields a baseline on its first read; an empty room yields no
// entry (total === 0 is intentionally dropped) — observe it anyway so later
// arrivals are deltas, not baselines.
const startFirst = wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 });
assert(
    Array.isArray(startFirst) && startFirst.some((d) => d.kind === 'baseline'),
    'start_room (non-empty) first read produces a baseline entry'
);
const rightFirst = wsc.getPerceptionDeltasForRoom(rightRoomId, { limit: 10 });
assert(Array.isArray(rightFirst), 'right_room first read is an array (baseline if non-empty, empty if empty room)');

// ---------------------------------------------------------------------------
// 1. Spawn an entity in start_room -> "appeared" delta
// ---------------------------------------------------------------------------
console.log('\n[1] Spawn entity in start_room (expect: appeared)');
const e1 = wsc.spawnEntity('smallBallDroid', startRoomId);
assert(Boolean(e1), 'spawnEntity returned an id');
let roomDeltas = wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 });
assert(lastEntry(roomDeltas)?.kind === 'delta', 'new entry is a delta (not baseline)');
assert(rowHas(lastEntry(roomDeltas)?.entities?.appeared, e1), 'appears in entities.appeared');
assert((lastEntry(roomDeltas)?.counts?.total ?? 0) > 0, 'counts.total > 0');

// ---------------------------------------------------------------------------
// 2. Spawn a second entity -> appeared; first is NOT re-listed
// ---------------------------------------------------------------------------
console.log('\n[2] Second spawn (expect: only e2 in appeared)');
const e2 = wsc.spawnEntity('smallBallDroid', startRoomId);
roomDeltas = wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 });
assert(
    rowHas(lastEntry(roomDeltas)?.entities?.appeared, e2),
    'e2 in entities.appeared'
);
assert(
    !rowHas(lastEntry(roomDeltas)?.entities?.appeared, e1),
    'e1 NOT re-listed in entities.appeared'
);

// ---------------------------------------------------------------------------
// 3. Move entity across rooms -> two-room diff (despawn in start, appear in right)
// ---------------------------------------------------------------------------
console.log('\n[3] Move entity start->right (expect: despawn in start, appear in right)');
assert(wsc.moveEntity(e1, rightRoomId), 'moveEntity succeeded');
let startDeltas = wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 });
let rightDeltas = wsc.getPerceptionDeltasForRoom(rightRoomId, { limit: 10 });
const startLast = lastEntry(startDeltas);
const rightLast = lastEntry(rightDeltas);
assert(rowHas(startLast?.entities?.despawned, e1), 'start_room shows e1 in entities.despawned');
assert(rowHas(rightLast?.entities?.appeared, e1), 'right_room shows e1 in entities.appeared');

// ---------------------------------------------------------------------------
// 4. Move back -> appears in start again, despawn in right
// ---------------------------------------------------------------------------
console.log('\n[4] Move entity right->start (expect: appear in start, despawn in right)');
wsc.moveEntity(e1, startRoomId);
roomDeltas = wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 });
assert(
    rowHas(lastEntry(roomDeltas)?.entities?.appeared, e1),
    'start_room shows re-entry in entities.appeared'
);
startDeltas = wsc.getPerceptionDeltasForRoom(rightRoomId, { limit: 10 });
assert(rowHas(lastEntry(startDeltas)?.entities?.despawned, e1), 'right_room shows e1 in entities.despawned');

// ---------------------------------------------------------------------------
// 5. Despawn entity -> "despawned" delta
// ---------------------------------------------------------------------------
console.log('\n[5] Despawn entity (expect: despawned)');
assert(wsc.despawnEntity(e1), 'despawnEntity succeeded');
roomDeltas = wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 });
assert(rowHas(lastEntry(roomDeltas)?.entities?.despawned, e1), 'e1 in entities.despawned');

// ---------------------------------------------------------------------------
// 6. Drop an item onto the floor -> dropped.added
// ---------------------------------------------------------------------------
console.log('\n[6] Drop an item (expect: dropped.added)');
const droppedItems = wsc.getDroppedItems() ?? {};
const droppedId = `dropped-smoke-${Math.random().toString(36).slice(2, 8)}`;
// e2 is still in start_room (e1 was moved to right_room then back to start and
// despawned in [5], but e2 was never moved). Give e2 an obviously distinct
// drop point so the drop-time position is unambiguous.
wsc.setDroppedItems({
    ...droppedItems,
    [droppedId]: { id: droppedId, itemId: droppedId, type: 'knife', x: 1000, y: 2000, roomId: startRoomId, ownerId: e2 }
});
roomDeltas = wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 });
assert(
    (lastEntry(roomDeltas)?.dropped?.added ?? []).some((e) => e?.itemId === droppedId),
    'new dropped item in dropped.added'
);
// Drop-time position: the dropper's position = the drop point (1000, 2000),
// NOT e2's current spatial. This proves a dropped.added row's actor carries the
// coordinate captured at the drop, not the owner's current position.
const dropRow = (lastEntry(roomDeltas)?.dropped?.added ?? []).find((e) => e?.itemId === droppedId);
assert(dropRow?.actor?.id === e2, 'dropped item credits the dropping entity (e2)');
assert(dropRow?.actor?.x === 1000, "dropper actor.x is the drop point (1000), not e2's current spatial");
assert(dropRow?.actor?.y === 2000, "dropper actor.y is the drop point (2000), not e2's current spatial");
// and it is NOT in right_room
assert(
    !wsc.getPerceptionDeltasForRoom(rightRoomId, { limit: 10 }).some((d) =>
        (d.dropped?.added ?? []).some((e) => e?.itemId === droppedId)
    ),
    'right_room did not report the dropped item'
);

// ---------------------------------------------------------------------------
// 7. Whole-entity stat change -> statChanges
// ---------------------------------------------------------------------------
console.log('\n[7] Stat change (expect: statChanges)');
const ent = wsc.getEntity?.(e2);
let statOk = false;
if (ent?.attributes) {
    for (const traitId of Object.keys(ent.attributes)) {
        for (const statName of Object.keys(ent.attributes[traitId])) {
            const changedPlus = wsc.setEntityAttributeDelta(e2, traitId, statName, 1);
            const changedMinus = changedPlus
                ? wsc.setEntityAttributeDelta(e2, traitId, statName, -1)
                : false;
            if (changedPlus || changedMinus) {
                const roomD = wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 });
                const found = roomD.some((d) =>
                    (d.entities?.statChanges ?? []).some((sc) => sc?.id === e2 && sc?.traitId === traitId && sc?.statName === statName)
                );
                statOk = found;
                if (found) break;
            }
        }
        if (statOk) break;
    }
    if (statOk) {
        passed++;
        console.log('  [PASS] whole-entity stat change in entities.statChanges');
    } else {
        console.log('  [SKIP] no modifiable whole-entity attribute on this blueprint (statChange path not exercised)');
    }
} else {
    console.log('  [SKIP] no entity attributes available (statChange path not exercised)');
}

// ---------------------------------------------------------------------------
// 8. Whole-world "WHAT CHANGED SINCE LAST OBSERVATION" (agent scope)
// ---------------------------------------------------------------------------
console.log('\n[8] Agent perception (whole-world, since last observation)');
// e2 is the observing agent (still alive, in start_room).
const agentRead1 = wsc.getAgentPerception(e2, { limit: 100 });
assert(agentRead1.length >= 1, 'first agent read returned entries');

// Force a change AFTER the first read; it must appear in the second read only.
const e3 = wsc.spawnEntity('smallBallDroid', startRoomId);
const agentRead2 = wsc.getAgentPerception(e2, { limit: 100 });
assert(
    agentRead2.some((d) => (d.entities?.appeared ?? []).some((e) => e?.id === e3)),
    'post-read spawn e3 appears in the SECOND agent read'
);
assert(
    !agentRead1.some((d) => (d.entities?.appeared ?? []).some((e) => e?.id === e3)),
    'post-read spawn e3 does NOT appear in the FIRST read (spawned after it)'
);
// The first read's changes must NOT be re-shown in the second read.
assert(
    !agentRead2.some((d) => (d.entities?.despawned ?? []).some((e) => e?.id === e1)),
    'e1 despawn (pre-read) is not re-shown after cursor advanced'
);
// Re-read with no new mutation => empty (cursor is already advanced).
const agentRead3 = wsc.getAgentPerception(e2, { limit: 100 });
assert(
    agentRead3.length === 0,
    'no-new-mutation re-read is empty (bounded since-window)'
);
assert(
    agentRead1.length <= 100 && agentRead2.length <= 100,
    'agent window bounded by limit'
);

// ---------------------------------------------------------------------------
// 9. Record an explicit observation (cursor advance without a read)
// ---------------------------------------------------------------------------
console.log('\n[9] recordAgentObservation (explicit cursor advance, no read)');
wsc.recordAgentObservation(e2);
const agentRead4 = wsc.getAgentPerception(e2, { limit: 100 });
assert(agentRead4 instanceof Array && agentRead4.length >= 0, 'post-observation read returns array (empty or new only)');
assert(agentRead4.length === 0, 'no new mutation => explicit observation leaves next read empty');

// ---------------------------------------------------------------------------
// 10. Executed action via the facade (expect: actions.performed row — the action
//     AND only the components the attribution store recorded as used)
// ---------------------------------------------------------------------------
console.log('\n[10] Executed action (expect: actions.performed row, used = only the recorded ids)');
let actionSucceeded = false;
let actionName = null;
for (const candidate of ['punch', 'move']) {
    const params = candidate === 'move' ? { targetX: 5, targetY: 5 } : { targetEntityId: e3 };
    let res;
    try {
        res = wsc.executeAction(candidate, e2, params);
    } catch (err) {
        res = { success: false, error: err?.message ?? String(err) };
    }
    if (res?.success) { actionSucceeded = true; actionName = candidate; break; }
    console.log(`  (attempt "${candidate}" not executable here: ${res?.error ?? 'no result'})`);
}
if (actionSucceeded) {
    const roomD = wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 });
    const last = lastEntry(roomD);
    const rows = last?.actions?.performed ?? [];
    const row = rows.find((r) => r?.entity === e2 && r?.action === actionName);
    assert(Boolean(row), `performed row for e2 "${actionName}" exists in the flushed entry`);
    assert(Array.isArray(row?.used), 'row.used is an array ("only the ones used")');
    // The row claims EXACTLY the ids the attribution store recorded for this
    // action (no overclaim, no underclaim).
    const store = wsc.getActionAttributionStore?.();
    if (store) {
        const rec = store.get(e2, actionName);
        const rowIds = (row.used ?? []).map((u) => u?.id).filter(Boolean);
        const recIds = rec?.ids ?? [];
        assert(JSON.stringify(rowIds) === JSON.stringify(recIds), 'row.used ids === store record ids (only the ones used)');
        // Every used component the store recorded must be one the entity actually
        // possesses right now.
        const entComps = last?.entities?.[e2]?.components ?? {};
        for (const id of recIds) assert(Boolean(entComps[id]), `recorded used component ${id} is part of e2`);
    }
    // The controller's count tracks the rows it filled.
    assert((last?.counts?.actions ?? 0) === rows.length, 'counts.actions === performed.length');
    // The summary sentence names the performed actions.
    assert(typeof last?.summary === 'string' && last.summary.includes('action'), 'summary names the performed actions');
    // A subsequent flush (new mutation, no new action) must NOT re-surface the
    // same action (per-entity seen-cursor advanced at the flush).
    const dropped2 = wsc.getDroppedItems() ?? {};
    const droppedId2 = `dropped-smoke2-${Math.random().toString(36).slice(2, 8)}`;
    wsc.setDroppedItems({
        ...dropped2,
        [droppedId2]: { id: droppedId2, itemId: droppedId2, type: 'knife', x: 1500, y: 2500, roomId: startRoomId, ownerId: e2 }
    });
    const nextLast = lastEntry(wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 }));
    assert(
        nextLast && nextLast !== last,
        'a new entry was flushed for the later mutation'
    );
    assert(
        !(nextLast?.actions?.performed ?? []).some((r) => r?.entity === e2 && r?.action === actionName),
        'the earlier action is not re-surfaced in the later flush (cursor advanced)'
    );
    passed++;
    console.log(`  [PASS] executed "${actionName}" surfaced once with only its used components`);
} else {
    console.log('  [SKIP] no action executable by this blueprint in the smoke world (action path not exercised)');
}

// ---------------------------------------------------------------------------
// 11. Coordinate truncation — every coordinate an entry ships is truncated to
//     2 decimals (the "00.00" perception display rule), in BOTH the room view
//     and the agent view. Property-based: a value is "truncated" when it
//     equals its own truncation (idempotent), whatever the spatial handler
//     computed for the target.
// ---------------------------------------------------------------------------
console.log('\n[11] Coordinate truncation (expect: 2-decimal coords in room + agent views)');
const truncMove = wsc.executeAction('move', e2, { targetX: 18.81000041279735, targetY: -6.795872605527817 });
if (truncMove?.success) {
    const isTruncated = (v) => Number.isFinite(v) && v === truncateCoord(v);
    const checkEntry = (entry, label) => {
        const rows = [
            ...(entry?.entities?.moved ?? []),
            ...(entry?.dropped?.added ?? []),
            ...(entry?.dropped?.removed ?? []),
            ...(entry?.dropped?.moved ?? []),
            ...(entry?.items?.added ?? []),
            ...(entry?.items?.removed ?? [])
        ];
        let checked = 0;
        for (const row of rows) {
            for (const f of ['x', 'y']) {
                if (row?.[f] != null) {
                    assert(isTruncated(row[f]), `${label}: row ${f}=${row[f]} truncated to 2 decimals`);
                    checked++;
                }
            }
            for (const pt of [row?.fromXY, row?.toXY, row?.spatial, row?.actor]) {
                if (pt?.x != null) {
                    assert(isTruncated(pt.x), `${label}: point.x=${pt.x} truncated to 2 decimals`);
                    checked++;
                }
                if (pt?.y != null) {
                    assert(isTruncated(pt.y), `${label}: point.y=${pt.y} truncated to 2 decimals`);
                    checked++;
                }
            }
        }
        return checked;
    };
    const roomEntry = lastEntry(wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 }));
    const movedRow = (roomEntry?.entities?.moved ?? []).find((r) => r?.id === e2) ?? roomEntry?.entities?.moved?.[0];
    assert(Boolean(movedRow), 'the move surfaced a moved row in the room view');
    if (movedRow?.toXY) {
        console.log(`  (moved ${movedRow?.name ?? e2}: from ${JSON.stringify(movedRow.fromXY)} → to ${JSON.stringify(movedRow.toXY)})`);
    }
    const nRoom = checkEntry(roomEntry, 'room view');
    assert(nRoom > 0, 'the room entry carried coordinates to check');
    // The agent (NPC/LLM) view carries the same truncated coordinates.
    const agentDeltas = wsc.getAgentPerception(e2, { limit: 10 }) ?? [];
    const agentEntry = agentDeltas.find((d) => d === roomEntry) ?? lastEntry(agentDeltas);
    const nAgent = checkEntry(agentEntry, 'agent view');
    assert(nAgent > 0, 'the agent view carried the same coordinates');
    const agentMoved = (agentEntry?.entities?.moved ?? []).find((r) => r?.id === e2);
    assert(
        Boolean(agentMoved) && JSON.stringify(agentMoved.toXY) === JSON.stringify(movedRow?.toXY),
        'agent view toXY === room view toXY (both truncated, never full precision)'
    );
} else {
    console.log(`  [SKIP] move not executable for this blueprint (${truncMove?.error ?? 'no result'}) — truncation property not exercised`);
}

// ---------------------------------------------------------------------------
// [12] Sub-resolution re-target (expect: NO moved row — the phantom-move bug)
// ---------------------------------------------------------------------------
console.log('\n[12] Sub-resolution re-target (expect: no moved row — the phantom-move bug)');
if (truncMove?.success) {
    const pos = wsc.stateEntityController?.getEntity?.(e2)?.spatial;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        // The reported bug: an agent brain re-dashes at a target within one
        // display step (0.01) of its own position. Old behavior: `x +
        // (target - x)` oscillated by 1 ulp, and the strict-float diff then
        // claimed a "moved" row with identical from/to coordinates every round.
        const entryBefore = lastEntry(wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 }));
        const target = { targetX: pos.x + 1e-9, targetY: pos.y };
        const r1 = wsc.executeAction('move', e2, target);
        const r2 = wsc.executeAction('move', e2, target); // same target again
        const posAfter = wsc.stateEntityController?.getEntity?.(e2)?.spatial;
        assert(r1?.success && r2?.success, 'the action executed (it was accepted)');
        assert(
            posAfter?.x === pos.x && posAfter?.y === pos.y,
            'sub-resolution target is a no-op: the stored position never drifts'
        );
        const entryAfter = lastEntry(wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 }));
        if (entryAfter !== entryBefore) {
            // An entry flushed anyway (the action is recorded in actions.performed —
            // that part is honest: the move WAS performed). It must carry no
            // "moved" row for e2.
            const movedRows = (entryAfter?.entities?.moved ?? []).filter((r) => r?.id === e2);
            assert(movedRows.length === 0, 'flushed entry carries no moved row for e2 (phantom move is gone)');
        } else {
            assert(true, 'nothing flushed at all — the no-op never woke the room');
        }
    } else {
        console.log('  [SKIP] entity has no spatial data — sub-resolution case not exercised');
    }
} else {
    console.log('  [SKIP] move not executable for this blueprint — sub-resolution case not exercised');
}

// ---------------------------------------------------------------------------
// [13] Punch a tree (expect: the performed row names WHO was acted upon and
//      WHICH component was hit — target attribution end-to-end: the dispatcher
//      records the target at the choke point, perception resolves display names
//      against the current world, and the agent view carries the same fields).
// ---------------------------------------------------------------------------
console.log('\n[13] Punch a tree (expect: performed row with target entity + hit component)');
const puncher = wsc.spawnEntity('m1Droid', startRoomId);
const tree = wsc.spawnEntity('tree', startRoomId);
if (puncher && tree) {
    const treeEnt = wsc.stateEntityController.getEntity(tree);
    const treeComp = treeEnt?.components?.[0] ?? null;
    // Close the punch range (100) by moving the droid onto the tree's spot.
    wsc.executeAction('move', puncher, {
        targetX: treeEnt?.spatial?.x ?? 0,
        targetY: treeEnt?.spatial?.y ?? 0
    });
    const punch = wsc.executeAction('droid punch', puncher, {
        targetEntityId: tree,
        targetComponentId: treeComp?.id ?? null
    });
    assert(punch?.success, `the punch executed (${punch?.success ? 'strength requirement met' : punch?.error ?? 'no result'})`);
    const entry = lastEntry(wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 }));
    const row = (entry?.actions?.performed ?? []).find((r) => r?.entity === puncher && r?.action === 'droid punch');
    assert(Boolean(row), 'the punch surfaced a performed row');
    if (row) {
        assert(row.target?.id === tree, 'the row names the target entity (the tree)');
        assert(Boolean(row.target?.name), `the target carries a display name (${row.target?.name})`);
        assert(!treeComp?.id || row.target?.componentId === treeComp.id, 'the row names the component that was hit');
        assert(Boolean(row.target?.componentName), `the hit component carries a display name (${row.target?.componentName})`);
        assert(row.used?.length > 0, 'the row lists the components that powered the punch');
    }
    // The agent (NPC/LLM) view carries the identical target attribution.
    const agentEntry = lastEntry(wsc.getAgentPerception(puncher, { limit: 10 }));
    const aRow = (agentEntry?.actions?.performed ?? []).find((r) => r?.entity === puncher && r?.action === 'droid punch');
    assert(aRow && JSON.stringify(aRow.target) === JSON.stringify(row?.target), 'agent view carries the same target attribution');
} else {
    console.log('  [SKIP] m1Droid/tree blueprint unavailable in this world');
}

// ---------------------------------------------------------------------------
// [14] Chat — a line sent to the room surfaces in that room's perception
//      (a *new* line in the room's chat transcript). The room is marked dirty
//      at the single facade choke point, so the next flush for this room
//      reports exactly the new line; a re-read with no new lines must not
//      re-surface it (cursor advanced).
// ---------------------------------------------------------------------------
console.log('\n[14] Chat: a line sent to the room surfaces in that room\'s perception (new lines only)');
const chatResult = wsc.sendRoomChat({
    roomId: startRoomId,
    speakerName: 'Player',
    speakerEntityId: null,
    text: 'Is anyone else in the hall?'
});
assert(chatResult?.success, `the chat line was accepted (${chatResult?.code ?? 'no result'})`);
if (chatResult?.success) {
    const entry = lastEntry(wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 }));
    const added = entry?.chat?.added ?? [];
    assert(added.length === 1, 'exactly one new chat line surfaced (the one just sent)');
    assert(added[0]?.speakerName === 'Player', 'the new line carries the speaker name (Player)');
    assert(added[0]?.text === 'Is anyone else in the hall?', 'the new line carries the exact text (trimmed, <= cap)');
    assert((entry?.counts?.chat ?? 0) === 1, 'counts.chat === 1 on the chat-only flush');
    // A SECOND line triggers the next flush: it must report only the new line
    // (the first line is not re-surfaced — the room cursor advanced at the
    // previous flush). The room view returns history (newest first), so
    // "cursor advanced" is proven by the *new* entry's contents, not by an
    // empty re-read (that is the agent view's contract, section [8]).
    const chatResult2 = wsc.sendRoomChat({
        roomId: startRoomId,
        speakerName: 'Player',
        speakerEntityId: null,
        text: 'Never mind, just checking.'
    });
    const reread = lastEntry(wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 }));
    assert(chatResult2?.success && reread !== entry, 'a new flush happened for the second line');
    assert(
        (reread?.chat?.added ?? []).length === 1 &&
            reread.chat.added[0].text === 'Never mind, just checking.',
        'the next flush reports only the second line (the first is not re-surfaced)'
    );
    assert(
        !(reread?.chat?.added ?? []).some((m) => m?.text === 'Is anyone else in the hall?'),
        'the earlier chat line is not re-surfaced in the later flush (cursor advanced)'
    );
}

// ---------------------------------------------------------------------------
// [15] Machines — a placed machine is perceived with WHO placed it and WHERE.
//      The place choke point tags the spawned entity (isMachine/machineType/
//      placedBy) and marks the room dirty, so the next flush reports the
//      placement (machines.placed) with the placer's identity and the floor
//      position; a retrieval reports the last-seen position (machines.
//      retrieved). Baselines carry the machines present at first observation
//      (a machine standing in a room is a placed machine — a fact).
// ---------------------------------------------------------------------------
console.log('\n[15] Machines: a placed machine is perceived with who placed it and where');
{
    // A named droid places the machine (players carry no display name; a
    // named placer keeps the "who" readable in the assertions).
    const placerId = wsc.stateEntityController.spawnEntity('smallBallDroid', startRoomId, { name: 'Ada' });
    // Mirror exactly what PlaceMachineHandler does at the spawn choke point
    // (the machine mechanics themselves are covered by MachineLifecycle.
    // test.js): spawn the blueprint tagged, position it, mark the room dirty.
    const machineId = wsc.stateEntityController.spawnEntity('knifeGenerator', startRoomId, {
        isStatic: true,
        name: 'Knife Generator',
        isMachine: true,
        machineType: 'knifeGenerator',
        placedBy: placerId
    });
    wsc.stateEntityController.updateEntitySpatial(machineId, { x: 12.3456, y: 7.5 });
    wsc._markPerceptionDirty(startRoomId);

    const placedEntry = lastEntry(wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 }));
    const placed = placedEntry?.machines?.placed ?? [];
    assert(placed.length === 1, 'exactly one machine placement surfaced');
    assert(placed[0]?.name === 'Knife Generator', 'the machine is named');
    assert(placed[0]?.type === 'knifeGenerator', 'the machine type is carried');
    assert(placed[0]?.placedBy?.id === placerId, 'the placer is credited (who)');
    assert(placed[0]?.placedBy?.name === 'Ada', 'the placer display name is resolved (who)');
    assert(
        placed[0]?.x === 12.34 && placed[0]?.y === 7.5,
        'the floor position is reported at the 00.00 resolution (where)'
    );
    // The machine is an entity: its raw row carries the tag, but counts.total
    // must NOT count it twice — the machines category is deliberately excluded
    // from total (the entity row is the one that is counted).
    assert(
        placedEntry.counts.total ===
            placedEntry.counts.entities +
            placedEntry.counts.items +
            placedEntry.counts.components +
            placedEntry.counts.internal +
            placedEntry.counts.equipped +
            placedEntry.counts.dropped +
            placedEntry.counts.chat,
        'machines are not folded into counts.total (no double-count)'
    );

    // Retrieval: despawn + mark — exactly what RetrieveMachineHandler does at
    // its choke point. The machine's last-seen snapshot carries the tag, so
    // the retrieval row reports where it stood and still credits Ada.
    wsc.despawnEntity(machineId);
    wsc._markPerceptionDirty(startRoomId);
    const retrievedEntry = lastEntry(wsc.getPerceptionDeltasForRoom(startRoomId, { limit: 10 }));
    assert(retrievedEntry !== placedEntry, 'a new flush happened for the retrieval');
    const retrieved = retrievedEntry?.machines?.retrieved ?? [];
    assert(retrieved.length === 1 && retrieved[0]?.name === 'Knife Generator', 'the retrieval surfaced with the machine name');
    assert(retrieved[0]?.placedBy?.id === placerId, 'the retrieval row still credits the placer (who)');
    assert(
        retrieved[0]?.x === 12.34 && retrieved[0]?.y === 7.5,
        'the retrieval row carries the last-seen position (where)'
    );

    // Quiet the room again for any reader that follows (the placer despawn is
    // via the sub-controller, unmarked — no extra flush).
    wsc.stateEntityController.despawnEntity(placerId);
    console.log('  ✓ machine placement/retrieval surfaces in the room view with who + where');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(42)}`);
console.log(`PERCEPTION SMOKE TEST: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(42)}`);
if (failed > 0) {
    process.exit(1);
}
console.log('  ALL OK');
process.exit(0);
