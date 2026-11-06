# Decision: the outfit registry — what a body wears, by blueprint

Date: 2026-11-06 (recorded in the commit that implements this)

## Context

The owner asked that a body designed in the "Create Agent Body" tab be able to be
**dressed** — that a garment be settable for the components a design created.
What already existed:

- **`WearLogic`** — clothing is an `inventoryItems` recipe declaring
  `wear: { minVolume: X }`, worn on a component the CALLER chose, by pure volume fit
  (no layers, no species matching). `facade.wearItem` / `facade.getWornItems` are the
  seam; an NPC dresses itself with the same two tools it uses for a knife.
- **Three clothing sites, none of them per body.** `core-world/world.json`
  `initialSpawns` carries `{ item: "tshirt", slot: "bestAvailable", wear: true }` for
  every non-NPC spawn; `core-npcs/npcs.json` `initialItems[].wear` and the card profile
  (`CardSpawnLogic` `CARD_DEFAULT_PROFILE`) do the same for NPCs and card droids. The
  garment always lands wherever the volume happened to be free.
- **The prose coverage rule** (`wiki/decisions/visual-stats.md`, amendment): the dossier drops a
  part that is under cloth — the covered component is the one wearing the garment, plus
  the mounts that declared `hidesWithParent`. So *where* a garment is worn is not
  cosmetic: it decides which body parts the world names out loud.

Nothing in the world could say "this body wears this garment, on this part". And a
designed body is keyed by the card's display name — the same key its saved blueprint is
stored under (`wiki/decisions/agent-body-design.md`) — which is the natural join.

## Decision

- **A new registry kind `outfits`** (`shared/RegistryKinds.js`), shipped as one official
  package `data/mods/core-outfits/` (`mod.json` requires `core-blueprints` and
  `core-inventory-items`). `shared/RegistryKinds.js` is the vocabulary, `DataLoader`
  the only place that names the file, `RegistryStore` the live holder: the seam is
  unchanged, a mod swap re-dresses the world at the round boundary like any other kind.
- **Keyed by BLUEPRINT key**, value a list of `{ item, component }`. For a designed card
  the blueprint key IS the card's display name, so "the body of Adam" and "what Adam
  wears" are two writes keyed by one thing. `component` is a component TYPE of that body;
  the garment goes on the first instance of it.
- **`src/controllers/logic/OutfitLogic.js`** owns it: `outfitForBlueprint` (narrow once:
  `{ item, component }` of non-empty strings or the entry is skipped with a warn),
  `clothedByOutfit`, `applyOutfit` (add the garment to the component it goes on, then
  wear it through `facade.wearItem` — never a second fit rule), `validateOutfitRegistry`.
- **THE rule that changes existing behaviour:** when the registry clothes a body, the
  **default clothing of the spawn loadouts stands down** — the `wear: true` entries of
  `core-world` initialSpawns and of `core-npcs` / the card profile. A body wears its
  outfit; the world's shirt is for bodies nobody dressed. Everything else in those
  loadouts (coal, toolbelt, knives) is untouched. `clothedByOutfit` is exported precisely
  so the two readers state the rule once instead of each inventing it.
- **The outfit is applied BEFORE the loadout**, in the same spawn observer
  (`FacadeInitLogic`), and every spawn reads it by blueprint key — card droids and
  `npcs.json` NPCs alike, one reader rule. This ordering is not cosmetic: the fit rule is
  *free volume*, and a loadout applied first has already spent it — measured, not
  guessed: with the outfit applied after the loadout, the m1 central body holds ten coal
  and the t-shirt no longer fits (`0 free volume; "tshirt" needs 2`).
- **Spawn never fails because of clothing.** A garment the item registry does not know,
  a part this body does not have, a fit that does not hold: warn, and the body is born
  undressed. Same discipline as every other spawn side-effect.
- **Boot validation, shared with the mod swap.** `validateOutfitRegistry` runs in the
  composition root's fail-fast block (an outfit naming a knife as a garment fails boot)
  and in `CompositionClassifier` per definition, so a mod that carries a bad outfit
  quarantines that blueprint key and the world keeps running. One rule, two readers
  (`CHG-2`): a swap never gets a looser world than a cold start.
- **The shipped seed is not new behaviour**: `m1Droid` wears `tshirt` on `m1CentralBody`
  — the generic droid already wore the shipped t-shirt on its central body, and still
  says so in the prose. The seed exists because that is what the world did, now written
  as data instead of falling out of "best available volume". (`officialMods` requires
  every official registry to ship content; dressing the generic body is the honest row
  to ship.)

## Consequences

- The world is built from one more registry kind, and `core-outfits` joins the official
  dependency graph holding `core-inventory-items` — which is exactly what
  `test/integration/modApplyAtRoundBoundary.test.js` unwinds, so that test now disables
  `core-outfits` too. `AGENTS.md` no longer states a package count (it says "one official
  `core-*` package per registry kind", which the contract test derives);
  `RegistryStore`'s header no longer says "21 registries" either.
- **An outfit key present means this body's clothing is authored.** Its opposite is not
  expressible yet: an *empty* list is indistinguishable today from no entry at all, so
  "Adam wears nothing" cannot be asked for — see Next change.
- Clothing is now a real claim per body, and the prose follows it automatically: a
  garment worn on the central body covers it (`worn`), and the mounts marked
  `hidesWithParent` under it stop being named. Nothing in `PerceptionController` changed.
- The `outfits` file is written by the "Create Agent Body" Save (with a timestamped
  backup, like every file that save touches) — see the next change note there.

## Rejected alternatives

- **A `wears` field on the component recipe (`components.json`).** Cheapest by far, and
  it binds clothing to a component TYPE: two bodies of the same type could never dress
  differently, and a body recipe starts answering a question about garments. The
  blueprint-family file is the one that is about *this* body.
- **An extra key inside `blueprints.json`.** That file is a pure mount tree — every
  value is an array of mounts (`_loadBlueprints`, the loader, the classifier all assume
  it). A sibling key holding a different shape buys nothing and costs the invariant.
- **Extending `initialItems` (npcs.json / card profile) with a component target.** The
  card is not in `npcs.json`, and the card profile is a global constant, so this cannot
  express "this card, this garment". It is also the wrong file: it answers "what it
  carries", and the clothing rule above is about what it WEARS.
- **Deriving clothing from names** (a component called `chest`, an item called `robe`).
  `H-4`, and the same class of guess `visual-stats` already rejected for coverage.
- **Applying the outfit after the loadout**, in `applyInitialItems`. It misses every
  non-NPC spawn, and it loses the volume race described above.

## Next change

The save side (`AgentBodyController.saveDesign`) writes this registry from a designed
body: `wiki/decisions/agent-body-design.md`. Two things that change owns and that this
note flags rather than decides silently: the design must be able to author an **empty**
outfit ("wears nothing"), which needs `clothedByOutfit` to distinguish an authored empty
list from an absent key; and the design must be able to author the **garment** itself,
which writes `core-inventory-items` as a third file the Save touches.
