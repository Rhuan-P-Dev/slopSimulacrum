# LLM Agent — Action-Result Feedback: Investigation & Implementation Plan

> **Status:** Architect deliverable (analysis + design only — no source changes in this doc).
> **Scope:** Make the outcome of each NPC agent action (success **or** failure with a
> specific reason) visible to **that agent** in the context of its **next turn**.
> **Root symptom:** an agent queues a `droid punch` with a component that lacks the
> required `Physical.strength`; the punch fails at resolution; the failure never reaches
> the LLM; the agent repeats the identical failing punch forever.

This plan is self-contained: it documents the root cause, the design (where the feedback
lives, where it is captured and injected), the edge cases, and the full test plan.

---

## 1. Investigation findings (verified against source)

### 1.1 Why the agent never learns the outcome

The world is tick-driven, and the LLM agent runs as a fire-and-forget hook: it plans and
queues actions early in a round, while the queued actions are resolved later in the same
round. By the time an action's outcome is known, the agent's turn has already returned —
the agent has no channel to learn what happened to the actions it queued.

### 1.2 Where the result is produced

The action pipeline already returns a structured result in every branch: range failures,
requirement failures (naming the specific missing trait/stat), consequence and runtime
errors, and success. Notably, success can be **partial** — the top-level result reports
success while individual consequences may have failed — so any feedback the agent receives
must convey that nuance rather than a false "all good".

### 1.3 Where the result is currently dropped (the 3 gaps)

**Gap A — the resolution-time outcome is never routed to the acting agent.**
The resolved outcome is used for two things only: logging, and recording to the **shared,
per-world** event log, which is surfaced to **everyone** in the rendered context. It is
**never** written to any per-agent memory. And because the agent's turn ended before
resolution, the agent has no channel to receive this outcome. This is the core bug.

**Gap B — the only per-agent cross-round memory is disabled.**
The agent already has a per-agent transcript mechanism that is supposed to replay prior
tool results into the next round's messages — but it is disabled: its retention is set to
zero rounds, so nothing survives to the next round. (Same-round dispatch/pre-validation
failures DO still trigger the single in-round retry — that part works — but nothing
survives to the *next* round.)

**Gap C — the context renderer has no per-agent action-outcome section.**
The rendered context has no "your recent actions and their results" section. The only place
an outcome can surface today is the shared **RECENT EVENTS** section — which is unattributed,
capped, and is the **first** thing truncated under the context's character budget. In a busy
multi-agent world the specific "your punch failed because X" line is buried and can be
evicted before the agent's next turn.

### 1.4 Why the punch loop specifically happens (the trigger)

The agent's pre-validation has a **capability gate**: it only checks whether *some* component
of the entity is capable of the action — it does **not** validate the specific component the
model chose. So a punch with a strength-less component passes the gate when *another* hand
has strength, and only fails later at resolution (the "Requirement failed: … strength >= 15"
branch). That failure is Gap A: produced at resolution, logged to the shared event log, never
delivered to the agent. Next round the context is unchanged (Gaps B/C) → the agent re-issues
the same bad punch → same failure → forever.

### 1.5 Existing per-agent history/observation memory?

Yes — the transcript of Gap B — but it is only ever populated with same-round dispatch
results, never the resolution outcome. There is **no** store that holds "action taken +
components used + success + failure reason" keyed per agent. We add one.

---

## 2. Design overview

Add a small per-agent **action-feedback store** (a ring of outcomes keyed by entity),
**capture** the real outcome at the two places it becomes known (resolution + immediate/
pre-validation), and **inject** the last N outcomes as a dedicated section of the rendered
LLM context so the next turn's prompt says, concretely, what the agent did and what
happened.

Structurally, the design has one new state owner, two capture paths, and one injection path:

- **Store** — a per-entity ring buffer of recent outcomes: the agent's short-term
  "what did I do and what happened" memory.
- **Capture (resolution)** — the turn system records the resolved outcome through an
  injected outcome sink.
- **Capture (immediate/pre-validation)** — outcomes that never reach resolution are recorded
  on the agent side at the end of its turn.
- **Injection** — the context renderer reads the acting agent's own recent outcomes and
  renders them as a dedicated section of the next turn's prompt.

The design reuses the project's existing dependency-inversion pattern (the agent is already
injected *into* the turn system as a callback via `setNpcAgent`; we add a sibling
`setActionOutcomeSink`).
It reuses the existing state-owner-on-the-facade pattern (like `roomChatController` and
`worldEventLogController`: built in the composition root, stored on the facade, read via a
facade public method, **no `getAll()`** so it is excluded from the full-state broadcast).

---

## 3. Data structure & where it lives

### 3.1 New state-owner: `LlmAgentFeedbackController`

**New file:** `src/controllers/networking/LlmAgentFeedbackController.js` (PascalCase, per
project rules §1.2; placed in `networking/` next to the other LLM controllers because it is
purely agent-flow memory, not general world state).

Purpose: a **per-entity ring buffer** of recent action outcomes — the agent's own "what did I
do and what happened" short-term memory. It is a state owner (per the controller-pattern rule
that state lives in a sub-controller) but deliberately **not** broadcast (no `getAll()`), exactly
like `WorldEventLogController` and `RoomChatController`.

Its public surface mirrors `WorldEventLogController`: record an outcome for an entity, read
an entity's recent outcomes (defensive copies, only that entity), clear (for tests), and —
if ever persisted — serialize/restore. It deliberately exposes no `getAll()`, so it stays out
of the world-state broadcast and keeps full-state payloads lean.

Each recorded outcome carries enough context to be rendered as one line (round, action,
component used, success, reason). The reason/detail field is the most important: for a
requirement failure it must carry the pipeline's verbatim reason (e.g.
`No component possesses the required Physical.strength (>= 15)`) so the model can see *why*;
for a range failure, the range text; for a queue rejection, the rejection reason
(`planning window closed`, `queue full`, etc.).

### 3.2 Construction & wiring

- The store is built in the **composition root** (it needs nothing at construction) and added
  to the facade's dependencies and sub-controller map.
- The **facade** exposes it through a **public wrapper**, following the existing pattern for
  non-broadcast state owners (world event log, room chat) so all callers follow the
  "public API only" rule.
- The **renderer** reads it only via that facade public wrapper (see §5).
- The **server** wires the outcome sink (see §4.1) next to the existing agent-hook wiring.

### 3.3 Keying & no-leak guarantee

Outcomes are keyed per entity, and every read is scoped to a single entity. The renderer is
always called for one entity and reads only that key; the sink writes only to the **acting**
entity's key (the actor is always the server-injected entity ID, never model-sourced). ⇒
One agent's feedback can never appear in another agent's context.

### 3.4 Persistence decision (recommend: DO NOT persist)

Recommend **not** persisting the store: it is ephemeral tactical memory
("what happened in the last few rounds"), a server restart resetting it is acceptable, and it
avoids changing the world-state persistence contract. If the team wants restart-survival,
the store would need a serialization section added to the persistence schema and the
persistence contract test updated — treat this as optional, not required.

---

## 4. Capture points

There are exactly two places an outcome becomes known. Record at both, with a strict
**no-double-record** rule.

### 4.1 Capture point A — resolution-time outcome (the real one; fixes the bug)

**Where:** the turn system's resolution stage — the single place where a queued action's
final outcome is known.

**How it decouples (dependency inversion — do not import the LLM layer here):** the outcome
is delivered through a newly **injected sink**, mirroring how the agent hook and broadcaster
are already injected into the turn system. The turn system stays free of any LLM-layer
import, preserving the "turn system owns timing/ordering only" contract (spec §5.3/§5.8).

The emission is best-effort: if the sink is unset it no-ops, and any sink failure is caught,
logged, and swallowed so it can **never** break the round (same posture as the existing
event recording).

**Wiring:** the server registers the sink next to the existing agent-hook wiring, pointing it
at the feedback store.

**Scope note:** recording for every resolution actor (player *and* NPC) is acceptable and cheap
(each entity's ring is capped at 5). If you prefer NPC-only, guard the sink body by the
actor's source. Both are correct; recommend recording all so the context debug endpoint works
for any entity.

### 4.2 Capture point B — immediate / pre-validation / queue-rejected outcomes (agent side)

These outcomes never reach the resolution stage, so the agent records them itself at the end
of its turn, for the entries that did **not** go through the queue:

- **Record** the immediate-execution outcomes (non-turn worlds), the pre-validation failures
  (unknown action, bad ID, capability gate), and the queue rejections (e.g. closed planning
  window, full queue).
- **Do NOT record** the queued entries — their outcome is owned by Capture point A at
  resolution. This is the no-double-record rule.

Recording goes through the facade's public path (public-API rule) and is wrapped defensively
so a missing or broken store can never break the agent (same posture as the agent's other
optional-layer reads).

> **Why both points:** the bug's failing punch is a *queued* action, so Capture point A is what
> fixes it. Capture point B is required so that (a) non-turn / immediate-execution worlds get
> feedback, and (b) pre-validation failures (unknown action, bad ID, capability gate, queue
> rejection) — which the same-round retry already sees — also persist into the next round's
> context instead of vanishing when the round ends.

### 4.3 Complementary: re-enable the tool-role transcript (low-risk, recommended)

The existing per-agent transcript retention is currently set to zero rounds (disabled).
Re-enabling it with a small retention (2 rounds — matching the spec's "last ≤2 rounds"
intent) makes the existing tool-result replay actually replay the raw per-tool-call results
for the last 2 rounds, giving the model the exact per-tool-call result in addition to the
human-readable context section.
This is independent of, and additive to, the new feedback store. It is the fix for Gap B.

> Keep the retention small (2) to protect the token budget; the durable, attributed
> channel is the new context section (§5), and the transcript is a secondary same/last-round aid.

---

## 5. Injection point (rendered LLM context)

### 5.1 New section in the context renderer

The context renderer gains a new section that reads the acting agent's recent outcomes via
the **facade public wrapper** (public-API rule) and threads them into the rendered context
and its structured data mirror (the mirror is what the context debug endpoint already
exposes). Defensive: if the wrapper/controller is absent (older composition / tests), it
returns empty — the section renders `(none)`, never throws (same posture as the hints
section).

### 5.2 Position and wording

Insert the section **after `=== YOUR STATE ===` and before `=== NEARBY ENTITIES ===`** (the model
reads its own recent outcomes while it still "is" its state, right before it sees what it can do).
Header (stable for prompt engineering, matching the existing `=== ... ===` style):
`=== YOUR LAST ACTIONS & RESULTS ===`.

- One line per outcome, ordered **oldest → newest**, so the most recent outcome is last and
  closest to the choice.
- The failure line carries the pipeline's **verbatim reason** — this is what breaks the loop.
- Each detail is truncated to a bounded length so one pathological error cannot blow the
  context budget.
- Empty → header + `(none)` (stable structure, matching every other section).
- The section is small (a few short lines worst case) and participates in the context's
  character budget/stats.

### 5.3 Budget / expiry behavior

- **Expiry:** the store caps at 5 outcomes per entity, and the renderer shows the last 5.
  Under the context's character budget, the section follows the existing truncation ladder:
  when over budget, it collapses from the last 5 to the **last 3**, then (if still over) to
  the **last 1** (newest only — the most recent outcome is the most decision-relevant), with
  a truncation flag alongside the existing ones.
- **Do not** let this section push out `YOUR STATE` or `YOUR ACTIONS` (the decision inputs);
  it is the most expendable of the "new" content, so it truncates before chat is dropped.

### 5.4 Endpoint effect

The existing LLM context debug endpoint needs **no change** — it already returns the
rendered context's text/data/stats, so the new section and its data mirror flow through
automatically. (Good for manual debugging of the loop.)

---

## 6. Edge cases (explicit handling)

| Case | Handling |
|---|---|
| **Multiple agents acting in parallel** | Store is keyed by entity; each agent's turn/context read only its own key. The resolution sink writes only to the acting entity. No cross-agent leak. (§3.3) |
| **Action partially succeeds** | The pipeline reports top-level success with a per-consequence count. Record success and a detail noting the count (e.g. `succeeded (1/2 consequences applied)`). The LLM sees "mostly worked" rather than a false failure. (Capture A, §4.1) |
| **Agent turn interrupted** (LLM timeout, entity gone, degeneration) | The round records no *new* outcome, but the ring is **not cleared** at round start — it is only evicted by capacity. So the next successful round still sees the prior failures. No stale "pending" entry is created (we record only real outcomes, never placeholders at queue time). (§4.2) |
| **Queued action whose round is never resolved** (restart before resolution) | No outcome recorded (we intentionally do not record at queue time). The agent simply has no feedback for it and re-decides fresh next round. Acceptable; avoids stale data. (§4.1/4.2) |
| **Context size / token budget** | Section capped at 5 lines, each detail truncated; participates in the context budget and truncates (5→3→1) before chat is dropped. The small transcript retention keeps the secondary channel small. (§5.3, §4.3) |
| **Non-turn / immediate-execution worlds & tests** (no tick system) | The agent's immediate-execution path is taken; Capture point B records the synchronous outcome. Works with no turn system. (§4.2) |
| **Late LLM response ("planning window closed", audit bug 4)** | The action is rejected as dropped; Capture point B records it so the next round knows the action was dropped. (§4.2) |
| **Older composition without the feedback controller** | The renderer and the sink both no-op gracefully (absent wrapper/controller → empty / no record); the section renders `(none)`. No new hard dependency. (§3.2, §5.1) |
| **The agent's turn must never throw** | All new capture paths are best-effort (errors caught and swallowed, matching the agent's existing guards), so a feedback-store bug can never break the turn loop. (§4.1, §4.2) |

---

## 7. Files to create / modify

**Create**
- `src/controllers/networking/LlmAgentFeedbackController.js` — the per-agent ring (state owner, no `getAll()`).

**Modify (source)**
- `src/composition/WorldComposition.js` — build the feedback controller and add it to the facade's dependencies and sub-controller map.
- `src/controllers/WorldStateController.js` — expose the store through a public facade wrapper.
- `src/controllers/core/TurnSystemController.js` — add the injected outcome sink and record the resolution-time outcome through it.
- `src/controllers/networking/LLMAgentController.js` — re-enable the transcript retention (0 → 2 rounds); record the immediate/pre-validation/queue-rejected outcomes at the end of the turn.
- `src/controllers/networking/LlmContextController.js` — render the new action-feedback section (position, wording, budget behavior per §5).
- `src/server.js` — wire the outcome sink next to the existing agent hook.

**Modify (tests) — see §8.**

**Deliberately unchanged:** `actionController.js`, `RequirementResolver.js`, `RangeValidator.js`,
`ConsequenceDispatcher.js` (the pipeline already returns the right success/error; we only
*consume* it), `llmRoutes.js` / `turnRoutes.js` (the new section flows through the context debug
endpoint for free).

---

## 8. Testing plan

Run with the project's vitest (`test/**/*.test.js`).

### 8.1 `test/unit/LLMAgentController.test.js` (existing — extend)

The hand-mocked world must gain an optional feedback-controller stub (record + recent-outcome
reader). New tests:

1. **Pre-validation failure is recorded for the next round.** Stub LLM proposes an unknown
   action. Assert nothing was queued/executed AND the feedback store has one entry for the
   agent: not queued, unsuccessful, detail = the pre-validation reason.
2. **Successful queue is NOT double-recorded by the agent.** Stub LLM queues a valid action.
   Assert it was queued AND the feedback store is empty (the resolution sink owns it).
3. **Immediate (non-turn) execution is recorded.** No turn clock → immediate fallback. Stub a
   failing execution result. Assert the store has an entry: not queued, unsuccessful,
   detail = the pipeline error.
4. **Transcript now replays (retention = 2).** Run two rounds; assert the second round's LLM
   messages include the first round's assistant tool-call + tool-role result (this currently
   cannot pass — it is the Gap B regression lock).

### 8.2 `test/unit/LlmContextRenderer.test.js` (existing — extend)

The mocked facade must gain the public feedback wrapper. New tests:

1. **Section present & ordered.** Rendered text contains `=== YOUR LAST ACTIONS & RESULTS ===`
   between `=== YOUR STATE ===` and `=== NEARBY ENTITIES ===`.
2. **Formatted lines.** Stub two outcomes (one FAILED with the exact requirement reason, one
   SUCCESS). Assert the rendered lines show each outcome once, oldest→newest, with the
   failure carrying the verbatim reason.
3. **`(none)` when empty.** No outcomes ⇒ header + `(none)`.
4. **Data mirror.** The structured data mirror exposes the same entries.
5. **Budget.** Flood the section (long details) so total exceeds the budget; assert the
   rendered text stays within budget, the action-feedback truncation flag is set, and the
   section collapses to the newest 1–3 lines.
6. **Absent controller degrades.** Facade without the wrapper ⇒ section is `(none)`, no throw
   (mirrors the hints-absent test).
7. **No cross-entity leak.** The wrapper is always called with the queried entity ID — and a
   second entity's context does not contain the first's lines.

### 8.3 `test/contract/LLMAgent.integration.contract.test.js` (existing — the end-to-end lock)

Uses the REAL world + REAL agent (only `fetch` stubbed). Add:

1. **THE bug regression — failing punch is visible next round.** Round 0: make the LLM
   propose a punch with a component that will fail at resolution (e.g. a component lacking
   the required strength stat while the action still passes the capability gate). Step to the
   agent tick (queued); step to resolution (fails). Assert the feedback store now contains
   the failure with a detail containing the requirement reason. Then step to the next round
   and **capture the context the LLM actually receives** (have the next round's fetch stub
   record the user message) and assert it contains `=== YOUR LAST ACTIONS & RESULTS ===` and
   the failure line. This proves the full loop: fail at resolution → stored → injected into
   the *next* prompt.
2. **Success path.** LLM proposes a valid self-affecting action → after resolution, the
   store has a success entry; next-round context shows the success line.
3. **No cross-agent leak.** If a second NPC is present, assert NPC B's next-round context
   does NOT contain NPC A's feedback line.

### 8.4 `test/contract/TurnSystem.contract.test.js` (existing — extend)

Add: resolution invokes the injected outcome sink. Inject a spy sink, queue one action that
succeeds and one that fails (out-of-range, per existing spec §5.12 style), step to
resolution, assert the spy was called once per resolved entry with the correct entity and
outcome fields (action, success, reason, queued, round). Also assert that with **no** sink
set (default) the round still completes unchanged (backward compat).

### 8.5 New unit test (optional but recommended)

`test/unit/LlmAgentFeedbackController.test.js` — capacity/eviction per entity, recent-outcome
ordering + defensive copies (mutating a returned entry does not mutate the store), per-entity
isolation (record for A does not appear in B's reads), clear, and (if persisted)
serialize/restore.

### 8.6 No changes needed
- `test/contract/persistence.contract.test.js` — only if we choose to persist (§3.4 recommends no).
- `test/unit/RangeValidator.test.js`, `LLMController.chatFull.test.js` — unaffected.

---

## 9. Conventions followed (per `wiki/project_rules.md`)

- **Public API only / one-way flow:** the renderer reads the store via the facade public wrapper
  `getAgentActionFeedback`; the turn system talks to the agent layer only through an injected
  sink callback (no upward state push, no LLM import in the turn system).
- **State owner in a sub-controller:** the feedback store is its own controller (state lives in a
  sub-controller), built in the composition root, stored on the facade — same shape as
  `worldEventLogController` / `roomChatController`.
- **No broadcast bloat:** no `getAll()` on the new controller ⇒ it is excluded from
  `world-state-update` (keeps every full-state payload lean, spec §4.1/§4.7).
- **Centralized logging:** all new log lines use `Logger`, never `console.*`.
- **Defensive copying:** `getRecent` returns defensive copies (the ring util already does this).
- **Data-driven, no new error taxonomy:** we reuse the pipeline's existing `success`/`error`
  strings verbatim; no new codes.
- **PascalCase** for the new controller (new-class convention).
- **runRound never throws / turn loop bulletproof:** every new capture path is best-effort
  try/catch, matching `_recordEvent` and the agent's existing guards.

---

## 10. Acceptance criteria (definition of done)

- [ ] A queued NPC action that fails at resolution produces a per-agent feedback entry with the
      verbatim pipeline reason (e.g. `Requirement failed: No component possesses the required
      Physical.strength (>= 15)`), keyed to that NPC.
- [ ] On the NPC's **next** round, the rendered context contains a
      `=== YOUR LAST ACTIONS & RESULTS ===` section showing that failure — verified by capturing
      the actual `chatFull` `messages` in the integration contract test.
- [ ] The failing-punch-repeat loop is broken: after one failed punch, the next round's prompt
      tells the model *why* it failed so it can pick a valid component or another action.
- [ ] No agent's feedback appears in another agent's context (isolation asserted).
- [ ] Partial success is reported as success (with a count), not as a false failure.
- [ ] The 4000-char budget holds with the new section present; `stats.truncated.actionFeedback`
      flags truncation.
- [ ] `world-state-update` payload size is unchanged (no `agentFeedback` key in the broadcast).
- [ ] `runRound` still never throws; the turn round still never aborts when the sink/store misbehaves.
- [ ] All existing tests in §8.1–8.4 still pass (no regressions).
