# Knowledge Viewer

## 1. Overview

The Knowledge Viewer is a read-only "codex" tab in the main UI: a full, always-true reference of the game's static data. It shows the material property → trait → stat derivation chain (the global trait molds, the property-to-stat mapping table, the per-material property values, and the cross-layer pinned vocabulary), every recipe with display names resolved, and every item type with its fields. It is the read-only mirror of the [crafting panel](../systems/crafting_system.md): the same registries, but with no mutation, no turn cost, and no entity requirement. The complete design contract (data shapes, the single pull endpoint, tests, risks) lives in the [Knowledge Viewer specification](../knowledge_viewer_spec.md).

## 2. Why a dedicated read-only codex tab

The live world-state panels — inventory, component viewer, crafting — show *instance* state: values merged and material-derived per component, per-instance durability, what a particular component currently holds. A reference is a different kind of truth: it is consulted as a rulebook, so it must be complete (every recipe, every item type, every mapping row) and independent of whatever happens to be on screen.

Embedding reference knowledge inside the live panels would mix two update cadences — static data that changes only when the data files change, and instance data that changes with every broadcast — making "the rules" depend on which entities and items a player happens to be looking at. A dedicated tab with a single pull keeps the reference a pure function of the data files: nothing in the world can change what the codex says, and it changes only when the data changes.

It is data-driven end to end, like the rest of the project: adding a material, a recipe, or an item type to the data files is all that is needed for it to appear in the codex — no viewer code change.

## 3. Why the data is assembled by a state controller outside the broadcast cycle

The knowledge payload is owned by a dedicated state controller that holds the registries and has no cross-controller dependencies. That placement buys three things:

- **Zero new I/O.** The composition root already loads all of the registries the codex shows — for the material, crafting, and inventory systems. The knowledge controller is constructed from the same loaded objects: one load, N readers, no second read of the same files, and no divergence between what the derivation pipeline validates and what the codex displays.
- **Fail-fast validation with a real home.** State controllers are where boot validation lives, and a corrupted or cross-broken registry (a malformed mapping key, a recipe naming an unknown item type) fails the server at startup — never a player mid-game. A route-local load would have no such home: it would either re-read and re-validate on every request or cache ad-hoc, a stateless side channel the project has already eliminated.
- **No desync surface, by construction.** The payload is immutable at runtime, so there is nothing for a broadcast to keep in sync; the controller deliberately stays out of the world-state aggregation, the same exclusion the crafting registry and the per-room chat ring follow. Shipping a codex in every full-state update would bloat every client for zero benefit, so clients pull it on demand instead.

## 4. Why exclusivity is enforced at assembly, and why the formula wins

The mapping table in the data file deliberately follows a lax convention: an entry declares *at least one* of a formula or a weighted source list. The wire contract the client renders is stricter: each row presents exactly one — a formula or a source list, never both. The two are reconciled at assembly time, when the payload is built: an entry that defines both is emitted as a formula row and its sources are dropped.

Enforcement belongs at assembly rather than in the data file or in the boot validator, because the data file is an author's file serving the derivation pipeline (where either side is fine) and the wire is a derived view (where the client's either/or rendering needs one truth). The boot validator therefore stays deliberately lax — the same "at least one" rule the material pipeline's validator enforces, and intentionally unchanged — while the wire contract is guaranteed by the assembly step.

Which side wins is not a coin flip: the derivation pipeline already treats a formula as authoritative for an entry that has one (a `densityVolume` formula is computed from the formula, and the entry's source list is never consulted). The codex resolves double-declarations the same way, so it shows exactly what the runtime computes — a reference that resolved the table differently from the pipeline would be a reference that lies about the derivation, which is the one thing a reference must not do.

## 5. Why the mapping-key form is a shared definition

The mapping table is keyed by the flat "trait group + stat" form, and two independent boot validators key off it: the knowledge controller's (for the codex) and the material controller's (for the derivation pipeline). A key pattern hand-typed into both would have to be changed in lockstep forever, and a missed one would fail one validator while the other silently accepted keys the other layer could not read — the exact silent-drift class of bug the `shared/` modules exist to prevent (see the shared-modules section of the [Controller Relationship Map](../map.md)). The form is therefore defined once — the `TRAIT_STAT_KEY_PATTERN` export in `shared/StatVocabulary.js` — and imported by both validators, so the two can never disagree on what a key is.

The codex is also the one place in the project where the shared vocabulary meets the full data. The shared module pins a *subset* of trait/stat names (a deliberate, drift-safe subset, not an exhaustive list), and the viewer presents that subset next to the complete registries, labeled as pinned — so a reader can see at a glance which names are frozen across the two layers and which are still free to grow in the data.

## 6. Why a wiring miss degrades to a total empty shape, not `null`

The facade is the only path to the payload, and it tolerates its knowledge controller being unwired: rather than emitting `null` (or failing), it returns a **total empty-shape payload** — every section present, every list empty, the pinned vocabulary still filled in because it comes from a code constant, not from a data file.

The reason is that a wiring miss is a server-side configuration problem, not a data condition, and the only honest thing to show a player is an empty reference. Turning it into an error state would tell the player the reference is broken when it is simply empty; an empty codex is a coherent degraded state in its own right. A total empty shape also preserves the invariant the client relies on — that the payload is always fully shaped, so the client never branches on missing keys, only on empty versus populated. That is what keeps "the data file is empty" (per-section empty states) distinguishable from "the fetch failed" (the panel's error card), even though both travel the same path.

## 7. Why the panel fetches once per session and fails inside the panel

The payload is immutable at runtime, so refetching it on every open would be pure waste; the panel fetches once per session and caches the result, which also means a failed first fetch is retried automatically the next time the panel is opened. Every failure class the fetch can hit is caught and rendered as an in-panel error state with a retry action — never a console log, never a global error path: the panel is an isolated floating window, so a broken reference must not break the rest of the client. The same separation applies to content: a section whose registry is empty renders a per-section empty state, visibly distinct from the error card, so a player can always tell "there is nothing defined" from "we could not load it".

## 8. Related Documentation

- [Knowledge Viewer specification](../knowledge_viewer_spec.md) — the full design contract: data shapes, the single pull endpoint, tests, and the risk register
- [Crafting System](../systems/crafting_system.md) — the mutation twin; the knowledge viewer is its read-only mirror over the same registries
- [Material System](../data/materials.md) — the derivation pipeline whose priority semantics and key form the codex mirrors
- [Traits System](../data/traits.md) — the 4-layer merge the codex deliberately does not compute (it shows the declared layer, not merged runtime values)
- [Controller Patterns](../controllers/controller_patterns.md) — the state-controller pattern and the facade-degradation rule the knowledge controller follows
- [Client Architecture](client_architecture.md) — the panel's place in the client module inventory
- [Overlay Manager](overlay_manager.md) — how the panel joins floating-window coordination (exclusive visibility, no numeric shortcut)
- [CSS Architecture](css_architecture.md) — the one-file-per-panel rule the knowledge stylesheet follows
- [Controller Relationship Map](../map.md) — the dependency graph (the knowledge controller node) and the shared-module drift rationale
