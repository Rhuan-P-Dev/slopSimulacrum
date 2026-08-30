# LLM, Turn System & NPC — Design Rationale

> **Status:** Approved-for-implementation design document (architect deliverable)
> **Scope:** 4 features — (B) state→text translation layer, (A) simultaneous-planning turn system, (C) text-based actions via LLM tool calling, (D) NPC + per-room chat — plus a step-0 bug sanitation pass.
> **Audience:** Implementers. Each section records the design decisions, their rationale, and the constraints that shape the implementation. Concrete signatures, data shapes, endpoint contracts, and call sequences live in the code (JSDoc and comments), not here.
> **Companion updates:** status changes in [`wiki/bugfixWiki/README.md`](bugfixWiki/README.md) for BUG-069 / BUG-124.

---

## 1. Why this spec exists (background)

The world is server-authoritative and **real-time**: actions are REST event-driven, and state is broadcast whole on change. A deterministic tick loop drives the internal-components job. The LLM integration today is a **stateless echo box**: it forwards chat messages with no system prompt, no world context, and no way to act on the world — and it cannot even parse a tool-calling response (the bug fixed in §6.1).

We want **droids that think**. Four capabilities are needed, in dependency order:

1. The LLM must be able to *read* the world → **Feature B** (a token-budgeted, LLM-readable context renderer + event ring buffer + natural-language action descriptions).
2. The world must be able to *pace* who acts when, so an LLM agent (which is slow by nature) and a human player can interleave fairly → **Feature A** (simultaneous planning + stat-based initiative).
3. The LLM must be able to *act* on the world safely → **Feature C** (tool calling, one generic action tool, pre-execution validation, one retry).
4. The world needs a *personality* to talk to → **Feature D** (a merchant NPC, a per-room chat channel the NPC and the player share).

### 1.1 Chosen semantics for turns (decided by product owner — binding)

> **Simultaneous planning + initiative by stats.** All participants (players and NPCs) may plan/queue actions at the *same time* within a per-round planning window. The window has **no end time** — the round closes the moment **every** roster planner has signaled plan-complete (a per-player ready gate; a player who never signals delays the round indefinitely, by design) — and the queued actions execute in initiative order, where each entity's **stats** decide who acts first. There is no deadline, and the ⚡ Immediate path stays available as the escape hatch.

Everything in Feature A follows from this sentence.

### 1.2 Cross-cutting decisions (apply to all features)

| Decision | Choice | Why |
|---|---|---|
| New class naming | **PascalCase** | Wiki recommends PascalCase for new classes; `src/controllers` has a mixed legacy convention, and new code should not perpetuate the older camelCase pattern (see BUG-052 guidance). |
| Construction | **Composition root** for anything that is *world state*; **server.js** for *services* that depend on the LLM layer or the broadcast service | Mirrors the existing pattern: world-state sub-controllers are built topologically and receive the facade; services created at boot wire things that only exist at boot. |
| Data | **`data/*.json`** via `DataLoader.loadJsonSafe()`, with `_validate*()` + `Logger.info` count | Project rule §5/§6 — data-driven is a core constraint (BUG-018). |
| Errors | Rule-level failures at execution time return **200 + a failed result**, not a new error taxonomy | Matches the existing action-execution contract exactly. |
| IDs | New IDs go through the typed-ID generator; all IDs in requests validated by the ID resolver | Typed-ID system (BUG-106/107) — no synthetic timestamp IDs (the `dropped-…` antipattern is one of the step-0 bugs). |
| Broadcasting | Full-state keeps the existing update event; **new** events are added as thin methods on the broadcast service, not new channels | Lowest friction with the existing service; clients already handle one global-emit pattern. |
| Logging | `Logger` only; no `console.*` | Project rule §2 (BUG-123 precedent). |
| Client | No build step, vanilla JS modules; one new CSS file and one controller class per feature area, wired in the app entry point | Matches the existing client architecture (BUG-053 layout, controller-per-concern pattern). |

---

## 2. What the design leans on (conceptual)

These are the existing capabilities the design deliberately reuses instead of building parallel machinery — confirm them in the code rather than re-deriving them from this document:

- **A single programmatic action executor already exists.** It runs range, requirements, synergy, and consequences and needs no prior selection state. The turn system reuses this exact path — **there is no second executor**.
- **A single broadcast choke point** already fans out full-state updates; any sub-controller that exposes a read-all method automatically appears in every full-state payload.
- **A deterministic tick loop** already runs jobs at a fixed cadence and persists the current tick. The turn machine only *observes* that clock for bookkeeping — rounds are event-driven and nothing about round structure is derived from it (§5.1). A corrupt clock value (e.g. NaN) must never masquerade as a tick, so the clock is read defensively at the single read point (non-finite values are rejected with a warn and a fallback), which keeps a stale external caller from poisoning the round state.
- **The event ring buffer is the only new *state* Feature B introduces.** Everything else in the LLM-facing layer is pure composition of injected state.
- **State lives in sub-controllers.** So each new state owner is a sub-controller that can opt into (or deliberately out of) the full-state aggregation.

---

## 3. Step 0 — Bug sanitation (do this first)

**Why first:** Feature A/B/C build directly on the internal-component routes, the client inventory flow, and the dropped-item ID family. Shipping features on a broken base makes every later test ambiguous.

| # | Bug | Decision | Rationale |
|---|---|---|---|
| 0.1 | **BUG-069** — the internal-component routes read the world controller through an undocumented `app.locals` side channel that is never set, so 4 of 5 endpoints 503 | **Fix via DI** | `app.locals` is an undocumented side channel that already bit us once; every other route module uses the standard dependency-injected registration shape. |
| 0.2 | **Dead broken endpoint** — a dropped-item delete route validates an ID prefix the IDs it would delete never carry, and **no client calls it** | **Remove the route** | No caller exists; picking up a dropped item already removes it through the existing pick-up path. "Fixing" it would mint a new typed-ID family that the map renderer, pick-up overlay, and persistence all ignore — new surface, no user. The underlying remove capability stays (it *is* the pick-up path). |
| 0.3 | **BUG-124** — the client reads a container-capacity attribute that is **never written**, so dropping into a container is always rejected client-side | **Write the attribute at render time** | The item-card render is the one place that already has both the item definition and the live item in scope, so the capacity is written where the other item attributes already are. |

### 3.1 Acceptance criteria (step 0)

- [ ] The internal-component endpoints return real data (no 503) with a live world, and no `app.locals` reads remain in the route layer.
- [ ] The dead dropped-item delete route is gone (404); the pick-up path still removes the dropped item (regression check).
- [ ] Client: dragging an item onto a container card with enough capacity succeeds (previously always rejected); insufficient capacity is still rejected.
- [ ] `wiki/bugfixWiki/README.md` index: BUG-069 and BUG-124 status updated (this spec's companion edit); the dead-endpoint removal is recorded under BUG-076's row or a new bug entry per [`template.md`](bugfixWiki/template.md) (implementer's call, low effort).

---

## 4. Feature B — State→text translation layer (for the LLM)

**Why this shape:** a local LLM (8k–32k context) can only reason about the world through text. We therefore need (a) a **single endpoint** that composes a bounded, sectioned narrative, (b) an **event ring buffer** so the LLM has a short-term memory of what just happened (the action pipeline today only writes to the server log), and (c) **natural-language action descriptions** in the action data, because the LLM cannot read raw consequence declarations. The renderer is a *logic controller* (pure composition of injected state), not a state owner — the only new *state* is the event ring buffer.

### 4.1 Event ring buffer

A small, reusable ring buffer utility holds the most recent world events under a hard capacity (oldest evicted). It is a **generic, world-agnostic utility** because it is reusable and trivially testable. The *state owner* is a thin controller that wraps it and deliberately exposes **no read-all method**, so it stays out of the full-state broadcast (keeps every full-state payload lean).

**Feed point (why here):** every successful and every failed action already produces a human sentence via the log consequence, so the log consequence handler is the *single* choke point where "something happened in the world" is already worded. We feed the buffer from there (not from the consequence dispatcher — that would double-log). Turn-system synthetic lines are recorded directly by the turn controller.

### 4.2 Natural-language action descriptions (data)

Each action gains a single natural-language `description` field in the action data. **No `aiDescription`** — one description serves both the LLM and (later, optionally) UI tooltips; forking the data would create two sources of truth for the same fact.

### 4.3 Context renderer

A new *reader/composer* controller (lives with the LLM flow; receives the facade) builds a bounded, sectioned narrative from injected state: the entity's own state, nearby entities, currently-executable actions, recent events, and room chat. A **hard character budget** bounds the output (weak local models); **sections are never omitted** when empty (stable structure helps weak models); and truncation has a defined priority (events, then entities, then chat). It is a reader/composer, not a state owner, and it exposes the rendered text plus a small structured mirror for debugging/testing.

### 4.4 Endpoint

A single **read-only** endpoint serves the rendered context for an entity. It needs no rate limiting: it is an in-memory read on a server-internal (LLM-facing) path, and it sits behind the same optional auth gate as everything else.

### 4.5 Persistence (schema bump — part of Feature B, applied once)

The event log is state, so it must persist. The persistence schema is **bumped once**, and the event section joins the required-sections list. Old-version snapshots are **rejected** by the strict, tested version contract (saves are operator tooling, not user data). Features A and D extend the *same* schema by adding their own sections — **no further bump** (the schema is "pre-release" until Feature D ships).

### 4.6 Acceptance criteria — Feature B

- [ ] Executing a world action produces an event entry with the resolved message and a tick.
- [ ] Recording more events than the capacity → the buffer holds exactly the newest `capacity` (oldest evicted).
- [ ] The context endpoint returns the full sectioned narrative for an entity: every listed action carries a description, a range, a requirement, and a valid source-component id; the rendered text is within the budget.
- [ ] Missing/unknown/malformed entity id is rejected (400 for missing/malformed, 404 for unknown).
- [ ] Serialize → mutate world → restore on a fresh instance → the event section is identical (round-trip contract test).
- [ ] The full-state broadcast payload size does **not** grow (no event key in the broadcast — the event log has no read-all method).

---

## 5. Feature A — Turn system (simultaneous planning + initiative by stats)

**Why this design:** LLM agents need seconds to "think"; human reflexes need milliseconds. A shared, *deterministic* cadence is the only way both can act fairly on one server-authoritative loop. We therefore give the world a **round**: a planning window during which *everyone* may enqueue, followed by a single synchronous resolution that replays the queue in **initiative order** derived from stats. Crucially, the resolution calls the *existing* action executor — the turn system owns **timing and ordering only**, never validation or consequences.

### 5.1 Round structure

A round is a **rendezvous**, not a tick span: the round number is stored state (incremented when a round starts), and nothing is derived from the tick clock. The roster is a snapshot of the entities present at round start; the NPC agent call fires at **round start** (the agent is the slowest planner); a per-entity queue cap bounds how much one entity can plan per round. The phase is **stored**, because close is event-driven (all-ready) and can no longer be derived from the tick clock — which is also what makes a restore mid-round resume consistently.

**Why the planning window has no deadline (the barrier):** the window closes as soon as every member of the round-start **roster** has signaled planning complete (a planner removed during planning counts as vacuously complete). There is **no deadline tick** — a player who never signals delays the round indefinitely (binding product decision) — which is why the barrier exposes a ready count and the pending planner IDs (so clients can *see* who is still planning) and why every NPC agent outcome must settle: a rejected or throwing agent signals "did nothing", because no timer would ever catch the hang. Consequence: the phase is **stored** (the public `planning`/`resolution` vocabulary is unchanged — a third public phase would break every existing consumer) and the round state carries an additive **barrier** sub-state (roster, ready set, close tick and reason).

**Why the next round waits one tick:** close and resolution complete in the same call, but the resolution phase stays observable for at least one tick, so the `PLANNING_CLOSED` rejection window is real and testable, and clients see the close transition and the settled state before the next planning transition. The only remaining round constant is the per-entity queue cap (shared constants file).

### 5.2 Initiative (decided — with justification)

Initiative is derived from the entity's **movement stat** (aggregated across its components) — the same aggregation the client already uses for movement range.

- *Why the movement stat:* it is the only stat with "quickness" semantics, it is per-component (so builds/data can differentiate droids), and it is the stat the movement system already treats as speed. Cognition or dexterity stats exist but mean thinking/dexterity — using them for initiative would conflate roles. Adding a brand-new reaction trait would touch the trait data and every component definition for zero gameplay difference today.
- **Tiebreaker (deterministic):** ascending typed entity id. Stateless, survives persistence, no spawn-order bookkeeping. Deliberate consequence: the merchant (low movement) acts *after* the player droids — the merchant is a trader, not a fighter.

### 5.3 Turn controller

A new state controller owns the round and the per-entity queues. It reads entities/stats and calls the existing action executor through the facade, and it receives the NPC agent **by injection** (dependency inversion) so the turn system never imports the LLM layer. It exposes the round state (which joins the full-state broadcast) and a small queue API (queue, cancel, read) used by both players and the NPC agent.

### 5.4 Queuing gate

The existing action-execution endpoint gains an optional **"queue for round"** flag. Absent, it behaves **exactly as today** (immediate execution) — that is the backward-compatibility guarantee for the current UI. Present, the action is queued (subject to entity/action/phase/cap validation) rather than executed. A small read/write surface exposes the round state and the player's queue. **Rule-level rejections** (closed window, full queue) follow the project's existing "rule failure = failed result, HTTP 200" contract; only *malformed* input is a 400. Queue-time validation is deliberately shallow — range may be true at queue time and false at resolution; that is the point of resolution-time validation. Because the planning window closes only on all-ready (never on the clock), a "closed window" queue rejection lasts until the next round starts on the next tick; resolution-phase semantics (initiative-order replay, full validation at replay time, failures discarded with a log) are unchanged by the barrier.

### 5.5 Resolution (determinism contract)

Resolution runs **synchronously** (all consequence handlers are synchronous), executes queued actions in initiative order through the *existing* pipeline (range, requirements, synergy, consequences), and **discards failures with a log, never throwing out of the loop** so one bad entry cannot kill the round. Each actor's outcome is recorded to the event buffer — this is the "who acted in what order" log the LLM context (Feature B) will surface. A single full-state broadcast at the end lets every client see the settled world.

### 5.6 Broadcasting (lowest-friction choice, decided)

Both, deliberately:
1. **The round state inside the existing full-state broadcast** — free via the read-all aggregation; the client HUD always has fresh data with zero new handlers.
2. **A new dedicated thin event** for the two transition moments (planning start, resolution start).

*Why a dedicated event at all:* the phase flip must reach clients the same tick it happens, even when no action (hence no full-state broadcast) occurs; the planning-phase full-state broadcast is otherwise barrier-change-gated (at most once per tick, only when the ready count or the pending set changes), because with unlimited planning a quiet phase can last minutes.

### 5.7 NPC participation in the loop (hook contract — Feature C implements it)

- An entity is an NPC when it is marked as such (Feature D marks it at spawn).
- At **round start**, the turn system calls the injected agent **fire-and-forget** (errors logged, never thrown); the agent's promise settlement (resolve *or* reject) is what signals the NPC's plan-complete — with no deadline, an unsettled agent would hold the round forever. The agent (async, seconds) may:
  1. Queue an action — accepted while planning (up to the cap); if its LLM call returns *after* the window closed, the queue call is rejected and the NPC simply did nothing this round (graceful silence, logged).
  2. Send room chat (Feature D) — chat is real-time and **not** turn-gated.
- No player permission is involved — the agent acts on the NPC's own entity id, which the agent layer injects (never sourced from the model; §6.5).

### 5.8 Persistence

The round state (number, phase, queues, bookkeeping) persists and restores, so a restore mid-round resumes consistently (a restore during planning keeps the pending queues; during resolution the queue is already empty). With the barrier, the persisted round state also carries the barrier sub-state (roster, ready set, close tick and reason) and the stored phase — persisting them is what lets a restore mid-planning resume the *same* round's barrier (same roster, same remaining planners) instead of silently re-planning the round. A mid-planning restore additionally **re-fires the agent** for every roster NPC that still exists and has not signaled — the in-flight promise was lost with the process, and with no deadline an un-signaled NPC would otherwise wait forever. The persistence schema is versioned (bumped for the barrier section, now v3) and old-version snapshots are rejected by the strict, tested version contract: saves are operator tooling, not user data.

### 5.9 Client: turn HUD + queue UX

A new client controller owns the turn HUD (round and phase — **no countdown**: planning is unlimited, so the HUD shows the barrier status instead: the ready count, who is still planning, and when/why planning closed) in an existing empty config-bar slot, and the player's queue list (each entry cancellable). A small mode toggle (`Turn` / `Immediate`) keeps the legacy immediate path always available: `Turn` mode queues during planning and falls back to immediate with a hint otherwise; `Immediate` is always the legacy path. The whole surface **hides when the world has no turn state** (e.g., a test world with no tick loop), so nothing in the existing flow changes.

### 5.10 Acceptance criteria — Feature A

Driven without starting the loop: create the world (tick not started), set the tick, and drive the controller's tick handler.

- [ ] At round start: the phase is planning, the actor order lists the droids with the expected initiative, ties ordered by ascending entity id, and the round state is present in the facade's read-all.
- [ ] Queuing during planning succeeds with a typed queue id; exceeding the per-round cap is rejected.
- [ ] At the resolution tick: the phase flips to resolution, queued actions ran through the normal pipeline (asserted via a stat delta), the event buffer contains the actor/order lines, and the queue is empty.
- [ ] An out-of-range queued action is **discarded with a failure log** at resolution, no exception, other entries still execute.
- [ ] Queuing after the planning window closes is rejected.
- [ ] With a stubbed agent: the agent is called exactly once per NPC at round start; a late settlement (after the round advanced) is dropped with a log, no crash, round completes.
- [ ] The execution endpoint with the queue flag returns a queued result; without the flag, immediate (legacy regression).
- [ ] The queue read/list/delete surface behaves (list an entry, delete it).
- [ ] Serialize mid-planning (with a pending queue) → restore on a fresh instance → queues identical; round-trip contract test passes.
- [ ] Client: the HUD shows round/phase and the barrier status (ready count, who is still planning — no countdown); a queued action appears and can be cancelled; the phase flip is visible.

---

## 6. Feature C — Text actions (the LLM "types" actions; the server validates and executes)

**Why this shape:** the model proposes, the world disposes. The agent layer never trusts the model with *who* acts (the NPC's entity id is injected server-side), pre-validates every proposed action against the *live* capability cache, and caps the loop (iterations, calls, round silence on LLM failure). Tool strategy is **one generic action tool + one speak tool** — not one tool per action — because small local models are far more reliable with a two-tool schema whose action name is an enum from the action data (which now carries descriptions from Feature B), and because the generic tool maps 1:1 onto the existing action payload, so **no second executor exists**.

### 6.1 LLMController fix — full-message return contract

The current LLM controller only returns the message's text and treats a tool-call-only response (empty text) as a parse error, and it forbids the tool-role messages a retry loop needs. The fix is **additive**: a full-message return (text *or* tool calls) plus relaxed message validation for multi-turn agent replay. The plain `/chat` path keeps its exact text contract and today's behavior.

### 6.2 Tool schemas (generated at runtime)

The tools are **generated at runtime from the action data** (names + descriptions) — **never hardcoded** (actions are data, BUG-018). Two tools:
- A **generic action tool** whose action name is an enum from the action registry, plus optional target/parameter fields.
- A **speak tool** for room chat.

Tool choice is `auto`. The speak tool takes **no room parameter** — the agent forces the NPC's current room (the model cannot choose to talk in a room it isn't in).

### 6.3 Agent controller

A new LLM-orchestration controller (lives with the LLM flow; constructed with the LLM controller and the relevant sub-controllers, **not** in the composition root — it is not world state, same tier as the broadcast service). Each round it:
- Guards (entity exists and is an NPC; otherwise a graceful "NPC gone").
- Builds the context (Feature B).
- Runs **one** LLM call with a **bounded timeout and token cap**, the NPC's system prompt, and the generated tools.
- Parses tool calls, **pre-validates** each (known action; ID hygiene; live capability gate; **actor forced to the NPC's entity id**), and dispatches (queue during planning, else immediate).
- **Retries at most once** on a pre-validation/execution failure, feeding the error back into history.
- On **LLM failure**, the NPC is **silent for that round** — it never throws out of the tick-driven hook. Prose-only (no tool call) is treated as "the model chose silence" and does **not** burn the retry.
- Stores a **capped transcript** (last two rounds) for replay.

### 6.4 System prompt

The system prompt is built from the NPC's data (display name, room, personality) and states the world rules: act only through the provided tools; you are the only actor (never another entity's id); at most N world actions and M chat messages per round; use only currently-executable actions (else talk briefly or stay silent); keep chat short and in character; respond with tool calls only.

### 6.5 Limits & security (decided)

| Limit | Choice | Why |
|---|---|---|
| LLM timeout per round call | Bounded, well inside the planning window | The NPC agent call must land comfortably before the planning window closes, or the queued action is meaningless. |
| Iterations per round | 2 (initial + 1 retry) | Bounded cost; weak models rarely recover from 2. |
| World actions queued per round | Capped (below the turn system's cap) | One LLM call can emit several tool calls; both layers cap. |
| Chat per round | Capped | Stops chatty loops. |
| Token cap | Bounded | Tool-call rounds are short; caps worst-case latency. |
| Acting identity | **Server-injected** entity id | The model can describe targets but never the actor; the speak room is likewise forced. |
| HTTP exposure | None — the agent is server-internal only | No new endpoint, no rate limiting needed beyond one call per NPC per round. |

### 6.6 Wiring

The agent is constructed with the LLM controller, the facade, and the context/chat/turn sub-controllers, and is wired as the turn system's NPC agent. (Feature D must exist first, since the agent reads the room-chat controller.)

### 6.7 Acceptance criteria — Feature C

- [ ] The full-message return resolves a tool-call-only response (empty text + tool calls) — the pre-fix bug — while the plain chat path keeps its exact string contract.
- [ ] Message validation accepts assistant+tool replay and still rejects a tool message without content.
- [ ] With a stubbed LLM returning an action call → the action is **queued on the turn system** with the NPC's entity id (not the model's claimed actor).
- [ ] Stub LLM returns an unknown action → exactly one retry with the error in history; transcript shows two iterations; no world mutation.
- [ ] Stub LLM times out → the round resolves with a timeout error, no throw, no queue entries, NPC silent.
- [ ] Stub LLM returns prose only → recorded as "prose-only", zero retries burned.
- [ ] Capability gate: an NPC with no equipped knife proposing cut (empty capability) → rejected.

---

## 7. Feature D — NPC entity + per-room chat

**Why a new blueprint (not reuse):** the merchant must be *legible* — distinct name, distinct stats (its initiative below the player's by design), and a flag the turn system and UI both read. Reusing the player's blueprint would make the NPC statistically identical to the player's droid and indistinguishable on the map; a few small new component types keep the data as the single source of truth (BUG-018).

### 7.1 Data

A new merchant **blueprint** mirrors the player's structure with a few new component types (core, head, arms, rolling balls). A new **NPC registry** data file holds, per blueprint, the display name, home room, personality, initial items, and per-round action/chat caps. The merchant's movement stat is deliberately low (acts after the player), and its other stats make a melee action available; the rest is flavor for the LLM.

### 7.2 NPC spawn (server)

At world init, the server loads the NPC registry and spawns each entry at the **center of its home room**, marked as an NPC with its display name and config, and equipped with its initial items. Spawns **skip the declarative world initial-spawns** (which target player-droid component types) so the merchant does not get spammed with failed spawns and instead receives its own goods. The display name is what map labels and chat show; player entities keep no name and the UI falls back to a default.

### 7.3 Room chat backend

- A new state controller owns **per-room ring buffers** of chat messages (bounded, oldest evicted) and deliberately exposes **no read-all method**, so it stays out of the full-state broadcast (clients use a dedicated event + a read endpoint).
- **Delivery decision (global emit, not server rooms):** the codebase has zero socket-rooms usage; introducing server rooms means a join/leave protocol on room focus, socket↔room bookkeeping, and re-join on reconnect — for one player + one NPC that is pure friction. So chat is emitted **globally** with the room id in the payload, and the client filters by its focused room. *Documented re-evaluation trigger:* if the world ever hosts many rooms × many players, revisit with real server rooms.
- Chat is keyed by **room UID** (what both sides already hold on entity location — no extra id mapping in the hot path).
- The route **reuses the chat rate-limit policy** (per-IP).

### 7.4 Room chat client

A new client controller shows the focused room's chat: renders history on focus, appends live messages for the current room (or increments an unread badge otherwise), and posts new lines. A new CSS file styles the panel, message list, speaker colors (player vs. NPC distinct), input, and badge. A config-bar button + overlay entry point it. The world map renders each entity's **display name** (falling back to a default) — the single UI change that makes the NPC legible on the map.

### 7.5 NPC ↔ chat integration (the loop closing)

- The NPC *hears* the player: the LLM context carries the recent messages of the NPC's room, so a player line this round can be answered in the NPC's *next* round (at most one round of latency — acceptable for chat).
- The NPC *comments on the world*: the recent-events section includes turn-resolution lines, so the NPC can react to being punched.
- The player *sees* the NPC: chat panel (live event) + map name label + the full state (entity, items, durability).

### 7.6 Acceptance criteria — Feature D

- [ ] Boot: a third entity exists in the start room at room center, marked NPC, with the display name and initial items; the spawn log shows zero failed initial-spawn lines for the NPC.
- [ ] Map: the NPC renders with the display-name label.
- [ ] A chat message posts (200); a second client sees the event; the read endpoint returns it; the rate limit kicks in.
- [ ] Empty/over-length message → 400; unknown room → 404.
- [ ] The N+1th message in a room → the ring keeps the newest N.
- [ ] The NPC's LLM context includes the player's chat line under the room-chat section.
- [ ] With a stubbed LLM returning a speak call, the NPC's line appears in the player's chat panel with its name (no client REST call involved).
- [ ] Serialize/restore round-trip preserves room chat.
- [ ] Turn order: the merchant (low initiative) sorts after both player droids.

---

## 8. Implementation order & rationale

| Step | Depends on | Why here |
|---|---|---|
| **0** | — | Feature A's tests and the client work on top of the internal-component routes and the inventory drag flow; a broken base makes every later test ambiguous. Also removes the `dropped-…` ID antipattern before the queue id is formalized. |
| **B** | 0 | **C's hard prerequisite:** the agent's context, the action descriptions, and the tool enum all come from B. A's event lines also land in B's buffer, so B must exist before A's resolution loop is written. B ships independently value (the context endpoint works against today's real-time world). |
| **A** | B | **Defines when C is invoked:** the NPC agent is fired by the turn system's planning tick and its actions queue through A's gate. A ships playable without C (players queue, no NPCs — the agent hook unset is a legal state). |
| **C** | A, B | The agent needs A's queue + NPC hook and B's context/descriptions. Until D exists, C is testable with a stub NPC entity — no product gap. |
| **D** | A, B, C | The NPC is the *consumer* of everything: spawn (world data), planning (A), acting/speaking (C), and being read (B). The chat backend is independent and could be pulled forward, but its only producer besides the player is the NPC, so it ships with the NPC. |

Each step ends green: tests added per step (§9), existing suite untouched except the persistence contract (the schema sections land incrementally — B, then A, then D; the section list is asserted only in D's final state).

---

## 9. Test plan

| Area | Type | Covers |
|---|---|---|
| Event ring buffer | unit | capacity/eviction, recent ordering, serialize/restore |
| Context renderer | unit | section presence & order; action line format; budget truncation priority and empty-section handling; other-room entity labeling |
| Tool-call parsing | unit | valid multi-call, malformed arguments, unknown tool, prose-only, empty arguments |
| LLM controller | contract | **stubbed fetch:** content-only and tool-call-only responses; timeout; message validation accepts assistant+tool replay, rejects tool without content |
| Turn system | contract | the full §5.10 checklist — driven deterministically via the tick (no timers); initiative ordering + tiebreak; queue cap; closed planning; resolution through the real pipeline (stat delta asserted); failed entry discarded without aborting the round; NPC hook fired once and late queue rejected; broadcasts emitted (stub); serialize/restore round-trip |
| Room chat | contract | send/read, per-room eviction, over-length rejection, unknown room, broadcast via stub, serialize/restore |
| Agent | contract | **stubbed LLM** (+ real world + stubbed NPC entity): tool call queued with injected entity id; unknown action → exactly one retry with error feedback; timeout → graceful silence; prose-only → no retry burn; capability gate blocks an unequipped action; transcript capped |

**Existing tests to update:** the persistence contract (schema version and required-sections list grow as B/A/D land) and the facade public-method snapshot (new wrappers + sub-controllers).

---

## 10. Risks & open decisions (only what needs a human)

Everything else in this spec is decided. Three items genuinely need sign-off:

1. **Turn-gating of player combat — always-on vs opt-in.** *Design decision:* turns are always active; the UI defaults to `Turn` mode but `Immediate` remains always available (legacy behavior preserved). *Open question:* do we want player *core* actions (punch/cut/move) eventually **forced** through the queue (true turn-based combat), with only utility actions immediate? This is a gameplay-direction call — this design is built to flip that later (it would be a one-line UI policy change + hiding the Immediate toggle).
2. **Strict new-version persistence — old saves rejected.** *Design decision:* restore rejects old-version snapshots (the documented, tested contract). *Open question:* acceptable for operator saves, or do we need a one-shot migration? Recommend strict; migration is trivial to add if a save actually exists.
3. **No JSON-in-text fallback for tool calling.** *Design decision:* v1 relies **only** on the model's native tool calls; a prose-only response is interpreted as "NPC chose silence" (never parsed as pseudo-JSON). *Open question:* if the chosen local model proves unreliable at tool calling in practice, should we add a strict-JSON text protocol as fallback (more prompt complexity, weaker guarantees)? Recommend staying tools-only and picking a stronger local model if needed.

*End of specification.*
