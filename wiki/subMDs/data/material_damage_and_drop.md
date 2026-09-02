# Material Damage & Chunk Drop

Two data-driven features that make matter consequential in combat and salvage: a **per-material damage-type split** (the attacking material decides how a hit's raw value is distributed across the damage channels) and a **material chunk drop on punch** (a successful punch may leave a small, pickable chunk of the target's material on the ground). Both are pure **data + thin read paths** — no new world-state categories, no new stat vocabulary, no new client protocol — and both degrade to exactly today's behavior if their data files are absent. The full rationale, data contracts, and open questions live in the [design spec](../../material_damage_and_drop_spec.md).

## Why the Attacker's Material Decides the Channel Split

The object doing the punching is *what bites*. A wooden fist blunts and shreds (impact mixed with cut and wear); an iron fist is pure impact. With material identity already central to what a component *is*, combat should read the same way — so a hit's channel mix is a property of the **attacker**, resolved from the attacking component's (or equipped item's) composition.

The split is blended by composition *fraction* for multi-material attackers: a hand that is mostly iron with some wood is neither, and the fraction-weighted blend reuses the exact same weighting rule the stat-derivation layer already uses. One rule for "what does a composition do" keeps the model consistent between derivation and combat.

The attacker's split and the target's resistance are deliberately independent: the attacker decides *which channels the value lands on*, and the target resists *each of those channels on its own*. That separation is what makes a cut slice hurt a soft target and an impact slice hurt a brittle one without either side needing to know about the other.

## Why One Shared Choke Point Serves Punch, Cut, and ShootT1

All channel-damage actions converge on a single place in the damage handler. The split is applied **once, at that choke point**, rather than per action. This is an action-name-agnostic design decision: any current or future channel-damage action gets material-aware splitting for free, and the split/resistance logic is written exactly once instead of being forked across punch, cut, and shootT1 (each of which would otherwise need its own copy, and would diverge as soon as one changed). The legacy trait/stat path (a consequence with no channel) is left untouched, so back-compat actions behave exactly as before.

## Why Chunks Are Synthesized, Not Added to the Item Registry

A chunk is a small, single-material item whose only variable is its **volume** (which depends on how much matter that punch actually tore off) and whose only identity is its **material**. Reifying each as an entry in the item registry would be the wrong shape on both counts:

- **Unbounded variety.** There is an entry-per-material problem — every material that can be punched would need its own registry row, and the registry would have to grow with the materials list.
- **Dynamic volume.** A registry entry carries a *static* volume, but a chunk's volume varies per drop. Storing a fixed number in the registry would be a lie the runtime would have to overwrite anyway.

Instead, a chunk's type is **self-describing** — the material name is embedded in the type string itself — and a definition is *synthesized* at the small number of places an item definition is looked up (pickup, add-to-inventory, re-drop, stat reporting). This costs nothing at boot, keeps the item registry strictly data-driven, and — because ground-item records were already self-describing — required **zero client changes**. It establishes a precedent the rest of the inventory system did not previously need: an item definition is no longer exclusively a registry entry; a self-describing type can stand in where the type itself names the material.

## Why a Fixed Minimum Chunk Volume Exists

A chunk's size is tied to the damage *actually applied*, so a barely-there hit can produce a numerically tiny amount of matter. A **global minimum chunk volume** (a balance lever, so it lives in the data file, not in code) sets a floor: it guarantees that whenever a drop roll *succeeds*, the player receives a physically meaningful, pickable token rather than a numerical speck. It does not change the *probability* of a drop — a roll that still misses drops nothing.

## Why the Break Flow Owns Total Loss

Chunks represent **partial** loss on a component that still exists — the repeated-punch "chips fly off" loop this feature targets. When a punch empties a component's existence, the existing break/removal cascade has already run and owns that **total** loss: the component's *contents* spill as items, and its own *matter* is consumed by the removal. Having the drop handler also emit chunks for a fully consumed component would double-represent the same matter. So a lethal punch yields **no** chunks, and the spill flow is untouched. The chunk drop and the break/spill flow are orthogonal: they share only the ground-item store, and neither triggers, delays, or observes the other.

## Why the Drop Consumes the Published Loss (Not a Recomputation)

The chunk's volume has to be tied to the damage that **actually left** the target. The damage step computes that applied (clamped) loss and publishes it into the shared dispatch context, and the dispatcher's existing parameter propagation carries it forward to the drop step that runs after it. The drop handler's entire damage input is therefore that one published number plus the target's own recipe — it never re-derives the split, the resistance, or the clamping.

This matters for two reasons. **It cannot diverge:** recomputing in the drop handler would duplicate the damage math, and the two copies would silently drift the moment either changed. **It preserves one-way flow:** the drop is a *consequence of* the punch result, computed from that result, never feeding back into it. The same contract scales to the multi-attacker path without any re-derivation: the dispatcher carries only the reserved published-loss key forward, and only inside each attacker's own isolated context, so each fist's drop step consumes that fist's *own* applied loss — two independent rolls, two independent chunks, never one combined over an aggregate (spec D11, revised).

## Why Deleting Either Data File Disables the Split (Not a No-Op)

The two files deliberately distinguish **"absent"** from **"malformed"**:

- **Missing or empty** means the *split is off* — each hit keeps its whole value on the consequence's single declared channel (the intended single-declared-channel formula) and no chunks drop. Deleting a balance file before boot must never crash the game; it quietly restores that single-channel behavior with a warning.
- **Structurally malformed** (a shape the model cannot interpret) is a real defect and fails boot, exactly like the existing material validation.

The "reproduces legacy" wording is accurate only in the *value-routing* sense: an absent file routes the whole value to the declared channel, which is what the pre-split design *intended*. It is **not** a no-op against the code that actually ran before this feature set — before Feature 1, channel damage raised an error the dispatcher silently swallowed, so a punch applied **zero** channel damage at all ([BUG-132](../../bugfixWiki/high/BUG-132-channel-damage-silently-never-applied.md)). That fix shipped *with* Feature 1, so "feature off" now means **one working declared channel, no split — not nothing happens.** The absent/malformed asymmetry is unchanged: tuning drift (percentages that don't sum to 100) is *normalized and warned*, never rejected, so a balance tweak is never a crash; only a genuinely broken file is.

## Related Documentation

- [Materials System](materials.md) — the composition/derivation model and the `MaterialController` that owns these registries
- [Attack System](../architecture/attack_system.md) — the unified attack handler and the split at the choke point
- [Inventory System](inventory_system.md) — the dynamic-item precedent (an item type with no registry entry)
- [Consequence Handler Architecture](../controllers/consequence_handler_architecture.md) — the new drop handler and the loss-publication precedent between consequences
- [Design spec](../../material_damage_and_drop_spec.md) — full rationale, data contracts, and open questions
