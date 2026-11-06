/**
 * AgentBodyPanel (CLIENT) — what the "Save" click actually posts.
 *
 * The regression this pins: `bb21855` made `_workingDesign` a working copy of
 * the design itself (`structuredClone(payload.body)`) so the tree's "hides with
 * parent" tick boxes could decide what hangs behind its cloth, but `_save()` kept
 * posting `design.body` — a second unwrap of an already-unwrapped object. The
 * request went out with no body at all, and the server answered:
 *   "The saved design failed validation: \"blueprintId\" must be a non-empty
 *    string; \"rationale\" must be a non-empty string; \"structure\" must be the
 *    body tree object"
 * i.e. Save could never write a design from that commit on.
 *
 * `_save()` needs no DOM: the constructor is field-only, `_setStatus` guards on
 * `_status`, and the buttons are plain objects here. `fetch` is stubbed.
 *
 * @module test/unit/AgentBodyPanel.client
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { AgentBodyPanel } from '../../public/js/AgentBodyPanel.js';

/** A design as `/agent-body/create` returns it inside `payload.body`. */
function designFixture() {
    return {
        blueprintId: 'Vespera',
        rationale: 'Built for a humid room: little cloth, wide contact.',
        structure: {
            component: 'torso',
            children: [
                { component: 'breast', mount: { type: 'surface', slot: 'chest' } },
                { component: 'shirt', mount: { type: 'wrap', slot: 'torso' }, children: [] }
            ]
        },
        components: [
            { name: 'shirt', form: { volume: 'small' }, materials: [{ material: 'cotton', fraction: 1 }] }
        ]
    };
}

/**
 * A panel that has just rendered a design — the state Save acts on.
 * @param {Object|null} design - the working design, or null for "never rendered".
 * @returns {AgentBodyPanel}
 */
function panelWithWorkingDesign(design) {
    const panel = new AgentBodyPanel();
    panel._saveButton = { disabled: design === null };
    panel._workingDesign = design;
    return panel;
}

/** Stubs fetch with a successful save response and returns the spy. */
function stubSaveOk() {
    return vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ saved: true, blueprintId: 'Vespera', blueprintOverwritten: [], newComponents: [] })
    });
}

/** The JSON object the panel posted, parsed back out of the fetch call. */
function postedDesign(fetchSpy) {
    const [, init] = fetchSpy.mock.calls[0];
    return JSON.parse(init.body);
}

describe('AgentBodyPanel.save (what Save posts)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('posts the design itself, not a field of it', async () => {
        const design = designFixture();
        const fetchSpy = stubSaveOk();
        vi.stubGlobal('fetch', fetchSpy);

        await panelWithWorkingDesign(design)._save();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe('/agent-body/save');
        const posted = postedDesign(fetchSpy);
        // The three fields the server validates — present because `design` is the
        // design, not `design.body`.
        expect(posted.blueprintId).toBe('Vespera');
        expect(posted.rationale).toBeTruthy();
        expect(posted.structure.component).toBe('torso');
        expect(posted).toEqual(design);
    });

    it('carries the operator tick-box edit on the tree into the saved design', async () => {
        const design = designFixture();
        // What the "hides with parent" box writes (`_setChecked`): the mount mark the
        // world reads to keep a part out of the round prose while its parent is clothed.
        design.structure.children[0].hidesWithParent = true;
        const fetchSpy = stubSaveOk();
        vi.stubGlobal('fetch', fetchSpy);

        await panelWithWorkingDesign(design)._save();

        expect(postedDesign(fetchSpy).structure.children[0].hidesWithParent).toBe(true);
    });

    it('posts nothing when no design was rendered', async () => {
        const fetchSpy = stubSaveOk();
        vi.stubGlobal('fetch', fetchSpy);

        await panelWithWorkingDesign(null)._save();

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('keeps Save clickable after a failed save', async () => {
        const fetchSpy = vi.fn().mockResolvedValue({
            ok: false,
            status: 422,
            json: async () => ({ error: { message: 'the world rejected it' } })
        });
        vi.stubGlobal('fetch', fetchSpy);
        const panel = panelWithWorkingDesign(designFixture());

        await panel._save();

        // The button was disabled while in flight and re-enabled afterwards, so a
        // rejected save is retryable without re-running the LLM call.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(panel._saveButton.disabled).toBe(false);
        expect(panel._saveInFlight).toBe(false);
    });
});
