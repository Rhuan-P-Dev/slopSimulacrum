# Decision: the inspector shows the request that was sent, not a recomposition

Date: 2026-11-03 (recorded in the commit that implements this)

> **Followed up the same day** by
> [`round-scoped-context.md`](round-scoped-context.md). The rule below — show the
> stored request, never a recomposition — is what that change did to the rest of
> the panel: the "Room tail" section is **removed as a standing section** (a
> view nobody was sent is not worth a title), and with the second kind of event
> read gone there are no longer two frame columns. It survives as a **fallback
> only** — `Context (recomposed now — NOT sent to any agent)`, rendered when the
> payload carries no stored request, which is the normal state right after a
> restart because the transcript is in memory. The report that prompted this
> note came back in the opposite direction then: a panel whose only content is a
> recomputed system prompt reads as "the context is missing". A titled
> recomposition is honest; an empty panel is not.
>
> Measured on the real composition: after one `runRound`, `describeAgentView`
> returns `lastRequest = { round: 0, messages: 1, system: 2046 chars }` — the
> server half was never the broken part. A server process older than this view
> answers no `lastRequest` field at all, and the panel now says that instead of
> saying "nothing has been sent". Where this note describes `observe: false` as
> rendering `… tail (newest first, not scoped to a round)`, that label no longer
> exists: a frame naming a round over rows that are not that round's was the bug,
> and the fix was to stop reading out of round, not to relabel it.

## The report

Owner: "the chat keeps showing lines from earlier rounds, and `=== WORLD
FAILURES ===` too", with a pasted context block: `=== ROOM CHAT ===` carried
three lines said in different rounds, `=== WORLD FAILURES ===` carried a
`Round 4: ... touch discarded` warning, and the change block listed ten rows -
all of it under `this round (round 7)`.

## What the pasted block actually was

Not a prompt. There are exactly three readers of
`LlmContextController.buildContext`:

| reader | `observe` | whose window |
| --- | --- | --- |
| `LLMAgentController.runRound` (the agent's turn) | `true` | the agent's own, **consuming** |
| `LLMAgentController.describeAgentView` (`GET /llm/agent/:entityId`) | `false` | the **room's** tails, stateless |
| `GET /llm/context?entityId=` | `false` | the **room's** tails, stateless |

The dump has the fingerprint of a stateless reader: several rounds of chat, a
warn from three rounds back, and exactly ten delta rows (`LLM_CONTEXT_MAX_DELTAS`
sliced out of the resident ring). A brain read of the same world shows one chat
line and one-to-two delta rows per round - verified by running the real
composition with a scripted provider: the brain received one round's worth every
round, while the stateless read grew 1, 2, 3 lines as rounds accumulated.

A live turn also cannot fall behind and accumulate a backlog: the planning
barrier closes only when the agent promise settles
(`src/controllers/core/TurnSystemController.js`, no deadline). With the agent's
turn withheld, the round does not advance at all.

The defect was ours: `current-round-events.md` put a round frame - "said in this
room this round (round 7)" - on top of every event section, including the
stateless ones, and the panel titled that section "World Context (narrative the
LLM reads)". An operator reading the truthful label over a tail of several rounds
sees a broken feature.

## Decision

Owner's direction: the inspector must show **exactly what is being sent to the
LLM**.

1. **`describeAgentView.lastRequest` - the exact request, reconstructed.** An
   outgoing request is `_transcriptFor(entity)` + the round's anchor
   (`round N` + the context snapshot) + the in-round feedback of every earlier
   call. All three are stored or derivable:

   - the replay - `_transcriptFor(entity, { upToRound: N })`, a new optional
     bound that keeps only the rounds stored before `N`, which is exactly what
     was in the buffer when that request went out;
   - the anchor - `round N\n\n<snapshot>`, the snapshot being the `context`
     field `_storeTranscript` already saves per round;
   - the feedback - rebuilt with `_buildFeedbackMessages`, the very builder
     `runRound` appends with, over `groups.slice(0, -1)` (the last group's
     assistant message is a *response*, never part of a request).

   `test/unit/LLMAgentController.test.js` pins it against the message array a
   provider actually received, with three rounds and two calls per round. Both
   halves of the reconstruction were mutation-tested (dropping the feedback, and
   replaying without the round bound) - each mutation fails the pin.

2. **The recomposed view stays, and stops pretending.** Under `observe: false`
   the four event frames no longer name a round:

   | section | brain (`observe: true`) | debug read (`observe: false`) |
   | --- | --- | --- |
   | WORLD FAILURES | `events of this round (round 7):` | `world failure tail (newest first, not scoped to a round):` |
   | HAPPENED TO YOU | `events of this round (round 7):` | `room event tail (newest first, not scoped to a round):` |
   | YOUR WORLD changes | `this round (round 7):` | `this room's recent changes (newest first, not scoped to a round):` |
   | ROOM CHAT | `said in this room this round (round 7):` | `room transcript tail (newest first, not scoped to a round):` |

   The Agent View section is titled **"Room tail (recomposed now - NOT sent to
   any agent)"**, and the exact request is its own section, rendered above the
   transcript.

3. **The panel renders the tail of the array (12 messages) and says how many it
   skipped.** The replay window is a count, not a budget
   (`llm-memory-window.md`), so a long-running world can replay thousands of
   rounds; printing every message of the reconstructed request is the freeze that
   note already warns about.

## Alternatives rejected

- **Read the agent's own window in the inspector.** The window is consumed by the
  agent's turn; a peek at it shows `(none)` - the 2026-11-02 incident, recorded
  in `current-round-events.md`.
- **Store the whole outgoing request per round.** The replay window is a count
  (10000 rounds), so a per-round copy of the prompt is megabytes per agent, for
  content the stored anchor already carries.
- **Filter the room tail to the reader's round.** Empties the panel at round
  start and deletes the only thing the tail is for: what the room holds.
- **Leave the round label on the tail.** That is what produced this report.

## Consequences

- The panel now carries two views of different truth: `lastRequest` is the
  prompt; `context` is the room. The titles say which is which.
- `system` and `tools` accompany the reconstructed messages **recomputed at view
  time** (they are static per config, and storing them per round is the
  megabyte bill above). The messages array itself is exact.
- Exactness has stated limits: the round must still be resident in the transcript
  buffer, and `LLM_REPLAY_ROUNDS` must not have changed since. A legacy entry
  with no round number cannot be dated, so its anchor cannot be rebuilt -
  `lastRequest` is `null` rather than a guess.
- `GET /llm/context` keeps composing a room tail (that is its contract); it is
  now labeled as one inside the text, so it cannot be mistaken for a prompt.

## Files

- `src/controllers/networking/LLMAgentController.js` - `_lastSentRequest`,
  `_transcriptFor({ upToRound })`, `describeAgentView.lastRequest`.
- `src/controllers/networking/LlmContextController.js` - `_eventFrame`, the
  unscoped tail frames, `observing` threaded into `_render`.
- `public/js/AgentViewPanel.js` - "Last request to the LLM" section, "Room tail"
  retitling, `RENDERED_MESSAGE_TAIL`.
- `src/routes/llmRoutes.js` - endpoint contract.

## Verification

- `test/unit/LLMAgentController.test.js` - `lastRequest` equals the array the
  provider received (3 rounds x 2 calls), is `null` before any send and for an
  unknown agent, and keeps the round-anchored form.
- `test/unit/LlmContextRenderer.test.js` - no event frame claims a round under
  `observe: false`; the brain keeps its round frames.
- `test/integration/happenedToYou.test.js` - the debug reader still shows the
  blow, and says it is a tail.
- `test/unit/AgentViewPanel.client.test.js` - the request section renders the
  round, the roles and the anchor verbatim; the room view is titled a room tail;
  a 40-message request renders as a 12-message tail with the skipped count
  stated and the live anchor open. (This file caught a real defect in the
  message numbering: `total - skipped + i + 1` double-counted, so with no
  messages skipped the live anchor was numbered `#8/4` and never recognized as
  the anchor - it would have shipped folded.)
