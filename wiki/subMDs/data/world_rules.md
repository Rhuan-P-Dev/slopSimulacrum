# World Rules — data/world_rules.json

A world rule is a **law of the world**: a stable string key mapping to a small config object that governs a cross-cutting behavior. It is not a loot table, not a per-entity attribute, and not an action parameter. Rules are global, data-driven, and additive to the existing damage-and-drop system.

## Why this layer exists

The chunk-drop system (see [material_damage_and_drop.md](material_damage_and_drop.md)) was designed as a *probabilistic* mechanic governed by per-material levers in `data/materialDropRates.json`. The torn-material rule introduces a complementary *deterministic* stream — a fixed percentage of applied loss always drops as torn matter. Mixing this logic into the `MaterialController` would conflate two distinct policy concerns (loot probability vs. world law) and couple the chunk system to a feature that may evolve independently.

## Degradation contract (deliberate divergence)

The material files (`materials.json`, `materialDropRates.json`, `materialDamageTypes.json`) follow a **boot-fail** rule: a missing or malformed file aborts server startup because the world is incomplete without them. The world-rules file deliberately diverges:

- A **missing**, **empty**, or **top-level-malformed** file means **all rules are off** and the server boots normally. "Off" is a complete world state for an optional overlay — the legacy chunk system still functions, just without the torn stream.
- An **unknown rule key** is ignored with a warning (forward compatibility: a file shipped for a newer version of the code does not crash an older build).
- A **malformed individual rule config** (e.g., `percent` is a string) disables *that rule only*; other rules remain active.

The controller never throws during load. This is intentional: world rules are an opt-in layer, and "nothing extra happens" is always a valid world.

## The torn-material rule (`damageTornMaterial`)

The shipped rule's config is two levers readable directly in the 8-line data file — `percent` (the share of the applied loss minted as torn matter) and `enabled` (a soft-off switch); per project rules §8.1 the wiki does not duplicate the schema, and the *why* of each lever (applied-loss basis, gate-not-floor semantics, the shipped default) is covered in the Semantics below and in [world_rules_spec.md](../../world_rules_spec.md) §4.

### Semantics

- **Basis:** the applied loss (post-resistance, per-fist in the multi-attacker path) — the same value the chunk stream uses.
- **Attribution:** per composition fraction — the target's recipe determines how much torn matter each material contributes.
- **Determinism:** no random roll. The same hit, same world state → the same torn tokens, always.
- **Gate (not floor):** if the computed torn volume for a material is below the shared `minChunkVolume`, nothing drops for that material. Unlike the chunk system's *floor* (which raises small drops to the minimum), the gate *suppresses* them. This guarantees the rule never drops more than X% of the damage in total.
- **Item mechanism:** torn tokens reuse the existing dynamic `chunk_<material>` item type. No parallel item family, no new pickup path. They are visually indistinguishable from chunk tokens (a known trade-off, carried forward as an open question).
- **Placement:** same disk-sample around the target entity as the chunk stream.
- **Batched write:** torn tokens join the chunk tokens in the same single ground-write per damage event.

### Additive relationship to the chunk system

The two streams are **independent and additive**:

- The chunk stream rolls per material (probabilistic) and applies a floor.
- The torn stream always fires (deterministic) and applies a gate.

A designer guideline (not an enforced check) keeps the world from creating matter out of damage: `chunkFraction_i + percent/100 ≤ 1` per material. The shipped defaults satisfy this with margin (iron: 0.4 + 0.1 = 0.5).

## Why a separate controller

The `WorldRulesController` is a Layer-0 data owner (built in the composition root, held by the facade for inspection, and forwarded to the chunk-drop handler as a named dependency). It is NOT:

- An extension of `MaterialController` — the material files are boot-fail; the rules file is graceful-off.
- Facade logic — the facade is an inspection-only accessor, not a policy engine.
- A handler-internal constant — the percentage is data, not code (no magic numbers).

This keeps the dependency graph clean: the composition root loads the file, the controller validates and exposes it, and the handler reads the active percentage through the controller's public API.
