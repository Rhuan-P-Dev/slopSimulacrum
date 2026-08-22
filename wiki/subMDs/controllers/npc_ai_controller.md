# 🤖 NpcAIController

## Why

The `NpcAIController` provides a deterministic, stateless alternative to LLM-based NPC decision-making. It decouples AI behavior logic from the game engine through a behavior registration pattern, enabling new behaviors to be added without modifying the core loop.

## Design Principles

- **Stateless**: reads world state via public APIs; never mutates state directly.
- **Public API only**: always communicates with the WorldStateController facade via its public methods (`getAllEntities()`, `getActionRegistry()`); never accesses sub-controllers (`stateEntityController`, `actionController`) directly.
- **Data-driven**: behaviors registered via `registerBehavior(name, strategyFn)` — no hardcoded branches in the brain.
- **Fail-safe**: root-level try/catch ensures bugs in behavior strategies cannot break the turn system loop.
- **Single responsibility**: one decision = one action per round; dispatch centralized in `_dispatchDecision`.

## Behavior Registration

Behaviors are functions receiving `{ entity, round, ai, facade, allEntities? }` and returning `{ actionName, params }` or `null`.

| Name | Description |
|------|-------------|
| `chase_attack` | Pursues the closest entity in the same room; attacks when within `attackRange`. Attack decision selects `targetComponentId` by preferring a component with `Physical.durability` (health-equivalent stat); fallback is `components[0]`. |

## Dispatch Contract

`_dispatchDecision` mirrors `LLMAgentController._dispatchAction`:
- `phase === 'planning'` → `queueAction(entityId, action, params, 'npc')`
- no `roundState` (TURNS_DISABLED) → immediate `executeAction` fallback
- window closed → discard with log, returns `{ acted: false, reason: 'window_closed' }`

## Performance

- **Single per-tick snapshot**: `getAllEntities()` is called once per `think()` and passed into the behavior strategy via `allEntities` context.
- **Clone-free capability gate**: uses `canEntityExecuteAction(entityId, actionName)` instead of `getActionsForEntity()` to avoid full-world deep clones on the hot path.

## Public API

- `think(entityId, round, preFetchedEntity = null)` — entry point called by the turn-system agent hook (tick 20); optional third parameter allows dispatcher to pass a pre-fetched entity to avoid double-fetch.
- `registerBehavior(name, strategy)` — register a new behavior.
- `hasDeterministicBrain(entity)` — static routing predicate (brain vs. LLM); the underlying predicate logic now lives in [`src/utils/npcAiUtils.js`](../../src/utils/npcAiUtils.js) and this method delegates to it.

## Integration Points

- **Dispatcher** (`src/server.js`): `ai.behavior` → `think()`; otherwise → LLM agent.
- **Boot validation** (`WorldStateController._spawnNpcs`): validates `ai.behavior`/`ai.attackRange` once at spawn (warns + normalizes); present-but-mistyped values (e.g. `"attackRange": "50"` string, `attackAction: 123` number) produce a `Logger.warn` identifying the NPC, field, offending value, and expected type.
- **LLM guard** (`LLMAgentController.runRound`): skips entities with deterministic brains (`DETERMINISTIC_AI`).
