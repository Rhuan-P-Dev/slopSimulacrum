# Knowledge Viewer

## 1. Overview

The Knowledge Viewer is a read-only "codex" tab in the main UI: a full, always-true reference of the game's static data. It shows the material property → trait → stat derivation chain (the global trait molds, the property-to-stat mapping table, the per-material property values, and the cross-layer pinned vocabulary), every recipe with display names resolved, and every item type with its fields plus its capabilities — what it can do, derived from the action registry, the equip list and its own matter (§8) — and every action with the stat gate that governs it (§9). It is the read-only mirror of the [crafting panel](../systems/crafting_system.md): the same registries, but with no mutation, no turn cost, and no entity requirement.

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

The mapping table is keyed by the flat "trait group + stat" form, and two independent boot validators key off it: the knowledge controller's (for the codex) and the material controller's (for the derivation pipeline). A key pattern hand-typed into both would have to be changed in lockstep forever, and a missed one would fail one validator while the other silently accepted keys the other layer could not read — the exact silent-drift class of bug the `shared/` modules exist to prevent (see the shared-modules section of the [Controller Relationship Map](../../map.md)). The form is therefore defined once — the `TRAIT_STAT_KEY_PATTERN` export in `shared/StatVocabulary.js` — and imported by both validators, so the two can never disagree on what a key is.

The codex is also the one place in the project where the shared vocabulary meets the full data. The shared module pins a *subset* of trait/stat names (a deliberate, drift-safe subset, not an exhaustive list), and the viewer presents that subset next to the complete registries, labeled as pinned — so a reader can see at a glance which names are frozen across the two layers and which are still free to grow in the data.

## 6. Why a wiring miss degrades to a total empty shape, not `null`

The facade is the only path to the payload, and it tolerates its knowledge controller being unwired: rather than emitting `null` (or failing), it returns a **total empty-shape payload** — every section present, every list empty, the pinned vocabulary still filled in because it comes from a code constant, not from a data file.

The reason is that a wiring miss is a server-side configuration problem, not a data condition, and the only honest thing to show a player is an empty reference. Turning it into an error state would tell the player the reference is broken when it is simply empty; an empty codex is a coherent degraded state in its own right. A total empty shape also preserves the invariant the client relies on — that the payload is always fully shaped, so the client never branches on missing keys, only on empty versus populated. That is what keeps "the data file is empty" (per-section empty states) distinguishable from "the fetch failed" (the panel's error card), even though both travel the same path.

## 7. Why the panel fetches once per session and fails inside the panel

The payload is immutable at runtime, so refetching it on every open would be pure waste; the panel fetches once per session and caches the result, which also means a failed first fetch is retried automatically the next time the panel is opened. Every failure class the fetch can hit is caught and rendered as an in-panel error state with a retry action — never a console log, never a global error path: the panel is an isolated floating window, so a broken reference must not break the rest of the client. The same separation applies to content: a section whose registry is empty renders a per-section empty state, visibly distinct from the error card, so a player can always tell "there is nothing defined" from "we could not load it".

## 8. Why item capabilities are derived, and why the list is coarse

An earlier version of this document closed the item section with "the viewer does not compute derived stats". That boundary has been moved deliberately, once, and the moved line is the point of this section.

**The world never links an action to an item.** `actions.json` gates on stats alone: `cut` is `Physical.sharpness >= 20`, `shootT1` is `Physical.existence >= 0.01`, `touch` declares nothing. No action names an item type, and no item field names an action. The only reason an item ever satisfies such a requirement is that equipping it seeds its per-instance stats from its own matter (`HoldingCostController._seedDerivedStatsOnEquip`, BUG-134) and the capability scan then prefers those seeded stats over the host's (`componentCapabilityController._getEffectiveStatsForAction`). So the question "what can this item do?" has no answer in any single field: answering it requires the same derivation the equip flow performs.

**What the codex therefore computes, and only this:** for each item recipe, the stats it carries before an instance exists (explicit `form.traits`, else matter derivation — the precedence of `src/utils/itemBaseStats.js`, which the equip flow delegates to as well, so reader and writer cannot drift; both carry the `Physical.existence` baseline the instance starts with (`EXISTENCE_BASELINE`), over explicit traits and over derived matter alike), and every action whose stat requirements those stats satisfy, gated on the item being equipable (`holdingCost.equipableItems` — an item that cannot be worn can never supply a requirement). The boundary that stays: recipe level only, never per instance, no wear, no entity, no live world state. Matter derivation arrives as an injected function (`(itemDef) => materialController.derive(itemDef)`), so the knowledge controller keeps its no-controller-dependency rule while calling the single derivation authority instead of re-implementing it.

**The list is coarse because the engine is coarse, and it is not curated.** Attribution follows the requirement check exactly: an equipable item shows every action its derived stats pass. That is why the T1 also shows `cut` (equipped, it carries sharpness 82.5, and the scan really does offer it) and why the knife shows `shootT1` (its own requirement is only `existence`, and any item is a valid container — `InventoryManager.addItemToContainer` caps at the item's own volume, so a knife can hold one knife). Editing those rows into a tidy "knife cuts, T1 shoots" would be hand-authoring a capability list the engine does not implement — the decoration this codex exists to avoid. Storing, likewise, is not a special power: capacity is the item's volume everywhere, and the pair that actually distinguishes an item is capacity against footprint (`definitionVolume.getDefinitionFootprint`), which is why the T1 reads *capacity 10, occupies 1*. That pair is also why the equip state is a bordered flag and not plain words: as text it shared a class with the capacity beside it and the row read as one label ("Equipable Capacity 10") -- the one reading the pair exists to prevent.

**The rule that must not fork:** the numeric-leaf rule (which declared trait values count) and the explicit-over-derived precedence live in `src/utils/itemBaseStats.js`, called by both the equip flow and the codex. A capability claim that no code enacts is a lie about the world; a second copy of this rule is how such a lie appears without anyone noticing.

## 9. Why the codex lists actions too, and why that is not the capability list

The Actions tab answers the other half of the question §8 answers. §8 reads an item and asks which actions it carries; the Actions tab reads an action and shows the gate the engine actually checks — `Physical.sharpness >= 20`, `Movement.move >= 5`, nothing at all for a universal action — as data, not prose. It exists because that gate is the whole of what an action demands: no action names an item type, so the requirement list is the only honest statement of who can act. Each card carries that gate, the server's reading of what the action **does**, and the full field listing kept as a collapsed appendix.

**The reading lives server-side** — `src/controllers/knowledge/actionSemantics.js`.
What a consequence type *means* is world knowledge, and world knowledge lives on
the server (the client is disposable); a bare dump of `damageComponent` + `params`
forced the reader to already know the meaning. The interpreter returns `targeting`
(from the shared `TARGETING_TYPES`), `range`, `narration` (from `prose.verbPhrase`
and `prose.instrumental.verb`, the fields `RoundProseBuilder` itself reads) and
`effects` / `failureEffects` — one sentence per consequence, read off its params,
plus `on`: the party it lands on, from the dispatcher's **closed** `target`
vocabulary (`self | target | entity`, per
`ConsequenceDispatcher._resolveTargetForConsequence`). Three rules the shape
encodes:

- **The party is a separate marker, never a word of the sentence.** No single
  preposition reads right across the types ("moves toward its target *on the
  acting entity*"), so `text` says what happens and `on` says whom it lands on.
  In the panel the three parts are one **visually bounded block** — a left bar per
  consequence, header line `type .... -> party`, sentence underneath — because a
  wrapping flex row collapsed into three unowned lines in a narrow panel and the
  reader could not tell which party went with which effect.
- **Nothing is invented, nothing is hidden.** A `:Stat` binding reads "resolved at
  run time" instead of a cryptic `:`; a missing channel or stat says "unstated";
  a type outside the handler map comes back `described: false` and the viewer
  marks it as undeclared behavior rather than paraphrasing it.
- **`log` reads its `message` from the top level** of the consequence (beside
  `level`), not from `params` — reading only `params` reported every log line as
  having no message.

**What the viewer cannot read, it shows raw and in red — in both directions.** An
unknown consequence type arrives `described: false`; an unknown `targetingType`
arrives as `targeting: "<the declared value>", targetingDeclared: false` (a type
inside `TARGETING_TYPES` arrives as its phrase with `targetingDeclared: true`).
Silence was the rejected alternative: omitting the cell would make "this action
targets something we have no reading for" render identically to "this action
declares no targeting", which is a different claim about the world — and a new
targeting type reaches the payload without complaint today, because no code
enforces exhaustiveness over `TARGETING_TYPES` (only five readers compare it, all
against specific constants, so an unrecognized value falls through to the generic
branch). The red cell is the visible half of that; the engine-side default branch
is a separate question, deliberately not settled here. One color per meaning:
red = declared-but-unreadable, orange = the "if it fails" heading.

The raw listing ships in full and renders inside a collapsed `<details>` ("Raw
definition (every field)"), so `groupPick` and any future mod field stays
reachable. **`groupPick` is read by no code** (checked server and client: the
group-pick overlay is not driven by the action's field) — which is precisely why
it appears as data and is not paraphrased into a capability.

What it deliberately is **not**: the live capability list. "Can *this* droid cut *that* component right now" is per-entity, per-instant, and depends on equipped items, current wear and stat values — that answer belongs to the runtime capability scan and its `GET /action-capabilities/entity/:entityId` surface, not to a codex that is a pure function of the data files and is fetched once per session (§7). The two are complements: the tab states the rule, the endpoint reports the moment. A codex row that claimed an entity's current abilities would be stale the instant anything changed, and the reference is the one panel a player must be able to trust between turns.

The chip jump is navigation, not derivation. Clicking `cut` in an item's capability row opens the Actions tab and flashes that card — the same cross-link convention the material links and the recipe refs already use, keyed on the card's `data-action` the way the item cards key on `data-item`. It moves the reader between two views of data the server already sent; the client computes no capability of its own.

## 10. Why the search is client-side, what it walks, and what the sub bar narrows

**Client-side, by construction.** The codex payload is fetched once per session and is
static at runtime (§7). A search endpoint would re-read on the server what the browser
already holds, for a filter that is not world knowledge — it is a reading convenience
over data the server already shipped. `public/js/KnowledgeSearch.js` holds it, pure:
no DOM, no fetch, no timers, so the whole rule is testable without a browser (the
client has no DOM harness).

**One rule, one pass.** `filterKnowledge` returns the filtered payload *and* the
counts, from the same walk. The tab badges, the two status lines and the no-match
state all read those numbers, so a badge can never disagree with the tab under it —
the fork this prevents is the ordinary one where a count is computed by a second,
slightly different predicate.

**What it walks: the whole row, raw dump included.** A term is matched against the
row serialised (`JSON.stringify`, lowercased), which reaches fields the panel never
displays — the appendix and anything behind it. The cost is stated plainly: a query
can match a **key** name (`range`, `wear`) as well as a value, because the row is
serialised whole. Terms are ANDed (every term must appear somewhere); it is not a
query language — there are no operators, no field filters, no ranking. That contract
is what makes `ammunition` find `shootT1`, whose only occurrence is inside the
action's failure log message, and `sharpness` find every item through its derived
base stats.

**The sub bar is a second term over the first, scoped to the tab on screen.** The
global bar answers "where is it" — each tab shows its own hit count; the sub bar
answers "and among those, which". Two rules keep the pair honest: the tab badges are
always the **global** counts (a badge that shrank because one tab was narrowed would
lie about the other four), and the narrowing is dropped the moment the reader jumps
to another tab, where it has no meaning -- by a plain tab click as well as by a
cross-link jump, while the global term survives both (it is still the question the
reader is asking). Both halves are pinned in `test/unit/KnowledgePanel.test.js`;
the reset also drops the search focus, because the click owns it now.

**The pinned vocabulary is dropped while a search is active.** It is reference chrome
— the same badges under every query — and rendering it made an empty result look
full. Without a term it is untouched.

**The Traits tab counts mapping rows plus stat cells.** It has no single row type, so
"how many" is defined once, in the filter, and the badge and the tab read that one
definition. A group whose **name** matches keeps all its stats; otherwise only the
matching cells survive.

**Reference data is not display data.** The Items cards look up material names to
render their cross-links. Filtering `traitStats.materials` with the query emptied
that map too, and item materials silently became plain text whenever a search
happened to narrow the Materials tab. `_renderSection` therefore takes the unfiltered
payload as a `reference` argument and filters only what a section displays. A filter
applies to content, never to the lookup table that renders the content correctly.

**A jump into a filtered result.** Clicking a cross-link is a change of intent, so
the sub bar always resets. The global term resets only when the target cannot survive
it — a jump to a filtered-out card would flash nothing at all — and a target the
search cannot locate never clears the reader's term. Silence is not a licence to
delete what somebody typed.

**The empty state of a search is not the empty state of the data.** "This section has
no items" and "no item matches your term" are different facts; the renderer's own
empty messages stay exactly where they were, and the search brings its own, with the
term echoed back.

## 11. Why class and stylesheet are pinned to each other

There is no DOM harness, so a mistyped class and an orphaned rule are invisible — the
panel just loses a style and the gate says nothing. `test/unit/knowledgeMarkupIntegrity.test.js`
reads the renderer and the sheet as text and asserts they agree in **both**
directions, plus the layout invariants of §9 (one bounded block per consequence, the
gap between blocks wider than the gap inside one — the inversion that made the
consequence rows read as three unowned lines) and brace balance across every
stylesheet, because one stray brace silently kills every rule after it.

Two escape hatches, both explicit lists in the test, neither a wildcard:
`UNSTYLED_HOOKS` (a class that carries meaning and takes its look from a parent
selector — six of them, each a decision) and `DYNAMIC_CSS_MODIFIERS` (a rule for a
class assembled at runtime, which a text scan cannot name — none today, so an
unmentioned rule is genuinely dead). The test also asserts the exception lists are
still true: a hook that gained a rule, or stopped being emitted, fails until the list
is corrected. Each assertion was proved to fire by breaking the source on purpose.

**Scope, stated as debt.** Only the `knowledge-` namespace in the panel's own sheet.
The rest of the client carries 26 unmatched classes across 12 files (`overlay-content`,
`clickable`, `pinned`, ...) — measuring that first is why the pin is scoped rather
than universal: a repo-wide assertion written today would either fail the gate or
ship with a 30-entry baseline nobody maintains. Widening it is a dedicated change.

**What the pin may import (decision).** It reads `public/js/KnowledgePanel.js` and
`public/css/knowledge.css` as *text*, through `node:fs` and `node:url`. That is in
scope for a test file: the assertion is that two files agree, and no runtime behavior
exposes a stylesheet, so text is the only surface the claim has. What stays out of
scope is importing server behavior into a client test, or reaching outside this
repository -- reading `src/controllers/**` to judge the browser's markup tests the
wrong seam, and a path outside the repo makes the test depend on the machine rather
than on the change.

## 12. Related Documentation

- [Crafting System](../systems/crafting_system.md) — the mutation twin whose registries the viewer renders (the knowledge viewer is its read-only mirror)
- [Action System](../architecture/action_system.md) — the action definitions the Actions tab lists, and the live capability scan the codex deliberately does not duplicate
- [Material System](../data/materials.md) — the derivation pipeline whose priority semantics and key form the codex mirrors
- [Traits System](../data/traits.md) — the 4-layer merge the codex deliberately does not compute (it shows the declared layer, not merged runtime values); §8 covers the one derivation it does perform
- [Controller Patterns](../controllers/controller_patterns.md) — the state-controller pattern and the facade-degradation rule the knowledge controller follows
- [Client Architecture](client_architecture.md) — the panel's place in the client module inventory
- [Overlay Manager](overlay_manager.md) — how the panel joins floating-window coordination (exclusive visibility, no numeric shortcut)
- [CSS Architecture](css_architecture.md) — the one-file-per-panel rule the knowledge stylesheet follows
- [Controller Relationship Map](../../map.md) — the dependency graph (the knowledge controller node) and the shared-module drift rationale
