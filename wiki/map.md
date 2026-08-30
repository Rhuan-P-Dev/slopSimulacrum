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
    SVR[Server]
    WGB[WorldGraphBuilder]
    ICE[InternalComponentController]
    INV[InventoryManager]
    EISC[EquippedItemStatsController]
    HCC[HoldingCostController]
    SCH[StatConsequenceHandler]
    RNGV[RangeValidator]
    NAC[NpcAIController]
    MC[MaterialController]
    CFT[CraftingController]

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
    LLMC -->|skips if hasDeterministicBrain| NAC

    WSC --> MC
    CC --> MC
    INV --> MC

    WSC --> CFT
    ```

## 🤖 AI Controllers

| Controller | Path | Description |
|------------|------|-------------|
| NpcAIController | src/controllers/ai/NpcAIController.js | Stateless AI brain, behavior registry, chase_attack |

## 📁 Data Files

| File | Purpose |
|------|---------|
| `data/actions.json` | Action definitions |
| `data/components.json` | Component type definitions with trait templates |
| `data/blueprints.json` | Entity blueprint definitions (component hierarchies) |
| `data/traits.json` | Global trait molds |
| `data/synergy.json` | Synergy configurations |
| `data/rooms.json` | Room definitions (name, description, connections as target references, coordinates) |
| `data/internalComponents.json` | Internal component type definitions (volume, repair config, excluded types) |
| `data/inventoryItems.json` | Item type definitions (name, description, volume, traits, externalVolume) — includes T1 container weapon with dual-volume support |
| `data/materials.json` | Material definitions (name, density, properties) for composition-driven trait derivation |
| `data/propertyTraitMapping.json` | Property-to-trait mapping table (formulas: densityVolume, weighted sources) |
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
