# 🗺️ Controller Relationship Map

This document serves as a high-level architectural map of the `slopSimulacrum` controller ecosystem. It is designed to help AI agents quickly understand the dependency chain and the flow of data and commands.

**Note:** For a more detailed, technical breakdown of the architecture, refer to the [System Architecture Map](subMDs/architecture/system_map.md), which serves as the "deep version" of this map.

## 📐 Architectural Overview

The system follows a **hierarchical dependency injection** pattern. The `WorldStateController` acts as the root injector, ensuring that all sub-controllers share the same state instances to prevent desynchronization.

### 1. Dependency Graph (Mermaid)

```mermaid
graph TD
    WSC[WorldStateController]
    CSC[ComponentStatsController]
    TC[TraitsController]
    CC[ComponentController]
    EC[EntityController]
    SEC[stateEntityController]
    RC[RoomsController]
    AC[ActionController]
    CCC[ComponentCapabilityController]
    CH[ConsequenceHandlers]
    SC[SynergyController]
    ASC[ActionSelectController]
    LLMC[LLMController]
    LLMA[LLMAgentController]
    SVR[Server]
    WGB[WorldGraphBuilder]
    ICE[InternalComponentController]
    TSC[TurnSystemController]
    INV[InventoryManager]
    EISC[EquippedItemStatsController]
    HCC[HoldingCostController]
    SCH[StatConsequenceHandler]
    DCH[DamageConsequenceHandler]
    MCH[MaterialChunkDropHandler]
    RNGV[RangeValidator]
    NAC[NpcAIController]
    MC[MaterialController]
    CFT[CraftingController]
    KC[KnowledgeController]
    WRC[WorldRulesController]
    ODL[OnDamageDropListener]

    SVR --> LLMC
    SVR --> WSC

    WSC --> RC
    WSC --> SEC
    WSC --> CC
    WSC --> AC
    WSC --> CCC
    WSC --> ASC
    WSC --> INV
    WSC --> EISC

    AC --> CH
    AC --> CCC
    AC --> SC
    AC --> ASC
    SC --> ASC
    CH --> WSC

    SEC --> EC
    EC --> CC
    CC --> CSC
    CC --> TC

    AC --> SEC
    AC --> CC
    AC --> RC
    CCC --> CC
    SC --> CC

    RC -->|getAll| WGB
    WGB --> WSC

    CC -.->|stat change| CCC

    SEC -->|auto-installs| ICE
    ICE -->|repairs| CC
    TSC -->|turn-start hook| ICE

    INV --> CC
    INV -.->|items array| SEC

    HCC --> EISC
    SCH --> EISC
    CCC -->|reads current stats| EISC
    EISC -->|stat change callback| WSC

    AC --> RNGV
    RNGV -->|uses| WSC

    NAC -->|hasDeterministicBrain| WSC
    NAC -->|think() called by| SVR
    LLMA -->|runRound() called by| SVR
    LLMA -->|skips if hasDeterministicBrain| NAC

    WSC --> MC
    CC --> MC
    INV --> MC
    DCH --> MC
    MCH --> MC
    MCH --> WSC
    CH --> MCH

    WSC --> CFT
    WSC --> KC
    WSC -->|inspection only| WRC
    MCH -->|torn percent| WRC
    WSC -->|injected; inspection| ODL
    ODL -->|event table| WRC
    ODL -->|chunk levers| MC
    CC -.->|damage event| ODL
    ```

## 🤖 AI Controllers

| Controller | Path | Description |
|------------|------|-------------|
| NpcAIController | src/controllers/ai/NpcAIController.js | Stateless AI brain, behavior registry, chase_attack |
| TurnSystemController | src/controllers/core/TurnSystemController.js | Event-driven rounds and planning-completeness barrier — the roster is a round-start snapshot, resolution is gated on every roster planner signaling ready (a removal counts as vacuously complete — no deadline), and the next round starts on the tick after resolution; owns the per-entity action queues |

## 📁 Data Files

| File | Purpose |
|------|---------|
| `data/actions.json` | Action definitions |
| `data/components.json` | Component recipes: form, material composition, and pre-installed ICs — no stat values; stats are derived from matter, form, and organs |
| `data/blueprints.json` | Entity blueprint definitions (component hierarchies) — includes the `m1Droid` player droid and the `killerLlmDrone` composition |
| `data/npcs.json` | NPC registry keyed by blueprint — name, room, personality, per-round action/chat caps, optional `ai.behavior` block (deterministic brain), optional `envGate` spawn-time env-var gate (default off), optional `objective` rendered into the LLM system prompt, and `initialItems` loadout with optional `equip` and nested `contents`; `killerLlmDrone` is the first env-gated, goal-bearing LLM-routed NPC |
| `data/traits.json` | No longer a source of global default stat values — the recipe model retires the global molds; trait/stat names live in the shared vocabulary, values are derived |
| `data/synergy.json` | Synergy configurations — multipliers of action output from bound components cooperating; kept as-is in the new model, with only the punch cap's dead reference to the never-defined `Physical.stability` stat corrected |
| `data/rooms.json` | Room definitions (name, description, connections as target references, coordinates) |
| `data/world.json` | Initial-spawn kit/loadout source (player kit: coal loadout, T1 weapon, knife stock) — entries carry an optional top-level `count` (default 1); the kit lives in one file so the player's starting inventory is a data-only balance decision, tunable without touching spawn code |
| `data/internalComponents.json` | Organ type definitions — the function stats each IC grants (strength, move, fine_controls, think_level), its weight, and its over-time effects; the repair organ converts salvage back into existence |
| `data/inventoryItems.json` | Item recipes: small components with their own form, material composition, and pre-installed ICs, never merged into the host on equip — includes T1 container weapon with dual-volume support |
| `data/holdingCost.json` | Burden definitions — a single lever: total carried mass reduces the carrier's effective `move` and `fine_controls`, with a strength/mass gate on equip |
| `data/materials.json` | Material definitions (name, density, properties) for composition-driven trait derivation |
| `data/propertyTraitMapping.json` | Property-to-stat mapping table (expanded): the single balance lever of the material layer — links material properties to the derived stat set (six channel resistances, sharpness, mass, threshold-derived flags) alongside existence, the ratio of remaining matter |
| `data/materialDamageTypes.json` | Per-material damage-type split — how a raw value dealt *by* a material is distributed across the six damage channels, so the attacker's material decides a hit's channel mix (wood blunts and shreds, iron is pure impact); a missing/empty file turns the feature off, exactly reproducing legacy combat |
| `data/materialDropRates.json` | Per-material chunk-drop loot — the chance a material drops a chunk on a successful channel-damage hit (punch, cut, shootT1) and the share of its lost matter that forms one, plus one global minimum chunk volume; a missing/empty file means no drops at all |
| `data/world_rules.json` | World-rules layer — stable string key → small config objects governing cross-cutting laws (not loot tables); ships the `damageTornMaterial` rule (a deterministic X% of applied loss drops as torn matter per composition fraction) and the `onDamage` event law (a small per-event chance to drop a chunk of the damaged component's material, additive to the per-material chunk drops); a missing/empty/malformed file means all rules and event laws off (legacy world, never crashes) |
| `data/crafting.json` | Crafting recipe definitions (inputs/outputs referencing inventory item types) |

## 🧩 Shared Modules

The `shared/` directory is the **only import path available to both layers** — the browser cannot import from `src/`, and the Node server cannot import from `public/`. These dependency-free modules are therefore the single source of truth for the string/number vocabularies that form a **wire contract or cross-layer contract**: each value must have exactly one definition, because a hand-typed duplicate that drifts silently breaks ID routing, stat lookups, or event matching (drift this codebase has observed: the client's per-file `PREFIX_LENGTH` artifact, and same-name/different-value durability constants in different files). These modules name the vocabulary; the data-driven values themselves stay in `data/*.json` ([Data-Driven Design](code_quality_and_best_practices.md)).

| File | Purpose |
|------|---------|
| `shared/IdPrefixes.js` | Typed-ID prefix family (`ent-`, `comp-`, `item-`, `eq-`, `q-`, `chat-`) with lengths and pure prefix helpers — the prefix is the type, so both layers route IDs unambiguously |
| `shared/StatVocabulary.js` | Trait-group/stat names that must match `data/traits.json`, the `trait.stat` flat-key form, and the two distinct durability semantics (broken threshold vs. usable minimum) |
| `shared/ActionVocabulary.js` | Action-system vocabulary: targeting types, component-binding roles, action names (keys of `data/actions.json`), target anchors |
| `shared/TurnPhases.js` | Turn-phase wire values (`planning`/`resolution`) stored in `state.turns.phase` — part of the persisted world-state schema |
| `shared/SocketProtocol.js` | Socket.IO event-name wire contract between server emitters and client listeners; a name renamed on one side alone fails silently in both directions |
| `shared/Defaults.js` | Cross-layer safety fallbacks (default player blueprint, item-volume fallback) — the safe direction when data files are missing or malformed |
| `shared/RangeResolver.js` | Range-expression resolver (numbers and `:trait.stat` expressions from `data/actions.json`) used by both layers so range semantics cannot drift |

`public/utils/MapGeometry.js` is the client-side counterpart for map-rendering geometry: it is shared **only** between the two client map renderers (`WorldMapView`, `RoomConnectionRenderer`) and is deliberately **not** part of `shared/` — the server has no map rendering.

`public/utils/ItemTree.js` is the client-side counterpart for the flat per-entity items model: it provides the pure child-grouping primitive (children of a host = the flat items whose `hostComponentId` names that host) shared **only** between the two client inventory surfaces (`InventoryManager`, `ComponentViewer`) and is deliberately **not** part of `shared/` — the server resolves the same containment independently in `src/utils/InventoryManager.js`.

`public/utils/InventoryFilter.js` is the client-only pure module behind the inventory panel's view filters (contains-item toggle + name search): it decides which components are visible and which displayed names matched, is used **only** by `InventoryManager`, and is deliberately **not** part of `shared/` — like `ItemTree.js` and `MapGeometry.js`, the server resolves containment independently, so no cross-layer contract is required.
