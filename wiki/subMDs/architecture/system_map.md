# 🗺️ System Architecture Map

## 1. Controller Hierarchy

```
WorldStateController (Root Injector)
├── State Controllers (data storage, self-instantiating)
│   ├── ComponentStatsController
│   ├── TraitsController
│   ├── stateEntityController
│   ├── InternalComponentController
│   ├── EquippedItemStatsController
│   ├── CraftingController
│   └── KnowledgeController
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
| **HintController** | Hint Engine | Deterministic hint registry — register rules by priority, resolve hints per entity, degrade gracefully on missing data |
| **CraftingController** | Recipe Registry | Data-driven crafting recipes (`data/crafting.json`) — pure "do these items satisfy this recipe" checks; no item/world state, no `getAll()` (stays out of the broadcast aggregation) |
| **KnowledgeController** | Reference Codex | Read-only codex payload assembled once at boot from the static registries (trait/stat derivation chain, recipes, item types) — no cross-controller dependencies, no `getAll()` (stays out of the broadcast aggregation) |
| **TurnSystemController** | Event-Driven Rounds & Barrier | Owns the round: the planning-completeness barrier (round-start roster, ready signals, the all-ready close decision — there is no deadline) and the per-entity action queues; resolution is gated on barrier close. Rounds are event-driven (roster snapshot at round start, next round on the tick after resolution), so the system no longer owns tick cadence |

## 3. Key Operational Flows

### Entity Spawn
Purpose: materialize a fully initialized entity from its data definition — components expanded
from the blueprint, traits merged, stats seeded, internal components installed — so that every
downstream system (capability evaluation, consequences, broadcasting) sees a complete,
consistent entity the moment it enters the world.

### Action Execution
Purpose: make actions safe and consistent — an action only takes effect when its requirements
are provably satisfiable by the actor's components, and every effect (success or failure)
flows through the consequence pipeline, so state changes, synergy, and lock management stay
consistent in one place.

### Stat Change
Purpose: keep the capability cache and every dependent system current whenever a stat changes,
so no decision is ever made on stale capabilities; the change is propagated to the affected
subsystems and broadcast to clients.

### Equipped Item Stat Change
Purpose: track per-instance degradation of equipped items (e.g. sharpness, durability) so that
capabilities depending on *current* equipped stats are re-evaluated automatically whenever such
a stat changes, and the updated state reaches the client.

### Crafting
Resolve recipe → verify item possession on the component → pre-check capacity before any mutation → consume inputs → produce outputs on the same component → broadcast to all clients

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
├── HintManager (new)
├── CraftingPanel (new)
├── KnowledgePanel (new)
└── ConfigBarManager
```

Both layers import the dependency-free vocabulary modules in `shared/` (typed-ID prefixes, stat names, action names, turn phases, Socket.IO event names, fallback defaults, range-expression resolution): `shared/` is the only import path available to both layers, so those wire and cross-layer contracts have exactly one definition — the client's historical per-file copies drifted (e.g. prefix lengths, durability constants), and a drifted value silently breaks ID routing, stat lookups, or event matching. `public/utils/MapGeometry.js` is the client-local counterpart for map-rendering geometry, shared only between the two map renderers (`WorldMapView`, `RoomConnectionRenderer`).