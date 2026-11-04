# Decision: an agent's turn carries one round of events, and nothing else

Date: 2026-11-03 (recorded in the commit that implements this)

Supersedes the delivery mechanism of `current-round-events.md` (per-agent
cursors over the event log and the room transcript). Keeps that note's frame
labels and its rule that a row carries no round of its own.

## The request

Owner, after `current-round-events.md` shipped: the chat turn still shows lines
from earlier rounds, and so does `=== WORLD FAILURES ===`. Stated rule: **the
turn is occupied with information from that round only** — applied to `ROOM
CHAT`, `YOUR WORLD`, `HAPPENED TO YOU`, `YOUR LAST ACTIONS & RESULTS`. Backlog
rule: an agent that missed rounds **discards** those events.

## What was wrong with the previous change

It replaced tails with **per-agent cursors**: each section delivered "what is
new to this agent since its own last look". A cursor is a backlog generator —
an agent that skips two rounds gets two rounds of events in one turn, under a
header naming one round. The measurement of the live loop (5 rounds, real
composition, scripted provider):

| section, at the agent's read in round N | rows | round that produced them |
| --- | --- | --- |
| ROOM CHAT | 1 | N-1 |
| YOUR LAST ACTIONS & RESULTS | 1 | N-1 |
| YOUR WORLD change block | 1-2 | resolution of N-1 + tick drain |
| WORLD FAILURES | 0 in that run | warns are written at resolution: N-1 |

So the content of a turn is the previous round's, always. The honest reading of
"that round" is therefore **the round that just resolved**.

## Why not the literal `row.round === roundNumber`

The turn fires while a round is OPEN (`agentFn` at round start); that round's
actions resolve after the agent has planned. Filtering on the open round leaves
every event section empty at every read. The alternative — firing the agent
inside the resolution — cannot queue actions either, because `queueAction` is
accepted only during the planning phase. Measured, not argued.

## Decision

**Reference round = the round that resolved.** `_referenceRound()` reads
`turns.getResolvedRound()` — a new accessor on `TurnSystemController`, because
`getRoundState()` does not carry the number and its shape is the pinned v2 wire
contract (`state.turns` in every broadcast); this number is for server-side
readers, not for the HUD. `-1` (nothing has resolved yet) falls through to
`getRoundState().roundNumber`, which before the first resolution is round 0 —
the only round there is. A seam that answers neither yields `null`, and `null`
delivers nothing. Every event section is filtered to the reference round, and
the frame line names it.

1. **Round stamped at write time.**
   - `RoomChatController.sendMessage` → `round` = the open round when the line
     is said (planning time), read from the facade's turn system.
   - `WorldEventLogController.record` → `round` = the open round when the event
     is written. Resolution runs while its own round is still open, so the open
     round IS the round that produced the event. Needs the facade:
     `setWorldStateController`, wired at the composition root.
   - Agent action outcomes (`LlmAgentFeedbackController`) → the round the agent
     is planning in (`_openRoundNow`, guaranteed stable for a turn by the
     planning barrier). The old code stamped `round: 0` with a comment claiming
     resolution would overwrite it — it never did, which is part of why this
     section always looked stale.
   - Unknown is never guessed: `round: null` for a send/write with no turn
     system, and **never backfilled on restore** — a snapshot predating the stamp
     has no record of which round said what. A `null` row is visible to every
     human reader and never delivered to a model.

2. **Round-scoped reads replace the cursor reads.**
   - `WorldEventLogController.getEventsForRound({ round, limit })`
     ← facade `getWorldEventsForRound`
   - `RoomChatController.getMessagesForRound(roomId, { round, limit })`
     ← facade `getRoomChatMessagesForRoom`… precisely:
     `getRoomChatMessagesForRound(roomId, { round, limit })`
   - `LlmContextController._buildFeedbackData(entityId, round)` filters the ring.
   - The perception window is filtered by the round its entry carries.
   All of them stateless: nothing is consumed, so the agent's turn, the dev
   panel and `GET /world-events` / `GET /rooms/:id/chat` cannot eat each other.

3. **The cursors are gone.** `getRecentEventsForAgent`,
   `getRoomChatMessagesForAgent`, `getRecentForAgent`, `getMessagesForAgent` and
   both `Map<entityId, cursor>` stores are removed. A round filter makes a
   backlog impossible by construction; keeping a cursor underneath it would be a
   second mechanism deciding what an agent sees, with the same failure mode.
   `sequence` stays as the write/send ordering key.

4. **A perception entry covers exactly one round.** An entry aggregates the
   changes since the room's last flush, and was stamped with the round of the
   FLUSH — so a window straddling a round boundary mixed two rounds into one
   sentence. `TurnSystemController` now fires a **round-resolved hook** after
   `_resolveRound` (a hook, not an import: the turn system stays free of the
   controllers its rounds feed), wired to `PerceptionController
   .flushDirtyForRound(round)`, so the rooms are flushed at the boundary and
   each entry means one round of change.

   Two things that method has to get right, both pinned in
   `test/unit/PerceptionController.roundFlush.test.js`. **It must push:**
   `_flushRoom` does not store, it diffs and *returns* the entry, and every
   reader is the one that pushes it into the room's ring — a boundary flush that
   forgot to push consumes the dirty mark and throws the round's changes away
   (that is precisely what it did before the test existed, and it emptied every
   round's prose). And an unknown round (`-1`, null, fractional) flushes
   **nothing**: stamping an entry with a number no reader can ask for would make
   the change undeliverable forever, so the room stays owed to the next reader.

## Consequences

- Before the first resolution every event section is `(none)`. That is honest:
  no round has happened yet. Same for a world with no turn system — the frame
  line then carries no number.
- A newly spawned agent has no past. It learns the world from the state block
  and from the rounds it lives through.
- Chat, events and feedback written while no turn system answers (`round: null`)
  never reach a model. Human readers still see everything.
- Perception rings fill faster: every round close flushes the dirty rooms, so a
  busy room produces one entry per round instead of one per reader poll. The ring
  cap (`PERCEPTION_MAX_LIMIT`) and the round filter keep the context bounded.
- Round-prose readers that group entries by tick window now see entries split at
  round boundaries rather than at read time — the same events, finer windows.

## Rejected

- **Per-agent cursors** (what this replaces): delivers backlogs, and needs
  reader state that is not persisted, so a restart re-delivers everything.
- **Filter on the open round**: `(none)` in every section, measured above.
- **Move the agent's turn into the resolution**: cannot queue (planning-only),
  and delivers the same content as the round filter — pure barrier risk.
- **Keep the cursor and add the round filter on top**: two mechanisms, and the
  cursor is the one that produced the complaint.

## Files

- `src/controllers/core/RoomChatController.js`, `WorldEventLogController.js` —
  round stamp, `getMessagesForRound` / `getEventsForRound`, cursors removed.
- `src/controllers/networking/LlmAgentFeedbackController.js` — `round` nullable.
- `src/controllers/networking/LLMAgentController.js` — `_openRoundNow`, real
  round on dispatch-time outcomes.
- `src/controllers/networking/LlmContextController.js` — `_referenceRound`,
  round-filtered `_buildFailureData` / `_buildChatData` / `_buildFeedbackData` /
  `_buildDeltasData`; the debug-only tail frames are gone (one semantics).
- `src/controllers/core/PerceptionController.js` — `_flushRoom(roomId,
  roundStamp)`, `flushDirtyForRound(round)`.
- `src/controllers/core/TurnSystemController.js` — `setRoundResolvedHook`.
- `src/composition/WorldComposition.js` — event-log facade, round-resolved hook.
- `src/controllers/WorldStateController.js` — facade surface.
- `public/js/AgentViewPanel.js` — the room-tail and structured-context sections
  are removed (`inspector-shows-last-request.md` already made the request the
  primary view).

## Verification

- `test/unit/RoomChatController.test.js`, `test/unit/WorldEventLogController.test.js`
  — round scoping: only the round's rows, `null`-stamped rows never delivered,
  nothing restored gets a guessed round, stateless readers unaffected.
- `test/unit/LlmContextRenderer.test.js` — every event section renders the
  reference round's rows and nothing else; no resolved round means empty
  sections; `YOUR LAST ACTIONS & RESULTS` carries the resolved round's outcomes.
- `test/unit/PerceptionController*.test.js` — `flushDirtyForRound` stamps the
  closing round and one entry covers one round.
- `test/contract/TurnSystem.contract.test.js` — the hook fires once per resolved
  round, after resolution (the round already reads back as resolved from inside
  it), and a throwing hook cannot break the close.
- `test/integration/currentRoundEvents.test.js` — real rounds: the turn carries
  its round, and a line said two rounds ago is never shown.
- `npm run check` (lint + language guard + suite).
