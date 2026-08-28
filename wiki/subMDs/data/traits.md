# 🧬 Traits System (Default-Override Architecture)

## 1. Overview

Components define only **overrides** from global default trait molds. Merge happens at component instantiation. A new **material-derived layer** sits between global defaults and blueprint overrides, enabling composition-driven stat derivation while preserving hand-tuned balance.

**Final Value = Blueprint Overrides → Material-Derived → Global Defaults**

## 2. Global Traits (Source of Truth)

A configuration file sets baseline values for all traits, establishing default values across every trait category.

### New Default: `Physical.flammability`

`Physical.flammability` was added in the material system update. It is non-flammable by default, so flammability only appears when a material composition derives it through the property-to-trait mapping table — content without materials stays non-flammable.

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
| 2 — Material-Derived **NEW** | Material composition derivation (`MaterialController`) | Physically-consistent stats from material composition |
| 3 — Blueprint Overrides | [`data/components.json`](data/components.json:1), [`data/inventoryItems.json`](data/inventoryItems.json:1) | Hand-tuned balance values (always win on conflicts) |
| 4 — Initial Overrides | Runtime initialization (e.g., crafting) | Runtime per-instance customization (future: crafting) |

## 4.1. Merge Rule: Key Set and Stat Value (Fix 4)

Since the materials feature, the merge pipeline follows a precise rule:

- **Key set**: The merged output contains exactly the trait groups that the blueprint declares or that material derivation produces. Global traits that neither source references are **excluded** from the output. This prevents "phantom" groups from appearing on components.
- **Stat value**: Within each group in the final set, values layer as global default, then material-derived values (if present), then blueprint overrides. The blueprint always wins on conflicts, so hand-tuned balance values are never displaced by derived ones.

### Example: Material-Derived Group Not in Blueprint

If a material component produces `Movement.move = 25` in `materialDerived`, and the blueprint declares only `Physical`, the merged output will contain **both** `Physical` (from blueprint) and `Movement` (from materials). The `move` stat will be `25`.

### Example: Blueprint Without Materials

If a blueprint declares no materials (so `materialDerived = {}`) and declares only `Physical`, the merged output contains **only** `Physical` — no other global trait groups appear, even if `data/traits.json` defines them.

## 4.2. Movement Default Removal

Since the materials feature, `Movement` carries **no default `move` stat**. A component has `Movement.move` only when its blueprint explicitly declares it (or a material-derived group produces it).

**Why this matters:** A global default like `move: 10` would give every entity phantom movement, inflating initiative scores that are meant to reflect hand-tuned or material-derived movement only. With no default, initiative arithmetic stays pure: an entity's initiative comes only from movement its blueprints (or materials) explicitly declare — which is what the initiative contract (player vs. NPC) depends on.

**Consumer impact:** Restoring a global `Movement.move` default would affect:
- [`TurnSystemController`](src/controllers/core/TurnSystemController.js) — initiative calculation
- [`public/js/App.js`](public/js/App.js) — frontend movement range display
- [`ReachabilityRule`](src/controllers/hints/rules/ReachabilityRule.js) — reachability hints
- [`LlmContextController`](src/controllers/networking/LlmContextController.js) — LLM context rendering

Correspondingly, the global traits definition in [`data/traits.json`](data/traits.json:18) intentionally leaves `Movement` empty — the contract is expressed in the data itself.

## 4.3. Backward Compatibility Note

With Fix 4 (key set = blueprint ∪ material-derived), the statement "when no material-derived values are supplied, output is identical to pre-material behavior" is **true only for blueprints without materials**. A blueprint that declares no materials and receives no derived values will produce output containing exactly the blueprint's trait groups — matching pre-material system output for those blueprints. However, a blueprint with materials that receives no derived values would lose all material-derived stats, which is not the intended usage.

## 5. Deep Trait-Level Merge

When updating stats at runtime, the system merges **within each trait category**, preserving other stats in the same trait that are not being updated.

See [BUG-005](../bugfixWiki/high/BUG-005-deep-trait-merge.md) for fix details.

## 6. Manipulation Trait

The `Manipulation` trait category represents dexterity and precision handling capability. It contains the `fine_controls` stat.

**Design Decision:** Manipulation is restricted to hands and fingers (which carry explicit `fine_controls` overrides) because these are the entity's primary interaction organs with the environment. Other components (arms, head, central ball, rolling balls) do not directly manipulate objects and simply inherit the global default.
