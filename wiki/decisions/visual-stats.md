# Decision: visual stats - appearance as data, spoken by the prose

**Status:** accepted (2026-11-05). Decisions 1-5 below were made by the operator; the
shape of the implementation is this note's own.

## Context

The world had no appearance. It had:

- **physics properties** (`data/mods/core-materials/materials.json`: flammability,
  electricalConduction, moistureRetention, cutResistance, impactResistance,
  wearResistance, heatConduction, density), blended by `Sigma(fraction x value)` and
  mapped to stats by `data/mods/core-property-trait-mapping/propertyTraitMapping.json`;
- **art direction for rooms** (`data/mods/core-rooms/rooms.json`: `atmosphere`
  temperature / lightLevel / lightColor / humidity / fog / smell / ambientSound, plus
  surface, ceiling, condition), rendered into sentences by `RoundProseBuilder`;
- **a body topology** (the blueprint tree with named attach points - `top`, `core`,
  `frontal_left`, `nose`, `f1..f5` - and per-recipe `form.volume` + `form.position`);
- **a character image the engine throws away**: `src/utils/PngCharaReader.js` reads the
  `chara_card_v2` JSON out of a card PNG and ignores the pixels ("the pixel data is
  irrelevant to simulation").

The operator's goal is the inversion of the last point: the simulation should hold
appearance as *data*, and a downstream image/video generator should produce the picture
from it. Two things about this codebase made that a design conversation rather than a
schema one:

1. Every material property passes through `Sigma(fraction x value)`. Numbers survive
   that; words and colours do not. `0.6 x "#4a4e57" + 0.4 x "#8b5a2b"` in sRGB is a
   muddy grey that describes no knife.
2. A stat nobody consumes is exactly the dead data the material system was built to
   kill (`wiki/basic_traits_and_stats_spec.md`: "Adding iron to a wooden part changes
   nothing, so material composition feels decorative").

## Decision

**1. Appearance lives in `materials.json`, in a `visual` block, as numbers only.**
A closed vocabulary, declared once in `VISUAL_KEYS` (`src/utils/materialLook.js`):
`hue`, `saturation`, `lightness`, `metalness`, `roughness`, `grain`, `translucency`.
`MaterialController._validateMaterialVisuals` narrows it at the edge (finite, in range,
no unknown key - a typo that silently names nothing fails boot, like every other
reference the material owner checks). Absence is legal and means "no look": callers drop
the clause rather than invent one.

The block is a sibling of `properties`, never inside it. `derive()` reads `properties`
only, so **appearance cannot move combat even by accident** - pinned by a test that
derives byte-identical stats with and without the visual blocks.

**2. Geometry is untouched.** No silhouette, no proportions, no depth. A renderer reads
the topology the world already publishes (blueprint tree + named attach points +
`form.volume`). Proportions were rejected as scope, not as a mistake: they are a
different change with a different surface (`components.json` form blocks) and nothing
consumes them yet.

**3. Identity is authored per blueprint, and the recipe tree IS that authorship.**
The humanoid families own their recipes (`maleHair`, `minakohair`, `maleEye`,
`minakochoker`), so per-blueprint appearance is expressed the way the world already
expresses everything else: which material that blueprint's part is made of. Minako's
hair is black because `minakohair` is `coal`; a blonde Minako is a different material on
that one recipe. No new mechanism was added for this, deliberately - a second way to say
"this part is this colour" would be a second source of truth drifting from the first.

**4. The prose is the first consumer, and it stays a pure reader.**
`RoundProseBuilder` is handed an optional `lookOf` lookup (component type -> words) by
`RoundProseController._lookResolver()`, which builds it once per request from
`MaterialController.describeCompositionLook` + the component composition map (one map
build per read, not per row - `PERF-4`). Without the resolver every paragraph is
byte-identical to the paragraph this server produced before appearance existed, so the
byte-pinned prose pins were not moved.

**5. The English word is DERIVED from the numbers, never authored beside them.**
A `lookWord` written next to `hue` would be prose's source of truth and the renderer
would read the numbers - two claims about the same matter, and one of them goes stale
the first time somebody tunes a value (`DOC-1`). `describeVisual()` is the only place a
material becomes a word, and the thresholds it reads are named constants, because moving
one changes which word a material gets.

The naming law it implements: at or below lightness 14, near-black; at or above 90,
near-white; at or below saturation 12, grey; light red is **pink**; dark orange is
**brown**; mid orange (lightness 53-66) is **tan** and takes no modifier; saturation
70+ is vivid; lightness 34- is dark, 62+ is pale. Metal (share
60+) is named by its finish - polished / brushed / dull metal - non-metal by smooth /
satin / rough / coarse. Grain 70+ is "grained", 35+ "with a faint grain". Translucency
50+ is "translucent", 20+ "slightly translucent". Shipped output: wood "brown, rough,
grained", iron "grey, brushed metal", coal "near-black, coarse, with a faint grain",
flesh "tan, satin".

A **composition is named by its dominant material** (`MaterialController.getPrimaryMaterial`,
the same rule and tie-break that decides which material a damage chip is made of). A
60%-iron knife is "brushed metal". Averaging the numbers first answers "blue" for a
knife, which is how this decision avoided the muddy-average failure at the naming layer
as well as the colour layer.

**Amendment - `tan` joins the law, and flesh is not translucent.** The first shipped
flesh numbers (hue 12, saturation 34, lightness 68, translucency 58) were an eyeballed
pick, and the paragraph they produced said "Male Arm (pale pink, satin, translucent)"
about every part of a human. Two things were wrong, and both only showed once a real
round was read aloud:

- **Light does not pass through a shoulder.** `translucency` was meant for ears and
  fingertips (the band's own comment says so), but the field lives on the MATERIAL, so
  the entire body claimed it, ten times a sentence. It is 0 now: flesh says nothing
  about translucency, and the word stays in the vocabulary for matter light actually
  passes through.
- **The vocabulary had no word for skin.** Measured against real skin samples, every
  tone from very fair to tan sits at hue 15-45 with a lightness in the tan band, and the
  law said "pale orange" for all of them:

  | skin reference | hue / sat / lightness | word the law produced |
  |---|---|---|
  | `#FFDBAC` very fair | 34 / 100 / 84 | pale orange |
  | `#F2C6A0` untanned light | 28 / 76 / 79 | pale orange |
  | `#F1C27D` light Latino | 36 / 81 / 72 | pale orange |
  | `#E0AC69` tan | 34 / 66 / 65 | pale orange |
  | `#C68642` medium brown | 31 / 54 / 52 | brown |
  | `#8D5524` deep brown | 28 / 59 / 35 | brown |

  `tan` therefore joins pink and brown as the third word English builds and the wheel
  does not: orange hue at lightness 53-66 is a **tan**, taking no modifier ("pale tan"
  is not a colour and "vivid tan" is a contradiction). Above 66 the orange is fair and
  says "pale orange"; at or below 52 it is brown, exactly as before. The band's edges
  are pinned in `test/contract/materialLook.contract.test.js`, because a nudge there
  renames every human in the world.
- **Flesh is hue 24, saturation 42, lightness 58**, which is the weighted mean of the
  American population (the ~57 / 19 / 13 / 6 / 3 split of non-Hispanic white, Hispanic,
  Black, Asian, multiracial) - a tan. The operator chose that reading of "average
  American"; the alternatives on the table were the majority group (fair, which said
  "pale orange") and a medium brown. It is a world authoring choice, not a measurement
  the world made, and it says "tan, satin".

## Consequences

- Prose gains one clause per acting part ("powered by Male Arm (tan, satin)"). Cost is
  bounded and per event, not per token: `RP-3` still governs the round's total budget.
- The knowledge codex and the browser's material panel do **not** show the look yet:
  `KnowledgeController._buildMaterials` publishes `{type, name, density, properties}`, so
  a `visual` block is invisible there. Deliberate (the prose is the consumer this change
  has); publishing it is a one-line change when a consumer asks for it.
- `hue/saturation/lightness` here is a **naming space, not sRGB and not OKLab**. A real
  renderer converts, blends in linear light, and never averages encoded channels. The
  conversion is deliberately not in this repository yet, because nothing renders.
- `MaterialController` grew by the look API (it is the owner of matter knowledge, and the
  look of matter is the same owner's subject). It is now past 700 lines; the honest next
  split is matter-vs-appearance, and it should wait for a second consumer.

## Rejected, and why

- **Per-instance identity seeded from the entity id** (a hash of `entity_...` perturbing
  the palette). Deterministic and free, and rejected on purpose: nobody chose the
  result, so a named character can come out wrong with no way to fix it short of an
  override mechanism. The operator chose authorship.
- **An authored `lookWord` / `textureWord`.** Cheaper prose, two sources of truth.
- **A new registry kind (`appearance`) as a mod package.** Cheap in code (two lines:
  `shared/RegistryKinds.js` + the `DataLoader` path table) and it would have made looks
  a disable-able, overridable package. Rejected in favour of keeping appearance next to
  the matter it describes, so a material and its look cannot be separated by a toggle.
- **A blended colour word for a composition.** See decision 5's dominant-material rule.
- **`temperature` as a material property.** Rooms already carry temperature and the prose
  already says "a temperature of 18.5"; a static temperature in a material would
  duplicate that and lie (iron at 18 degrees is not cold, it is conductive - and the
  material already says so, via `heatConduction`).
- **New fields nobody has a value for yet** (`emissive`, `ior`, `sheen`, `perceivedWarmth`,
  `friction`, `magnetism`). `CHG-6`: not added, because a vocabulary entry with no value
  in the world is speculative. They arrive with the rule that consumes them.

## Open questions (named next changes)

- **Renderer contract**: `GET /render/recipe/...` answering scene + component tree + look
  numbers, so the browser, a shader and an image model read the same resolved values.
- **The aged look**: `patinaRate` / wear tint tied to `Physical.existence` (already 0..1
  per instance), so a damaged part visibly changes colour and prose can say so.
- **A per-recipe look override** (a `tint` on a composition entry), only if two blueprints
  ever need the same material at different tones - the moment "change the material" stops
  being the right authoring gesture.
- **Skin tone per entity.** Every human in the world is one tan, because tone lives on the
  `flesh` material and nothing in the world distinguishes two bodies. The day two named
  characters must look different is a real decision (a trait? a component? a tone rolled
  at spawn and stored on the entity?), and the dossier is where the difference would have
  to be spoken - which means it needs the per-instance look this note defers.
- **State of matter** (solid / liquid / paste) for `chunk_...` ground items, which today
  are self-describing records with no material block of their own.

## Amendment - an item authors its own look, and clothing hides the part it covers

The dossier read a dressed human exactly as a naked one. Adam spawns wearing the shipped
t-shirt (`world.json` `initialSpawns`, `wear: true`, on `maleCentralBody`), and the
paragraph said `Male Central Body (tan, satin)` about a torso the world says is covered.
The operator asked for clothing to be rendered: a part with something on it does not
reveal its details, the clothing does; and clothing should carry appearance the way matter
does.

**Four decisions, all the operator's.**

1. **The data is a `visual` block on the item recipe** (`data/mods/core-inventory-items/
   inventoryItems.json`), the same closed vocabulary as a material's. Rejected: a
   `wear.visual` sub-block (it would make a knife undescribable for a reason the reader
   cannot see, and `wear` stops meaning only "fit"), and a new `appearance` registry kind
   - the same rejection this note already recorded for materials, because a look kept
   apart from the thing it describes is a second source waiting to drift.
2. **A covered part reads as its clothing**: `Male Central Body wearing a T-Shirt
   (red, rough)`, and its own matter words are dropped. Rejected: the look swapped in
   place with the garment unnamed (`Male Central Body (red, rough)` reads as the flesh
   being red), and a separate "Adam is wearing ..." sentence, which separates a garment
   from the part it covers and adds a sentence per actor.
3. **Coverage is exactly the component the item is equipped on** - the wear system's own
   answer (`WearLogic`), nothing inferred from the garment's kind. Rejected: subtree
   coverage (the shipped t-shirt is mounted on the ROOT component, so a t-shirt would
   cover the head, the arms and the legs), and an authored `wear.covers` type list, which
   was on the table and remains the honest next change if a garment must hide more than
   one component (`CHG-6`: not added while nobody has declared a need). The visible
   consequence in the shipped world: the t-shirt hides one of the ten parts the dossier
   names, and the rest of the body stays `tan, satin`.
4. **Scope is the round prose**: the dossier in both the room paragraph and the entity
   paragraph, plus the equip/unequip clauses (`Adam unequipped a T-Shirt (red, rough)`).
   NOT the agent's own `YOUR BODY` context - that moves prompt bytes (`RP-3`) and was not
   asked for.

**The shape that fell out of it.**

- The narrowing moved to `narrowVisualBlock` (`src/utils/materialLook.js`): ONE rule for
  every authored `visual` block, called by `MaterialController` (materials, boot), the
  `WorldComposition` startup pass (items, boot) and `CompositionClassifier` (items,
  per-definition quarantine). The vocabulary and the rule that accepts it are the same
  claim; two copies drift the first time a key is added.
- **The FACT that a part is clothed is recorded on the action row's `body`**
  (`worn: [{ type, name }]`, absent when nothing covers it), by
  `PerceptionController._bodyRecord` reading `WorldStateController.getWornItems`. Worn
  state is the one part of a body that changes mid-round, so it belongs to the flush like
  the parts themselves - and it can only be recorded there: coverage is exact to a
  component id, while a body row carries part TYPES, so no reader could resolve it later.
- **The WORDS stay a lookup** (`garmentLookOf`, built once per read from the item registry
  through `describeVisual`), for decision 5's reason: one place where a number becomes a
  word. With no resolver the garment is still named - the row says the part is clothed -
  and says nothing about its appearance. A reader with no data access cannot be told a
  dressed torso is bare skin.
- The lookup is keyed by **item type**, so any item with a `visual` block says how it
  looks; the prose does not classify garments from tools.

**Shipped:** t-shirt `visual` hue 0, saturation 66, lightness 46, metalness 0, roughness
62, saying `red, rough` - while the wood it is modelled from says `brown, rough, grained`.
Independent on purpose: that is the whole argument for the item authoring its own look.

**The boundary that stays.** The `powered by` clause still names the MATTER of the part
that acted, even a clothed one: a used-part row carries no `worn` field, and what threw
the punch was the arm, whatever is on it. Extending it means dressing the `used` rows too,
which is a change nobody has asked for yet.

## Amendment - a mount declares that its child hides with its parent

Decision 3 left the shipped world half-dressed. The t-shirt is fitted to `maleCentralBody`
(`WearLogic`), so the central body read `Male Central Body wearing a T-Shirt (red, rough)` -
and the two parts hung ON that central body, `Male Breast (left, ...)` and
`Male Breast (right, ...)`, were still revealed in the same sentence, next to the cloth that
covers them. The operator asked for the cloth over a part to hide the parts hung under it:
the chest is covered, and therefore the breasts behind it are not in the sentence.

**This reverses one rejection.** Decision 3 rejected *subtree coverage*. It is reversed;
what decision 3 rejected was a different mechanism from the one that landed, and the
difference is the whole reason it is safe here.

1. **The mark is the blueprint's, and it lives on the MOUNT**: a third element of the
   array entry - `["maleBreast", "left", { "hidesWithParent": true }]`. Per mount, not per
   component type, because *what hangs under whose cloth* is a fact about this joint: the
   same component type may hide in one body and not in another. Rejected: a per-type flag
   (`components.json`), which would hide a `maleBreast` under every parent it is ever
   mounted to, and an inference from the part's name or slot, which is the disallowed move
   (`H-4`).
2. **The instance carries it, not the reader.** `EntityController.expandBlueprint` carries
   the mount's options through the flatten (and through the parent-slot rename, which
   would otherwise quietly un-mark a child mounted under a renamed parent), and
   `createEntityFromBlueprint` writes `hidesWithParent: true` onto the component instance -
   absent, not false, when the mount authored nothing. A reader of a live body never
   re-opens a blueprint to learn what a part is under.
3. **Propagation walks UP from the child, and is opt-in per joint.**
   `PerceptionController._coveredIds`: a marked part is covered when the part it hangs on
   wears cloth, or when that part is itself under cloth higher up, so the mark chains to any
   depth. It is cycle-safe (broken `dependsOn` data stops the walk rather than inventing
   coverage) and yields an empty set when nothing is worn - an undressed body's rows stay
   byte-identical to the rows this file wrote before coverage existed.
4. **The row carries the FACT (`covered: true`), the prose only reads it.** `isCovered`
   (`RoundProseBuilder`) drops a covered part out of the dossier sentence; it never renames
   a part into a garment. A part wearing something of its own is never in the covered set -
   the garment is the visible thing there, and decision 2's `X wearing Y (...)` wording wins
   for it. The two facts are read in that order by one function, which is the only reader.

**Why this is not the subtree coverage that was rejected.** What was rejected walked DOWN
from the *garment*, and the shipped t-shirt is the reason: fitted to one component, so a
walk from it either covered one component (too little) or was widened by the garment's kind
(arbitrary). The rejection was right about that shape. What landed asks the garment nothing
at all: each child declares whether it hides behind its own parent, and the walk goes UP
from the child to the cloth. A garment covering a parent therefore hides exactly the parts
that declared themselves behind it - no head, no arms, no legs, because those mounts say
nothing and stay `tan, satin`.

**The other rejected shape stays rejected.** An authored `wear.covers` type list on the item
was the honest next change under decision 3; it is still worse than what landed. It makes
every garment enumerate the parts it hides, so each new component type has to be added to
every garment that would cover it, and a garment author has to know the whole body. The
mount mark is authored once per joint, and any cloth that reaches the parent hides the child
- which is also the reason the mark belongs to the blueprint and not to the item registry.

**Shipped, in a driven round** (spawn -> punch -> perception flush -> prose, pinned by
`test/contract/proseClothingLook.contract.test.js`, words derived from data):

```
Adam, with Male Central Body wearing a T-Shirt (red, rough), Male Head (top, tan, satin),
Male Torso (core, tan, satin), Male Arm (left, tan, satin), Male Arm (right, tan, satin),
Male Genitals (lower, tan, satin), Male Leg (frontal left, tan, satin), and Male Leg
(frontal right, tan, satin). ... Adam threw a punch against Ball, powered by Male Arm
(tan, satin) and a Knife appeared.
```

Both `Male Breast` rows are gone; take the shirt off and they are readable again
(`Male Breast (left, tan, satin)`). The shipped mark is those two mounts and nothing else -
`data/mods/core-blueprints/blueprints.json`.

**What got better.**

- Coverage costs one data line per joint. No prose, wear or registry change teaches a new
  part to hide, and the knowledge sits where the shape of a body already lives.
- The whole chain is authored data on the mount, so a mod can ship a body whose joints hide
  differently without touching a line of server code.
- `AgentBodyController._blueprintExampleLine` had to learn the three-element mount. Before
  this change it rendered a mount that authored options as `[object Object]` in the body the
  model is asked to design - a latent break the new data shape would have hit.

**What got worse.**

- A body row now carries TWO coverage facts, `worn` and `covered`, where decision 3 had one.
  A reader that only reads `worn` sees a bare breast under a shirt. The mitigation is that
  `isCovered` is the single reader and both fields are documented on `_bodyRecord`; the cost
  is real for any future reader that hand-rolls the check.
- A blueprint author can now hide a part from every prose reader, with no error and no log.
  The mark is visible in the blueprint and nothing validates it - the same standing risk as
  every other authored shape in the world, now with a visible consequence.
- `expandBlueprint`'s flat row grew an optional fourth slot (index 3). Rows that authored
  nothing stay the `[type, slot, parentIndex]` triple they always were, so every existing
  blueprint expands identically; but a consumer that assumed a fixed length-3 row is now
  reading a longer array, and `MOUNT_OPTIONS` is the only name for that index.

**The boundary that stays.** Only the marked joints hide. `maleGenitalia` hangs on the same
covered central body and is NOT marked - whether the cloth over a groin hides what is under
it is the same question, still unanswered, and it is world data for whoever answers it, not
a rule here. The `powered by` clause still names the MATTER of the part that acted (a
used-part row carries no `covered` field), and the agent's own `YOUR BODY` context is still
untouched (`RP-3`).
