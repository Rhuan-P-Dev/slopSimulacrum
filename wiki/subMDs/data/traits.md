# 🧬 Traits System (Default-Override Architecture)

## 1. Overview

Components define only **overrides** from global default trait molds. Merge happens at component instantiation.

**Final Value = Component Override || Global Default**

## 2. Global Traits (Source of Truth)

A configuration file sets baseline values for all traits, establishing default values across every trait category.

## 3. Component Blueprints (Overrides)

Components override only what differs from global defaults. Values not explicitly overridden inherit from global defaults.

## 4. The Merge Process

A dedicated traits controller performs the merge at component initialization time. The merged result is cached in the component stats controller.

## 5. Deep Trait-Level Merge

When updating stats at runtime, the system merges **within each trait category**, preserving other stats in the same trait that are not being updated.

See [BUG-005](../bugfixWiki/high/BUG-005-deep-trait-merge.md) for fix details.

## 6. Manipulation Trait

The `Manipulation` trait category represents dexterity and precision handling capability. It contains the `fine_controls` stat.

| Component | fine_controls | Notes |
|-----------|--------------|-------|
| droidHand | 50 (override) | Primary manipulation organs — 5x the global default |
| humanoidDroidFinger | 30 (override) | Precision assist — 3x the global default |
| Other components | 10 (default) | Inherits global default from `data/traits.json` |

**Design Decision:** Manipulation is restricted to hands and fingers because these are the entity's primary interaction organs with the environment. Other components (arms, head, central ball, rolling balls) do not directly manipulate objects.

**Frontend Support:** The `Manipulation` trait has a default color (`#a855f7`, purple) defined in `StatBarsManager.TRAIT_DEFAULT_COLORS`.
