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
    ```

## 📁 Data Files

| File | Purpose |
|------|---------|
| `data/actions.json` | Action definitions (requirements, consequences) |
| `data/components.json` | Component type definitions with trait templates |
| `data/blueprints.json` | Entity blueprint definitions (component hierarchies) |
| `data/traits.json` | Global trait molds |
| `data/synergy.json` | Synergy configurations |
| `data/rooms.json` | Room definitions (name, description, connections as target references, coordinates) |
| `data/internalComponents.json` | Internal component type definitions (volume, repair config, excluded types) |
| `data/inventoryItems.json` | Item type definitions (name, description, volume, traits, externalVolume) — includes T1 container weapon with dual-volume support |