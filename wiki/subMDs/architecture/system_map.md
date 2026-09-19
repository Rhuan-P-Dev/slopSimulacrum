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
│   ├── KnowledgeController
│   └── WorldRulesController
├── Logic Controllers (dependency-injected, coordinated by root)
│   ├── ComponentController → State controllers
│   ├── EntityController
│   ├── CapabilityCacheController
│   ├── SelectionController
│   ├── SynergyController
│   ├── ActionController
│   ├── HoldingCostController → EquippedItemStatsController
│   ├── StatConsequenceHandler → EquippedItemStatsController
│   ├── RangeValidator → WorldStateController (range checks)
│   ├── OnDamageDropListener → WorldRulesController, MaterialController (observes ComponentController damage events)
│   └── EnergyFlowController → WorldRulesController (energyFlow rule), stateEntityController (census), ComponentController (stat writes, damage suppressed) — per-turn step (round start, after the IC step)
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
| **WorldRulesController** | World-Rules Layer | Receives the boot-loaded `data/world_rules.json` registry from the composition root (the controller itself performs no I/O) and validates it — stable key → small config objects governing cross-cutting laws (deterministic config laws plus the probabilistic `onDamage` event table, stored separately from the rule keys so the rule map's shape stays untouched); inspection-only on the facade, out of the broadcast aggregation, null-tolerant getter degrading to an empty rule set; the chunk-drop handler consults it for the torn-material percentage, and the onDamage drop listener consults it for the damage-event table |
| **OnDamageDropListener** | World-Rules Event Enforcement | Observer of the component stat choke point — the one place every damage source converges — so the `onDamage` law fires on *any* damage (action channel, direct stat delta, IC tick), not only on actions; consults the world-rules event table and the material levers, and may mint a self-describing chunk token of the damaged component's primary material into the ground-item store through the facade; per-listener fault isolation keeps it from ever touching the break/broadcast pipeline |
| **EnergyFlowController** | Cross-Component Energy Circulation | The `energyFlow` world law as a per-turn step on the round-start hook (after the IC per-turn step, wired in the composition root): one fully-interconnected network per entity, simultaneous turn-start read/compute/write, per-part capacity bound from the recipe or the rule default, overflow lost, strict decreases written with the damage event suppressed, writes skipped below the no-op epsilon, and a flow-scoped broadcast window (exactly one full-state broadcast per turn when anything moved). No-op when the rule is off; no `getAll()` (stays out of the broadcast aggregation). **Shipped state: off by data** — no `energyFlow` key in `data/world_rules.json` — so the step no-ops every round; re-activatable by re-adding the rule to the data |

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

### Energy Flow (per round, after the IC per-turn step)

**Shipped state: off** — the data no longer ships the `energyFlow` rule, and the (inert) coalGenerator organ no longer charges anything, so every round start the step skips at the zero-total check and writes nothing. The line below documents what the step does when the rule is active (and is re-activated by a one-line data edit):

Read all components' turn-start energies → skip the entity when nothing holds any → for each entity, compute the simultaneous redistribution (each component sends a fixed share of its turn-start energy, divided equally among the others; inflow minus send, clamped at the per-component capacity, overflow lost) → skip no-change writes below the epsilon → write changed stats with the damage event suppressed → close the flow broadcast scope (one full-state broadcast iff anything changed)

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