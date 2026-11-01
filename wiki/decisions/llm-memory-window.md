# Decision: the agent's memory window is 10000 rounds, a count and not a budget

Date: 2026-11-01 (recorded in the commit that implements this)

## The request, and the coupling it walked into

"Make `LLM_REPLAY_ROUNDS` 10000." One number, and changing it alone does nothing of the
kind: `_storeTranscript` slices the buffer to `LLM_AGENT_VIEW_HISTORY_ROUNDS` (50) on every
append, so `slice(-10000)` over a 50-round buffer returns 50 rounds. The literal edit would
have raised the memory to 50 rounds, broken the invariant written on the constant itself
("must stay <= that window"), and left the number in `Constants.js` describing a memory the
system does not have.

The two numbers are one decision. The owner chose both at 10000, after the costs below were
measured and stated, and declined the alternative (a size budget) when it was offered.

## What was measured, on this repo's data and this machine's provider

**Growth per round.** World built from `data/mods/`, real `LLMAgentController` and real
`LlmContextController`, provider stubbed. A fixed overhead of ~8.5 KB per call (system 2233
chars, tools 6254), plus ~3.8 KB of transcript per stored round, and the replay plateaued
exactly when the ten-round window filled: 52.8 KB, ~13.2k tokens at steady state with three
in-round calls per round. The rounds were synthetic (short prose plus one `get_actions`), so
the per-round volume is illustrative - the shape is what was measured, and the shape is a
straight line with no ceiling on it.

**What the provider does with a prompt that is too big.** It does not refuse it. One request
with a 300 KB prompt:

```
prompt 300 KB  ->  HTTP 200, prompt_tokens 60786, in 133.6 s
```

Two things follow. It accepts at least 60.8k prompt tokens, so `n_ctx >= 60786`; and past
whatever `n_ctx` is, llama.cpp truncates from the beginning and logs a warning - the oldest
rounds quietly stop existing as far as the model is concerned, with nothing in this server's
response to say so. And the price of the prefill is paid whether the content is used or not:
133.6 s of wall clock, to generate one token.

**What that means next to `LLM_ROUND_TIMEOUT_MS = 450000`.** A round whose replay has outgrown
the provider does not throw a visible error to the operator. The LLM call times out, and a
timed-out call is handled as *graceful silence* by design - the NPC simply stops acting. That
is the failure mode of a large memory window: not a crash, a world where NPCs go quiet, one
at a time, as the history grows. The in-round loop makes it worse: up to
`LLM_AGENT_MAX_ITERATIONS = 50` calls per round, each re-sending the whole replay.

## The decision

`LLM_REPLAY_ROUNDS = 10000` and `LLM_AGENT_VIEW_HISTORY_ROUNDS = 10000`. Both, so the number
means what it says. No size budget: it was offered (window by prompt size, oldest rounds
shed) and the owner chose the count.

Consequences that are now true, and were stated rather than discovered later:

- **RAM per NPC is bounded by a round count, not by bytes.** At the measured ~3.8 KB per
  round, 10000 stored rounds is tens of megabytes of transcript per NPC - per NPC, not per
  world. The old 50 kept that in the hundreds of KB.
- **`_storeTranscript` is O(buffer) per round**, forever: it slices the whole array on every
  append. At 10000 that is a 10000-element copy per round per NPC, every round, for the life
  of the process.
- **`GET /llm/agent/:entityId` returns the whole buffer**, and the route has no rate limit.
  A long-running world turns one inspector request into megabytes of JSON.
- **`AgentViewPanel._transcriptSection` renders every round it is given.** It has no cap. The
  dev tab on an old world is the first thing to hurt.
- **Nothing is shed by size anywhere on the path.** `_transcriptFor` slices by count;
  `LLMController` has no size guard - its only truncation is a 500-character *log* limit. The
  provider decides what actually fits, silently.
- **None of it survives a restart.** `_transcripts` is a `Map` in the controller; nothing in
  `DataLoader` or `WorldComposition` persists it. The 10000-round window is per process, and a
  restart still wipes the memory to zero.

## How to tell it is biting

The log line that matters is the LLM timeout, not an error from the provider: a round that
goes silent with `LLM_TIMEOUT` while the model is up is a prompt that outgrew the prefill
budget. The size is visible in the debug payload log. The quick mitigations, in order of
how little they cost: turn thinking off for the round (already the default - each reasoning
block is replayed in full by `_transcriptFor`, so thinking is what makes the replay expensive
first), lower `LLM_REPLAY_ROUNDS`, or raise the provider's `n_ctx` and accept slower prefills.

## Open question

The honest version of "remember everything" is two windows: a deep buffer (this one, for the
inspector and for any future summariser) and a *sized* replay, shedding oldest rounds until
the prompt fits a stated budget. The count and the budget answer different questions - the
count answers "how far back does the NPC go", the budget answers "how long is this round" -
and only the second one has a fixed unit. The owner declined it today; the moment a world
dies of silence at round 4000, it is the fix, and the measurement above is the starting point
for choosing the number.
