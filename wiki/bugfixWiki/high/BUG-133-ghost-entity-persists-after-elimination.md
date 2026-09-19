# BUG-133: Ghost Entity Persists After Elimination — AI Permanently Stuck Targeting a Dead Entity

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `src/controllers/WorldStateController.js`, `src/utils/npcAiUtils.js`, `src/controllers/ai/NpcAIController.js`, `src/controllers/networking/LlmContextController.js`, `shared/StatVocabulary.js`

## Symptoms

An attacking droid (deterministic AI brain) became permanently stuck targeting an entity it had already killed. The entity's components were all broken, yet the droid re-selected it as its closest target every round with no ability to move on. The LLM-routed path exhibited the same behavior: the ghost entity appeared in the `NEARBY ENTITIES` context block, causing the LLM to re-target it indefinitely. The entity remained registered in the world state, occupied a slot in the turn barrier, and was re-rendered to clients on every broadcast — a persistent world-state desync with no visible recovery.

## Root Cause

The component-break cascade — the recursive pipeline that removes child components when a parent component's existence drops below the broken threshold — operated exclusively at the component level. It marked components broken and removed them from the tree, but it never evaluated whether the **parent entity** itself had lost all remaining components and should be despawned. The entity record lingered in the entity registry with an empty component list: a "ghost."

Both AI targeting paths lacked a viability filter capable of recognizing such a ghost. The deterministic `chase_attack` behavior re-derived the closest entity from the full registry every round and had no predicate to exclude entities with no usable components. The LLM context renderer similarly included all registered entities in its proximity list without checking whether any of them were still functionally alive. The absence of an entity-level elimination step and the absence of a targetability guard together created a permanent targeting lock.

## Fix

Two complementary layers were introduced:

1. **Entity elimination at the cascade exit** (`WorldStateController`): When the component-break cascade completes and an affected entity has zero remaining components, the entity is despawned through the public `despawnEntity()` API. The check is isolation-wrapped so that a failure in the despawn path cannot break the cascade itself. Additionally, the post-removal cleanup step was extended to release equipped items that were hosted on a now-broken host component, preventing orphaned item references.

2. **Shared targetability predicate** (`src/utils/npcAiUtils.js`): A set of pure predicates (`isComponentUsable`, `filterUsableComponents`, `hasUsableComponent`) defines the single rule for whether an entity is a valid target: a component is usable iff its existence is unknown or above the `EXISTENCE_GONE_AT` threshold (sourced from `shared/StatVocabulary.js`). Both the deterministic brain (`NpcAIController._isViableTarget`) and the LLM context path (`LlmContextController._isViableTarget`) delegate to this shared predicate, ensuring identical viability logic across both AI paths. This is defense-in-depth: even if a ghost were somehow created by an unforeseen path, neither AI system would target it.

The fix records an accepted consequence: a full droid-body destruction yields 39 knife drops rather than 42, because the three knives nested in the root component are lost with the body (see the trigger cascade resolution in this entry).

## Prevention

- **Turn barrier contract test** (test 24 in `turnBarrier.contract.test.js`): asserts that a cascade-eliminated entity vacuously completes its round, preventing a deadlock where the barrier waits for a planner that no longer exists.
- **Brain-vs-LLM targetability parity contract** (`targetabilityParity.contract.test.js`): asserts that both AI paths produce the same set of viable targets for a given world state, catching any future divergence in the viability logic.
- **Entity elimination unit tests** (`WorldStateController.entityElimination.test.js`): cover despawn on zero components, survival on partial break, missing-array guard, idempotency, cross-entity isolation, throwing-despawn isolation, and equipped-item cleanup.
- **Ghost-targeting regression tests** (`NpcAIController.ghostTargeting.test.js`): assert that neither AI path selects an entity whose components are all below the gone threshold.

## References

- NPC AI controller: [`wiki/subMDs/controllers/npc_ai_controller.md`](../../subMDs/controllers/npc_ai_controller.md)
- Components & entities data model: [`wiki/subMDs/data/components_and_entities.md`](../../subMDs/data/components_and_entities.md)
- Related tests: [`test/unit/WorldStateController.entityElimination.test.js`](../../../test/unit/WorldStateController.entityElimination.test.js), [`test/unit/NpcAIController.ghostTargeting.test.js`](../../../test/unit/NpcAIController.ghostTargeting.test.js), [`test/contract/targetabilityParity.contract.test.js`](../../../test/contract/targetabilityParity.contract.test.js), [`test/contract/turnBarrier.contract.test.js`](../../../test/contract/turnBarrier.contract.test.js)
- Related controllers: `WorldStateController`, `NpcAIController`, `LlmContextController`
