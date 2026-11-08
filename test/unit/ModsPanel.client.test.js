/**
 * ModsPanel (CLIENT) — the package list as a stack, not as a table.
 *
 * The list is the operator's only view of what the world is made of, and two facts
 * decide what a package actually does: where it sits in the stack (`loadOrder` wins a
 * shared key) and whether the packages it requires are on. Both are claims about the
 * render, and both were previously a comma-separated sentence. Pinned here, over the
 * pure functions the class delegates to (the suite has no DOM):
 *
 *   1. stack order is `loadOrder` ascending with id as the tie-break, the alphabet is
 *        available, and neither reorders the caller's array;
 *   2. the ordinal gutter carries that number, zero-padded, so the position is read
 *        before the name;
 *   3. every requirement is its own chip, carrying the state the install is really in
 *        (enabled / disabled / not installed) and a jump to the package it names;
 *   4. the shadow markers come from a plan and from nothing else — no plan, no claim;
 *   5. the description is always rendered, clamped until opened, and escaped: it is a
 *        string from a file this server's operator does not control.
 *
 * @module test/unit/ModsPanel.client
 */

import { describe, it, expect } from 'vitest';
import {
    renderPackageList, requirementState, shadowIndex, sortMods, moveSummary,
    SORT_NAME, SORT_STACK
} from '../../public/js/ModsPanel.js';

/** A package row in the shape `GET /mods` returns. */
const mod = (id, loadOrder, extra = {}) => ({
    id,
    version: '1.0.0',
    official: id.startsWith('core-'),
    enabled: true,
    loadOrder,
    content: ['components'],
    requires: [],
    description: `The ${id} package.`,
    blocked: null,
    ...extra
});

/** The gutter numbers in rendered order — the stack, read top to bottom. */
const ordinals = (html) => [...html.matchAll(/class="mods-ordinal"[^>]*>(\d+)</g)].map((m) => m[1]);

/** The rows in the order they were rendered. */
const rowOrder = (html) => [...html.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1]);

describe('the mod package list', () => {
    const stack = [
        mod('core-materials', 0),
        mod('extra-sensitive-parts', 21, { official: false, requires: ['core-components', 'core-ghost'] }),
        mod('core-components', 12, { requires: ['core-materials', 'core-off'] }),
        mod('core-off', 5, { enabled: false })
    ];

    it('reads as a stack: load order ascending, id as the tie-break', () => {
        expect(rowOrder(renderPackageList({ mods: stack })))
            .toEqual(['core-materials', 'core-off', 'core-components', 'extra-sensitive-parts']);
    });

    it('offers the alphabet without pretending it is a fact about the world', () => {
        expect(rowOrder(renderPackageList({ mods: stack, sortMode: SORT_NAME })))
            .toEqual(['core-components', 'core-materials', 'core-off', 'extra-sensitive-parts']);
        // The control says which of the two is on screen.
        expect(renderPackageList({ mods: stack })).toContain('in stack order');
        expect(renderPackageList({ mods: stack, sortMode: SORT_NAME })).toContain('in alphabetical order');
    });

    it('never reorders the answer it was given', () => {
        const given = [...stack];
        sortMods(given, SORT_STACK);
        sortMods(given, SORT_NAME);
        expect(given.map((m) => m.id)).toEqual(stack.map((m) => m.id));
    });

    it('puts the position in the stack in the gutter, with the raw load order behind it', () => {
        const html = renderPackageList({ mods: stack });
        // The gutter is the rank, not the raw number: on an install nobody tuned every
        // package carries the same load order, and a column of identical digits says
        // nothing. The number itself is in the tooltip, where it is still readable.
        expect(ordinals(html)).toEqual(['01', '02', '03', '04']);
        expect(html).toContain('Stack position 1 of 4 (load order 0)');
        // "the last one", not "the highest": the highest load order is drawn at the BOTTOM of
        // the stack, so "highest" read as "the one on top" - the opposite of the truth. The
        // position buttons make the direction clickable, so the tooltip has to say it plainly.
        expect(html).toContain('the last package that ships a key is the definition the world runs');
        expect(html).toContain('Ties in <code>loadOrder</code> break by id');
    });

    describe('the levels of the stack', () => {
        // The shape a real install has: every package at the same default order.
        const untuned = [
            mod('core-b', 1000), mod('core-a', 1000), mod('guest', 1000, { official: false })
        ];

        it('says out loud when nobody has set an order, and ranks by id', () => {
            const html = renderPackageList({ mods: untuned });
            expect(rowOrder(html)).toEqual(['core-a', 'core-b', 'guest']);
            expect(html).toContain('Every package sits at load order 1000');
            // Nothing to mark, so nothing is marked.
            expect(html).not.toContain('mods-shadow--level');
        });

        it('marks the one package somebody moved, and only that one', () => {
            const html = renderPackageList({ mods: [mod('late', 500), ...untuned] });
            expect(rowOrder(html)).toEqual(['late', 'core-a', 'core-b', 'guest']);
            expect(html).toContain('Levels in use: 500, 1000');
            expect(html.match(/mods-shadow--level/g)).toHaveLength(1);
            expect(html).toContain('>load order 500</span>');
        });

        it('marks nothing when every package carries its own order, and says why', () => {
            // Four levels among four packages is not four exceptions; marking them all
            // would be a marker that means nothing.
            const html = renderPackageList({ mods: stack });
            expect(html).not.toContain('mods-shadow--level');
            expect(html).toContain('every package sits at its own level, so none is out of place');
        });
    });

    describe('requirements', () => {
        it('are one chip each, and the chip carries the state of the install', () => {
            const byId = new Map(stack.map((m) => [m.id, m]));
            expect(requirementState('core-materials', byId)).toBe('on');
            expect(requirementState('core-off', byId)).toBe('off');
            expect(requirementState('core-ghost', byId)).toBe('missing');

            const html = renderPackageList({ mods: stack });
            expect(html).toContain('class="mods-req mods-req--on" data-jump="core-components"');
            // A state that is not the healthy one is said in words, not only colored:
            // grey alone is not a sentence, and red alone is not either.
            expect(html).toContain('class="mods-req mods-req--missing" data-jump="core-ghost"');
            expect(html).toContain('<span class="mods-req-state">missing</span>');
            expect(html).toContain('class="mods-req mods-req--off" data-jump="core-off"');
            expect(html).toContain('<span class="mods-req-state">off</span>');
            expect(html).not.toContain('requires core-components, core-ghost');
        });

        it('name the missing package as the reason the package cannot load', () => {
            const html = renderPackageList({ mods: stack });
            expect(html).toContain('core-ghost is not installed here');
        });
    });

    describe('shadow markers', () => {
        const plan = {
            fromVersion: 7,
            shadowed: [
                { kind: 'components', key: 'extraTorso', from: 'core-components', to: 'extra-sensitive-parts' },
                { kind: 'components', key: 'extraHead', from: 'core-components', to: 'extra-sensitive-parts' }
            ]
        };

        it('group the plan per package, in both directions', () => {
            const index = shadowIndex(plan);
            expect(index.over.get('extra-sensitive-parts')).toBe(2);
            expect([...index.under.get('core-components')]).toEqual(['extra-sensitive-parts']);
            expect(shadowIndex(null).over.size).toBe(0);
        });

        it('are absent until a plan has been read, and the legend says what to do', () => {
            const bare = renderPackageList({ mods: stack });
            // Named by their own classes: a level marker is not a shadow claim.
            expect(bare).not.toContain('mods-shadow--over');
            expect(bare).not.toContain('mods-shadow--under');
            expect(bare).toContain('Read the plan to see which package takes a key from which');

            const marked = renderPackageList({ mods: stack, plan });
            expect(marked).toContain('wins 2 shared key(s)');
            expect(marked).toContain('overlaid by extra-sensitive-parts');
            expect(marked).toContain('Markers from the plan against v7');
        });
    });

    describe('the description', () => {
        it('is always there, clamped until opened', () => {
            const closed = renderPackageList({ mods: stack });
            expect(closed).toContain('The core-materials package');
            expect(closed).toContain('mods-desc mods-desc--clamped');
            const open = renderPackageList({ mods: stack, expanded: new Set(['core-materials']) });
            expect(open).toContain('data-desc="core-materials"');
            expect(open.match(/class="mods-desc" data-desc="core-materials"/)).toBeTruthy();
        });

        it('says so when the manifest declares none, instead of leaving a blank hole', () => {
            const html = renderPackageList({ mods: [mod('mute', 1, { description: '' })] });
            expect(html).toContain('mods-desc--none');
            expect(html).toContain('declares no description');
            // And it is not a control: there is nothing there to expand.
            expect(html).not.toContain('data-desc="mute"');
        });

        it('escapes text that came out of a package file', () => {
            const hostile = [mod('evil', 1, { description: 'A "quote" <img src=x onerror=alert(1)>' })];
            const html = renderPackageList({ mods: hostile });
            expect(html).toContain('&quot;quote&quot; &lt;img src=x onerror=alert(1)&gt;');
            expect(html).not.toContain('<img');
        });
    });

    it('calls a package that is not core- somebody else\'s, and says so', () => {
        const html = renderPackageList({ mods: stack });
        expect(html).toContain('mods-flag--official');
        expect(html).toContain('mods-flag--third');
        expect(html).toContain('mods-flag--off');
    });

    it('keeps the empty install honest', () => {
        expect(renderPackageList({ mods: [] })).toContain('No package in');
    });
});

describe('the position controls: moving a package in the stack', () => {
    /** Every rendered move button, in DOM order. */
    const moveButtons = (html) => [...html.matchAll(/<button[^>]*class="mods-move"[^>]*>/g)].map((m) => ({
        id: /data-move="([^"]+)"/.exec(m[0])?.[1],
        direction: /data-direction="([^"]+)"/.exec(m[0])?.[1],
        disabled: /\sdisabled(\s|>)/.test(m[0]),
        title: /title="([^"]*)"/.exec(m[0])?.[1] ?? ''
    }));

    /** The move buttons of one package. */
    const buttonsFor = (html, id) => moveButtons(html).filter((b) => b.id === id);

    const rows = [
        mod('core-atlas', 1000),
        mod('core-forge', 2000),
        mod('extra-glyph', 3000)
    ];

    it('puts one button per direction under the rank, not in the actions column', () => {
        const html = renderPackageList({ mods: rows });
        const glyphs = buttonsFor(html, 'extra-glyph');
        expect(glyphs.map((b) => b.direction)).toEqual(['up', 'down']);
        // They live in the ordinal gutter: an operator aiming a package aims at its number.
        const gutter = html.match(/class="mods-ordinal"[^>]*>\d+<span class="mods-move-group">/);
        expect(gutter).not.toBeNull();
    });

    it('says in the title which way the stack runs, because the arrow says the opposite', () => {
        const html = renderPackageList({ mods: rows });
        const [up, down] = buttonsFor(html, 'core-forge');
        // `^` is a demotion and `v` a promotion: the list composes top to bottom and the LAST
        // package that ships a key is the one the world runs. A bare arrow would lie.
        expect(up.title).toMatch(/earlier.*loses a shared key/);
        expect(down.title).toMatch(/later.*wins any shared key/);
    });

    it('disables the button at each end and says why', () => {
        const html = renderPackageList({ mods: rows });
        const top = buttonsFor(html, 'core-atlas');
        expect(top.find((b) => b.direction === 'up').disabled).toBe(true);
        expect(top.find((b) => b.direction === 'up').title).toMatch(/already at the top/);
        expect(top.find((b) => b.direction === 'down').disabled).toBe(false);
        const bottom = buttonsFor(html, 'extra-glyph');
        expect(bottom.find((b) => b.direction === 'down').disabled).toBe(true);
        expect(bottom.find((b) => b.direction === 'down').title).toMatch(/already at the bottom/);
    });

    it('offers no position control in alphabetical order', () => {
        // In that view the rows are drawn one way and ranked another, so an arrow would move a
        // package relative to neighbours that are not its neighbours in the stack.
        const html = renderPackageList({ mods: rows, sortMode: SORT_NAME });
        expect(moveButtons(html)).toEqual([]);
        expect(renderPackageList({ mods: rows, sortMode: SORT_STACK })).not.toBe(html);
    });

    it('escapes an id written by somebody else, in the attribute and the title', () => {
        const hostile = [mod('e"x><img', 1000)];
        const html = renderPackageList({ mods: hostile });
        expect(html).not.toContain('<img');
        expect(html).toContain('e&quot;x&gt;&lt;img');
    });

    describe('moveSummary', () => {
        const payload = (extra) => ({
            id: 'extra-glyph', direction: 'down', rank: 2, total: 6, pending: true,
            appliesAt: 'next round boundary', shadowChanged: [], shadowChangedTruncated: false,
            ...extra
        });

        it('says where it landed, when it applies, and that nothing was reassigned', () => {
            expect(moveSummary('extra-glyph', payload()))
                .toBe('extra-glyph moved down to position 2 of 6 - takes effect at the next '
                    + 'round boundary. No shared key changed hands.');
        });

        it('names the keys that changed owner, both sides of the change', () => {
            const line = moveSummary('x', payload({
                shadowChanged: [{ kind: 'components', key: 'knife', was: 'glyph', now: 'forge' }]
            }));
            expect(line).toContain('Owner changed: components/knife now forge');
        });

        it('caps the names and says how many it dropped', () => {
            const many = Array.from({ length: 9 }, (_, i) => ({
                kind: 'components', key: `k${i}`, was: 'a', now: 'b'
            }));
            const line = moveSummary('x', payload({ shadowChanged: many }));
            expect(line).toContain('components/k5');
            expect(line).not.toContain('components/k6');
            expect(line).toContain('(+3 more)');
        });

        it('does not claim a boundary for a change the server did not queue', () => {
            expect(moveSummary('x', payload({ pending: false }))).toContain('the world already matches');
        });
    });
});
