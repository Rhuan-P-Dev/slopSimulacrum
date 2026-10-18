# toApproach Agent Tool

## 1. Why this tool exists (problem)

The agent expresses intent as **named entities** ("get close to that merchant"), but the only registered movement action (`move`) is a **coordinate** action: it takes `targetX`/`targetY` in *room* space. Asking a small local model to know — or compute — the target's coordinates is a reliability trap: the agent's context carries entities and their names (Feature B renders entities, not a coordinate grid), so any coordinates it invents land elsewhere and the NPC walks away from the intent. The same trap is exactly why [killer_llm_drone.md](killer_llm_drone.md) forgoes a world-wide target list: the model's view of the world is room-bounded, and coordinates must be resolved server-side.

`toApproach` turns "get close to entity X" into a first-class tool: the model **names the target** (`ent-*`), and the server resolves the target's **live** room coordinates at dispatch time. Intent at the model side, deterministic geometry at the server side.

## 2. Why it's a tool, not a new action

Approach is not new movement behavior — it **is** the registered `move` action aimed at the target's live position. It therefore lives in the **tool layer** (`LLMAgentController._buildTools`) and is mapped 1:1 onto the registry's `move` entry at dispatch (`_dispatchApproach`). Consequences:

- the action registry stays the single source of truth for how movement works (no new action, no new requirement, no new consequence handler, no new broadcast);
- `move` keeps owning the requirement (`Movement.move` stats), the `deltaSpatial` consequence (one step capped by speed — and by the distance left to the target), and the `move` broadcast;
- approach keeps the registered move **data-driven**: new movement modifiers from `data/systems/actions.json` apply to `toApproach` for free.

`toApproach` contributes only an **intent + coordinate-resolution** step; everything about the actual movement already exists in the registry.

## 3. Why same-room only (and what happens across rooms)

Spatial coordinates are per room (`entity.spatial`), and the agent's context (Feature B) is same-room perception — out-of-room entities are known by name only. "Approach" across rooms is a pathfinding problem, and the design deliberately refuses it as an accepted trade-off (echoing [killer_llm_drone.md](killer_llm_drone.md) §2): the pipeline paces approach incrementally —

1. `move` with a door via `targetRoomId` (the registered move action's own cross-room semantics), then
2. `toApproach` each round in the room the target shares —

a weak model still traverses the map, but round by round, never in one call. The tool description says "same-room only" up front, and the validation returns a hint ("travel through a door (move with `targetRoomId`) first"), so the agent is never silently dropped — it is steered. Cross-room approach is physically impossible anyway (range is per-room), so nothing is gained by pretending otherwise.

## 4. Why it spends one world-action slot

A successful approach is a **world effect** (the NPC moved through the `move` consequence pipeline — queued during planning, immediate fallback otherwise), not a chat message. It therefore counts against `maxWorldActionsPerRound` exactly like `execute_action`:

- one LLM call may emit several `toApproach` calls; both layers cap;
- an approach that "costs" nothing per round would let a single round burn the entire action budget on movement and starve attack/defense — the same budget that already protects against action-spam;
- one slot = one maximum-step move per round, which is the world's honest per-turn cost (the `deltaSpatial` cap).

`execute_action` on `move` and `toApproach` are budget-equivalent by design: same registry action, same consequence, same cap.

## 5. Why the tool (not `execute_action` on `move`) for "get closer"

`move` is the *general* movement tool — right for "go to x/y", "step toward the door", "walk away". But a model that says "chase the merchant" is already choosing an *intent*; making it also pick coordinates turns one decision into two, and the second decision is made against data the model does not have. `toApproach` collapses it: the intent name is the API, coordinates are an implementation detail. Both tools coexist because the registries they wrap are different concerns — **where** to go (coordinates) vs. **who/what** to get near (entity identity).

## 6. Failure semantics (identical to `execute_action`)

The tool is a world action, so it follows the same discipline as the action tool:

| Failure | What the agent sees |
| --- | --- |
| Bad argument shape / missing `targetEntityId` | `malformed tool arguments` / `missing "targetEntityId"` — no world mutation |
| Wrong id type (`comp-*`, `item-*`) | `invalid id format: targetEntityId="..."` — id hygiene is type-prefixed, [BUG-081-style direct access avoided](../bugfixWiki/README.md) |
| No such entity (respawned/removed) | `target entity not found` |
| Target in another room | `target not in your room — travel through a door (move with targetRoomId) first` |
| No spatial data on target | `target has no spatial position` |
| `move` not currently executable (stat gate) | `move not executable right now (insufficient movement stats)` |
| Queue full / planning window closed (turn world) | queued=false, `planning window closed` — the NPC stays **silent this round**, never bypassing the turn system (spec §5.8) |

On any world-action failure the agent gets **exactly one retry** with the failure fed back as a tool-role message (spec §6.3), then the round ends. The outcome is **replayed truthfully**: a successful approach appears in the next round's transcript as a tool message with `success: true` and the dispatch detail (e.g. "move queued toward target"), so the model knows it got closer instead of re-issuing the same call.

## 7. Where it lives (code seams)

- **Schema:** `LLMAgentController._buildTools()` — `toApproach` is always in the tool list (like `execute_action`), `speak_in_room` added when chat is enabled, `use_instinct` when instincts exist. Action names/descriptions stay generated from the registry; the toApproach shape is the one fixed constant (its "action" is always the registered `move`).
- **Parsing:** `LLMAgentController._parseToolCalls()` returns `approaches` alongside `speak`/`action`/`instinct`.
- **Validation:** `LLMAgentController._prevalidateApproach()` — id hygiene, live-entity resolution, same-room check, spatial check, `move` capability gate. Mirror of `_prevalidateAction()`.
- **Dispatch:** `LLMAgentController._dispatchApproach()` → `_dispatchAction(npcEntityId, 'move', { targetX, targetY })` — queue-while-planning / immediate-fallback semantics, `move` consequence, and turn effects apply unchanged.
- **Budget:** the shared `maxWorldActionsPerRound` gate (same counter as `execute_action`); over-budget → `max world actions per round reached (N)` failure + one retry.
- **Truthfulness:** `_transcriptFor()` replays each approach by its `tool_call` id (success + dispatch detail), and `_buildFeedbackMessages()` uses the same id-matched entry for the retry tail.

## 8. Related

- [llm_turns_npc_spec.md](../llm_turns_npc_spec.md) — §6.2 (tool strategy, updated), §6.3 (retry), §5.8 (late-response rule)
- [killer_llm_drone.md](killer_llm_drone.md) — the same "approach is an incremental, per-room pipeline" trade-off, at the drone level
- [movement_system.md](movement_system.md) — the underlying movement mechanics `toApproach` rides on
- [bugfixWiki/README.md](../../bugfixWiki/README.md) — context for BUG-081 / BUG-122 (public-API-only rule this tool *follows*: approach touches only the public `executeAction` seam)

## 9. Known trade-offs (accepted)

1. **Per-round approach ≠ pathfinding.** An agent stuck in an adjacent room must walk door-by-door; one LLM round = one move step. That is the documented pacing cost — cheaper and more predictable than asking the model for routes.
2. **Coordinate resolution happens at dispatch.** The target's position is read *just before* the `move` executes, so a target that moves between validation and execution is approached to where it *was*; if it is now out of range, `move`'s delta caps to distance and it simply does not overshoot. Same behavior as any `move`, no special case.
3. **`toApproach` is the intent, `move` is the effect.** If future movement gets richer (e.g. pathing actions), the intent→action mapping in `_dispatchApproach` stays the only thing to change — the tool schema does not.
