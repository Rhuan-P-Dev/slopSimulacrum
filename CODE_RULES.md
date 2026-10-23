# CODE_RULES.md

The normative quality bar for this codebase. `AGENTS.md` tells you how to run things;
**this file tells you how code must be written.** When the two disagree, this one wins
on matters of code quality.

**Reality of this repository's tooling (read first).** This codebase is **plain ES2023+
JavaScript (no TypeScript), run with `node`, linted with `ESLint 10` flat config,
tested with `vitest`, and **not formatted by any tool** (no Prettier).** It has
**no type-check step and no type-aware linting.** So most rules here are enforced by
*review*, and only the handful tagged `[enforced: eslint]` / `[enforced: eslint +
check:lang]` / `[enforced: vitest, hook]` are mechanical. Treat an untagged `[enforced:
review]` rule as a human checkpoint, not a machine guarantee — and prefer to make a
rule mechanical when a review rule bites (see "Enforcement is itself tested").

Every rule has a stable ID (`CAT-N`). IDs are append-only: never renumber, never reuse.
Cite them in reviews and commits as `CR: E-5` so a waiver is traceable.

## How to read this

- **MUST / MUST NOT** — non-negotiable. A violation blocks the change. Fix it or record
  a waiver (see [Waivers](#waivers)).
- **SHOULD / SHOULD NOT** — follow it, or say in the PR why you did not. Silence is not
  a justification.
- **May** — genuinely optional.
- `[enforced: eslint]` — the gate fails; the rule is listed below and covered by a fixture
  or a base ESLint rule.
- `[enforced: eslint + check:lang]` — two independent checks: an ESLint rule and the
  repo-wide `check:lang` language guard.
- `[enforced: vitest, hook]` — a `vitest` suite / git hook runs it.
- `[enforced: review]` — nothing mechanical catches it. It drifts; say so when it bites.

### Enforcement map

What is mechanical **today**, verified by running the rules against fixtures rather than
assuming they fire.

| Tag | Meaning |
| --- | --- |
| `[enforced: eslint]` | the gate fails; the rule is listed below and, for `cr/*`, covered by a fixture in `src/lint-fixtures/` and pinned by `test/lint-rules.test.js` |
| `[enforced: eslint + check:lang]` | an ESLint rule (server + shared) *and* the repo-wide language guard |
| `[enforced: vitest, hook]` | a `vitest` suite and/or a `githooks/` hook runs it |
| `[enforced: review]` | nothing checks it mechanically. It drifts. Say so when it bites. |

| Rule | Mechanism |
| --- | --- |
| `E-5` | `cr/fetch-requires-signal` (error) — any `fetch()` with no `AbortSignal` fails; fixture `fetch-no-signal.fixture.js` |
| `B-3` | `cr/no-direct-file-read` (error) — `fs`/`fs/promises` fails outside the data seam (`src/utils/DataLoader.js`, `src/utils/PngCharaReader.js`, `src/controllers/logic/CardSpawnLogic.js`); fixture `direct-file-read.fixture.js` |
| `NAME-1` | `cr/no-accented-text` (error, server + shared) + repo-wide `check:lang` (Portuguese accents + PT word list); fixture `accented-text.fixture.js` |
| `OBS-1` | `no-console` (error, server + shared; exempt `src/utils/Logger.js` and `shared/RangeResolver.js`); fixture `console-in-server.fixture.js` |
| unused / undefined | `unused-imports/no-unused-imports`, `no-undef`, `no-unused-vars` (base `@eslint/js` recommended) |
| `GIT-1` (mechanical half) | `githooks/commit-msg` — non-empty, ≤ 72 chars, no trailing period, ASCII only, no placeholder |
| `GIT-3` (fast) | `githooks/pre-commit` — `npm run lint` + `npm run check:lang` on every commit |
| `GIT-3` (full) | `githooks/pre-push` — `npm run check` (lint + lang + all tests) on every push |
| `GIT-5` | `.gitignore` — generated/ignored artifacts never reach the index |
| — | `test/lint-rules.test.js` (vitest) pins every `cr/*` rule to a fixture and runs the repo's *actual* `eslint.config.js` |

Rules that are `[enforced: review]` in this codebase (no mechanical check exists):
`CHG-*`, `NAME-2/3/4/5/6/7/8/9`, `T-*` (no type checker here), `B-1/2/4/5/6/7`,
`E-1/2/3/4/6/7/8`, `A-*`, `D-*`, `P-*`, `SEC-*`, `OBS-2/3/4/5`, `RP-*`, `H-*`,
`TST-*`, `PERF-*`, `API-*`, `DOC-*`, `GIT-2/4`, `AP-*`. All of them bind by review
and by the Definition of done, exactly as the tag says.

### Enforcement is itself tested

`npm test` runs `test/lint-rules.test.js`: it lints every fixture under
`src/lint-fixtures/` with the **repo's actual `eslint.config.js`** and asserts the exact
rule ids that fire on each — and that `clean.fixture.js` produces zero messages.
`npm run lint:rules` runs just that file.

So when you add or tighten a rule here: add the fixture, add the assertion, then write
(or tighten) the rule. Three edits, one commit, and the claim in this document stays true.
If a rule stops firing on its fixture, the commit is broken, not passing.

Still not mechanical, and this is where review earns its keep in a JS codebase without a
type checker: import cycles (`B-4` — nothing catches them, so a clean lint means little),
secret handling (`SEC-1`), retry discipline (`E-6`), the typed-error taxonomy beyond
`throw` (`E-1`), prompt-assembly discipline (`RP-1`, `RP-3`), and every judgement about
whether a name is *good* rather than merely not-banned.

The ordering principle behind every rule below, and the tiebreaker when two rules conflict:

> **Optimize for the person changing this code in two years — who will not be you, and
> who will not have the context you have now.**

Density, cleverness and brevity all lose to legibility. A computer is fast at whatever
you write; the limited resource is the reader's understanding.

---

## 1. Changeability and size (CHG)

- **CHG-1 — Change is the only unit of cost.** Before writing, ask what the next three
  changes to this file will be. Code written for a hypothetical future is debt today;
  code that resists the *obvious* next change is worse. `MUST` state the expected next
  change in the PR when you add an abstraction. `[enforced: review]`
- **CHG-2 — Rule of three.** `MUST NOT` extract an abstraction the first time a shape
  appears. The second time, tolerate duplication. The third time, extract — and name the
  abstraction after what the three cases have in common, not after where they came from.
  `[enforced: review]`
- **CHG-3 — File size is a design signal, not a quota.** Past ~300 lines, a file is
  usually two responsibilities wearing one name; past ~500, it is unreviewable. `MUST`
  split on responsibility, never mid-responsibility to hit a number. No `max-lines`
  rule is enabled here — `[enforced: review]`.
- **CHG-4 — Function shape.** `MUST NOT` exceed ~40 meaningful lines or 3 parameters;
  pass one options object instead of a 4th positional argument. `MUST NOT` use a
  boolean parameter to select behavior — write two functions; callers reading
  `run(x, true)` cannot tell what `true` means. `[enforced: review]`
- **CHG-5 — Nesting depth.** `SHOULD NOT` exceed 3 levels of nesting in a function; use
  early returns and guard clauses. Flatten with `continue`/`return` rather than `else`.
  No `no-nested-ternary` rule is enabled — `[enforced: review]`.
- **CHG-6 — Delete, do not keep.** `MUST NOT` commit commented-out code, unused exports,
  dead branches or `// kept for reference` blocks. Git has the history; the file does
  not. `MUST` delete a flag once its experiment resolves, and `SHOULD NOT` add a flag
  without naming the change that removes it. `[enforced: review]`
- **CHG-7 — Refactor under cover of tests.** `MUST` have a passing `vitest` that pins the
  current behavior before restructuring a behavior-bearing path. A refactor that also
  changes behavior was not a refactor — label it honestly. `[enforced: vitest]`
- **CHG-8 — No opportunistic reformatting.** `MUST NOT` let a formatter or a rename touch
  files your change did not need to touch. Formatting churn is what makes blame useless
  and reviews unreadable. There is no formatter here, which makes this rule *easier* to
  violate by hand: split a mechanical reformat into its own commit, alone, never mixed
  with a behavior change. `[enforced: review]`

## 2. Naming (NAME)

Names are the documentation you cannot delete, so they are the highest-leverage words in
the file.

- **NAME-1 — English only, no accents, no Portuguese.** See the language policy in
  `AGENTS.md` and `check:lang`. Applies to identifiers, files, comments, commits, error
  strings and test names. `[enforced: eslint + check:lang]`
- **NAME-2 — Say what it is, and say nothing else.** `MUST NOT` use `data`, `info`,
  `payload`, `obj`, `item`, `thing`, `util`, `helper`, `manager`, `handler`, `processor`,
  `common`, `misc`, `system` as the whole name. If a name would be one of those, the
  concept is not understood yet — stop and find it. `[enforced: review]`
- **NAME-3 — Length matches lifespan.** A loop index may be `i`. A module-level export
  must be a phrase. Scope and name length are proportional; a name that needs scrolling
  to read is a name that needs a comment. `[enforced: review]`
- **NAME-4 — No abbreviations** except universal ones in their established position
  (`id`, `url`, `http`, `db`, `msg` in a log field). `MUST NOT` invent `usrPrv` — the
  reader pays your typing savings as their reading time, forever. `[enforced: review]`
- **NAME-5 — No negation.** `MUST NOT` name a boolean `isNotReady` or `noError`; double
  negation is a bug factory. Positive form: `isReady`, `hasError`. `[enforced: review]`
- **NAME-6 — Booleans as state are a smell past two.** `SHOULD NOT` keep more than two
  related booleans (`isOpen`, `isClosing`, `isClosed`); replace them with a union of
  states. Two booleans encode a fourth, impossible state that someone will have to
  handle at 2am. `[enforced: review]`
- **NAME-7 — Plural and unit-bearing.** Collections are plural (`npcs`), and anything
  with a unit says it in the name: `timeoutMs`, `maxTokens`, `sizeBytes`, `sentAt`.
  `MUST NOT` pass a bare `timeout` or `size`. `[enforced: review]`
- **NAME-8 — Verbs for functions, nouns for everything else.** A function name starting
  with `get`/`load` `MUST` be obvious about whether it performs I/O: prefer `loadEntity`
  (async, I/O) vs `entityFromCache`. `[enforced: review]`
- **NAME-9 — File names.** `camelCase` for source modules (the codebase's convention:
  `WorldStateController.js`, `rateLimiter.js`), named after the concept, never after
  the consumer. One primary export per file. No `kebab-case` rule is enabled —
  `[enforced: review]`.

## 3. Contracts (T) — JS, no type checker

This repository has **no TypeScript and no type-check step**. "Contracts" here are the
*runtime* contract: what a module exports, the shape of a value, and any JSDoc that
documents it. The compiler will not protect you — the rules below keep your *readers*
and your **tests** protected.

- **T-1 — No untyped boundary values.** `MUST NOT` accept a raw value (env var, JSON key,
  HTTP/Socket.IO payload, LLM output, data-file field) and pass it through unchecked.
  `MUST` narrow it once, at the edge, into a known shape, then stop re-checking
  downstream. `[enforced: review]`
- **T-2 — Parse, don't validate, repeatedly.** Data crossing a boundary `MUST` be
  narrowed once, at the edge. Downstream code `MUST NOT` re-check fields the edge already
  guaranteed. Hand-written guards are preferred here — a guard is 10 lines and adds no
  dependency. `[enforced: review]`
- **T-3 — Make illegal states unrepresentable.** `SHOULD NOT` express a set of mutually
  exclusive possibilities as several optional fields. Use a discriminated shape with a
  literal `kind` tag: `{ kind: 'text'; text: string }` | `{ kind: 'tool_call'; ... }`.
  `[enforced: review]`
- **T-4 — Exhaustive matching.** A `switch`/`if-else` over a closed set of variants
  `MUST` handle every case, and the fall-through `MUST` be a deliberate failure (throw
  with the unhandled variant named) rather than a silent `return`. A new variant then
  becomes a visible bug, not a runtime surprise. `[enforced: review]`
- **T-5 — Opaque where it matters.** `SHOULD` distinguish values that are not interchangeable
  — a turn id, a token budget, a timestamp — with a convention the code enforces, rather
  than three raw `string` args that will be swapped. `[enforced: review]`
- **T-6 — Infer parameters, document returns.** Exported functions `SHOULD` state their
  return shape (JSDoc `@returns`) because the signature is the contract and there is no
  compiler to infer it for the reader. `[enforced: review]`
- **T-7 — No type assertions that lie.** `as`/`// @ts-ignore` do not exist here (no TS),
  so the analogue is "trust a value because the error message said so" — `MUST NOT`.
  Narrow after a real check; never cast to silence a mismatch. `[enforced: review]`
- **T-8 — `Object.freeze` by default.** `MUST` freeze exported configuration and
  read-only tables (e.g. vocabulary constants, stat definitions) unless mutation is
  part of the contract. Mutation you cannot see is mutation you cannot reason about.
  `[enforced: review]`
- **T-9 — Config objects frozen.** `MUST` `Object.freeze` the loaded config and export
  it as a value, never as a getter, never as a mutable singleton anyone can patch.
  `[enforced: review]`

## 4. Boundaries and dependencies (B)

- **B-1 — Dependency direction points inward.** Domain logic (`controllers/`) `MUST
  NOT` import HTTP plumbing, the socket layer, or `node:fs`. The edge (routes,
  `server.js`, composition) imports domain; domain must never reach outward. No
  exceptions, no "just for the type" — put the type in the domain. `[enforced: review]`
- **B-2 — One seam per external world.** Exactly one module talks to the **LLM provider**
  (`src/controllers/networking/LLMController.js`), one to the **realtime channel**
  (`src/controllers/networking/SocketLifecycleController.js`), one to the **filesystem /
  data** (`src/utils/DataLoader.js`, the data seam). `MUST NOT` reach for `fetch` or
  `fs` or a socket call outside those seams. A new seam is a decision in
  `AGENTS.md` plus a seam exemption — and, where one is machine-checkable (the fs seam),
  a fixture and a pin in `test/lint-rules.test.js` prove the ban still fires outside
  it and the seam still compiles. `[enforced: review + vitest]`
- **B-3 — Data seam only.** No module imports `fs` / `fs/promises` outside the seam
  (`src/utils/DataLoader.js`, `src/utils/PngCharaReader.js`, `src/controllers/logic/
  CardSpawnLogic.js`). `[enforced: eslint]`
- **B-3b — Extend the seam deliberately.** If a new module legitimately must touch the
  filesystem, it goes *through* the data seam (`DataLoader.js`), or the seam is extended
  in `eslint.config.js` (`DATA_SEAM_FS_FILES`) in the same commit that justifies it.
  `[enforced: review]`
- **B-4 — No import cycles.** `MUST NOT` create one. Nothing here catches a cycle (no
  `import/no-cycles`), so a clean lint proves nothing. Check it by reading the import
  list. `[enforced: review]`
- **B-5 — No barrel files.** `MUST NOT` add an `index.js` that re-exports a directory.
  `src/routes/index.js` exists as a *route table* (the single place routes are declared,
  `H-5`) — it does not re-export domain modules. `[enforced: review]`
- **B-6 — Small, honest interfaces.** `SHOULD` keep a seam's surface to the 2–4 methods
  actually used. An interface mirroring the provider's full API is not abstraction; it
  is the provider's API with extra files. `[enforced: review]`
- **B-7 — The layering contract, in order.** `server` → `routes` → `controllers`/use
  case → data seam; domain `MUST NOT` import infrastructure. Keep `src/` shallow: if
  you cannot explain the arrow diagram in three lines, it is wrong. `[enforced: review]`

## 5. Errors (E)

The dominant failure mode of a chat server is not "it crashes"; it is "it fails in a
way nobody can debug".

- **E-1 — Three kinds of failure, three kinds of response.**
  - **Expected failure** (bad input, unknown id, missing card) — return it as a typed
    domain value or a domain error (`src/utils/CustomErrors.js`). `MUST NOT` throw for
    control flow you expected.
  - **Requestable failure** (provider 400/401/429/5xx, timeout) — throw/return a typed
    error carrying a status and a machine-readable code; the route maps it to 4xx/5xx.
  - **Programmer error** (unhandled variant, broken invariant) — throw, and let it be
    loud. Do not map it to a friendly 500 message; keep the stack.
  `[enforced: review]`
- **E-2 — Never swallow.** `MUST NOT` write `catch {}` or a catch that only logs and
  continues on a path where continuing produces wrong state. If you truly mean to ignore,
  write `// why: <reason>` next to it. No `no-empty` rule is enabled here, so the empty
  half is review; the "log and continue" half is always review. `[enforced: review]`
- **E-3 — Add context on the way out.** `MUST` rethrow with `cause` (`new Error(msg,
  { cause: err })`) and a message that names the operation and its identifiers
  (`'prompt assembly failed for npc id …'`). `MUST NOT` rethrow the same error object
  unchanged — that is a no-op with indentation. `[enforced: review]`
- **E-4 — Error messages are for the next responder.** They `MUST` say what failed, on
  what, and what was attempted. `MUST NOT` interpolate secrets, tokens, API keys, or
  full conversation text into an error message (errors get logged; logs get shipped).
  `[enforced: review]`
- **E-5 — Timeouts on everything external.** Every outbound `fetch` (provider call, any
  second HTTP seam) `MUST` carry an `AbortSignal` — `AbortSignal.timeout(ms)` when there
  is no caller-controlled controller, otherwise the caller's signal. `[enforced: eslint]`
- **E-6 — Retry discipline.** `MUST` retry only idempotent operations, only transient
  classes (`429`, `5xx`, network), with exponential backoff **plus jitter**, a bounded
  attempt count, and a deadline that respects the caller's `AbortSignal`. `MUST NOT`
  retry a `400`. `MUST NOT` retry without a cap — a retry storm against a struggling
  provider is an outage you caused. `[enforced: review]`
- **E-7 — No 500 for caller mistakes.** Invalid input is 4xx with a field-level reason.
  `MUST NOT` leak internal stack traces, data-file paths, provider payloads, or model
  names into responses to clients. `[enforced: review]`
- **E-8 — Fail fast at boot.** `MUST` validate config and required env at startup (via
  `dotenv` / `src/utils/serverBootstrap.js`) and exit with a clear message, not on the
  first request that needed it. `[enforced: review]`

## 6. Async and concurrency (A)

- **A-1 — No floating promises.** Every promise is awaited, returned, or explicitly
  `void`-prefixed with a `// why:`. No `no-floating-promises` rule is enabled here,
  so this is review — but a dangling LLM call that never settles is a socket that
  never answers. `[enforced: review]`
- **A-2 — Propagate cancellation.** Any async function that does I/O `MUST` accept an
  `AbortSignal` and pass it down. Any long-lived loop `MUST` check `signal.aborted`.
  Without this, a disconnecting client leaves a provider stream burning money
  (`SEC-9`). `[enforced: review]`
- **A-3 — Cleanup is not optional.** Every `setInterval`/`setTimeout`, socket event
  handler, stream, and file handle `MUST` have a matching teardown on a path that runs.
  `MUST NOT` register a listener inside a per-request/per-connection function that outlives
  it. `[enforced: review]`
- **A-4 — Streams: respect backpressure.** When piping a provider stream to a socket,
  `MUST` honor write backpressure and `MUST NOT` buffer an unbounded stream in memory.
  `[enforced: review]`
- **A-5 — Sequential by default; parallel on purpose.** `SHOULD NOT` fire `Promise.all`
  unless the operations are independent and the failure semantics are decided. `Promise
  all` rejects fast and leaves the siblings running — pick deliberately. `[enforced:
  review]`
- **A-6 — No shared mutable state across turns.** Node is single-threaded but
  interleaving is still concurrency. `MUST NOT` mutate a shared world/entity object across
  `await` points; take a snapshot, then commit the mutation in one step. `[enforced:
  review]`
- **A-7 — Bound every queue and every body.** Incoming request bodies (`MAX_BODY_LIMIT`),
  retry queues, in-memory caches and history buffers `MUST` have explicit numeric limits
  defined in `src/utils/Constants.js` / config. Unbounded growth is how a long-running
  process dies at 4am on a Tuesday. `[enforced: review]`
- **A-8 — Graceful shutdown.** On `SIGTERM`/`SIGINT`: stop accepting, give in-flight
  requests a bounded drain window, close sockets and the LLM, then exit. A process that
  needs `SIGKILL` is a deployment hazard. `[enforced: review]`

## 7. Determinism, time and randomness (D)

Reproducibility is what separates a debuggable system from an anecdote-driven one.

- **D-1 — Inject the clock and the RNG.** `MUST NOT` call `Date.now()` / `new Date()` /
  `Math.random()` inside behavior under test; take them from an injected provider when
  determinism matters (turn timing, cooldowns, the rate limiter's window). Only the
  composition root supplies the real ones. `[enforced: review]`
- **D-2 — IDs are generated at the edge, never derived from time alone.** Use
  `crypto.randomUUID()` or a monotonic/namespace sequence (`src/utils/idGenerator.js`,
  `src/utils/IdResolver.js`). `MUST NOT` assume `Date.now()` uniqueness — two events in
  the same millisecond will collide. `[enforced: review]`
- **D-3 — Store and transmit UTC.** Timestamps are ISO-8601 UTC (`...Z`). Local time is
  a presentation concern. `MUST NOT` emit a bare `toLocaleString()` into storage or a
  log line. `[enforced: review]`
- **D-4 — Durations are measured monotonically.** Use `performance.now()` for elapsed
  time; wall-clock jumps backwards on NTP corrections and will produce negative
  latencies in your metrics. `[enforced: review]`
- **D-5 — Money and counts are integers.** Token counts, byte sizes and durations `MUST`
  be integers with a unit in the name (see `NAME-7`). `MUST NOT` use floating point for
  anything you sum. `[enforced: review]`

## 8. Persistence and data files (P)

Storage decision: **JSON data files under `data/`**, loaded through the data seam
(`B-3`), **no database, no SQLite, no ORM, no migration runner**. The world is "governed
by JSON data files, not code." The rules below are about keeping those files trustworthy
over months of hand-edits and agent edits.

- **P-1 — Data files are authoritative and versioned.** A data file's shape is part of
  the contract. `MUST` carry a `version` (or `rev`) field when concurrent editors write
  it, and `MUST` document which file owns which concept (see `data/` top: `world/`,
  `entities/`, `components/`, `systems/`, `materials/`, `cards/`). `[enforced: review]`
- **P-2 — Expand, migrate, contract — for data schemas.** To change a field: add the new
  one, keep the old one reading for one cycle, backfill, switch reads, drop the old
  in a later commit. `MUST NOT` ship a file whose new shape the currently-running code
  cannot read on load. `[enforced: review]`
- **P-3 — Atomic reads, whole-file writes.** `MUST` read a data file in one load and
  `MUST` write it as one atomic operation (replace the whole file) when you update it.
  No partial writes, no one-line patches to a live file. `[enforced: review]`
- **P-4 — No N+1 file reads.** `MUST NOT` read a data file per row inside a hot path.
  Load once (in `DataLoader.js`), cache in memory, and build maps/indices in memory. If
  you can see a loop around a data read, it is a bug report in waiting.
  `[enforced: review]`
- **P-5 — Never interpolate unvalidated data into prompts or commands.** `MUST NOT`
  splice user input or model output into a prompt, a shell command, or a file path
  without explicit allowlisting/validation (see `SEC-4`). Treat data files as *structure*
  to be mapped, not as text to be concatenated. `[enforced: review]`
- **P-6 — Carries versioning and timestamps.** Persisted aggregates `SHOULD` carry
  `createdAt`/`updatedAt` (UTC, `D-3`) and a `rev` where concurrent writes are possible.
  `[enforced: review]`
- **P-7 — Deletes are soft where history matters.** Cards and world definitions the user
  cares about: `SHOULD` tombstone (keep a record, mark it disabled) rather than
  destroy, so a reload does not lose it. `[enforced: review]`
- **P-8 — Data files are definitions, not logs.** `MUST NOT` store one row per token, or
  an unbounded event stream, in a data file. Event history goes in memory (the turn
  stream) or a real log, never as an ever-growing JSON file. `[enforced: review]`

## 9. Security (SEC)

- **SEC-1 — Secrets are env-only.** `MUST NOT` hardcode keys, commit `.env`, log a key,
  or accept a key from a request body, query string, or CLI argument visible in `ps`.
  Redact on the way out: `authorization`, `x-api-key`, and `*token*`/`*secret*` fields
  never reach a log line. `[enforced: review]`
- **SEC-2 — Validate at the edge, with limits.** Every inbound payload `MUST` be size-capped
  before parsing (`MAX_BODY_LIMIT`) and shape-checked after. `MUST` cap message length,
  history length, token budget and request rate (`src/utils/rateLimiter.js` — 20 req /
  60 s per client key). A chat endpoint without limits is a denial-of-service endpoint.
  `[enforced: review]`
- **SEC-3 — Outbound calls are attacker-controlled input.** Any URL built from user- or
  config-supplied values `MUST` be validated against an allowlist of hosts and schemes,
  with redirects forbidden or re-validated — otherwise it is SSRF. `[enforced: review]`
- **SEC-4 — Prompt injection is a real injection class.** Model output is untrusted data,
  never a command. `MUST NOT` feed model output into `eval`/`Function`/`exec`, a shell,
  a file path, or a tool call without an explicit allowlist and validation. User text is
  never translated or rewritten, but it `MUST` be length-limited and structurally
  delimited before it reaches a prompt. `[enforced: review]`
- **SEC-5 — AuthN/AuthZ at the boundary, once.** Authorization checks live in the
  middleware/route layer (`src/utils/authMiddleware.js`), not scattered inside domain
  functions. `MUST NOT` trust a client-supplied identity; verify ownership of every
  conversation/turn id that arrives. `[enforced: review]`
- **SEC-6 — No secrets in errors, and no stack traces downstream.** See `E-4`, `E-7`.
  `[enforced: review]`
- **SEC-7 — Files are paths from an allowlist.** Any path built from user input `MUST`
  be resolved and verified to stay inside a base directory
  (`path.resolve` + `startsWith` with a trailing separator). `[enforced: review]`
- **SEC-8 — Dependencies are liability.** Before adding one: last release date, open
  critical advisories, license, maintainer count, install size and transitive count.
  Every runtime dependency is code you will maintain forever without being able to fix
  upstream. The runtime set (express, socket.io, dotenv) is fixed; adding to it needs
  this vetting in the commit message. `[enforced: review]`
- **SEC-9 — Rate-limit and cost-guard outbound spend.** A chat loop with a paid provider
  `MUST` have a per-client budget (the 20/60s limiter) **and** a per-turn token budget
  (`LLM_TIMEOUT_MS` caps duration; the per-round token cap is a code constant). Without
  it, one runaway client or one retry loop converts a bug into an invoice.
  `[enforced: review]`

## 10. Observability (OBS)

- **OBS-1 — Structured logs only, through `Logger`.** JSON/level-filtered logs from
  `src/utils/Logger.js`. `MUST NOT` use `console.*` in server or shared source
  (`src/`, `shared/`) — the sole exception is `src/utils/Logger.js` (it *is* the
  logger) and `shared/RangeResolver.js` (pure client geometry). `no-console` is an
  **error** with no blanket allowlist, so any stray `console` in a server file fails
  the gate. `[enforced: eslint]`
- **OBS-2 — Every turn carries a correlation id.** Generated at the edge, attached to
  every log line and error for that turn, and passed into provider calls. Without it,
  concurrent turns are indistinguishable. `[enforced: review]`
- **OBS-3 — Log the decisions, not the prose.** Each outbound provider call logs: model,
  latency ms (`D-4`), token counts in/out, status, attempt number. Each inbound request
  logs method, route, status, duration. `MUST NOT` log conversation content or prompt
  bodies — log lengths instead. `[enforced: review]`
- **OBS-4 — Level discipline.** `error` = someone must act. `warn` = degraded but
  self-healing. `info` = business event. `debug` = off in production (`LOG_LEVEL`).
  `MUST NOT` log at `error` anything expected, and `MUST NOT` log in a hot loop or per
  streamed token. `[enforced: review]`
- **OBS-5 — Process hygiene.** Boot logs version, commit, and a non-secret config summary.
  Unhandled `unhandledRejection`/`uncaughtException` are logged and the process exits —
  a zombie process is worse than a crash-loop an operator sees. `[enforced: review]`

## 11. NPC / LLM domain rules (RP)

- **RP-1 — One builder per kind of prompt, and every kind listed.** Prompt assembly lives
  in the networking controllers (`src/controllers/networking/LLMController.js` and
  its context/feedback controllers). `MUST NOT` call the provider from anywhere else, and
  `MUST NOT` start a third assembler without naming that prompt *kind*. A new kind is
  a decision in `AGENTS.md`, not a stray `fetch`. `[enforced: review]`
- **RP-2 — Prompts are versioned.** A prompt template carries a `version` string persisted
  alongside each generated message. Without it you cannot answer "which prompt produced
  this reply" and cannot A/B a change after the fact. `[enforced: review]`
- **RP-3 — Token budget before the call.** Trimming history `MUST` happen explicitly with
  a stated policy (keep system, keep last N turns, drop oldest) and `MUST` be logged.
  `MUST NOT` rely on the provider to truncate, and `MUST NOT` silently drop the persona.
  `[enforced: review]`
- **RP-4 — Turn integrity.** Every message in a turn `MUST` carry role, content, and a
  monotonic sequence; a regenerated reply appends a new branch or tombstones the old one
  — never silently overwrites the record the next turn will read. `[enforced: review]`
- **RP-5 — Provider neutrality in the domain.** Domain code speaks this codebase's
  message shape, never a provider's SDK shape. Provider-specific fields die at the seam
  (`B-2`). `[enforced: review]`
- **RP-6 — Streaming contract is explicit.** A provider stream emits a defined sequence
  (`start` → `delta*` → `done` | `error`) and `MUST` terminate exactly once, including
  on abort and on upstream error. A client that never sees `done` is the bug this rule
  exists to prevent. `[enforced: review]`
- **RP-7 — Guardrails in one filter, on model-directed content.** Category restrictions
  live in the input filter, respect the chosen provider's policy, and are enforced
  before prompt assembly — not spread across handlers, and never applied by altering what
  the user typed. `[enforced: review]`
- **RP-8 — Cost is a first-class number.** Every provider call records tokens in and out,
  and the per-turn cap is a named constant (`SEC-9`). `MUST NOT` raise a model's token
  budget without stating its cost class in the same commit. `[enforced: review]`

## 12. HTTP / realtime surface (H)

- **H-1 — Version the public API.** Routes are `/api/...`; `MUST` make changes additive;
  a breaking change gets a new prefix and a documented sunset. `[enforced: review]`
- **H-2 — Errors have a machine-readable shape.** `{ error: { code, message, fields? } }`
  with a stable `code`; the HTTP status carries the class, the code carries the case.
  Clients switch on the code, not the sentence. `[enforced: review]`
- **H-3 — Idempotency where retries are expected.** Any non-safe endpoint a client may
  retry `MUST` accept an idempotency key and return the original result for a replayed
  key. `[enforced: review]`
- **H-4 — Limits and content types.** Enforce `Content-Type`, max body size
  (`MAX_BODY_LIMIT`), and request timeout (`LLM_TIMEOUT_MS`) at the server (Express
  middleware / the limiter), not inside the handler. Return 413/415/429 correctly.
  `[enforced: review]`
- **H-5 — Routes declared in one table.** Every route → controller mapping lives in
  `src/routes/index.js` (wired from `server.js`). Adding a route in two places is how
  auth (`authMiddleware`) or rate-limiting gets skipped. `[enforced: review]`
- **H-6 — Realtime is Socket.IO, and its events are the contract.** The socket event
  vocabulary is in `shared/SocketProtocol.js`. `MUST` publish only events in that table
  and `MUST` keep them shared (the client reads the same constants). `[enforced: review]`

## 13. Testing (TST)

- **TST-1 — Test behavior through a public interface.** `MUST NOT` test private
  functions, and `MUST NOT` assert on intermediate calls unless the interaction *is* the
  contract (e.g. "the LLM was called exactly once"). A test that breaks on refactor is
  a test of the implementation. `[enforced: review]`
- **TST-2 — Deterministic or deleted.** No wall-clock dependence, no ordering luck, no
  real network, no real LLM, no sleeps standing in for synchronization. Inject the clock
  (`D-1`), await the actual condition. A test that fails 1 in 50 trains everyone to
  rerun the suite. `[enforced: review]`
- **TST-3 — No real provider in unit tests.** `MUST` use an in-memory fake implementing
  the LLM seam (`B-2`). Real provider calls belong in a separate, explicitly-invoked,
  opt-in suite. `[enforced: review]`
- **TST-4 — Shape: many unit, few integration, almost no end-to-end.** Fast tests at the
  domain seam (`test/unit/`), a handful over HTTP/socket against the fake provider
  (`test/integration/`), contract tests for the data schemas (`test/contract/`).
  `[enforced: review]`
- **TST-5 — Every bug fix ships with the reproducing test.** Written first, against the
  failing behavior, so it demonstrably failed before the fix. `[enforced: review]`
- **TST-6 — Name the scenario in the name.** `test('rejects a message longer than the
  budgeted size')`, not `test('validate')`. Given/When/Then in three lines inside.
  `[enforced: review]`
- **TST-7 — Coverage is a diagnostic, never a target.** `MUST NOT` write assertion-free
  tests. Use it to find untested branches. `[enforced: review]`
- **TST-8 — Tests are ESM, `vitest` + `expect`, top-level `await` where a test needs it.**
  Test doubles live next to the file they stub; a test's fake is a module, not a global.
  Ephemeral state (an in-memory world, a temp data copy) is built in `beforeAll` and
  torn down in `afterAll`. `[enforced: vitest]`

## 14. Performance (PERF)

- **PERF-1 — Measure before optimizing.** `MUST NOT` optimize without a number and a
  repro. "Feels slow" is not a measurement; a timed loop with 100 samples is.
  `[enforced: review]`
- **PERF-2 — Correct and clear first.** `SHOULD NOT` trade legibility for speed unless a
  timed trace says the code is hot. Premature optimization buys nothing here and is the
  usual origin of unreadable code. `[enforced: review]`
- **PERF-3 — Watch allocation in hot paths.** Turn loops run thousands of times per
  session: `SHOULD` avoid per-token object churn, repeated `JSON.stringify` of unchanged
  structures, and regex recompilation inside loops. `[enforced: review]`
- **PERF-4 — Build maps, don't re-scan.** Data files are loaded once and indexed in
  memory (per entity/component id). `MUST NOT` linear-scan a loaded data file per turn.
  `[enforced: review]`
- **PERF-5 — Stream, don't buffer.** Long provider responses `MUST` stream; `MUST NOT`
  assemble a full response in memory before forwarding it (`A-4`). `[enforced: review]`
- **PERF-6 — Set budgets and enforce them.** Latency per route (`LLM_TIMEOUT_MS`),
  token budget per turn (named constant, `RP-8`), rate budget per client (`rateLimiter.js`
  20/60s), body cap (`MAX_BODY_LIMIT`) — written in config/`Constants.js`, checked in
  code, logged when exceeded (`SEC-9`, `A-7`). `[enforced: review]`

## 15. API and interface design (API)

- **API-1 — Command–query separation.** A method either does something (and returns a
  status or the changed value) or answers something (with no side effects). `MUST NOT`
  write `getAndMaybeCreate()`. `[enforced: review]`
- **API-2 — No temporal coupling.** `MUST NOT` require calls in an undocumented order
  (`init` then `use`). Return a ready object instead of a construct-then-configure one.
  `[enforced: review]`
- **API-3 — Least knowledge.** `MUST NOT` return a whole record when the caller needs two
  fields, and `MUST NOT` take an options bag of eight fields of which one is ever set.
  `[enforced: review]`
- **API-4 — Additive or nothing.** Public exported signatures change additively; a
  breaking change is a rename in place plus every caller fixed in the same commit, never
  a deprecated shim kept "for now". `[enforced: review]`
- **API-5 — Default to no default.** An implicit default that changes behavior surprises
  the reader. If a default exists, `MUST` state it in the signature's doc or `Constants.js`,
  and it `SHOULD` be boring. `[enforced: review]`

## 16. Documentation (DOC)

- **DOC-1 — Comment the why, never the what.** `MUST` comment constraints, invariants,
  workarounds, and non-obvious ordering. `MUST NOT` comment the code into restating
  itself. A comment that lies is worse than none — prefer a name over a comment.
  `[enforced: review]`
- **DOC-2 — Every public module has a short header:** what it owns, what it depends on,
  what it deliberately does not do. `[enforced: review]`
- **DOC-3 — Decisions get written down.** Any choice that will be argued later (data-file
  ownership, the seam list, prompt versioning, provider choice) gets a one-page record
  (`wiki/` decision notes / `AGENTS.md` note): context, decision, consequences, what was
  rejected and why. `MUST` write one when you add a dependency or change an architectural
  rule. `[enforced: review]`
- **DOC-4 — Docs live with the code.** `MUST` update `AGENTS.md`, `CODE_RULES.md`, or a
  module header in the same commit as the change that makes them stale. A stale doc is a
  bug with a long fuse. `[enforced: review]`
- **DOC-5 — Delegation passes pointers, never copies.** When work is handed to another
  agent, the handoff carries the document *path* and the instruction to read it, plus
  scope, goal and verification. `MUST NOT` inline a summary of `AGENTS.md` or
  `CODE_RULES.md` into a prompt, and `MUST NOT` quote either into the conversation —
  reference the rule ID instead. See `AGENTS.md` → Delegation to subagents. `[enforced:
  review]`

## 17. Git and review discipline (GIT)

- **GIT-1 — Commits are one logical change.** No "wip", no "fixes", no drive-by formatting
  (`CHG-8`). Imperative subject, ≤ 72 chars, scoped: `llm: retry 429 with jitter and
  deadline`. English + ASCII only. The `commit-msg` hook enforces the mechanical half —
  non-empty, ≤ 72 chars, no trailing period, ASCII only, no placeholder (`update`, `fix`,
  `wip:`, `fixup!`, `changes`, `stash`). Whether the subject is *true* and the commit
  really is one change stays with review. `[enforced: hook + review]`
- **GIT-2 — The diff is the unit of review.** `MUST NOT` land a diff that cannot be read
  in one pass; split mechanical changes (renames, moves) from behavioral ones.
  `[enforced: review]`
- **GIT-3 — Green before commit and before push.** `pre-commit` runs the fast gate
  (`npm run lint` + `npm run check:lang`) on every commit; `pre-push` runs the full
  gate (`npm run check`: lint + language guard + all tests) as the net for
  `--no-verify` commits. A red gate never becomes "I'll fix it in the next commit".
  Bypassing requires `--no-verify` and needs a waiver entry (see Waivers). A gate that
  cannot run (missing `node_modules/`) blocks too: "could not check" is never "checked".
  `[enforced: hook]`
- **GIT-4 — The reviewer's default answer is no.** A change must argue for itself.
  Approving a rule violation without recording the waiver makes the next reviewer's job
  impossible. `[enforced: review]`
- **GIT-5 — Never commit generated or ignored artifacts** (see `AGENTS.md` — the
  `.gitignore` list), and never amend a pushed commit. `[enforced: review]`

## 18. Known anti-patterns (AP)

Recognize these on sight — they are the recurring failure modes of Node/TypeScript chat
backends, and each one converts a small mistake into a long debugging session.

- **AP-1 — Boolean-flag parameter / flag argument explosion** (`render(x, true, false)`)
  → two functions (`CHG-4`).
- **AP-2 — Optional-field soup instead of a union** (`{ text?, toolCall?, image? }`) →
  discriminated shape (`T-3`).
- **AP-3 — `catch` that logs and returns a default** → silent data corruption (`E-2`).
- **AP-4 — A `null` that means three different things** → distinguish deliberately, or
  a union of explicit states.
- **AP-5 — Reaching through a chain of collaborators** (`world.state.items.get(id)`) →
  ask the right object (`B-6`).
- **AP-6 — Global mutable singleton** (`config` anyone can write) → frozen config,
  injected (`T-9`, `B-3`).
- **AP-7 — God object named `*Controller`/`*Manager`** → find the responsibilities it
  hides (`NAME-2`).
- **AP-8 — `await` inside a loop when the operations are independent** → deliberate
  batching (`A-5`).
- **AP-9 — Retry without jitter, cap, or idempotency check** → self-inflicted outage
  (`E-6`).
- **AP-10 — String-matching an error message** (`err.message.includes('not found')`) →
  typed error with a `code` (`E-1`).
- **AP-11 — Sleep to let something happen** → wait for the real condition (`TST-2`).
- **AP-12 — An unchecked raw value passed straight through** → narrow it at the boundary
  (`T-1`, `T-2`).
- **AP-13 — Business logic in the route handler** → use-case layer (`H-5`, `B-7`).
- **AP-14 — Unbounded in-memory cache** → size + eviction policy decided now (`A-7`).
- **AP-15 — Reading a data file in a hot loop** → load once, index in memory
  (`P-4`, `PERF-4`).

---

## Waivers

A `MUST` is bypassable only by writing it down, so the exception is visible to the next
reader:

1. Inline: `// waiver: <CAT-N> — <reason and the condition that would let us remove it>`.
2. It ships with a test or a follow-up; a waiver without a removal condition is a rule
   change, and then change the rule here instead (with a decision note, `DOC-3`).
3. Two waivers on the same rule in the same module means the rule is wrong for this
   codebase — raise it, do not accumulate the third.
4. Skipping the gate counts as a waiver and needs the same record. Both paths are loud
   by design: `git commit --no-verify`, `git push --no-verify`. The `pre-push` hook runs
   the full gate again, so a skipped commit is caught before it leaves the machine —
   treat the push as the moment to fix it. A gate that cannot run (missing `node_modules/`)
   blocks too.

## Definition of done

A change is done when, in this order:

1. `npm run lint`, `npm run check:lang`, `npm test` are green (`GIT-3`). (`npm run check`
   is the single command; there is no typecheck and no format step in this repository.)
2. The behavior was actually exercised — a real request over Express/Socket.IO, a real
   LLM turn against a fake seam, or a test that would fail if you broke it. "It lints"
   is not verification.
3. New/changed behavior has a test; new bug fixes have their reproducing test (`TST-5`).
4. Docs touched: `AGENTS.md`, `CODE_RULES.md`, or a module header / decision note if a
   rule or decision changed (`DOC-4`).
5. No new dependency, or the `SEC-8` vetting is in the commit message.
6. Diff contains only files the change needed to touch (`CHG-8`).
7. You can name the next change this makes easier — or you have deleted the abstraction
  that speculated about it.

## What this document deliberately does not contain

No style opinions that a formatter would settle (there is no formatter here). No rules
about tools we do not use. No TypeScript-specific checks (there is no type checker). No
aspirational architecture ("when we have 10k users…") — every rule here is justified by a
cost we would pay in the first months of this project's life. If a rule cannot meet that
bar, it does not belong here; add it as a decision note (`DOC-3`) when the need arrives.
