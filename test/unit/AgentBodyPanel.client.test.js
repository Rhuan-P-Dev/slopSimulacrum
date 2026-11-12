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

/**
 * Stubs fetch with a successful save response and returns the spy. The payload is the
 * package report the server answers with now: a directory under data/mods/, the kinds it
 * carries, and nothing about the world having changed.
 * @param {Object} [overrides] - fields to change for one case (e.g. a shadowing overlap).
 * @returns {Function}
 */
function stubSaveOk(overrides = {}) {
    return vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
            saved: true,
            packageId: 'body-vespera',
            dir: 'data/mods/body-vespera',
            version: '1.0.0',
            created: true,
            content: ['blueprints'],
            blueprintId: 'Vespera',
            newComponents: [],
            overlapsOfficial: [],
            applied: false,
            appliesVia: 'POST /mods/apply',
            ...overrides
        })
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

    it('names the package it wrote and points at the Mods panel, because writing is not applying', async () => {
        const statuses = [];
        const panel = panelWithWorkingDesign(designFixture());
        panel._setStatus = (text) => statuses.push(text);
        vi.stubGlobal('fetch', stubSaveOk());

        await panel._save();

        expect(statuses.at(-1)).toContain('body-vespera');
        expect(statuses.at(-1)).toContain('Apply it in the Mods panel');
        // No claim that the world moved: nothing here reloads or applies anything.
        expect(statuses.at(-1)).not.toMatch(/reload/i);
    });

    it('says so when the package shadows a definition the official packages also define', async () => {
        const statuses = [];
        const panel = panelWithWorkingDesign(designFixture());
        panel._setStatus = (text) => statuses.push(text);
        vi.stubGlobal('fetch', stubSaveOk({
            overlapsOfficial: [{ kind: 'blueprints', key: 'torso' }]
        }));

        await panel._save();

        expect(statuses.at(-1)).toContain('1 definition(s) the official packages also define');
        expect(statuses.at(-1)).toContain('above them in the Mods stack');
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

// ================================================================
// The live stage list: the owner's ask is that every step of the
// design pipeline is visible on the frontend. The server reports one
// AGENT_BODY_DESIGN_STEP socket event per stage attempt; the panel
// filters by the card it is designing and renders the run.
describe('AgentBodyPanel stage list (the four pipeline stages, visible on the frontend)', () => {
    /**
     * A panel that is designing `cardId`, with a body element stubbed
     * (the panel needs only the `innerHTML` sink for the stage list).
     * @param {string} cardId
     * @returns {AgentBodyPanel}
     */
    function panelDesigning(cardId) {
        const panel = new AgentBodyPanel();
        panel._body = { innerHTML: '' };
        panel._designingCardId = cardId;
        panel._designEvents = [];
        return panel;
    }

    it('renders one row per reported stage; the last attempt per stage wins', () => {
        const panel = panelDesigning('nova');
        const step = (n, stepName, status, extra = {}) => panel.onDesignStep({
            runId: 'r1',
            cardId: 'nova',
            step: stepName,
            stepNumber: n,
            totalSteps: 4,
            attempt: 1,
            maxAttempts: 3,
            status,
            ...extra
        });
        step(1, 'concept', 'started');
        step(2, 'anatomy', 'started');
        step(1, 'concept', 'retrying', { attempt: 1, error: '"rationale" must be a non-empty string' });
        step(1, 'concept', 'succeeded', { attempt: 2, latencyMs: 340 });
        step(2, 'anatomy', 'succeeded', { latencyMs: 512 });
        step(3, 'organs', 'started');
        step(3, 'organs', 'retrying', { attempt: 2, error: 'grants no stat and marks no flag' });
        step(3, 'organs', 'failed', { attempt: 3, error: 'stage "organs" gave up: grants no stat and marks no flag' });

        const html = panel._body.innerHTML;
        expect(html, 'the section names the card being designed').toContain('Design stages — nova');
        expect(html, 'the corrected stage shows its final attempt').toContain('1. <strong>concept</strong> ✓ 2 attempt(s), 340 ms');
        expect(html, 'the one-shot stage shows its single attempt').toContain('2. <strong>anatomy</strong> ✓ 1 attempt(s), 512 ms');
        expect(html, 'a failed stage says where it stopped and why').toContain(
            '3. <strong>organs</strong> ✗ after 3 attempt(s) — stage &quot;organs&quot; gave up: grants no stat and marks no flag'
        );
        expect(html, 'a stage the run never reached is not shown as waiting after it stopped')
            .not.toContain('outfit');
    });

    it('shows the not-yet-reached stages as waiting while the run is in flight', () => {
        const panel = panelDesigning('nova');
        panel.onDesignStep({
            runId: 'r2', cardId: 'nova', step: 'concept', stepNumber: 1,
            totalSteps: 4, attempt: 1, maxAttempts: 3, status: 'started'
        });
        const html = panel._body.innerHTML;
        expect(html, 'the running stage shows its attempt').toContain('1. <strong>concept</strong> → attempt 1/3');
        expect(html, 'later stages wait in order').toContain('… waiting');
    });

    it('drops stage events from another card (a design started elsewhere)', () => {
        const panel = panelDesigning('nova');
        panel.onDesignStep({
            runId: 'r3', cardId: 'nova', step: 'concept', stepNumber: 1,
            totalSteps: 4, attempt: 1, maxAttempts: 3, status: 'started'
        });
        const before = panel._body.innerHTML;
        panel.onDesignStep({
            runId: 'r9', cardId: 'quiet', step: 'outfit', stepNumber: 4,
            totalSteps: 4, attempt: 1, maxAttempts: 3, status: 'started'
        });
        expect(panel._designEvents, 'the foreign event is not stored').toHaveLength(1);
        expect(panel._body.innerHTML, 'the list is untouched').toBe(before);
    });

    it('drops same-card events from a different run (run correlation; a second design for the same card cannot interleave)', () => {
        const panel = panelDesigning('nova');
        // First design (run r1) is in flight and reporting.
        panel.onDesignStep({
            runId: 'r1', cardId: 'nova', step: 'concept', stepNumber: 1,
            totalSteps: 4, attempt: 1, maxAttempts: 3, status: 'started'
        });
        const before = panel._body.innerHTML;
        // A second-run event for the same card (run r9) must not interleave, even
        // though the cardId filter on its own would accept it.
        panel.onDesignStep({
            runId: 'r9', cardId: 'nova', step: 'outfit', stepNumber: 4,
            totalSteps: 4, attempt: 1, maxAttempts: 3, status: 'started'
        });
        expect(panel._designEvents, 'the out-of-run event is not stored').toHaveLength(1);
        expect(panel._body.innerHTML, 'the list keeps only the r1 row').toBe(before);
    });

    it('shows the final per-stage LLM call records (meta.stages) after a completed design', () => {
        const panel = panelDesigning('nova');
        panel._render({
            card: { cardId: 'nova', name: 'Nova', description: '', personality: '' },
            body: designFixture(),
            meta: {
                kind: 'agent-body-design-pipeline',
                stages: [
                    { step: 'concept', kind: 'agent-body-concept', version: '1.0.0', model: 'test-model', finishReason: 'stop', latencyMs: 340, attempts: 2, promptMessages: [{ role: 'system', content: 'concept system prompt' }, { role: 'user', content: 'concept user prompt' }] },
                    { step: 'anatomy', kind: 'agent-body-anatomy', version: '1.0.0', model: 'test-model', finishReason: 'stop', latencyMs: 512, attempts: 1, promptMessages: [] },
                    { step: 'organs', kind: 'agent-body-organs', version: '1.0.0', model: 'test-model', finishReason: 'stop', latencyMs: 90, attempts: 1, promptMessages: [] },
                    { step: 'outfit', kind: 'agent-body-outfit', version: '1.0.0', model: 'test-model', finishReason: 'stop', latencyMs: 120, attempts: 1, promptMessages: [] }
                ]
            },
            organsByComponent: {}
        });
        const html = panel._body.innerHTML;
        expect(html, 'the section names the four calls').toContain('LLM calls (4 stages — one call each, fresh context)');
        expect(html).toContain('1. <strong>concept</strong> <span class="agent-body-stat">agent-body-concept v1.0.0</span>');
        expect(html).toContain('2. <strong>anatomy</strong> <span class="agent-body-stat">agent-body-anatomy v1.0.0</span>');
        expect(html).toContain('3. <strong>organs</strong> <span class="agent-body-stat">agent-body-organs v1.0.0</span>');
        expect(html).toContain('4. <strong>outfit</strong> <span class="agent-body-stat">agent-body-outfit v1.0.0</span>');
        expect(html, 'the prompt capture is shown per stage').toContain('Prompt — concept');
    });
});
