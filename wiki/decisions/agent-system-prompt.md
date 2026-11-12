# Decision: the agent system prompt gains a universal purpose, a "Your tools" section, and a version

Date: 2026-11-12

Status: accepted and implemented in this change.

## The problem this is about

The per-NPC system prompt (`LLMAgentController._buildSystemPrompt`, the spec §6.4
template) had three properties that limited how the NPC agents of this world behave:

1. **An NPC whose card/registry entry declares no objective had no purpose at
   all.** Its advance rule read "stop the round when nothing is worth doing" — and
   silence is legal (PROTOCOL B), so the only purpose an objective-less droid had was
   to stop. Most of the world's population is like that: every card without an
   `objective` field.
2. **The section titled "World rules:" was not about the world.** It mixed real
   rules (you are the only actor; the per-round budget) with per-tool usage
   instructions (use_instinct, craft, get_actions, toApproach, use_door,
   equip_item/unequip_item, move_item) in one flat list of ~8 bullets. The operator
   asked for that section to become an explicit how-to-use-your-tools.
3. **Unlike the other three LLM prompt kinds** (`system-authoring`,
   `card-user-relationship`, `agent-body-design` — each of them declares
   `PROMPT_KIND`/`PROMPT_VERSION` and states them in the prompt), the agent-round
   prompt carried no kind and no version: "which prompt produced this round" was
   unanswerable for the exact call the world fires every tick (RP-2).

## The template (kind `agent-round`, version `1.0.0`)

Layout, top to bottom:

- **Identity:** `You are <name>, an NPC droid in the room <room>.` / `Personality:
  ...` / `Purpose: <universal>` / `Objective: <card text>` (only when the card
  declares one) / the judged user-relationships block (unchanged).
- **World rules:** three bullets only — the only-actor rule, the per-round budget
  (two variants, chat on/off; the "call the done tool" sentence moved out to
  "How you respond", one home for the round-ending rule), and the advance rule.
- **Your tools:** one bullet per family — Discover (get_actions/get_instincts/
  get_crafts are the only source of executable options), Act (execute_action /
  toApproach / use_instinct), Move (use_door), Carry (equip_item / unequip_item /
  move_item), Craft (craft), and Speak (speak_in_room — only when chat is enabled,
  so an action-only agent's list never describes a tool the round does not have).
- **How you respond:** PROTOCOL B (the tool call is the content; never JSON/code/
  XML/markup in the message text) and the done/silence line (unchanged text).
- **The kind/version line:** "(This is prompt kind agent-round, version 1.0.0.
  Never mention this line in chat.)" — the last line of the prompt.

The universal purpose is the module constant `UNIVERSAL_PURPOSE`, rendered as the
`Purpose:` line for **every** NPC:

> Live by who you are: let your personality set your wants, your body set your
> limits, and your mind set your choices.

The wording maps the three words onto data the model already sees in the same
request: the `Personality:` line, the body attributes and components of the
context snapshot, and the instincts (the mind). A card-declared objective is
**never rewritten or dropped**: it keeps its existing `Objective:` label and its
verbatim text; the advance rule points at it (and at the universal purpose only
when no objective is declared) — the two variants mirror each other, pointing
at the declared objective or, without one, at the universal purpose.

Versioning: `PROMPT_KIND = 'agent-round'`, `PROMPT_VERSION = '1.0.0'` (module
exports, same shape as the other kinds). Bump on any change to
`_buildSystemPrompt`: major for a layout or protocol change, minor for wording
that changes behaviour, patch for wording-only polish. The versioned era starts
here — the historical spec §6.4 template predates it and was unversioned.

## What was rejected

- **Universal purpose as fallback only** (objective-less NPCs get it; agents with a
  card objective keep the old template): the operator asked for a purpose for all
  agents, and the old advance rule of the objective branch still read
  stagnation-adjacent.
- **Universal purpose replacing the card objective**: card-authored content is
  never rewritten, translated or dropped (AGENTS.md language policy); the two
  lines coexist.
- **Renaming the "World rules:" heading into the tools section** (collapsing both
  into one how-to list): the real world rules (actor, budget, advance) would have
  had no home and would dilute the tools list. The operator chose the
  slim-rules + separate "Your tools" layout.
- **Full RP-2 (version persisted with each stored transcript round):** the version
  is stated in the prompt, and the Agent View inspector shows the exact system
  string it received — no change to the transcript data shape (P-2). The other
  kinds attach kind/version to the HTTP response meta because they answer a
  request; the agent round is tick-driven and has no response meta.

## Consequences / next change

- Every system prompt is two lines longer (Purpose + the kind/version line); the
  tools bullets keep their historical wording, regrouped under family labels — a
  small local model reads the same sentences it was regression-fixed for, under
  clearer headings.
- `test/unit/KillerLlmDronePrompt.test.js` pins the new template byte-for-byte
  (the no-objective variant) and asserts the Purpose/Objective lines, the
  advance-rule wording, the section order, and that the version line ends the
  prompt. `test/unit/CardUserPrompt.test.js` and
  `test/integration/cardLlmNpc.test.js` pass unchanged — every line and heading
  they check survives at its old relative position.
- Next change this makes easier: per-kind prompt A/B (two `PROMPT_VERSION`s on
  the wire) and, if ever wanted, per-round version persistence in the transcript
  (the rejected shape above).
