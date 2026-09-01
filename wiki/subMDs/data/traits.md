# 🧬 Traits System (Recipe → Derivation Model)

## 1. Overview

A component is **matter, shaped, and given function** — and everything it is can be traced to those three sources. The blueprint is a **recipe**: it declares **form** (size/volume), a **composition** of a variable number of distinct materials, and **which internal components (ICs) are pre-installed**. It no longer declares stat values.

Every stat is **derived** from exactly one of the three sources — matter, form, or function — so the same recipe and organs always yield the same stats, and nothing a player can see is without a cause. Named traits sit on top as a separate concern: they **gate and mark, never patch numbers** — flags decide which damage channels and interactions apply, and transient conditions are stored per instance and apply damage over time.

The full design record is in [Basic Traits & Stats — Spec](../../basic_traits_and_stats_spec.md); the matter side of the derivation is covered in [Material System](materials.md).

## 2. The Blueprint Is a Recipe, Not a Stat Sheet

A blueprint declares structure only: form, composition, pre-installed organs. The old "blueprint override" layer — hand-tuned per-component stat values — is retired as a source of values, and the global-defaults mold (the baseline trait sheet every component merged from) is retired with it. [`data/traits.json`](data/traits.json:1) remains part of the data set but no longer plays a role as a source of stat values.

**Why.**

- **Hand-tuned values are an N×M tuning matrix** (every material × every stat) that does not scale — the same problem the material system already solved for its own layer.
- **Arbitrary values make composition feel decorative.** Adding iron to a wooden part changed nothing, so what a component was made of had no gameplay meaning.
- **Every visible number must have an investigable cause.** Two parts with identical recipes but different remaining matter should be *different in the world*.
- **A global default resurrects the phantom-stat problem** — the key-set merge rule was introduced precisely to stop trait groups a component never declares from appearing on it. With no defaults, nothing can leak in.
- Positioning offsets move out of the trait contract into form data, where structure belongs.

## 3. One Source Per Stat

| Stat | Source | Meaning |
|------|--------|---------|
| `existence` (0–1) | matter | how much of the original matter remains; zero means the component is gone |
| six channel resistances (cut, impact, wear, heat, electricity, corrosion) | matter | how much damage of each channel the composition absorbs |
| `mass` | matter | heaviness; the currency of carrying |
| `sharpness` | matter | the edge the composition holds; a depletable quality of the edge material |
| `volume` | form | size declared by the recipe; what fits where |
| `strength` | IC | force: impact damage, what can be carried |
| `move` | IC | autonomy: how fast it moves, and initiative order |
| `fine_controls` | IC | precision: fine handling, crafting quality |
| `think_level` | IC | cognition: how much the NPC's AI can hold |

**Why one source per stat.** There is never ambiguity about why a number has the value it has, and derivation stays a pure function: the same composition and organs always yield the same stats, which is what makes the state serializable and syncable without drift. A component with matter but no organs is **inert** — it resists, it weighs, it can be cut, but it does not punch, walk, grip, or think. Function requiring organs is what makes ICs the game's upgrade path.

**Two scales, by design.** The world already speaks two scales and the basic set keeps both: **0–100** for every material property and for every derived or organ-granted stat (the existing convention across data files), and **0–1** for existence, because existence is a *ratio of matter*, not a tuned quantity. If a different range is wanted later, only data files change.

## 4. Existence: Life Is Matter

Every component has **existence** — a ratio from 0 to 1 reflecting how much of its original matter remains. It replaces `durability`: when existence reaches zero — all matter gone — the component **ceases to exist**: it is removed from its entity, and whatever matter still has shape drops as **salvage**.

**Why.**

- This is a scrap world: a component dying by losing what it is made of is the theme, and it makes damage legible — the composition visibly thins instead of an opaque health bar dropping.
- `durability` used to play the role of health while the materials sat inert: two stores describing the same thing, and the project already paid for that dual-state desynchronization (see [BUG-017](../../bugfixWiki/architectural/BUG-017-dual-state-bug.md)). With existence derived from matter there is exactly one store, so save/load and client/server sync stay trustworthy by construction.

## 5. Damage Has a Channel

Damage arrives with a **channel** — cut, impact, wear, heat, electricity, corrosion — and consumption proceeds **one material at a time**, starting with the material least resistant to that channel. A highly resistant material absorbs the same damage with almost no loss: a cut is trivial on iron, fatal on a cable.

**Why.**

- Channels make **material identity matter in combat**, which a single health number could never express.
- They let the **composition evolve**: a component can lose its iron and keep its wood, so its derived stats change before it dies — identity drift is emergent, not scripted.
- The existing material properties map **one-to-one onto the six channels** (three as resistance, three as susceptibility inverted at conversion), so no new material science is invented; the mapping table stays the single balance lever (see [Material System](materials.md)).

## 6. Named Traits Gate and Mark, Never Patch Numbers

The basic named traits come in two kinds:

- **Flags** — `flammable` and `conductive` are **derived on read** whenever a material property crosses a declared threshold; `corrosive` is **granted by a specific IC**. Flags decide *which* channels and interactions apply to a component — a flammable one in fire, a conductive one in a shock, a corrosive one touching iron.
- **Conditions** — `burning`, `wet`, `corroded` — are transient and **stored per instance in world state**. They apply damage over time: a burning component loses matter to the heat channel; a corroded one loses matter with no attacker at all.

**Why.**

- If a trait could add or multiply a stat value, stats would again have two sources and the derivation invariant would die. Gating keeps every number traceable to matter and organs while making the *interaction* between components rich.
- Flags are derived on read, so they can never desync from the matter that causes them.
- Conditions are stored because they are *events that happened*: they must survive save/load, and they must be visible to the client and the LLM context.

## 7. What the Old Model Retired

The four-layer merge (global defaults → material-derived → blueprint overrides → runtime initial overrides) is gone, and with it everything that existed to keep that merge safe:

- **Global trait molds** no longer hold baseline stat values — there is nothing to inherit from.
- **Blueprint stat overrides** — the hand-tuned per-component numbers — are replaced by structure: form, composition, pre-installed organs.
- **Runtime per-instance stat overrides** (e.g., from crafting) disappear. The only per-instance state that mutates is the matter that remains (depletable) and transient conditions; the deep trait-level merge that kept runtime overrides consistent (see [BUG-005](../../bugfixWiki/high/BUG-005-deep-trait-merge.md)) is retired with them, because stats are re-derived, never merged into stored values.
- The **no-default-`move` special case** is no longer needed: `move` is granted by organs, so a component without them simply has none — the phantom-movement concern the special case guarded against is impossible by construction.

## 8. Manipulation and Precision

`fine_controls` is the precision stat — how carefully a component can handle things. It is no longer hand-tuned onto hands and fingers; it is **granted by a precision organ (IC)** on whatever component hosts it. The old restriction (precision only on hands, the entity's primary interaction organs) is subsumed: a component is precise because it carries the organ that makes it so.

## 9. The Entity Is the Aggregate of Its Components

No entity-level stats exist. An entity's health and capability are what its components' existence and stats already express.

**Why.** The existing broken-component removal pipeline already gives the world its notion of injury and death. Adding a parallel entity-level health store would recreate the dual-store desynchronization class this model exists to remove (see [BUG-017](../../bugfixWiki/architectural/BUG-017-dual-state-bug.md)).

## 10. Vocabulary

Every name above — groups, stats, flags, conditions, channels — is declared in the shared vocabulary module (`shared/StatVocabulary.js`), the only place those strings are defined. Both the server and the client import from it, so a spelling can never drift; the data files must match the vocabulary, never the other way around.

## Related

- [Basic Traits & Stats — Spec](../../basic_traits_and_stats_spec.md) — the agreed design record for this model
- [Material System](materials.md) — matter: the source of resistances, mass, sharpness, and existence
- [Internal Components](internal_components.md) — organs: the source of function stats
- [Holding Cost](holding_cost.md) — equipped items as small components; the price of carrying mass
