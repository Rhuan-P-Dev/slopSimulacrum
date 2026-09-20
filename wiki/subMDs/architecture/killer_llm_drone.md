# Killer LLM Drone Architecture

## Overview

The killer LLM drone is the project's first env-gated, goal-bearing NPC: an `isNPC` entity whose sole purpose is to attack every other entity, whose spawn is controlled by an environment variable that is **off by default**, and whose decisions are made by the LLM agent loop rather than the deterministic brain. It is defined entirely by data — a blueprint composition, an NPC registry entry carrying an objective and an env-gate flag, and a declared loadout — and flows through the existing production-hardened LLM pipeline end-to-end. No dedicated controller, no new routing predicate, and no new decision system exist for it.

## Why a data-driven LLM-routed NPC instead of a dedicated controller

The drone's round loop — bounded context building, the model call, tool-call parsing, pre-validation, dispatch through the standard action pipeline, a single retry, transcript replay, turn discipline, and graceful degradation — is the same production-hardened loop that already drives the project's LLM NPCs, written once. A dedicated "killer" controller would have duplicated every one of those concerns for near-identical behavior, and would have introduced a new invariant to protect (that two loops never drive the same entity).

The decisive reframe is that the drone is *content* — a new NPC with a goal — not a new *kind* of decision system. It is the LLM-side twin of the deterministic chase-and-attack NPC: same world, same action pipeline, same turn discipline, with its choices coming from the model instead of a registered strategy. Keeping it on the shared loop also means the drone inherits every future hardening of that loop for free, and it satisfies the data-driven design standard: the blueprint, room, goal, loadout, per-round caps, and gate all live in the data files, so any future env-gated or goal-bearing NPC is a data edit, not a code change. The existing droid NPC was already an LLM agent; the drone is the same animal with a different goal.

## Why the routing needed no new predicate

Ownership of an NPC's decisions is already determined by one question: does the entity carry a deterministic `ai.behavior` configuration? A shared brain-vs-LLM routing predicate answers that in one place, the server's per-round dispatcher routes entities with a deterministic brain to the brain and every other NPC to the LLM agent, and the agent repeats the same check internally so the two decision systems can never drive one entity.

Omitting the `ai` block from the drone's registry entry is therefore *itself* the routing decision: no new predicate, no new branch, no new guard. This is why the deterministic brain controller and its shared utility remain entirely untouched by the feature.

## Why the spawn gate is data-driven and deliberately relaxed

The *name* of the gating variable lives in the registry entry (`envGate`), while the *mechanism* — skip the entry with a log when the named variable is not on — is generic code that applies to any entry that declares a gate. That split is what makes the feature extensible without code: a future env-gated NPC is a data edit, an entry without a gate spawns unconditionally exactly as before, and a missing or malformed gate means "no gate", so bad data can never fail boot — the same tolerance the registry already has for malformed entries.

The gate is evaluated once at bootstrap, when NPCs are spawned. It is a spawn-time gate, not a runtime toggle: a restart is required for a change to take effect. That is deliberate — the server's entity set is fixed at boot, so a runtime switch would only promise a toggle the world cannot honor.

The on/off test intentionally uses the relaxed comparison shared by spawn-time gates (a string equal to "true" after trimming and case-folding) rather than the strict per-request check the API-authentication gate uses. The two sites protect different things: the auth gate guards every API request and its strictness is a security semantic that must not be loosened; the spawn gate is a developer convenience that can afford to tolerate what a human typed. Unifying them would either weaken production auth or make the spawn gate hostile to its users, so they are kept deliberately distinct. The default is off: with the variable unset the entry is skipped, no entity is created, and nothing else in the pipeline changes.

## Why the objective lives in data and renders into the prompt

The goal is a sentence in the registry, rendered into the LLM's system prompt as an objective line plus a strengthened rule: advance the objective instead of staying silent when a round cannot complete it. That split — the model is told *what to want*; the standard action pipeline (requirements, range, consequences) constrains *what it can do* — is the whole safety story. A goal-bearing prompt cannot make the physically impossible happen, because every proposed action still passes the same validation a player's action passes, and a failed action is recorded as feedback the model learns from.

Keeping the objective in data rather than in a code branch means a designer can reword or retarget an NPC's purpose without a code change, and the engine contains no dedicated branch for the drone at all. The extension is strictly additive on both copies of the data: the persisted entity configuration gains the field only when present, and the prompt gains the two lines only when the registry entry has a non-empty objective — every existing NPC's prompt renders byte-identically to before, which the test suite pins as a regression guard. The prompt is rendered from the agent's own read of the registry while the persisted copy exists for serialization and inspection; the two stay in sync through the single data file.

## Why pre-filled containers use the generic `contents` / `equip` mechanism

The drone's T1 weapon spawns with its magazine already loaded with knives. Rather than a one-off special case for this drone, the loadout declaration gained two *generic* extensions: an optional per-entry flag that equips the item on a host component that can actually meet its holding-cost requirements (instead of merely holding it), and an optional nested `contents` list that places items inside a container item at spawn time — the same container model the world already uses for player-carried ammunition, re-exposed for NPC loadouts. Built only on the public add / nest / equip facade, they make any future NPC able to spawn armed and pre-loaded with no new code.

Each extension degrades safely: an item that cannot be added, nested, or equipped is logged, and the entity keeps its unequipped baseline (the punch that needs no equipment), so a loadout problem can never fail a spawn.

## Accepted trade-offs

### Same-room perception, not a world-wide target list

The drone's world view is the same bounded, same-room-scoped context every LLM NPC reads: full detail for entities in its own room, and a small number of other-room entities by name only. "Attack all other entities" is therefore realized *incrementally* across rounds — strike what is in range, move or dash (or use the chase-and-attack instinct) toward what is not, and continue in each new room entered. A world-wide target list was rejected because widening the context budget for one NPC would not make out-of-room attacks possible anyway: the pipeline's range check makes them physically impossible regardless of what the model is told. The bounded view is the honest one.

### Silent rounds, never a second brain

When the LLM is unavailable, times out, or returns malformed or degenerate output, the drone is simply silent for that round and retries independently the next round — the project's established degradation for LLM-driven entities, and the only one consistent with the invariant that exactly one decision system drives each entity. A deterministic fallback ("if the LLM fails, attack anyway") was explicitly rejected because it would give the drone two brains and defeat the very routing invariant the feature relies on.

The drone is a "killer" in intent, not in reliability guarantees: with the backend down it stands still, exactly like every other LLM NPC. The decision loop is built to never throw out of the turn-system tick, so no LLM failure mode can break the round loop or the server — and because spawning does not depend on LLM availability, the drone still spawns, persists, and broadcasts like any other entity even when the backend is down at boot.

## Related

- [Communication and Error Handling](../networking/communication.md) — why LLM output is treated as untrusted external data and validated at one centralized boundary
- [NPC AI Controller](../controllers/npc_ai_controller.md) — the deterministic-brain counterpart, and the shared routing predicate that separates the two decision systems
- [Inventory System](../data/inventory_system.md) — the flat, polymorphic container model that the pre-filled `contents` mechanism nests into
