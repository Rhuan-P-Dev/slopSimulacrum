# Decision: the LLM sees one user-anchored block per round

Date: 2026-11-02 (recorded in the commit that implements this)

## The request

Owner asked to change how the NPC LLM sees the context. Before, each round's
request ended with a single user message containing only that round's context
text; prior rounds' context was never shown to the model and round numbers
never appeared in its view. The target shape, per round:

```
user:
round x

<round x context>
ai: tool calls
```

followed round for round. Three follow-up choices, made in the same session:

- Past rounds **keep their tool results** in the replay (tool results stay;
  only the user anchors are added) — the NPC keeps direct confirmation of its
  own outcomes in every future round. The literal alternative (replayed rounds
  as user + assistant only, dropping `tool` results) was considered and
  rejected: the cost of losing outcome confirmation is a behavior regression
  the owner did not ask for, and replay already re-sends those messages.
- The persona **stays the `system` message** (unchanged); only the user
  messages change shape.
- Scope: **code + tests + wiki + dev tab** (`describeAgentView` exposes the
  snapshot; `AgentViewPanel` renders it collapsed under each round).

## Before

- Round N's request: `[system persona]` + replay of the last
  `LLM_REPLAY_ROUNDS` stored rounds as assistant + tool pairs only + one
  user message: the current round's context text, plain.
- Round numbers never appeared in the model's view; prior rounds' context
  never reached the replay.

## After

- Every stored round saves its context snapshot (`runRound` step 4, at every
  store site reached after context build). The `NPC_GONE` guard stores before
  context is built, so `{ error }` entries carry no snapshot — replay degrades
  to the round number alone, same as legacy entries.
- `_transcriptFor` emits one user message per replayed round: `round N` +
  saved context, separated by a blank line. The live round gets the same
  anchor as the last user message in the request.
- `_getTranscriptRounds` exposes the snapshot (`context: string|null`) and the
  dev tab renders it collapsed per round.

## What was deliberately not changed

- The in-round feedback loop (spec §6.5): tool results stay fed back within
  the same round — the agent loop needs them to chain calls. The tool-result
  choice above only affects what prior rounds look like inside the replay.
- `LlmContextController` context build, `LLMController` validation,
  `_buildSystemPrompt`, the `LLM_ROUND_*` knobs, and
  `LLM_REPLAY_ROUNDS` / `LLM_AGENT_VIEW_HISTORY_ROUNDS` (10000, since 2026-11-01
  — `llm-memory-window.md`).

## Cost delta vs llm-memory-window.md

The per-stored-round replay grows from ~3.8 KB to ~3.8 KB + ~4 KB context
snapshot (~8 KB). The window is a count, not a size budget, so the silent
timeout failure mode in `llm-memory-window.md` is reached at roughly half the
depth. At the measured synthetic numbers, 10000 replayed rounds are ~80 MB
per NPC instead of ~40 MB. Mitigations unchanged: turn thinking off (each
replayed reasoning block re-sends in full), lower `LLM_REPLAY_ROUNDS`, or
raise the provider `n_ctx` and accept slower prefills.

## Consequences that are now true

- Every NPC round adds the context snapshot to RAM on top of its groups (the
  transcript is still a per-process `Map`, wiped on restart).
- The dev tab renders every stored round's context snapshot, collapsed; the
  "no cap on round count" warning in `llm-memory-window.md` still applies and
  is now heavier.
- Tests pin the new shape: one user message per replayed stored round (round
  number alone for legacy / no-snapshot entries), the live round's anchor as
  the last user message, and the snapshot exposed by `describeAgentView`.
