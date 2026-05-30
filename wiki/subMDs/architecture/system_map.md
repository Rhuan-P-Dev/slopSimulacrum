# 🗺️ System Architecture Map

## 1. Controller Hierarchy

```
WorldStateController (Root Injector)
├── State Controllers (data storage, self-instantiating)
│   ├── ComponentStatsController
│   ├── TraitsController
│   ├── stateEntityController
│   ├── InternalComponentController
│   └── EquippedItemStatsController
├── Logic Controllers (dependency-injected, coordinated by root)
│   ├── ComponentController → State controllers
│   ├── EntityController
│   ├── CapabilityCacheController
│   ├── SelectionController
│   ├── SynergyController
│   ├── ActionController
│   ├── HoldingCostController → EquippedItemStatsController
│   ├── StatConsequenceHandler → EquippedItemStatsController
│   └── RangeValidator → WorldStateController (range checks)
└── Consequence Dispatchers
```

## 2. Responsibility Matrix

| Controller | Role | Key Responsibility |
|-----------|------|-------------------|
| **WorldStateController** | Root Injector | DI, aggregation, public API |
| **RoomsController** | Spatial Data Store | Room definitions, ID mapping |
| **stateEntityController** | Instance Manager | Entity lifecycle management |
| **EntityController** | Blueprint Registry | Blueprint loading and expansion |
| **ComponentController** | Logic Coordinator | Trait merging + stat updates |
| **ComponentStatsController** | Data Store | Raw stat persistence |
| **TraitsController** | Data Store | Global trait defaults |
| **ActionController** | Action Coordinator | Execute actions, check requirements |
| **ComponentCapabilityController** | Cache Manager | Scan, score, cache, re-evaluate capabilities |
| **ActionSelectController** | Selection/Locking | Component locking per action |
| **SynergyController** | Synergy | Multi-component bonus computation |
| **InternalComponentController** | Internal State | Volume-based auto-install, repair system |
| **EquippedItemStatsController** | Mutable Stats Store | Per-instance mutable stat tracking for equipped items (sharpness, durability degradation) |
| **RangeValidator** | Range Validation | Spatial range checks for proximity-based actions with failure consequences |

## 3. Key Operational Flows

### Entity Spawn
Create entity from blueprint → expand hierarchy → initialize components → merge traits → set stats → auto-install internal components → re-evaluate capabilities

### Action Execution
Validate requirements → resolve components → compute synergy → dispatch consequences → release locks

### Stat Change
Notify listeners → identify dependent actions via reverse index → re-evaluate affected capabilities → notify subscribers → broadcast updates

### Equipped Item Stat Change
HoldingCostController.equipItem() → EquippedItemStatsController.initializeStats() → ConsequenceDispatcher routes damage to EquippedItemStatsController.updateStatDelta() → stat change callback fires → WorldStateController triggers reEvaluateEntityCapabilities() → ComponentCapabilityController rescans equipped items with current stats → broadcast to client

## 4. Client-Side Architecture

```
App (Orchestrator)
├── WorldStateManager
├── UIManager
├── ActionExecutor
├── ActionManager
├── SelectionController
├── SynergyPreviewController
├── EventDispatcher
├── StatBarsManager
├── ComponentViewer
├── NavActionsPanel
├── WorldMapView
└── ConfigBarManager
```