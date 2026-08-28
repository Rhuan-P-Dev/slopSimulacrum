/**
 * EventLogPanel (CLIENT) unit tests — enriched room-context sub-line formatting.
 *
 * Covers the `_formatOthers` / `_formatContext` logic that renders the
 * "others:" segment of the event-panel context sub-line (spec: better text
 * & vision). `_formatOthers` renders each other same-room entity by name +
 * position instead of a bare count, collapses the remainder past the
 * CONTEXT_MAX_ENTITIES cap into "… +N", renders entities without a position
 * as the bare name, and yields "others: none" when empty.
 *
 * The panel is a plain ES module; `_formatOthers` and `_formatContext` are
 * pure functions on the prototype (no DOM, no fetch), so they are exercised
 * directly with a bare instance — no DOM stub or fetch mock required.
 *
 * @module test/unit/EventLogPanel.client
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventLogPanel } from '../../public/js/EventLogPanel.js';
import { AppConfig } from '../../public/js/Config.js';

/** The cap the panel uses (mirrors the server CONTEXT_MAX_ENTITIES). */
const MAX = AppConfig.EVENTS.CONTEXT_MAX_ENTITIES;

let panel;

beforeAll(() => {
    // No DOM/fetch needed — _formatOthers and _formatContext are pure.
    panel = new EventLogPanel({});
});

afterAll(() => {
    // Nothing to tear down (no listeners registered without init()).
});

describe('EventLogPanel._formatOthers', () => {
    it('lists multiple entities with coordinates as "name (x, y)"', () => {
        const entities = [
            { name: 'Droid A', x: 10, y: 20 },
            { name: 'Droid B', x: 5.4, y: 5.6 },
        ];
        expect(panel._formatOthers(entities)).toBe(
            'others: Droid A (10, 20), Droid B (5, 6)'
        );
    });

    it('renders an entity without coordinates as the bare name (no coord slot)', () => {
        const entities = [
            { name: 'Droid A', x: 10, y: 20 },
            { name: 'Droid B', x: null, y: null },
        ];
        expect(panel._formatOthers(entities)).toBe(
            'others: Droid A (10, 20), Droid B'
        );
    });

    it('renders an entity whose spatial fields are missing as the bare name', () => {
        const entities = [
            { name: 'Ghost Droid' },
        ];
        expect(panel._formatOthers(entities)).toBe('others: Ghost Droid');
    });

    it('returns "others: none" for an empty array', () => {
        expect(panel._formatOthers([])).toBe('others: none');
    });

    it('returns "others: none" when entities is not an array', () => {
        expect(panel._formatOthers(undefined)).toBe('others: none');
        expect(panel._formatOthers(null)).toBe('others: none');
        expect(panel._formatOthers('nope')).toBe('others: none');
    });

    it('caps at CONTEXT_MAX_ENTITIES and appends "… +N" for the overflow', () => {
        // MAX + 3 entities → first MAX shown, remaining 3 collapsed.
        const entities = Array.from({ length: MAX + 3 }, (_, i) => ({
            name: `Droid ${i + 1}`,
            x: i,
            y: i * 2,
        }));
        const result = panel._formatOthers(entities);

        // First entity and last shown entity are present; the overflowed one is not.
        expect(result).toContain('Droid 1 (0, 0)');
        expect(result).toContain(`Droid ${MAX} (${MAX - 1}, ${(MAX - 1) * 2})`);
        expect(result).not.toContain(`Droid ${MAX + 1}`);
        // Overflow marker.
        expect(result).toContain('… +3');
        // Exactly MAX "name (x, y)" pairs are rendered before the marker.
        const pairs = result.match(/\(\d+, \d+\)/g);
        expect(pairs).toHaveLength(MAX);
    });

    it('does not append an overflow marker when the list is exactly at the cap', () => {
        const entities = Array.from({ length: MAX }, (_, i) => ({
            name: `Droid ${i + 1}`,
            x: i,
            y: i,
        }));
        const result = panel._formatOthers(entities);
        expect(result).not.toContain('… +');
        expect(result).toContain(`Droid ${MAX} (${MAX - 1}, ${MAX - 1})`);
    });

    it('falls back to the name "Droid" when a record has no name', () => {
        const entities = [
            { x: 1, y: 2 },
        ];
        expect(panel._formatOthers(entities)).toBe('others: Droid (1, 2)');
    });
});

describe('EventLogPanel._formatContext (full sub-line)', () => {
    it('renders others with names+positions while keeping the rest of the line intact', () => {
        const context = {
            roomName: 'The Entrance Hall',
            roomWidth: 300,
            roomHeight: 200,
            playerPosition: { x: 0, y: 0 },
            entities: [
                { name: 'Droid A', x: 10, y: 20 },
            ],
            droppedItems: [{ name: 'knife', x: 5, y: 5 }],
            exits: [{ door: 'right_door', targetRoomName: 'The Eastern Corridor' }],
        };
        const line = panel._formatContext(context);
        expect(line).toBe(
            '@ The Entrance Hall 300x200 you: (0, 0) | others: Droid A (10, 20) | items: 1 | exits: right_door→The Eastern Corridor'
        );
    });

    it('renders "others: none" when there are no other entities', () => {
        const context = {
            roomName: 'The Entrance Hall',
            roomWidth: 300,
            roomHeight: 200,
            playerPosition: { x: 0, y: 0 },
            entities: [],
            droppedItems: [],
            exits: [{ door: 'right_door', targetRoomName: 'The Eastern Corridor' }],
        };
        const line = panel._formatContext(context);
        expect(line).toContain('| others: none |');
    });

    it('collapses overflow entities past the cap into "… +N"', () => {
        const entities = Array.from({ length: MAX + 5 }, (_, i) => ({
            name: `Droid ${i + 1}`,
            x: i,
            y: i,
        }));
        const context = {
            roomName: 'Hall',
            playerPosition: null,
            entities,
            droppedItems: [],
            exits: [],
        };
        const line = panel._formatContext(context);
        expect(line).toContain(`… +5`);
        expect(line).toContain(`Droid ${MAX} (${MAX - 1}, ${MAX - 1})`);
        expect(line).not.toContain(`Droid ${MAX + 1}`);
    });
});
