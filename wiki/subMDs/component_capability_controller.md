# 🧩 ComponentCapabilityController

## 1. Overview

This controller manages the **capability cache** that maps each action to an array of qualifying component entries. It was extracted from the action controller to adhere to the Single Responsibility Principle.

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

Methods for full cache scans, single entry re-evaluation, all-actions re-evaluation for a component, entity-scoped re-evaluation, entity cache removal, cache retrieval, best-component lookup, all-capabilities lookup by action, capabilities by entity, filtered actions for an entity, and event subscription.

## 4. Stat Change Flow

The controller registers itself as a listener on the component controller. When any component stat changes, the reverse index maps the changed trait-stat combination to dependent actions, which are re-evaluated individually. Updated or removed entries trigger subscriber notifications.

## 5. Internal Component Impact

The repair system modifies component durability, which triggers the stat-change flow. Actions depending on durability may become newly capable after enough repair ticks.