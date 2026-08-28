# 🧩 Component Capability Controller

## 1. Overview

This controller manages the **capability cache**, which records every component that qualifies for each action, best match first. It was extracted from the action controller to adhere to the Single Responsibility Principle.

**What it does**: Scan, score, cache, re-evaluate component capabilities, and notify subscribers of changes.

**What it does NOT do**: Execute actions, check entity-level multi-component requirements, or execute consequences.

## 2. Architecture Position

It is instantiated by the root state controller and then injected into the action controller. The action controller delegates all cache queries to this controller.

```
Root Controller
    ├── CapabilityCacheController (owns cache)
    │       ├── reads stats from ComponentController
    │       └── injected into ActionController
    └── ActionController (delegates all cache queries to it)
```

## 3. Public API

The public surface serves two jobs: answering capability queries (which components qualify for an action, which is the best fit, or what an entity as a whole can do) and triggering re-evaluation when world state changes. It also exposes event subscription so consumers can react to capability changes as they happen.

## 4. Stat Change Flow

Stat changes do not trigger a full cache rebuild. A reverse index maps each trait-stat combination to the actions that depend on it, so only the affected actions are re-evaluated for the changed component — keeping the cache current at a fraction of the cost of a full rescan. Subscribers are notified whenever an entry is updated or removed, so downstream consumers never re-derive capabilities themselves.

## 5. Internal Component Impact

The repair system modifies component durability, which triggers the stat-change flow. Actions depending on durability may become newly capable after enough repair ticks.

---

## 🗂️ Action Capability Cache System

### 1. Overview

The capability cache records, for each **action**, **every component that qualifies for it**, best match first. Every qualifying component gets its own entry, not just the winner.

**Key behavior**:
- **All qualifying components** are tracked, not just the best one
- **Automatic re-evaluation** on stat changes, entity spawn/despawn
- **Event-driven notifications** via a pub/sub pattern per action
- **Reverse index** maps trait-stat combinations to dependent actions for efficient incremental updates

### 2. Data Structure

Entries carry everything a consumer needs to act on a capability: which component it is, how well it fits, and the role it plays in the action (source, target, spatial, or self-target). Because subscribers track individual entries over time, deletions are signalled explicitly with a removal marker rather than implied by an entry's absence from the cache.

### 3. Scoring Algorithm

Scoring exists to rank viable components by how well their stats match an action's demands, so consumers can prefer the best tool while still seeing every viable option. Components that meet none of the requirements are excluded from the cache entirely — surfacing incapable components would only add noise.

### 4. Event Subscription

Capability changes are pushed to subscribers rather than polled: any mutation that can change who is capable (stat changes, entity spawn/despawn, component add/remove) notifies the affected action's subscribers. This keeps consumers in sync without them re-deriving capabilities themselves.

### 5. Stat Change Flow

Re-evaluation is incremental by design: a stat change re-evaluates only the actions its trait-stat combination affects, keeping the cache current without a full rescan, and subscribers are notified as entries update or disappear.

### 6. Public API

The controller's public surface covers capability queries, re-evaluation triggers for world state changes, and event subscription. A read-only HTTP surface also exposes the cache (with a refresh trigger) so it can be inspected externally without mutating it.

### 7. Internal Component Impact

The repair system modifies component durability over time. Actions that depend on durability may become newly capable or lose capability as durability fluctuates across repair ticks.