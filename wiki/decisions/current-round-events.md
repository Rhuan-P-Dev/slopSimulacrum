# Decision: every event an agent reads belongs to the round it is reading in

Date: 2026-11-03 (recorded in the commit that implements this)

> **Partly superseded the same day** by
> [`round-scoped-context.md`](round-scoped-context.md). The frame labels and the
> rule that a row carries no round of its own still hold. The *delivery
> mechanism* — per-agent cursors over the event log and the room transcript — is
> removed: a cursor is a backlog generator, an agent that skipped two rounds got
> both of them in one turn under a header naming one. Read the newer note before
> touching either store.

## The request

Owner asked to change how the agent sees context: "a chat turn can carry events
from other rounds; the events mentioned in the chat turn must be directly from
the current round." Three choices were asked and given in that session, and they
are recorded here because they are the arguable part:

- **Re-anchor, do not filter.** What the agent reads IS this round's news: the
  only round number in the context is the reader's round, not the round the
  event was executed in.
- **Delivery changes for the two tail-based streams, not just their labels.**
  `=== WORLD FAILURES ===` and `=== ROOM CHAT ===` get a per-agent cursor, the
  way the perception stream already had one.
- **The round moves from the row to the section header.** `HAPPENED TO YOU`
  loses its `[round N]` prefix; the change block inside `YOUR WORLD` is renamed
  from `since you last looked:` to `this round:`.

## Why "show only rows whose round equals the current round" was not the answer

The turn system makes the mismatch structural, not accidental
(`src/controllers/core/TurnSystemController.js`):

| moment | what happens | round stamped |
| --- | --- | --- |
| round N opens | `agentFn(npcEntityId, N)` fires - the LLM turn, and `buildContext` inside it | `roundNumber = N` |
| planning closes | RESOLUTION executes the queued actions, synchronously, still inside round N | `round = N` (`ActionAttributionStore`, stamped by the consequence dispatcher) |
| next tick | round N+1 opens and its agents read | they read rows stamped `[round N]` |

At the moment an agent reads, the events of round N do not exist yet - that
round's actions have not resolved. An equality filter on `round` therefore
renders `(none)` in every event section of every turn: an agent that sees
nothing is not an agent that sees the current round.

## Before

- `=== WORLD FAILURES ===` read `getRecentEvents(WORLD_EVENTS_MAX_LIMIT)`: the
  warn-level tail of one global ring. Reader-independent, so it re-delivered
  warnings the agent had been shown in earlier rounds, and each line was
  prefixed with its `[tick]`.
- `=== ROOM CHAT ===` read `getRoomChatMessages(roomUid, limit)`: the room's
  transcript tail. Every round re-read the lines the agent had already answered.
- `=== HAPPENED TO YOU ===` and `since you last looked:` read the perception
  window (per-agent cursor - already reader-relative), each row prefixed with
  `[round N]` from the round stamped at execution (commit 23edc20).
- No section said which round it was written for. The only round in the request
  was the `round N` anchor of the user message (`round-anchored-transcript.md`).

## After

- **Frame.** Each event section prints one frame line naming the round the
  reader is in, read once per `buildContext` from the turn system
  (`subControllers.turns`, the same path `PerceptionController._currentRound`
  uses). This is the frame of a **brain** read (`observe: true`); a debug read
  names no round - see the follow-up at the end of this note:
  - `=== WORLD FAILURES ===` / `=== HAPPENED TO YOU ===` -> `events of this round (round 7):`
  - `=== ROOM CHAT ===` -> `said in this room this round (round 7):`
  - `YOUR WORLD` change block -> `this round (round 7):`
  With no turn system wired (or a round that is not a whole number) the label
  stays and the number does not: a round is never invented.
- **Delivery.** `WorldEventLogController` and `RoomChatController` each stamp a
  monotonic `sequence` on write and hold a `Map<entityId, cursor>`. The
  consuming reads are `getRecentForAgent(entityId, { limit })` and
  `getMessagesForAgent(entityId, roomId, { limit })`, published on the facade as
  `getRecentEventsForAgent` / `getRoomChatMessagesForAgent`. Acknowledgment
  covers the whole resident window (a line the `limit` tail shed was part of the
  world the agent looked at; a budget drop must not become a permanent backlog),
  and for chat it is room-scoped (reading room A does not consume B).
  `getRecent()` and `getMessages()` stay stateless, so `GET /world-events`,
  `GET /rooms/:id/chat` and the dev inspector (`observe: false`) read a tail
  without eating what an agent is about to see - the split the perception stream
  documents after its 2026-10-21 and 2026-11-02 incidents.
- **Rows carry no provenance stamp.** No `[round N]` on `HAPPENED TO YOU`, no
  `[tick]` on `WORLD FAILURES`: inside a block whose header names the round, a
  per-row stamp either restates the header or contradicts it. The execution
  round and the tick stay on the data mirror (`data.happenedToYou[].round`,
  `GET /world-events`), which is what the dev inspector reads.

## What was deliberately not changed

- Perception cursor semantics (the window, the baseline acknowledgment, the
  room-scoped advance) - only the label of the block it feeds.
- The `ActionAttributionStore` round stamp: still stamped at execution, still
  `null` without a turn system, still on the row data. Only the render stopped
  printing it.
- The budget cascade order and caps, the section set and order, the delta
  summaries, the transcript replay (`round-anchored-transcript.md`) and the
  `LLM_REPLAY_ROUNDS` window.
- `PerceptionController._currentRound()` stamps `entry.roundNumber` at flush
  time; that entry field belongs to the UI's per-entry labeling and is
  untouched.

## Consequences that are now true

- Two more state owners hold reader cursors (`WorldEventLogController`,
  `RoomChatController`). Both are bounded by the number of readers, both are
  cleared by `clear()`/`restore()`, and neither is persisted: a restarted server
  re-delivers the resident ring once, exactly as it does to an agent that never
  looked.
- **An agent no longer sees the room's old lines.** Conversational continuity
  for the model now comes from the transcript replay of its own turns, not from
  a re-read of everyone's. An NPC that spoke in round N sees its own line once,
  in round N+1.
- The cursor is shared across rooms, so lines older than the agent's last read
  are not surfaced when it walks into a new room (only lines that post-date it).
  This is the same property the perception cursor already had.
- Two new facade methods appear on the pinned public surface, each with a
  stateless sibling that did not change.
- Four extra short lines per context (~120 chars) - the frame lines.
- A debug reader that wants "what an agent will see next" cannot use the
  stateless tails, and a debug reader that wants "what the room holds" must keep
  using `observe: false`.
- Putting a round frame on those stateless tails turned them into a false
  promise: an operator opening the dev tab saw three rounds of chat under
  "this round (round 7)" and reported the feature as broken. Corrected in
  `inspector-shows-last-request.md`.

## Rejected

- **Strict equality filter (`row.round === reader's round`).** Renders
  `(none)` almost every turn, for the timeline reason above. Rejected by the
  owner in the same session that chose re-anchoring.
- **Relabel only** (frame the tails as "this round", keep the global reads).
  Cheapest diff, nothing new consumed - but events from earlier rounds keep
  entering the turn, which is the reported bug wearing a new label.
- **Re-anchor the stamped round instead** (stamp events with the reader's round
  at write time). Loses execution provenance in the store for every consumer,
  and still re-delivers old events.
- **Give the agent a second turn inside the round** (after resolution, so the
  round's own events exist when it reads). The only option that would make
  "events of the current round" literally true, and a change to the planning
  barrier, the roster and the settlement watchdog. Not asked for; the round the
  agent acts in remains the round it plans at.

## Files

- `src/controllers/core/WorldEventLogController.js`,
  `src/controllers/core/RoomChatController.js` - sequence + per-agent cursor.
- `src/controllers/WorldStateController.js` - `getRecentEventsForAgent`,
  `getRoomChatMessagesForAgent`.
- `src/controllers/networking/LlmContextController.js` - `_currentRound`,
  `_roundFrame`, the consuming reads, the row stamps removed.
- `src/utils/Constants.js` - the docs of `LLM_CONTEXT_MAX_FAILURES`,
  `LLM_CONTEXT_MAX_DELTAS`, `LLM_CONTEXT_MAX_CHAT`.
- `wiki/subMDs/systems/perception_system.md` - section 9.1 renamed block,
  new section 9.2.
- Tests: `test/unit/WorldEventLogController.test.js`,
  `test/unit/RoomChatController.test.js` (agent window),
  `test/unit/LlmContextRenderer.test.js` (frames, consuming reads,
  `observe: false`, partial-seam fallback), `test/integration/currentRoundEvents.test.js`
  (real rounds, no stubs), `test/integration/happenedToYou.test.js`,
  `test/contract/worldStateController.contract.test.js` (facade surface).

## Follow-up the same day: the frame was only true for the brain

The frame line promised round scope in every reader, including the two debug
readers (`describeAgentView`, `GET /llm/context`), which read stateless ROOM
tails - so the panel printed several rounds of chat under
"this round (round 7)" and the owner reported the change as not working. It was
working; the label was lying.

Under `observe: false` no event frame names a round any more (each says
`... tail (newest first, not scoped to a round):`), and the inspector's primary
section is now `lastRequest` - the exact request the model received,
reconstructed from the stored transcript. Full decision, the fingerprint that
identified the pasted dump as a debug read, and what was rejected:
`inspector-shows-last-request.md`.
