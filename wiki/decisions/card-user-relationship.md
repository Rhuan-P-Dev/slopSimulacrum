# Decision: card `{{user}}` relationship — the LLM judges what a card's character is to its user

Date: 2026-11-08 (recorded in the commit that implements this)

## Context

The Cards tab (`GET /agent-body/cards`) is the gallery of the character cards
on disk. SillyTavern-style cards carry `{{user}}` tokens in their persona text
(see `card-user-mapping.md`), so a card implicitly claims a relationship with
the person its character talks to — but the claim is buried in free-form text.
The owner asked for a feature that judges, per card, which relationship the
card has with its `{{user}}`, and shows the judgment where the cards are
shown.

Only an LLM can make that judgment: the persona is free-form user content, so
no rule table can classify it. The cost guard follows the `agent-body-design`
precedent: one LLM call per explicit operator click, rate-limited in the
route, never triggered by a load or a refresh.

## Decision

- **Fifth LLM prompt kind (RP-1):** `card-user-relationship`, versioned per
  RP-2 (`PROMPT_VERSION`, stated in the system prompt itself). Owned by
  `src/controllers/networking/CardUserRelationshipController.js` behind the
  LLM seam (`chatFull`); no second transport, no SDK (CR B-4; `llm-transport.md`).
- **Endpoints** (same `/agent-body/cards` family as the existing card routes,
  `agentBodyRoutes.js`):
  - `GET /agent-body/cards/user-relationships` — read-only overlay:
    `{ relationships: { [cardId]: { label, summary, judgedAt } } }` for every
    fresh sidecar (CR API-1 — it never writes).
  - `POST /agent-body/cards/:cardId/user-relationship` — one LLM call; writes
    the sidecar; returns the frozen verdict plus `meta` (prompt kind and
    version, model, finish reason, latency).
- **Judgment basis:** the card's *effective persona* — the exact precedence
  the spawn uses (`CardSpawnLogic.buildCardProfile`: non-empty `personality`
  wins, then `description`, then the built-in default, each trimmed), because
  that is the text the NPC would actually carry. A card whose effective
  persona carries no literal `{{user}}` token cannot be judged:
  `422 CARD_USER_TOKEN_ABSENT`.
- **Output shape (owner's choice — free-form, not a fixed vocabulary):** a
  free-form label (at most 3 words / 48 characters) plus one short free-form
  sentence (at most 200 characters). A closed list cannot cover the range of
  relationships a free-form persona can claim; the validator enforces shape
  and length at the boundary (T-1), never vocabulary. The answer is fenced to
  `max_tokens: 160` and run at `temperature: 0.2` (RP-3): a rambling or
  truncated answer is a clean, retryable `422 RELATIONSHIP_JUDGMENT_INVALID`,
  never a silent partial write.
- **Persistence: a sidecar next to the card, never the card itself.** The
  verdict is written as `<card stem>.user-relationship.json` beside the PNG in
  `data/cards/`, through a new data-seam module
  (`src/utils/CardRelationshipStore.js` — the fourth `DATA_SEAM_FS_FILES`
  entry, CR B-3; atomic tmp-then-rename, P-3). Record shape (versioned, P-1):
  `{ version, cardId, name, personaHash, judgedAt, { label, summary } }` —
  `judgedAt` is UTC ISO-8601 (P-6). The PNG is never written (the language
  policy, AGENTS.md) and the world definition (`data/mods/`) is untouched
  (CR B-2): the sidecar is derived data, and the world never reads it.
- **Invalidation:** `personaHash` is a sha-256 of the display name and the
  effective persona the verdict was judged from (D-1 — pure, no clock). A
  replaced card file changes the hash, so a stale verdict is not served.
  Housekeeping runs on the *command* (each judgment), not on a read (CR
  API-1): sidecars whose PNG no longer exists (deleted or renamed card) are
  deleted on that occasion — derived data is deleted, not kept (CHG-6; it is
  not user content, P-7).
- **Error codes** (route header, CR H-2): `400 CARD_ID_REQUIRED`,
  `404 CARD_NOT_FOUND`, `422 CARD_USER_TOKEN_ABSENT`,
  `422 RELATIONSHIP_JUDGMENT_INVALID` (naming the violated rules, E-4),
  `502 LLM_ERROR_CODES.*`, and the `503 CARD_USER_RELATIONSHIP_CONTROLLER_NOT_WIRED`
  boot-order guard.
- **Test seam (TST-8):** the card directory is a constructor option (default
  `data/cards`), so the unit suite runs against a temp dir with synthetic
  PNGs and never touches the user's cards.

## UI rules (CardsPanel)

- Each card row gains a relationship zone: a fresh verdict renders as
  `{{user}} relationship: <label> (judged <time>)` + the one-sentence summary
  + a `Re-judge` button; without a verdict the zone shows the
  `Judge {{user}} relationship` button and a hint.
- The control is **grayed and locked** for a card whose prompt carries no
  `{{user}}` token — the same rule the Create-World binding applies
  (`cardHasUserPlaceholder`, mirrored again per CHG-2).
- Refresh loads the listing and the overlay in parallel; a failed overlay
  degrades to "nothing judged" and never blanks the gallery (E-2).
- A judgment updates only that row's zone in place, so the row's photo
  `<img>` keeps its loaded state instead of being re-fetched.

## Consequences

- Cost: one LLM call per click, bounded by the route limiter (20/min/IP) and
  the small answer budget; the provider timeout stays the LLM seam's single
  knob (CR A-5).
- The judgment is a property of the card file on disk, not of a world spawn:
  the world does not consume it. It is a dev/display aid for the operator —
  the actual `{{user}}` binding stays the `card-user-mapping` one.
- Replacing a card file makes its verdict vanish from the gallery (hash
  mismatch) and the sidecar is deleted at the next judgment; the operator
  never has to clean up by hand.
- `AGENTS.md` lists the fifth prompt kind; this note is where its shape
  decisions live.

## Rejected alternatives

- **A fixed relationship vocabulary** (e.g. a closed enum the LLM picks
  from): the owner chose free-form — a closed list cannot cover what a
  free-form persona can claim, and the label is display text, not a key.
- **Ephemeral judgment (no persistence):** the owner chose persistence, so a
  verdict survives reloads and is inspectable as a file next to the card.
- **An in-memory cache:** lost on restart, not inspectable, and not the
  repo's data-file idiom (P-1/P-7).
- **Writing the verdict into the PNG's tEXt side channel:** forbidden by the
  language policy — card files are user content and are never rewritten.
