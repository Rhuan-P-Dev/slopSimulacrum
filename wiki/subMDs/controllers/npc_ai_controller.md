# 🤖 NpcAIController

## Why

The `NpcAIController` provides a deterministic, stateless alternative to LLM-based NPC decision-making. It decouples AI behavior logic from the game engine through a behavior registration pattern, enabling new behaviors to be added without modifying the core loop.

## Design Principles

- **Stateless**: reads world state via public APIs; never mutates state directly.
- **Public API only**: always communicates with the WorldStateController facade through its public surface; never accesses sub-controllers directly.
- **Data-driven**: behaviors are registered as named strategies; the brain contains no hardcoded branches.
- **Fail-safe**: failures in behavior strategies are contained so they can never break the turn-system loop.
- **Single responsibility**: one decision = one action per round, with dispatch centralized in a single place.

## Behavior Registration

A behavior is a registered strategy that receives the entity, the round, and the AI facade, and returns the action it has chosen (or a skip when no action is warranted).

| Name | Description |
|------|-------------|
| `chase_attack` | Pursues the closest entity in the same room; attacks when within `attackRange`. The attack targets a component that can receive damage; if the preferred component is destroyed, the AI deterministically selects an alternative viable component so the action stays effective. When no viable component exists, the attack is skipped. |

## Dispatch Contract

The dispatch path mirrors the LLM agent's dispatch contract, so deterministic decisions flow through the same action pipeline as LLM decisions. Decisions made during the planning phase are queued for the turn, and when the turn system is disabled they execute immediately. A decision that arrives after the action window has closed is discarded with a log rather than executed — NPC actions are subject to the same turn discipline as LLM actions.

## Performance

- **Single per-tick snapshot**: the world is snapshotted once per decision and shared with the behavior strategy, avoiding repeated state fetches on the hot path.
- **Clone-free capability gate**: capability checks answer "can this entity execute this action?" without building the entity's full action list, avoiding full-world deep clones on the hot path.

## Public API

The entry point is invoked by the turn-system agent hook on a fixed tick; it accepts an optional pre-fetched entity so the dispatcher can avoid a duplicate state fetch. Behavior registration is the extension point for new deterministic behaviors.

The brain-vs-LLM routing predicate is a static helper extracted to a shared utility ([`src/utils/npcAiUtils.js`](../../src/utils/npcAiUtils.js)) so that every caller routes on the same implementation.

## Integration Points

- **Dispatcher** (`src/server.js`): entities with a deterministic brain are routed to this controller; all others go to the LLM agent.
- **Boot validation** (`WorldStateController`): AI configuration (behavior and attack range) is validated once at spawn; present-but-mistyped values are logged with the NPC, field, offending value, and expected type, so bad data is fixed in the data files rather than failing at runtime.
- **LLM guard** (`LLMAgentController`): skips entities with deterministic brains, so both decision systems never drive the same entity.
