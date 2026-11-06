# Decision: action prose - the registry words the act, the row records the body

## Context

Round prose already said who acted, against whom, and which parts powered it:
`Adam threw a punch against Ball, powered by Male Arm (pale pink, satin,
translucent)` (`RoundProseBuilder.entryClauses`, appearance from
`wiki/decisions/visual-stats.md`). Two things about that sentence were wrong for
what the prose is for now - an observer, and eventually an image/video pipeline,
reading a world it did not build.

1. **The verbs were hardcoded.** `actionVerb()` was a `switch` inside
   `RoundProseBuilder`, covering 11 of the 14 shipped actions; `touch`, `grab` and
   `crossDoor` fell through to `did <action>`. A new action therefore arrived in
   the world mute, and nothing failed when it did.
2. **The actor was invisible.** The sentence named the parts that took part and
   nothing else. To draw an entity one needs what it is made of - and the world
   has that (`entity.components`, each with a blueprint `identifier` and a
   `dependsOn` mount), but no prose ever said it.

The shape asked for is: *an entity, with component A (its details), component B
(its details), ...; that entity used component A to perform action X.*

Two facts about the machinery decided most of this note, and both were measured
rather than assumed:

- **An action is observable only after its round has closed.**
  `TurnSystemController._closePlanning` stamps the round's `endTick`, resolves the
  round (attribution records written), and only then calls the round-resolved hook
  that flushes perception. So there is no live round carrying an action row, and
  any "describe the actor from the live world while the round is open" plan
  describes nothing at all.
- **A human is 78 components, not 10.** The male blueprint nests: eight teeth,
  twenty nails, ten fingers, ten toes, nipples, glans. Read out with their looks,
  the dossier clause measured 686 words / ~910 tokens per actor per round, and the
  room paragraph stopped being prose (~740 words, of which 686 was the body list).

## Decision

### 1. The action registry is the only source of action wording

`actionVerb()` is deleted. `data/mods/core-actions/actions.json` gains a `prose`
block per action:

```json
"touch": {
  "description": "Touch a specific body part of another droid ...",
  "prose": { "verbPhrase": "touched", "targetLink": "direct" },
  ...
}
```

- `verbPhrase` - past tense, third-person-safe, composed as
  `<actor> <verbPhrase> [link] <target>`. All 14 shipped actions declare one; the
  11 that already had wording keep it verbatim, so no sentence changed meaning.
- `targetLink` - how the verb joins its target. Absent keeps the historical
  `" against <target>"`; `"direct"` hands the verb the target with no preposition
  (`Adam touched Ball`, not `Adam did touch against Ball`); any other string is
  that preposition; an empty or unknown value falls back to `"against"`, so a
  half-written data entry cannot delete the target from the sentence.
- `instrumental` - the same act's **base verb**, the one that follows "used <part>
  to ...": `{ "verb": "throw a punch" }`, and where the base verb governs a
  different preposition than the past-tense one, its own `targetLink`
  (`"cut something against X" versus `"used the Knife to cut X""). Absent means the
  act has no instrumental form - see §5. English does not derive it, so the act
  authors it.
- Without a resolver, or for an action whose data declares nothing, the clause
  degrades to `did <action>`. That is the honest fallback - the act happened, only
  its wording is missing - and never a verb this module invented.

`test/contract/actionProse.contract.test.js` pins that **every** action in the live
registry declares a non-blank ASCII `verbPhrase`, so a shipped action cannot be
mute and green.

### 2. The body is recorded on the act, at the round's flush

`PerceptionController._collectPerformedActions` writes `body` on every
`actions.performed` row: `[{ type, identifier, shallow }]`, in the entity's own
component order (`_actorBody`, `_bodyRecord`). The actor already gone falls back to
its room-snapshot row (types, no placement); an actor with no parts yields `null`.

- `identifier` is the part's **own** label, not the blueprint chain: a component's
  chain is its own label with its parent's appended (a nail is `tip_f1_hand_left`
  under a finger `f1_hand_left`), so the writer strips the parent's tail and the
  sentence does not say twice what the name says. `frontal_left` survives whole -
  it is a leg's own label, not a leg inside a left.
- `shallow` is structural: the part hangs off nothing, off a part no longer in the
  body, or off a root itself. **It is never computed from the identifier string**,
  because a string rule cannot tell `frontal_left` (a leg) from `left_top` (an
  eyebrow inside a head) - `dependsOn` is the only source that can.

### 3. Prose names the shallow parts, as its own sentence, once per actor

`RoundProseBuilder.dossierClause` renders `<Actor>, with <Part> (<own label>,
<look words>), ...` and keeps only the `shallow` parts: a human's 78 become the ten
that hang off the root (central body, head, torso, two breasts, two arms, genitals,
two legs) - ~130 tokens instead of ~910. The deep parts stay on the row: the record
is complete, only the reading is gross anatomy. A real round now says:

> Adam, with Male Central Body (pale pink, satin, translucent), Male Head (top,
> pale pink, satin, translucent), ..., Male Leg (frontal right, pale pink, satin,
> translucent). In The Entrance Hall (300 x 200, ...), Adam used Male Arm (pale
> pink, satin, translucent) to throw a punch against Ball, Adam touched Minako, and
> a Knife appeared.
>
> (The act clause in that paragraph is the instrumental form of §5; before it, the
> same round said "Adam threw a punch against Ball, powered by Male Arm (pale pink,
> satin, translucent)").

- **Its own sentence.** `assemble` weaves clauses into sentences, which put the
  body list in the middle of the act ("..., and Male Leg (frontal right, ...), Adam
  threw a punch"). `entryClauses` therefore hands dossiers to a `dossiers`
  out-parameter and the caller says each one as a sentence, before the act it
  belongs to. A dossier does not name the room, so the narrative sentence right
  after it still carries its "In <room>, ..." prefix.
- **Once per actor**, deduped by the actor's id (name, when a row has no id) in a
  `seen` set the caller owns - one body per paragraph, however many acts.
- **No placeholder.** A row with no `body`, an empty body, or a body with no
  shallow part says nothing. "Adam, with nothing" would be a claim about the world
  that nothing in the world supports.
- Parts are named individually with their own label rather than collapsed into
  counts ("two Male Arms"), because English plurals cannot be derived from a
  display name without inventing them (`Male Genitals` is already one, `Male Foot`
  is not `Foots`).

### 4. The builder still reads no world

`buildRoomProse` / `buildEntityProse` take `lookOf` (material look words) and
`verbOf` (action name -> registry `prose` block), both built once per request by
`RoundProseController` (`_lookResolver`, `_verbResolver` over
`facade.getActionRegistry()`). The body needs no third resolver: it arrives on the
row. Without either resolver the paragraph is exactly the one this server wrote
before they existed - which is what the existing byte-pinned prose tests still
check.

### 5. The instrument comes first: `used <part> to <verb> <target>`

The shape Context asked for - *that entity used component A to perform action X* - is
what prose now says, for the acts whose data declares the base verb:

> In The Entrance Hall (300 x 200, ...), Adam used Male Arm (pale pink, satin,
> translucent) to throw a punch against Ball, Adam used Male Mouth (tan, satin) to
> touch Minako, and a Knife appeared.

`entryClauses` writes that clause when three things are present: the act declared
`prose.instrumental.verb`, the row named a target, and the row named a part. **One
missing half falls back to the old clause** - `Adam threw a punch against Ball,`
`powered by Male Arm` becomes `Adam threw a punch, powered by Male Arm` when no target
was recorded, and `Adam threw a punch against Ball, powered by Male Arm` stays whole
when the act declares no base verb. A blank `verb` is no declaration: the old clause,
never a verbless sentence.

Locomotion is deliberately **not** in this form. A move does not act on anything, so
the part is not an instrument - it is what the entity moved with, and
`Minako moved from (2.71, 93.05) to (9.94, 74.40), powered by minakoleg` says that
plainly. The two clauses are built at different places in the builder and read
differently on purpose.

Why data and not a base-verb function: English. `threw a punch` is `throw a punch`,
`fired the T1` is `shoot`, `cut something` is `cut` and drops its `against` - no rule
lives in this module that could know that, and a guessed verb is the one thing §1
forbids. The registry already owns the verb, so it owns its second tense.

- Ten of the fourteen shipped acts declare a base verb - the acts that do something TO
  something. `move`, `dash`, `crossDoor` and `selfHeal` do not, and there is no
  instrument to name in front of them. `actionProse.contract.test.js` pins that set by
  name (an act cannot start claiming an instrument on its own) and the shape of every
  declaration: non-blank ASCII `verb`, string `targetLink` when present.
- A part the row cannot name contributes nothing. `touch` attributes the part
  touched, which belongs to the **victim**, so the writer records `type: null` for it
  (`PerceptionController` looks the id up in the actor's own components) - and
  `componentTypeName` prettifies *any* unknown key, so a part named by its instance id
  printed the id itself: `Adam used Comp-da4a543c-… to touch Minako`. `partList` now
  names a part by its **type** or not at all, which holds the "raw ids never surface"
  invariant this module already claims. The attribution question - should the touched
  part be credited as the instrument at all, or the part that touched - is a separate
  decision in `ConsequenceDispatcher`, untouched here.
- The bytes moved from the tail clause into the verb phrase, which is where a reader -
  or a pipeline looking for actor -> instrument -> patient - wants them. No new fact
  enters the sentence and none leaves.
- The agent's own context is untouched: `LlmContextController._inboundActionLine`
  still words an act as `<actor> used "<actionKey>" on you` (see Open questions). The
  observer and the actor agree about the *actor's* instrument in neither direction yet.

### 6. The target is named with the part the act was aimed at

`an entity used Male Mouth (tan, satin) to touch Minako` named the owner and dropped
the part the row already carried. Prose says whose part it was:

> ... an entity used Male Mouth (tan, satin) to touch Minako's minakotorso (tan, ...), ...

The whole point is that the row knew and the sentence did not: the attribution store
resolved the target component (`componentId`, `componentName`) at the flush, and
`targetPhrase` read only the entity name.

- The **look** of the target part is why the perception row grew a field. The writer
  resolves `componentName` as a display name (`"Male Mouth"` is no key anything can
  look up), while the look lookup speaks recipe keys - so `_resolvePerceivedTarget`
  now records `componentType` beside it. Nothing is stored: names are still resolved
  at flush time, the attribution store keeps ids only.
- The possessive is chosen by rule and rewrites nothing: `Minako` -> `Minako's`, a
  name that already ends in `s` -> `Boss'`. ASCII apostrophe, no typographic one.
- A part with no owner still reads on its own, and an owner whose "name" is really an
  id is dropped rather than printed - the same rule the rest of the module holds.
- What the part is **called** stays the recipe's business. Minako's own components
  carry `name: "minakotorso"` (the design wrote the key as the name), so the sentence
  says `minakotorso`, and her dossier says `minakobody`. Left as authored, by the
  operator's decision: prose reads whatever `name` the recipe gives, and renaming them
  is a data edit in `core-components`, not a prose rule.

## Consequences

- The shipped data now carries prose. An action whose `prose` block is missing
  says `did <action>` in the observer's paragraph, and the contract test fails at
  the completeness assertion, so the mute case cannot ship silently.
- An act whose `prose.instrumental` block is missing is narrated the way it always
  was. Adding the field is a data-only change to one action - which is how the next
  act that wants the instrumental form gets it.
- Perception rows grew by one field per action (`body`, 78 short objects for a
  human). This is the in-memory per-room ring (`PERCEPTION_MAX_LIMIT` entries),
  not the persisted world; the cost is bounded by the ring, not by history.
- Rows written before `body` existed render no dossier. Prose says less about an
  old row than about a new one, and never reconstructs a body it did not record.
- Round prose is not in any agent's LLM context (only the `/perception/*` routes
  read it), so the dossier costs an observer's bytes, not a model's budget.
- `RoundProseBuilder` is ~1,130 lines and now holds three renderers (room, entity,
  dossier) plus the wording resolution - a `CHG-3` split signal. The honest seam is
  "matter and appearance" (`materialLook`, `dossierClause`) out of "narration";
  deferred until the second consumer exists, same as the visual-stats note said.

## Rejected, and why

- **`actionVerb()` kept, validated against the registry at boot.** Cheapest diff,
  and it makes wording a code change for every new action - the opposite of a
  data-driven world. Rejected for "prose owns no verbs".
- **Reuse the registry `description`.** It is written for the actor:
  "Advance your droid toward a target point in the current room using your rolling
  wheels." Stripping second person is lossy and says a human has rolling wheels.
  `description` keeps its job in the actor's available-actions list; prose never
  reads it.
- **Read the body at render time** (`bodyOf(entityId)` threaded like `lookOf`).
  It is what this change first implemented, and it is unfalsifiable in the wrong
  direction: an action row only exists once its round closed, so the live entity is
  *not* the entity that acted (the round's own resolution may have torn the part
  off). Re-rendering round 3 after the actor lost an arm would describe today's
  body in that round's sentence.
- **Dossier only while the round is live.** Vacuous by the first measured fact: a
  live round never carries an action row. This is why the question came back to the
  operator instead of being resolved in code.
- **Collapse into counts ("two Male Arms")** - needs an English plural this module
  would have to invent (or a `plural` field on 79 component types). Deferred to the
  day a `plural` is data the world needs anyway.
- **List all 78 parts** - measured at ~910 tokens per actor per round, and the
  paragraph stops being prose. Kept as the row's contents, not the sentence.
- **Depth from the identifier string** (count the underscores) - `frontal_left` and
  `left_top` are indistinguishable that way and one of them is a leg.

## Open questions (named next changes)

- Nothing renders from the `body` yet. The next consumer decides what else the row
  needs - a generator wanting relative position would ask for the mount (the
  `identifier` chain is on the entity, deliberately not copied here), and one
  wanting colour per instance would ask for the component's own material rather
  than the type's.
- Only the room and entity prose views say the dossier; the LLM's own context still
  words an act as `<actor> used "<actionKey>" on you`
  (`LlmContextController._inboundActionLine`) and does not read `prose`. Making the
  agent's own text agree with the observer's is a separate decision with a token
  cost on every turn.
- `shallow` is prose policy written into a perception row. If a second consumer
  wants a different granularity, the field stays as the fact ("hangs off the root")
  and the choice moves to the reader.
