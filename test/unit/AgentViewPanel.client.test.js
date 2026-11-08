/**
 * AgentViewPanel (CLIENT) unit tests — the two context views.
 *
 * The panel used to title a stateless ROOM composition "World Context
 * (narrative the LLM reads)". That title is how a correct agent read got
 * reported as a broken feature: the operator opened the tab, saw three rounds of
 * chat under "this round (round 7)", and concluded the round-scoped context had
 * failed (wiki/decisions/inspector-shows-last-request.md). What replaced it:
 * the request section IS the prompt; the room recomposition survives only as a
 * fallback titled `Context (recomposed now — NOT sent to any agent)`, and only
 * when no request is stored at all (after a restart there is none until the
 * agent's next round) — a panel showing nothing but a system prompt reads as a
 * missing context, which is the report of 2026-11-03. And a long replay
 * renders as a tail with the skipped count stated — never silently dropped,
 * never dumped whole.
 *
 * Pure render methods only: no DOM, the suite runs in node.
 *
 * @module test/unit/AgentViewPanel.client
 */

import { describe, it, expect } from 'vitest';
import { AgentViewPanel } from '../../public/js/AgentViewPanel.js';

const panel = () => new AgentViewPanel({});

describe('AgentViewPanel — the exact request section', () => {

    it('renders the round, every role and the content that was sent', () => {
        const html = panel()._lastRequestSection({
            lastRequest: {
                round: 7,
                system: 'You are Nova.',
                messages: [
                    { role: 'user', content: 'round 6: the earlier anchor' },
                    {
                        role: 'assistant', content: null,
                        tool_calls: [{ id: 'c1', function: { name: 'move', arguments: '{"dx":1}' } }]
                    },
                    { role: 'tool', content: '{"success":true}' },
                    { role: 'user', content: 'round 7: the live anchor' }
                ]
            }
        });
        expect(html).toContain('Last request to the LLM (round 7)');
        expect(html).toContain('reconstructed from the stored transcript (not recomposed)');
        // The round-anchored form survives: delimiters and all.
        expect(html).toContain('round 7: the live anchor');
        expect(html).toContain('round 6: the earlier anchor');
        expect(html).toContain('tool_call move');
        expect(html).toContain('dx');
        expect(html).toContain('content: null (tool-call message)');
        expect(html).toContain('You are Nova.');
        expect(html).toContain('>user<');
        expect(html).toContain('#4/4');
    });

    it('names why there is no request, instead of a bare "nothing"', () => {
        // "Nothing has been sent to this agent yet" read as a broken feature. The
        // reason is knowable and is stated: the transcript is in memory, so a
        // restart empties it until the agent's next round
        // (wiki/decisions/round-scoped-context.md).
        const html = panel()._lastRequestSection({ lastRequest: null });
        expect(html).toContain('No LLM round has been stored for this agent since the server started');
        expect(html).toContain('a restart empties it');
        // No section here pretends to be a prompt.
        expect(html).not.toContain('narrative the LLM reads');
    });

    it('renders the tail of a long replay and states how many messages it skipped', () => {
        // The replay window is a COUNT (llm-memory-window.md): a long-running
        // world hands the panel thousands of messages. Rendering them all is the
        // freeze that note already warns about; rendering them silently would be
        // a different lie.
        const messages = Array.from({ length: 40 }, (_, i) => ({
            role: i % 2 === 1 ? 'user' : 'assistant', content: `MSG-${String(i).padStart(2, '0')}`
        }));
        const html = panel()._lastRequestSection({
            lastRequest: { round: 9, system: null, messages }
        });
        expect(html).toContain('28 earlier messages of this request not rendered');
        expect(html).toContain('Total: 40');
        expect(html).toContain('MSG-39');
        expect(html).toContain('MSG-28');
        expect(html).not.toContain('MSG-27');
        expect(html).not.toContain('MSG-00');
        // The live anchor (the last user message) renders open; every replayed
        // message stays collapsed — 12 shown, 11 folded.
        expect(html.split('<details').length - 1).toBe(11);
        expect(html).toContain('#40/40');
    });
});

describe('AgentViewPanel — the panel never shows a context without saying what it is', () => {

    /** Render a payload into a string (the panel writes into `_content`). */
    const render = (payload) => {
        const p = panel();
        const sink = { innerHTML: '' };
        p._content = sink;
        p._render(payload);
        return sink.innerHTML;
    };

    const CONTEXT_TEXT = 'said in this room this round (round 9):\nNova: hi';
    const base = {
        entityId: 'ent-1',
        name: 'Nova',
        room: { id: 'room-main', name: 'The Entrance Hall' },
        context: { text: CONTEXT_TEXT, stats: { chars: 42, budgetChars: 8000 } }
    };

    it('with a stored request, the recomposition is not shown: one context, and it is the true one', () => {
        const html = render({
            ...base,
            systemPrompt: 'SYS',
            lastRequest: {
                round: 9,
                system: 'SYS',
                messages: [{ role: 'user', content: 'round 9\n\n=== YOUR STATE ===\nName: Nova' }]
            }
        });
        expect(html).toContain('Last request to the LLM (round 9)');
        expect(html).toContain('=== YOUR STATE ===');
        // The live composition is not shown beside it: two context blocks, one of
        // them sent to nobody, is the confusion this panel already had.
        expect(html).not.toContain('Nova: hi');
        expect(html).not.toContain('recomposed now — NOT sent');
        // And the standalone system prompt yields to the copy inside the request.
        expect(html).not.toContain('System Prompt (recomputed now)');
    });

    it('without a stored request, the live composition appears — titled as not a prompt', () => {
        // The transcript lives in memory, so right after a restart there is no
        // request to show. A panel with only a system prompt in it reads as "the
        // context is missing", which is how this was reported (2026-11-03): the
        // operator sees no context at all. So the room composition appears here,
        // under a title that cannot be misread as a send
        // (wiki/decisions/round-scoped-context.md).
        const html = render({ ...base, systemPrompt: 'SYS', lastRequest: null });
        expect(html).toContain('a restart empties it');
        expect(html).toContain('Context (recomposed now — NOT sent to any agent)');
        expect(html).toContain('Nova: hi');
        expect(html).toContain('context 42 chars');
        expect(html).toContain('No model received this');
        // Never the old title, which claimed the composition WAS the narrative.
        expect(html).not.toContain('narrative the LLM reads');
    });

    it('a server that answered no `lastRequest` field at all is named as the cause', () => {
        // A running process older than this view: the field is absent, not empty.
        // "No round has run" would send the operator off to look for a broken
        // agent instead of restarting the server.
        const html = render({ ...base, systemPrompt: 'SYS' });
        expect(html).toContain('older than this view');
        expect(html).toContain('Restart the server');
        expect(html).toContain('Nova: hi');
    });

    it('no request and no context says so plainly, without inventing a section', () => {
        const html = render({ entityId: 'ent-1', name: 'Nova', systemPrompt: null, lastRequest: null });
        expect(html).toContain('The transcript is in memory');
        expect(html).not.toContain('<pre');
    });
});
