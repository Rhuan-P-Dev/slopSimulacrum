# Decision: card `{{user}}` mapping — binding a card's user to another card

Date: 2026-07-12 (recorded in the commit that implements this)

## Context

SillyTavern-style card PNGs carry `{{user}}` tokens in their persona text: the
placeholder for the human who talks to the character. In this world no human ever
sits in a room, so a card's `{{user}}` resolved to nothing — the token passed
through the agent's system prompt literally (`LLMAgentController._buildSystemPrompt`).
The owner asked: at world create, allow binding card X's `{{user}}` to card Y, so
X's agent behaves as if the user it talks to is Y (by name).

## Decision

- `POST /world/create` accepts an optional `users` map
  `{ [sourceCardId]: targetCardId }`. Absent (or `null`) means "no bindings" and
  the old behavior is preserved byte-for-byte: unbound prompts keep the literal
  token.
- **Validation** (`WorldRecreateLogic.resolveUserMap`) runs before any mutation —
  before a single entity is despawned:
  - `users` must be a plain object, and every key/value a string of 1–128 chars
    with no path separator, or `400 WORLD_CREATE_USER_MAP_INVALID`;
  - both sides of every binding must name card files on disk
    (`data/cards/*.png`), or `400 WORLD_CREATE_USER_UNKNOWN`, naming the
    offenders (capped).
- **Application** (`CardSpawnLogic.spawnCards` → `resolveUserNames` →
  `_spawnSingleCard`): each distinct target's **display name** is read once from
  the target's own card payload (the PNG `name`, via `readCharaCard`; the id is
  the fallback) and written into the source NPC's `config.userName`. The LLM
  layer then rewrites the token in the effective persona:
  `personality.split('{{user}}').join(name)`.
  - The effective persona is what `buildCardProfile` renders: the personality
    when the card has one, otherwise the description, otherwise the default
    profile — which never carries the token.
  - The token is **literal**: `{{ user }}`, `{{User}}` and the like pass through
    exactly as they always have. Only the exact lowercase form is replaced.
- The binding is a per-spawn fact: it lives in the spawned entity's NPC config,
  not in the card file. A card's PNG bytes are never rewritten (user content is
  never mutated, per the language policy).
- The create report carries `cards.users` (source card id → the bound target's
  `{ cardId, name }`) only when at least one binding landed on a spawned card,
  keeping the unbound response shape byte-identical to before.

## UI rules (CreateWorldPanel)

- One "its {{user}} is" selector per card row. The options list **every** card
  file on disk except the row's own card (self-binding is a UI mistake; the
  server stays lenient and accepts it if ever sent).
- The control is disabled while the row's checkbox is off: a binding only
  reaches a card that actually spawns.
- The control is **grayed and locked** (always disabled, CSS class
  `cw-user--locked`) for a card whose effective persona carries no `{{user}}`
  token at all: there is nothing for a binding to act on, and offering one
  would be the client inventing a rule the server cannot apply. The check is
  `cardHasUserPlaceholder` (exported by the panel, pinned in
  `test/unit/CreateWorldPanel.client.test.js`) and mirrors the server exactly:
  the same effective-persona precedence and the same literal token.

## Consequences

- A bound card's agent talks to the target's display name. If the target card
  was not selected to spawn, the name is still bound — validation is against
  files on disk, not against the selection — so the agent may address a name
  with no body in the room. The options list presents every card on disk for
  exactly this reason.
- The binding survives as long as the world state does; the next create or
  recreate re-reads the request and re-applies it.
