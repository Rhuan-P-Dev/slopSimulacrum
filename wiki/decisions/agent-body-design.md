# Decision: Agent body design from a character card (Create Agent Body tab)

Date: 2026-10-26 (recorded in the commit that implements this)

## Context

A persistent, data-driven world simulation (`slopSimulacrum`) where LLM agents live
as NPCs. A "body" for an NPC is a **blueprint** (component tree) from
`data/entities/blueprints.json`, which composes recipes of **components**
(`data/components/components.json`: volume, materials, organs) over **materials**
(`data/materials/materials.json`) and **organs**
(`data/components/internalComponents.json`). A "card" for a character is the PNG in
`data/cards/` whose `tEXt` side channel embeds the identity (name, description,
personality; `chara_card_v2` spec). The owner asked for a developer tab called
"Create Agent Body" that analyzes a card and has the LLM judge/author how the
character's body is built.

Constraints that shaped the design (all from `CODE_RULES.md`):
- `CODE_RULES.md` §RP-1: LLM prompt kinds live in `src/controllers/networking/`;
  every new kind is a decision. This is a third kind, `agent-body-design` (after
  `chat` and the NPC agent round).
- §B-2: only `LLMController` may touch the provider.
- §RP-2: prompts must be versioned and named.
- §B-3 / §DATA-1: all data access through the seam (`DataLoader.js`,
  `PngCharaReader.js`, `CardSpawnLogic.js` — the only files that may touch `fs`).
- §H-1/H-2: every API error carries a machine-readable `code` in the
  `{ error: { code, message } }` envelope.
- §SEC-9: the LLM call must be cost-guarded (named token budget + rate limit).
- §OBS-3: LLM payloads are logged by length only.
- §E-1: expected failures surface as domain values/errors with the faulty
  entity named.

## Decision

- New controller `src/controllers/networking/AgentBodyController.js` (LLM tier,
  built in `src/server.js` next to `llmAgentController` and exposed on the
  `WorldStateController` facade for the routes — same pattern as the Agent View
  agent).
- New prompt kind **`agent-body-design`** (version **1.4.0** — see the amendments at
  the end of this note; named in the prompt
  itself so the model sees it; also in the module header, `AGENTS.md` and this
  decision note). The prompt carries: the anatomy facts (blueprint = component
  tree; component = form + materials + organs; volume = capacity), the full
  vocabulary (every component, material, organ, example blueprint), the output
  schema, and the rules (every node must be an existing component or a NEW
  component the model defines in the same response; organ refs must be available;
  the blueprint id is set to the card's display name, which the model does NOT
  choose — v1.1.0 removed the "pick your id" instruction so the model only authors
  structure and recipes; v1.2.0 makes it explicit that NEW component recipes are
  the intended way to faithfully represent the card's distinctive features; at
  most 16 body nodes).
- The design output shape: `{ blueprintId, rationale, structure, components }`
  where `structure` is the body tree (`{ component, slot, children }`, and since v1.3.0 a
  node may author `hidesWithParent` — see the amendment at the end of this note) and
  `components` is the list of new component recipes (name, form, materials with
  fractions summing to 1.0, internalComponents, energyCapacity). `blueprintId`
  is the card's display name (trimmed `name` field, falling back to the card stem)
  — the server sets it from the card identity; it is not a model-invented slug
  (v1.1.0). This is the exact key a card is spawned with when it has a saved
  body (see the spawn bullet below).
- Routes:
  - `GET /agent-body/cards` → `{ cards: [{ cardId, name, description, personality }] }`
    (read-only card list from `data/cards/`; no LLM call).
  - `GET /agent-body/cards/:cardId/image` → the card's own bytes with the
    content type of its file extension (`image/png`, `image/jpeg`, ...),
    `Content-Length` and `Cache-Control: no-store` (the art changes on disk
    when the user drops a new file). 400 `CARD_ID_REQUIRED` (segment missing or
    over 128 chars); 404 `CARD_NOT_FOUND`; 500 (the shared route contract) when the read
    fails for any other reason (a disk error, not a missing card); 503
    `AGENT_BODY_CONTROLLER_NOT_WIRED`.
    The id is matched against the cards-directory listing, so a traversal in the
    request is a non-match, not a path (SEC-7); the bytes come from the data seam
    (`readCardFileBytes` in `src/utils/PngCharaReader.js`, B-3). The listing is read
    once per gallery open and cached on the controller instance (`_listCardFiles`),
    so the per-card reads reuse it instead of re-reading the directory each time
    (`listCards` refreshes the cache on open). Served to the Cards menu tab's gallery
    (`public/js/CardsPanel.js`), which pairs each row's photo with the name and
    description the same listing carries. No LLM call.
  - `POST /agent-body/create` with body `{ cardId }` (1..128 chars, stem, no
    extension) → 200 `{ card, body, meta }` with `meta = { promptKind,
    promptVersion, promptMessages (captured, dev inspection), model, finishReason,
    latencyMs }`; 400 `CARD_ID_REQUIRED`; 404 `CARD_NOT_FOUND`; 422
    `BODY_DESIGN_INVALID` (validation rule list in message); 502 `<LLM_ERROR_CODE>`
    (codes from the seam: `LLM_TIMEOUT` | `LLM_HTTP_ERROR` | `LLM_PARSE_ERROR` |
    `LLM_REQUEST_ERROR`); 503 `AGENT_BODY_CONTROLLER_NOT_WIRED`. Rate limit 20
    per minute per IP (`createRateLimiter`, same gate as `/llm/chat`, SEC-9).
  - `POST /agent-body/save` with body `{ blueprintId, rationale, structure,
    components? }` (a design object) → 200 `{ saved, blueprintId,
    newComponents, blueprintWritten, blueprintOverwritten, backups }` after
    re-validation and persistence (new component recipes merged into
    `data/components/components.json`; the droid-type pointer plus every part
    sub-tree written to `data/entities/blueprints.json`; timestamped pre-write
    backups of both files). 400 `SAVE_PAYLOAD_INVALID` (body not an object);
    422 `BODY_DESIGN_INVALID` (rule list in message); 500 on any other
    `saveDesign` failure; 503 `AGENT_BODY_CONTROLLER_NOT_WIRED`. Rate limit 20
    per minute per IP (`createRateLimiter`) — it writes data files, though it
    makes no LLM call.
- Validation (in `AgentBodyController._validateDesign`, before the design is
  returned or a save is persisted; the raw model output never reaches the client):
  shape rules (JSON object, rationale required, valid recipe fields, material
  fractions sum 1.0 ± 0.005, tree ≤ 16 nodes, depth ≤ 8, slot null-or-string,
  unknown component/organ rejection) plus blueprint-id rules: a **model-chosen**
  id must be a unique slug that does not collide with an existing blueprint, and
  a **card-derived** id (the card's display name, set by `designBody` and
  persisted by `saveDesign`) is validated only as a non-empty string — it may
  reuse the card's own previously-saved body. Finally, the droid-type key must
  be a distinct registry key from every component used in the tree (the `[root]`
  pointer must not overwrite a part's sub-tree), enforced on both the design and
  save paths. Failure throws `DesignValidationError` (code
  `BODY_DESIGN_INVALID`) whose `errors` array is surfaced in the 422.
- A **Save** action (the "apply" flow, implemented as a follow-up decision
  once the display-only core was verified): `POST /agent-body/save` re-validates
  the design against the same rules with `cardNameId: true` (the blueprint id is
  the card's display name, so the slug/collision checks are relaxed to a
  non-empty string; overwriting the card's own previously-saved body is intended),
  takes a timestamped pre-write backup of `data/entities/blueprints.json` and
  `data/components/components.json`, merges new component recipes into
  `components.json` (an existing recipe is never overwritten), and writes the
  droid-type pointer plus every part sub-tree into `blueprints.json`.
  **Confirmed side-effect**: any part whose sub-tree the design redefines is
  overwritten in the live registry — the operator confirmed this is intended, and
  the pre-write backup makes it recoverable. Save writes only the blueprints and
  component recipes; the entity side (spawn) is handled by the spawn path (see
  the spawn bullet below).

- Spawn (change 2): when a card is spawned (`CardSpawnLogic.spawnCards` →
  `spawnSingleCard`, in the first room at a random point), the body used is the
  card's **own saved body when it exists** — i.e. a blueprint keyed by the card's
  display name (the exact name `designBody` sets) — otherwise the generic
  `m1Droid` blueprint. The name key is derived the same way in both places
  (trimmed card name, stem fallback), so a saved body is matched by exact name.
  `data/cards/` remains the source of truth for which cards exist (unchanged); a
  light facade with no blueprint registry still falls back to `m1Droid` so spawn
  never fails.

- Named token budget 10x the global `LLM_DEFAULT_MAX_TOKENS`
  (`LLM_AGENT_BODY_MAX_TOKENS = LLM_DEFAULT_MAX_TOKENS * 10`, 2048 to 20480):
  the precision reasoning model counts its thinking tokens against this cap, so
  a small budget truncated the design (finishReason "length"). The per-call
  token cap lives on this controller (precedent: `LLMAgentController
  LLM_ROUND_MAX_TOKENS`); the timeout stays the seam's `REQUEST_TIMEOUT_MS`
  (env `LLM_TIMEOUT_MS`) — no second knob. If a reasoning model's response
  regularly outruns the default 30s, raise `LLM_TIMEOUT_MS` rather than adding
  a per-call knob.

- A new controller in the networking tier keeps the LLM seam intact (B-2) and
  follows the precedent set by `LLMAgentController` / the Agent View inspector
  (feature C, spec §4.4).
- New component recipes are the intended way to make a body FAITHFUL to its card
  (v1.2.0 prompt): when the character has a distinctive feature (signature
  weapon, role gear, unique anatomy) not already covered by the generic AVAILABLE
  COMPONENTS, the model is instructed to invent a NEW component recipe for it so
  the body reads as THIS character rather than a generic M1 droid. The material
  and organ vocabulary stays fixed for determinism (A-7) — only the composition and
  the new recipes are the creative part.
- Capturing the prompt in `meta` (returned, not just logged) makes the
  `agent-body-design` prompt auditable from the dev tab — the prompt is the
  product of this feature; seeing it is how the owner tunes it.
- The design is returned frozen and normalized (slots default to null, missing
  children to `[]`) so the client and future writers both see one canonical
  shape (T-1/T-2).

## Consequences

- A third LLM prompt kind exists; `AGENT_BODY_*`-style behavior is owned by
  `AgentBodyController` — prompt changes are version bumps to
  `PROMPT_VERSION` in that file, not edits to the prompt text in other places.
- `data/cards/` becomes a visible input for a non-deterministic feature: every
  design call is a real provider cost, so the client requires an explicit
  click and the route is rate-limited (SEC-9).
- The `cardId` route param is resolved against the on-disk card list (exact
  match), so path traversal through `cardId` cannot reach the file system (the
  seam builds the path from a known-stem list, SEC-7).

## Rejected alternatives

- **Write the design into `data/entities/blueprints.json` directly** — initially
  rejected as out of scope (display-only first), then implemented as a separate,
  operator-confirmed change (the Save action above) with a timestamped pre-write
  backup and an overwrite rule; the entity-spawn part remains deferred.
- **Restrict the model to existing components only (no new recipes)** — rejected:
  a "generic" system that cannot invent novel body parts is not a judgment,
  and the fixed vocabulary + recipe validation already keeps the world's
  determinism (A-7).
- **Text-only output (natural-language body description, no JSON)** — rejected:
  the body IS a blueprint; free text is not reusable, not inspectable, and not
  the data shape the world stores.
- **A second timeout constant for this call** — rejected: the seam's
  `REQUEST_TIMEOUT_MS` (env `LLM_TIMEOUT_MS`) already serves every LLM call and
  is operator-controlled; a second knob would be a second knob the operator
  would have to remember (A-7: avoid hidden magic numbers).

## Next change (when the owner asks for it)

The save flow (validate + write blueprints + component recipes, with pre-write
backups and the confirmed overwrite rule) is implemented, and the spawn path
(`CardSpawnLogic`) now uses the card's own saved body when one exists (see the
spawn bullet above) so a saved blueprint becomes the living NPC's body. What
remains is **undo semantics** — restoring a previously-overwritten body (or the
previous registry state) if the operator changes their mind — which is a
separate commit with its own decision note.

## Amendment — the design authors what hangs behind its cloth (prompt v1.3.0)

**What bit.** The world already answers "is this part under someone else's
cloth?": a blueprint mount may carry a third element
(`["maleBreast", "left", { "hidesWithParent": true }]`), `EntityController` reads it
onto the instance and `PerceptionController._coveredIds` drops the part from the
dossier sentence (`wiki/decisions/visual-stats.md`, amendment). The designer did not
speak it. Worse than not speaking it: `_flattenTree` wrote every mount as
`[type, slot]`, so **saving a design that redefined a sub-tree silently deleted the
marks the shipped data had authored on those joints** — Adam's chest kept the
t-shirt and lost the fact that the breasts hang behind it. Nothing reported it, which
is the shape of bug this repository exists to make expensive.

**The decision.** The mark is authored on the mount, in the design, by the model, and
the operator has the last word before anything is written:

- The prompt (**v1.3.0**) documents `"hidesWithParent": true` on a node: the part hangs
  behind whatever covers the part it hangs on, so a garment over the parent takes it out
  of the prose. The instruction says joint-not-type (the same part may hide in one body
  and not in another), says sparingly, says never on the root, and says omit rather than
  write `false` — the world's convention is the mark or silence
  (`createEntityFromBlueprint`), and a written `false` would be a second claim about a
  fact the data answers by saying nothing.
- Validation takes a boolean or rejects (`T-1`); normalization carries `true` and drops
  everything else, so the frozen design the client and the writer both read has one
  shape.
- `_mountEntry` writes the third element. A **marked mount with no slot** says
  `[type, "default", { … }]`: the options object is index 2 of a mount, and
  `"default"` is the identifier `expandBlueprint` itself gives a slotless mount — so the
  mark never invents a body position, and the identifier the prose prints is unchanged.
- The panel puts a tick box on every non-root row and **Save posts the working copy of
  the design**, not the raw model answer. The model proposes a joint; the operator decides
  it. The "Raw response" section still shows what the model said, unchanged.

**What this does NOT do.** No inference. A component named `breast`, a slot named
`chest`, a garment that could plausibly reach — none of it marks anything (`H-4`, and the
rejected "garment enumerates the body" in `visual-stats.md`). And no new prose rule: the
coverage reader, the row's `covered: true` and the dossier sentence are the shipped ones;
this change only lets a designed body reach them.

**Verified.** `npm run check`; and in `test/unit/AgentBodyController.test.js`, the design
keeps the mark, a non-boolean is rejected, the prompt says what the mark means, and — the
half that matters across the seam — the blueprint the Save wrote is instantiated by the
real `EntityController` and the instances come back carrying `hidesWithParent`. The shape
the design writes is the shape the world reads, pinned rather than assumed.

## Amendment — the design dresses the body (prompt v1.4.0)

**What was missing.** A designed body could be built from any parts at all and still
be born wearing the world's default shirt, on whatever part had free volume. The
owner asked for clothing to be settable for the components a design creates. The wear
system already existed (`WearLogic`, pure volume fit); what did not exist was a
per-body claim about clothing — so this change added one (`wiki/decisions/outfits.md`)
and taught the designer to write it.

**The decision.** Two new output fields, both optional, both validated against the
world rather than trusted:

- **`garments`** — new wearable ITEM recipes (`name`, optional `displayName`,
  `form.volume`, `materials`, `wear.minVolume`, optional `visual` from the closed
  `materialLook` vocabulary). A garment is a thing the character carries and wears:
  never a node of `structure`. It is validated against the MATERIALS vocabulary, the
  existing item and component keys (no collision), and the rule that a garment asks no
  more of a body than it takes itself (`minVolume <= volume`). `displayName` is what
  the prose will speak ("Ash-Cloaked Courier Mantle"); the key is the identifier.
- **`outfit`** — `{ item, component }` pairs: the item must be a garment proposed in
  the same design or one of the WEARABLE ITEMS listed in the prompt (the item registry,
  filtered to those declaring `wear.minVolume`); the component must appear in this
  body's tree. Bounds: 8 garments, 8 entries (nothing in this feature is unbounded).
- **The Save writes the garment recipes and the outfit row under the same blueprint key**
  as the body. Designing a body and dressing it are two writes keyed by one thing. (Where
  those bytes live changed afterwards: the Save no longer writes the official packages —
  see the last amendment of this note.)
- **Saying nothing is not the same as saying "nothing".** The normalized design carries
  `outfit` ONLY when the model authored the array. An authored `[]` is written as `[]`,
  which the world reads as "born wearing nothing, and the spawn loadout's default shirt
  stands down"; an absent field writes nothing, so the default stays. Absent-not-empty
  is the convention everywhere else in this repository (a mount mark, a `covered` row),
  and it is what lets the design object round-trip through Save without a lie: the
  client posts back exactly what it received, and the distinction survives the trip
  because it is carried in presence, not in a boolean.
- The panel shows the garments and the outfit **read-only**. A mount tick box is a fact
  about a joint the operator can see; a garment recipe is the model's judgment, and
  hand-editing world data through a dev tab is editing the world.

**What this does NOT do.** No live dressing (that is `/inventory/:id/wear/:itemId`), no
per-instance clothing, no layers, no inference from names — and the material/organ/item
vocabulary stays closed, so the world remains deterministic (`A-7`).

**Verified.** `npm run check`; unit: the design keeps garments and an authored outfit,
treats an absent `outfit` as no claim, rejects a garment that cannot be worn / asks more
than its own volume / collides with `tshirt` / names an unknown material, and rejects an
outfit naming a part the body does not have or a knife as clothing; the Save writes the
item recipe and the outfit row (and leaves both files byte-identical when the design
said nothing). Contract (`test/contract/outfitDesignProse.contract.test.js`): a world
built from the shipped registries plus one designed garment and outfit speaks
"Male Central Body wearing <the garment> (<its look>)", does NOT say the default shirt,
and goes silent about the male breasts the shipped mounts mark as hanging behind that
parent.


## Amendment - the Save writes a mod package, not the official data

Date: 2026-11-07 (recorded in the commit that implements this)

### Context

Until now `saveDesign` merged its way into the shipped world: new part recipes into
`core-components`, the body tree into `core-blueprints` (overwriting the sub-tree of every
part it touched), garments into `core-inventory-items`, the outfit into `core-outfits`.
That made a card designed in a dev tab an edit of the official content, which has three
costs the mod system was built to avoid: undoing one body means restoring a data file by
hand from a `.bak-*` sibling, the change is invisible in the Mods view (which speaks about
packages, not about edits inside one), and a designed body cannot be carried between installs
as the unit it is. The repository already had the right tool: `ModPackageWriter`, the module
`/system/write` uses for a `system-<slug>` package.

### Decision

- **One package per card, named after the card.** `data/mods/body-<slug>/`, the slug folded
  out of the card display name (diacritics folded, anything that is not a letter or a digit
  becomes one dash, tail cut at the length `MOD_ID_PATTERN` allows) and prefixed `body-`.
  The prefix is the feature's mark on the stack, the same way `system-` marks the authoring
  tab's output; `core-` is refused by the writer and cannot be reached from here.
  Re-saving a card rewrites the same package, steps the manifest patch version, and the
  writer backs up every file the rewrite replaces. A display name with no ASCII letters or
  digits is a refusal (`BODY_DESIGN_INVALID`), not an invented fallback id: silently sharing
  a package with another card is worse than a save that says what it could not name.
- **The package carries only what this design authored**, one file per kind: `blueprints`
  (the droid-type pointer plus one key per part of this body that has children), `components`
  and `inventoryItems` (only the recipes the design invented - restating a shipped recipe
  would shadow official content with a copy of it, and a copy is the one definition nobody
  maintains), `outfits` (present only when the design spoke about clothing; an authored `[]`
  still means born wearing nothing). A kind with nothing in it is omitted, because the writer
  refuses an empty one and "said nothing" must not become "authored nothing".
- **Nothing is ordered and nothing is applied.** `loadorder.json` is untouched, the world
  moves only at `POST /mods/apply`. The answer carries `applied: false`, `appliesVia` and a
  fresh mods `scanned` count, the same shape `/system/write` settled on. The honest
  consequence: a package that redefines a key the official set still publishes composes
  BELOW it at the default load order and loses, so the save reports those keys as
  `overlapsOfficial` and the panel says to move the package above them in the Mods stack.
  A silent loss dressed up as a successful save is the failure this report exists to prevent.
- **Minako's designed body moved out of the official set** in the commit after this one:
  the 7 blueprint keys, 4 component recipes, 3 garments and 1 outfit row the Save had
  written into `core-*` are gone from there and live in `data/mods/body-minako/`. The set
  deleted is exactly the set a save of that design writes, which is what keeps the load
  order question moot for her: after the move nothing in `core-*` defines those keys, so the
  package is their only provider wherever it composes. Verified by merging the official set
  plus the new package and diffing it against `HEAD`'s `core-*`, key for key, in all four
  kinds.

### Consequences

- The `core-*` set is authored content again. A designed body is an overlay, and `POST
  /mods/:id/disable` is the undo - no `.bak-*` spelunking, no reload of a data file.
- A body's package is **local**: `data/mods/*` is gitignored except `core-*/`, so a designed
  body does not ship with the repository and CI never sees it. `test/unit/entityController.mountOptions.test.js`
  therefore pins only the official marks (the male breasts) now; the mark SHAPE is pinned
  where it is written, in `test/unit/AgentBodyController.test.js`, which instantiates the
  written blueprint with the real `EntityController`.
- A card whose display name needs no change still rewrites the same package forever; two
  cards whose names fold to the same slug share one package (and already collide, because
  `spawnCards` matches a body to a card by that same display name).
- The designer's vocabulary is still the shipped one (`DataLoader.loadRegistry`): a design
  does not see a previously saved body package unless the world has applied it.

### Rejected

- **Registering the package above the official stack in `loadorder.json`.** It would make
  every save quietly win against shipped content, and `ModService` - not the writer, not the
  designer - is the owner of the stack. The report names the overlap instead.
- **Keeping the official merge and adding a package on top.** Two sources for one body, and
  the first one wins silently.
- **A new package per save (`body-minako-2`).** Every version would sit in the stack
  shadowing the same keys, and only one of them can win.
- **Deleting the `minako*` component recipes too** (the flesh anatomy shipped before the
  designer existed). They are not shadowed by anything the package writes, and
  `test/contract/fleshAnatomy.contract.test.js` pins them as the humanoid flesh vocabulary.

### Verified

`npm run check` green. Unit: the save writes one package under `data/mods/body-<slug>/` and
asks the seam for no `data/mods/core-*` path at all; the blueprint file holds this body and
not the world; an absent garment/outfit kind is absent, not empty; an authored empty outfit
is written; a rewrite reuses the id, steps to `1.0.1`, backs up both files and writes
`mod.json` last; the folding of accented and punctuated names and the refusal of a name with
nothing ASCII in it; `overlapsOfficial` names the official keys the package shadows and only
those; a design refused by validation writes nothing. Route: `applied: false` + `appliesVia`
+ a rescanned mods count, and a `MOD_PACKAGE_*` refusal answers 422 with its own code. Panel:
the status line names the package and points at the Mods panel, and says so when something
is shadowed.
