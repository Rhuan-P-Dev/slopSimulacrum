# World Rules — data/world_rules.json

A world rule is a **law of the world**: a stable string key mapping to a small config object that governs a cross-cutting behavior. It is not a loot table, not a per-entity attribute, and not an action parameter. Rules are global, data-driven, and additive to the existing damage-and-drop system.

## Why this layer exists

The chunk-drop system (see [material_damage_and_drop.md](material_damage_and_drop.md)) was designed as a *probabilistic* mechanic governed by per-material levers in `data/materialDropRates.json`. The torn-material rule introduces a complementary *deterministic* stream — a fixed percentage of applied loss always drops as torn matter. Mixing this logic into the `MaterialController` would conflate two distinct policy concerns (loot probability vs. world law) and couple the chunk system to a feature that may evolve independently.

The layer has since grown a second kind of law — a *probabilistic event law* (`onDamage`): a small chance, on any damage to a component, that a chunk of its material flies off. It lives here for the same reason the torn rule does: it is a law of the world, not a lever of the chunk system, and it must be able to evolve (new event keys, new drop tokens) without touching the material files or the chunk handler's per-material rolls.

## Degradation contract (deliberate divergence)

The material files (`materials.json`, `materialDropRates.json`, `materialDamageTypes.json`) follow a **boot-fail** rule: a missing or malformed file aborts server startup because the world is incomplete without them. The world-rules file deliberately diverges:

- A **missing**, **empty**, or **top-level-malformed** file means **all rules and event laws are off** and the server boots normally. "Off" is a complete world state for an optional overlay — the legacy chunk system still functions, just without the torn stream or the onDamage drops.
- An **unknown rule key** is ignored with a warning (forward compatibility: a file shipped for a newer version of the code does not crash an older build).
- A **malformed individual rule config** (e.g., `percent` is a string) disables *that rule only*; other rules remain active.
- A **malformed individual event entry** is skipped with a warning; the surviving entries of the same table — and every other key in the file — remain active.

The controller never throws during load. This is intentional: world rules are an opt-in layer, and "nothing extra happens" is always a valid world.

## The torn-material rule (`damageTornMaterial`)

The shipped rule's config is two levers readable directly in the 8-line data file — `percent` (the share of the applied loss minted as torn matter) and `enabled` (a soft-off switch); per project rules §8.1 the wiki does not duplicate the schema, and the *why* of each lever (applied-loss basis, gate-not-floor semantics, the shipped default) is covered in the Semantics below.

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

## The onDamage Event Rule (Probabilistic Event Law)

The layer now carries two kinds of laws: **deterministic config laws** (`damageTornMaterial` — a fixed share of applied loss, always) and **probabilistic event laws** (`onDamage` — a chance that fires when damage is applied). Both belong here for the same reason: they are *laws of the world* — global, data-driven, answerable to no single mechanic — and neither is a balance lever of the chunk system.

### Why the drop is additive to the per-material drop rates

The onDamage drop is a **cross-cutting law, additive to the per-material drop rates**, not a change to them. The two streams are owned by different data files and different controllers: the per-material levers (chance to drop, share of lost matter) live with the material system, and the event table lives with the world-rules layer. They roll **independently** on the same damage event — both may fire, and neither suppresses nor re-uses the other's roll. A designer therefore has two independent knobs for two different questions: "how much loot does this material yield?" (the material files) and "how often does the world shed a chip of whatever is being damaged?" (the world rules). Additivity is what keeps those two questions from being conflated in one file.

### Why each entry is an independent trial per event

Each entry in the event table is rolled **separately on every damage event**, rather than the whole table sharing one roll. This mirrors how the material files already roll per material: entries compose without interfering, and adding or tuning an entry changes only that entry's odds. It also keeps the table open-ended — a future entry (a different drop, a different chance) is a pure addition, not a reshaping of existing odds.

### Why the trigger is the component stat choke point

"Damage" in this world means *any* decrease of a component stat: action-channel damage (punch/cut/shoot), direct stat deltas, and internal-component ticks (corrosion and similar). The component's stat-update choke point is the **one place every damage source converges** — the only place the law can observe "all damage" without every damage source having to know the law exists. Consequences cannot serve: they are action-scoped and run only when an action declares them, so a corrosion tick would never reach one. The hook fires **after the stat is written** (the law may never alter what damage actually landed) and **before the break cascade** (the damaged component must still exist when the law acts on it; and each listener is isolated in its own fault boundary, so a listener's failure can never delay or break the break/broadcast pipeline).

### Why the drop is the component's primary material

On success, the law drops a chunk of the component's **primary material** — the largest composition fraction (array order breaks exact ties, deterministically). A multi-material component is one thing made mostly of one material, and the token should be the material the player already thinks of as *the* material of that component, not a random member of its composition.

### Why a total-loss hit drops nothing

When the damage event consumes the component's existence entirely, the break/removal cascade already owns that **total** loss — contents spill, matter is consumed by removal — the same decision the chunk system encodes (see [material_damage_and_drop.md](material_damage_and_drop.md)). The event rule mirrors it: a lethal hit sheds no onDamage token. (The legacy chunk and torn streams run inside their own damage consequence and are unaffected.)

### Why the event config is stored separately from the rule keys

The event table is validated and stored in its own space inside the controller, not merged into the scalar rule-key map. The rule-key map is what the facade's world-rules accessor exposes, and its shape is a stable contract that inspection and tests depend on. Keeping events in separate storage means a whole new *class* of world law can be added without ever perturbing that shape — the existing rules remain bit-identical, and a reader of the rule map is guaranteed to see exactly the scalar rules and nothing else.

### Why the degradation contract stays never-throw, per-entry

The file is an opt-in overlay: "nothing extra happens" must always be a valid world, so loading never throws — a missing/empty/malformed file turns **all** rules and event laws off, and the world boots legacy. Within an event table, tolerance drops to the **entry**: one malformed entry is skipped with a warning, and the rest of the table stays alive. A balance file must never crash the world, and per-entry tolerance is what keeps one bad row from silencing the laws beside it.

### Why chunk item identity is shared across all three drop streams

The world has **one notion of "a chip of matter"**: the self-describing dynamic chunk item. The onDamage token is the same kind of thing as the chunk-stream and torn-stream tokens — same item mechanics, same matter-math lever, indistinguishable on the ground. Sharing the item's identity from a single source across all three streams (rather than inventing a parallel item family) keeps clients, recipes, and the ground-record format unchanged, and makes it structurally impossible for the three streams to drift into minting different-looking objects for the same world matter.

## Why a separate controller

The `WorldRulesController` is a Layer-0 data owner (built in the composition root, held by the facade for inspection, and forwarded to the chunk-drop handler as a named dependency). It is NOT:

- An extension of `MaterialController` — the material files are boot-fail; the rules file is graceful-off.
- Facade logic — the facade is an inspection-only accessor, not a policy engine.
- A handler-internal constant — the percentage is data, not code (no magic numbers).

This keeps the dependency graph clean: the composition root loads the file, the controller validates and exposes it, and the handler reads the active percentage through the controller's public API.
