# Hint System

## 1. Overview

The hint system gives actionable suggestions about what to do next. Hints are computed by the **server** from live world state and have exactly **two consumers**: the **player** (on demand, displayed in the UI) and the **LLM NPC agent** (injected into its per-round world context so the model is guided toward viable actions). v1 implements exactly **one hint — the reachability-move hint** — but the system is built as an extensible rule registry so future suggestion types can be added without touching the route, the client, the LLM context layer, or the facade.

The first hint answers the most common dead-end in the game: an entity wants to interact with an item that is **out of reach**, gets an error with no guidance, and has to figure out on their own where to move. The hint converts that failure into a concrete next action.

## 2. Purpose and Scope

### Why a hint system exists

- **Turns failures into guidance**: today an out-of-range interaction produces only a red error popup. The error says *what* is wrong, not *what to do about it*. A hint closes that loop.
- **Onboarding aid for spatial reasoning**: range is derived from entity stats (see [Door Range System](door_range_system.md) and [Movement System](movement_system.md)), which is not obvious to new players. A hint teaches the range/movement relationship by showing a reachable intermediate position.
- **Guidance for the LLM agent**: the NPC agent ([LLMAgentController](src/controllers/networking/LLMAgentController.js)) acts on a text rendering of the world and currently has no notion of *where* to go — a model that wants to grab a distant item just fails the range check and burns its retry budget. Feeding the agent the same deterministic hints tells it exactly which move to take and where, without the model doing its own (unreliable) spatial math.
- **Extensibility by design**: the hint system implies future suggestions (requirement hints, attack-range hints, navigation hints). The registry pattern makes each future hint an isolated rule module.

### Scope of v1 (explicit)

- **One rule implemented**: the reachability-move hint — "target entity/item is out of the player's reach → suggest a position that gets the player closer."
- **Target candidates in v1**: dropped items **and** entities (NPCs, droids) in the player's room. Both candidate types are evaluated against the same reach gate. Cross-room targets are out of scope (doors have their own [door range system](door_range_system.md) with green/red hover feedback).
- **Not in v1**: pathfinding, requirement-not-met hints, a manual "hint" button, LLM-*generated* hints (the LLM consumes hints; it does not produce them), broadcast/push delivery. The route is stateless and queryable at any time, so all of these can be added later without a contract change.
- **i18n**: v1 uses English exclusively for hint messages; Portuguese or other locales are planned as a future extension.

## 3. Design Decisions (Why)

### Why deterministic computation, with the LLM as consumer (not producer)

- **A hint is arithmetic, not language.** The suggested position is a pure function of numeric world state: entity position, target position, room bounds, movement stat, and range. An LLM is unreliable at exact coordinate math, and a wrong coordinate is worse than no hint — so the coordinates are computed deterministically even in the LLM-facing path.
- **Availability and latency.** Hints must work with **no** LLM backend configured, exactly like the rest of the world-state flow. If hint quality depended on the model, guidance would disappear precisely when the backend is down or slow.
- **Flow separation.** Per [Project Rules §4](../../project_rules.md), LLM interaction and world-state management are distinct middleware flows. Hints read world state and belong to the world-state flow; the LLM flow *consumes* them at context-build time.
- **One engine, two consumers.** The player-facing path and the LLM context section both call the same hint logic — the agent is guided by the same suggestions the player would see, so "what the game considers a good next move" has a single definition. The LLM never computes a hint and never sees a coordinate the deterministic engine did not approve.

### Why the LLM agent is fed the hints (and where)

- **The agent's only perception is the context text.** The agent's per-round context is built by [LlmContextController](src/controllers/networking/LlmContextController.js) and the model acts only on what that text contains. A hint that reaches the player but not the context is invisible to the agent.
- **The context already has a stable section format.** The context renders stable section headers, printing a placeholder for empty sections so weak local models always see the same structure. Hints plug in as one more such section — minimal disruption, maximal consistency with the existing prompt engineering.
- **Hints fix the agent's biggest failure mode: spatial aimlessness.** Without a hint the model sees an item listed as nearby and attempts a ranged action, fails the server range gate, and wastes its single retry. With a hint it sees an explicit, pre-validated move target and can queue a move to exact coordinates, then retry the ranged action next round.
- **The hints section is cheap and bounded.** At most a few short lines per round, inside the existing context character budget, so guidance does not starve the other sections.

### Why server-side evaluation, client-side trigger

- **Single source of truth.** Positions, room geometry, component stats, and dropped items are authoritative on the server. Client state can be stale between broadcasts; a hint computed on stale client data could suggest an impossible position.
- **The client keeps its fast pre-check.** The existing pattern (see [Door Range System §2](door_range_system.md)) is: the client validates range instantly for UX, the server authorizes. The hint inverts the same idea: the client *detects* the frustration (it already did, to show the red popup) and the server *computes* the suggestion. One round trip is acceptable here because the hint is a reaction to a rejected action, not a hover-time interaction.

### Why trigger on the out-of-range click (not turn end, not polling)

- **Relevance.** A hint is a reaction to a concrete blocked intent. The only moment in the current UI where "range not satisfiable" is actually true for the player is the dropped-item click rejection. Hinting on turn end or via polling would produce noise (empty hints most of the time) or stale hints (state changed since the request).
- **Non-intrusiveness.** The hint appears *after* the red error popup, as a follow-up. The player asked for something, was told no, and is told how to get yes.

### Why the reach check agrees with the client's range gate

The hint must agree with the gate that produced the error, or it will be absent exactly when the player is frustrated. The client resolves an action's range from the player's stats with a documented fallback, and the server rule uses the **same shared range resolver** — the project's single source of truth for range expressions — so both sides classify reach identically. Duplicating a different range rule on the server would reintroduce exactly the desynchronization the hints are meant to prevent (cf. [BUG-083](../bugfixWiki/high/BUG-083-dropped-item-distance-check-coord-mismatch.md)).

### Why continuous room-centered coordinates

- The spatial model is **continuous**, room-relative, and origin-at-room-center. There is no grid, so "one step toward it" is a vector of length up to the player's movement stat, not a cell hop.
- **One step = the player's movement stat.** Suggesting a point exactly one full move-step toward the target guarantees the player can act on the suggestion in a single move action.
- **Clamping to room bounds** guarantees the suggested position is valid inside the room, using the same room-centered bounds the door-position math already uses. A guard verifies the clamped position still strictly reduces the distance to the target; otherwise no hint is produced (a false "get closer" is worse than silence).

## 4. Architecture

Read-only, pull-based, and stateless per request: each consumer asks the hint controller, which asks the facade for world data, evaluates the registered rules, and returns whatever the rules produced. No world state is mutated and no new broadcast payload is added (so there is no state-desync surface, cf. [BUG-008](../bugfixWiki/high/BUG-008-state-desync.md)).

Controller placement follows [Controller Patterns](../controllers/controller_patterns.md): the hint controller is a **logic controller** (computation, no owned game data) constructed in the composition root and wired to the facade through a setter after the facade is built — the same late-facade-injection pattern used by [RangeValidator](src/controllers/actions/RangeValidator.js). The rules are stateless modules instantiated by the controller (utility-class rule, Controller Patterns §8).

The two consumers (the player route and the LLM context renderer) both call the same hint entry point; the controller does not know which consumer is calling, so adding a third consumer later requires no change to the controller.

## 5. Future Extensions (out of scope for v1)

- **Manual "hint" button** in the config bar: the route is already stateless — add an endpoint entry, a config-bar button, and wire it through the client hint manager with no server change.
- **Requirement-not-met hints** (e.g. missing strength for pickup): a new rule reading the action registry's requirements; same response contract — automatically visible to both the player path and the agent's context section.
- **LLM-generated freeform hints**: a future rule could ask the LLM to phrase a deterministic suggestion in character; the registry isolates text from geometry, so the deterministic engine stays the source of truth.
