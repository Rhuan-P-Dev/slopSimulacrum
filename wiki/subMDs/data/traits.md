# 🧬 Traits System (Default-Override Architecture)

## 1. Overview

Components define only **overrides** from global default trait molds. Merge happens at component instantiation. A new **material-derived layer** sits between global defaults and blueprint overrides, enabling composition-driven stat derivation while preserving hand-tuned balance.

**Final Value = Blueprint Overrides → Material-Derived → Global Defaults**

## 2. Global Traits (Source of Truth)

A configuration file sets baseline values for all traits, establishing default values across every trait category.

### New Default: `Physical.flammability`

Added in the material system update:

| Stat | Default | Meaning |
|------|---------|---------|
| `Physical.flammability` | `0` | Non-flammable by default. Materials derive flammability via the property-to-trait mapping table. |

## 3. Component Blueprints (Overrides)

Components override only what differs from global defaults. Values not explicitly overridden inherit from global defaults (or material-derived values, if applicable).

## 4. The 4-Layer Merge Process

The merge pipeline now has **four layers** (newest to oldest):

```
Global Defaults → Material-Derived → Blueprint Overrides → Initial Overrides (runtime)
```

| Layer | Source | Purpose |
|-------|--------|---------|
| 1 — Global Defaults | [`data/traits.json`](data/traits.json:1) | Base values for every trait |
| 2 — Material-Derived **NEW** | `MaterialController.derive()` | Physically-consistent stats from material composition |
| 3 — Blueprint Overrides | [`data/components.json`](data/components.json:1), [`data/inventoryItems.json`](data/inventoryItems.json:1) | Hand-tuned balance values (always win on conflicts) |
| 4 — Initial Overrides | `initializeComponent(initialOverrides)` | Runtime per-instance customization (future: crafting) |

Implementation: [`TraitsController.mergeTraits(blueprintTraits, materialDerived = null)`](src/controllers/traits/TraitsController.js:45) accepts one optional parameter:

- `materialDerived = null` → merge output contains only keys from `blueprintTraits` (backward compatible with Fix 4 key-set change)
- `materialDerived = { Physical: { mass, durability, flammability } }` → derived stats fill gaps before blueprint overrides; any group present in `materialDerived` appears in the merged output even if the blueprint does not declare it

## 4.1. Merge Rule: Key Set and Stat Value (Fix 4)

Since the materials feature, the merge pipeline follows a precise rule:

```
final key set = blueprint groups ∪ material-derived groups
stat value per key = global default ⊕ derived value ⊕ blueprint override (blueprint wins)
```

- **Key set**: Only trait IDs that appear in `blueprintTraits` or `materialDerived` are iterated. Global traits that the blueprint does NOT declare and are not produced by materials are **excluded** from the merged output. This prevents "phantom" groups from appearing.
- **Stat value**: For each key in the final set, the merge is shallow: start with global defaults for that trait, overlay material-derived values (if present), then overlay blueprint overrides. The blueprint always wins on conflicts.

### Example: Material-Derived Group Not in Blueprint

If a material component produces `Movement.move = 25` in `materialDerived`, and the blueprint declares only `Physical`, the merged output will contain **both** `Physical` (from blueprint) and `Movement` (from materials). The `move` stat will be `25`.

### Example: Blueprint Without Materials

If a blueprint declares no materials (so `materialDerived = {}`) and declares only `Physical`, the merged output contains **only** `Physical` — no other global trait groups appear, even if `data/traits.json` defines them.

## 4.2. Movement Default Removal

Since the materials feature, `Movement` carries **no default `move` stat**. A component has `Movement.move` only when its blueprint explicitly declares it (or a material-derived group produces it).

**Why this matters:** A global default like `{"move": 10}` would inflate initiative scores. The turn system (`TurnSystemController`) calculates initiative as the sum of `move` values across all `Movement` components on an entity. With a default `move: 10`:

- Player entity (2 Movement components) → 2 × 10 = 20 per component, total 40 → would become 2 × 20 = 40 extra if default was `move: 20`
- Merchant NPC (2 Movement components) → 2 × 10 = 20

The current contract asserts player initiative = 40 and merchant initiative = 20, which is consistent with `Movement` having no default `move` — the droid's `droidRollingBall` components declare `Movement: { move: 20 }`, giving 2 × 20 = 40.

**Consumer impact:** Restoring a global `Movement.move` default would affect:
- [`TurnSystemController`](src/controllers/core/TurnSystemController.js) — initiative calculation
- [`public/js/App.js`](public/js/App.js) — frontend movement range display
- [`ReachabilityRule`](src/controllers/hints/rules/ReachabilityRule.js) — reachability hints
- [`LlmContextController`](src/controllers/networking/LlmContextController.js) — LLM context rendering

The `Movement` entry in [`data/traits.json`](data/traits.json:18) is intentionally empty: `"Movement": {}`.

## 4.3. Backward Compatibility Note

With Fix 4 (key set = blueprint ∪ material-derived), the statement "`materialDerived = null` makes output identical to pre-material behavior" is **true only for blueprints without materials**. A blueprint that declares no materials and whose `materialDerived` is empty will produce output containing exactly the blueprint's trait groups — matching pre-material system output for those blueprints. However, a blueprint with materials but `materialDerived = null` would lose all material-derived stats, which is not the intended usage.

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
