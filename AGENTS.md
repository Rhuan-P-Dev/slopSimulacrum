# AGENTS.md

Instructions for coding agents. Read this before making any change in this repository.
When it and `CODE_RULES.md` disagree on *how to run things*, this file wins; on
*how code must be written*, `CODE_RULES.md` wins.

## Project

`slopSimulacrum` is a persistent, data-driven world simulation in which LLM agents live
as NPCs. Droids (and the LLMs driving them) roam rooms, carry inventory, craft items,
take damage, lose components, burn coal to stay alive, and act in turns — all governed
by **JSON data files, not code**.

The server is the product: a Node.js/ESM core with an **Express 5 + Socket.IO** API and
a thin single-page browser client. The client is disposable by design — every rule of the
world lives server-side.

## Language policy (hard rule)

**Everything committed in this repository is written in English — no Portuguese, no accented letters.** Code, identifiers, file names and commit subjects are ASCII. This applies to:

- identifiers, function names, file names
- all code comments, `TODO`/`FIXME` notes
- commit messages, branch names, PR titles and descriptions
- documentation (`README.md`, `AGENTS.md`, `CODE_RULES.md`, module headers), error
  messages and log messages
- test names and assertion messages

The codebase carries an automated language guard — **`check:lang`**
(`scripts/check-pt.mjs`) — which fails the gate when it finds Portuguese in the committed
tree. It detects (a) accented Latin letters (the Portuguese diacritics on the vowels and c, and their uppercase forms) and
(b) a curated list of unambiguous Portuguese words, word-boundary and case-insensitive.
The scanner skips only: `node_modules/`, `.git/`, `coverage/`, `src/lint-fixtures/`
(counter-examples, pinned by `test/lint-rules.test.js`), and itself plus its regression
test.

A second, narrower guard — **`cr/no-accented-text`** (an ESLint rule, `tools/eslint-rules.js`)
— rejects accented Latin letters in server (`src/`) and shared (`shared/`) source, and
the `commit-msg` hook rejects **non-ASCII commit subjects**.

The one exception: user-authored world content (card JSON, NPC dialogue, chat text typed
by end users) is never translated, rewritten or language-filtered. Local planning notes and
`wiki/` are gitignored working artifacts, not part of the committed gate.

Do not introduce Portuguese or non-ASCII into source, comments or docs, even when the
surrounding conversation happens in another language. If you find non-English content in a
committed file, translate it in a separate commit that touches nothing else.

## Stack (this repository)

- **Runtime:** Node.js 20.19+ (22+ recommended). There is **no `engines` field**, so do
  not assume anything below 20.19. There is no build step: `src/` is the source of truth
  and you run it directly with `node` / `node --watch`.
- **Language:** plain ES2023+ **JavaScript**, ESM (`"type": "module"` in `package.json`).
  **There is no TypeScript, no `tsc`, no type-check step, and no type-aware linting.**
  The "types" in `CODE_RULES.md` mean the *runtime contract* (module exports, value
  shapes, light JSDoc), not a type system.
- **Runtime dependencies:** exactly three, all deliberate — `express` (the REST/HTTP
  surface), `socket.io` (the realtime channel), `dotenv` (loads `.env` at boot).
  **LLM access goes through plain `fetch` against an OpenAI-compatible chat-completions
  endpoint — there is no LLM SDK dependency.** Do not add one to "simplify" a call.
- **Dev dependencies:** `@eslint/js`, `eslint` (v10 flat config),
  `eslint-plugin-unused-imports`, `vitest` (^4) and `@vitest/coverage-v8`. That is all.
- **Lint:** `ESLint 10` flat config (`eslint.config.js`) built from `@eslint/js`
  recommended + `eslint-plugin-unused-imports` + a **local plugin** `cr/*`
  (`tools/eslint-rules.js`, no npm dep) that encodes the house rules. See below.
- **Formatting:** **none.** There is no Prettier, no `.prettierrc*`, and no
  `format`/`format:check` script. Formatting is by hand / via the editor. Do not add
  a formatter without a recorded decision; do not bulk-reformat files your change does
  not touch (`CHG-8`).
- **Bundler:** none. Run with `node --watch src/server.js` (dev) and `node src/server.js`
  (prod). No `dist/`.
- **Persistence:** **JSON data files** under `data/`, loaded through the data seam
  (`src/utils/DataLoader.js`). There is **no SQLite, no database, no ORM, and no
  migration system** (`CODE_RULES.md` §Persistence/Data files). Forward changes to data
  schemas are versioned in the file, not run through a migration runner.
- **HTTP framework:** Express 5 + Socket.IO is the agreed surface. If you want to replace
  it, that is a discussion and a decision, not a refactor (stack-level prohibition, see
  §Rules).

## Commands

Implemented in `package.json` (run `npm run help` — not present, so just read the
scripts block):

```bash
npm run dev             # node --watch src/server.js
npm start               # node src/server.js
npm test                # vitest run  (test/{unit,contract,integration}/**)
npm run test:watch      # vitest (watch)
npm run test:coverage   # vitest run --coverage
npm run test:coverage:ci# vitest run --coverage (CI)
npm run lint            # eslint . --ignore-pattern 'src/lint-fixtures/**'
npm run lint:fix        # eslint . --fix --ignore-pattern 'src/lint-fixtures/**'
npm run check:lang      # node scripts/check-pt.mjs   (no Portuguese in the tree)
npm run lint:rules      # vitest run test/lint-rules.test.js  (pins the cr/* rules)
npm run check           # npm run lint && npm run check:lang && npm test   (the whole gate)
npm run prepare         # git config core.hooksPath .githooks (runs on npm install)
```

Run `npm run check` before calling any task done. `npm test` already includes
`lint:rules`, so a rule that stopped firing fails the suite — the enforcement claims in
`CODE_RULES.md` are checked, not assumed. `npm run lint:rules` runs only that fixture
pin.

The gate is deliberately **three steps**, not four, because this codebase has no type
system and no formatter:

- **`npm run lint`** — ESLint (incl. the local `cr/*` rules) — catches the four CR
  rules that are mechanical here (`cr/fetch-requires-signal`, `cr/no-direct-file-read`,
  `cr/no-accented-text`, `no-console`) plus unused imports, `no-undef`, `no-unused-vars`.
- **`npm run check:lang`** — the Portuguese/accent guard across the tree.
- **`npm test`** — the full vitest suite (unit + contract + integration) and the
  fixture pin.

## Lint and config

Committed as `eslint.config.js` and the local plugin `tools/eslint-rules.js`. Shape,
abridged:

```js
import js from "@eslint/js";
import unusedImports from "eslint-plugin-unused-imports";
import crRules from "./tools/eslint-rules.js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { /* process, fetch, Buffer, setTimeout, vitest globals, … */ },
    },
    plugins: { "unused-imports": unusedImports },
    rules: {
      "unused-imports/no-unused-imports": "error",
      "no-unused-vars": ["error", { vars: "all", args: "after-used",
        argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
    },
  },
  { files: ["public/**/*.js"], /* browser globals; no-console off in the client */ },
  {
    // The house rules (CODE_RULES.md). Scope: server + shared source.
    plugins: { cr: crRules },
    files: ["src/**/*.js", "shared/**/*.js"],
    rules: {
      "cr/fetch-requires-signal": "error",   // CR E-5
      "cr/no-direct-file-read": ["error", { allowedFiles: DATA_SEAM_FS_FILES }], // CR B-3
      "cr/no-accented-text": "error",        // CR NAME-1
      "no-console": "error",                 // CR OBS-1
    },
  },
  { files: ["src/utils/Logger.js", "shared/RangeResolver.js"], rules: { "no-console": "off" } },
  { ignores: ["node_modules/", "coverage/", "data/", "wiki/", "plans/", "docs/"] },
];
```

The `cr/*` block is the mechanical heart of `CODE_RULES.md`. `cr/no-direct-file-read`
keeps `fs` out of the whole tree except the **data seam** — `src/utils/DataLoader.js`,
`src/utils/PngCharaReader.js`, `src/controllers/logic/CardSpawnLogic.js` (listed as
`DATA_SEAM_FS_FILES`). `no-console` is off only in `src/utils/Logger.js` (it *is* the
logging utility) and `shared/RangeResolver.js` (pure client-side geometry).

Rules for the config itself:

- ESLint owns correctness; the *reader* owns formatting. If you add a rule, add the
  fixture first (`src/lint-fixtures/`), then the rule, then its scope entry — one commit.
  `test/lint-rules.test.js` then proves it still fires (`npm run lint:rules`).
- A rule that stops firing on its fixture is a broken commit, not a passing one.
- Never drop a fixture to make a rule "quiet"; loosen the rule itself in `tools/eslint-rules.js`.
- `eslint-disable` in source needs the rule name and a reason on the same line. A
  blanket `/* eslint-disable */` at the top of a file is forbidden.
- The `src/lint-fixtures/` directory is *deliberately non-green*: it holds one violation
  per rule. `npm run lint` excludes it with `--ignore-pattern`; the language guard
  (`check:lang`) excludes it via `SKIP_DIRS`. It is not application source.

## Layout

```
src/
  server.js             # entry: express app + socket.io + middleware + routes
  routes/               # one Express router per API domain (chat, actions, world, …)
  controllers/          # business logic, grouped core/ networking/ traits/ logic/ actions/
  services/             # long-lived service objects
  composition/          # the composition root: world -> controllers -> server bootstrap
  utils/                # helpers (Logger, DataLoader, rateLimiter, idGenerator, …)
  lint-fixtures/        # programs that MUST fail the lint — see test/lint-rules.test.js
shared/                 # pure modules imported by both client and server (RangeResolver,
                        #   SocketProtocol, IdPrefixes, …)
public/                 # SPA client: index.html, js/, css/  (disposable; linted, no-cr)
test/                   # vitest .test.js in test/{unit, contract, integration}/
tools/
  eslint-rules.js       # local cr/* ESLint plugin (CODE_RULES.md); no dependencies
scripts/
  check-pt.mjs          # Portuguese language guard (check:lang)
data/                   # JSON world data (gitignored: cards are user-supplied)
```

- `src/server.js` wires the Express app; `src/composition/` is where collaborators are
  built and injected. Business logic belongs in `controllers/`, not in route handlers
  (`H-5`, `AP-13`) and not in `utils/`.
- The data seam (`B-3`) is the only place `fs` is imported: `src/utils/DataLoader.js`,
  `src/utils/PngCharaReader.js`, `src/controllers/logic/CardSpawnLogic.js`. Add a new
  reader there and extend `DATA_SEAM_FS_FILES` in `eslint.config.js` in the same commit.
- Import always with the **`.js` extension** from `.js` files (required by ESM). There is
  no `index.js` barrel re-exporting a directory — import the specific module.
- `shared/` holds only modules both sides can import without Node or browser globals
  (pure geometry, protocol constants, id schemes).

## Rules

**How code must be written is governed by [`CODE_RULES.md`](./CODE_RULES.md).** Read it
before writing code. It holds the normative rules by category — changeability, naming,
contracts, boundaries, errors, async, determinism, data files, security, observability,
the NPC/LLM domain, HTTP, testing, performance, interface design, docs, git, anti-patterns
— plus the waiver process and the definition of done.

This file keeps only what is needed to operate the repository: stack, commands, toolchain
config, layout, and the hard rules below. It deliberately does not restate
code-quality rules — two documents saying the same thing is how both rot. If you find a
rule duplicated here, delete it here and keep it in `CODE_RULES.md`.

Two stack-level prohibitions, since they are decisions rather than code style:

- **No new runtime dependency** without the vetting in `CODE_RULES.md` `SEC-8`. The
  runtime set (express, socket.io, dotenv) is already paid for; do not spend more on it.
- **No replacement of the Express 5 + Socket.IO surface** (and no swap of LLM access
  to an SDK) on your own initiative. The `fetch`-against-an-OpenAI-compatible-endpoint
  choice is deliberate; overturning it is a discussion and a decision, not a refactor.

## Ambiguity: ask, do not guess (hard rule)

Applies to every agent working in this repository, including subagents spawned by
another agent.

A wrong guess is more expensive than a round trip: the diff looks finished, passes
`npm run check`, and is wrong in exactly the way the gate cannot see — the gate checks
that the code is well built, never that it is the code that was asked for.

- **Ask before acting.** `MUST NOT` act on a requirement that has more than one reading.
  Stop, ask, wait for the answer, then implement. This holds for guesses that would be
  cheap to undo as well: a reversible wrong guess is still work nobody asked for, and it
  lands in the history of the file.
- **What counts as ambiguous.** Two readings that would produce different diffs; scope
  nobody stated (which files, which controller, are tests in this change); an instruction
  that conflicts with `AGENTS.md`, with `CODE_RULES.md`, or with what the code already
  does; a `how` given without a `why`, where several `why`s are plausible; destructive or
  open-ended verbs that were not named exactly (`clean up`, `refactor`, `improve`,
  `remove the old one`); a success criterion nobody defined, which would leave `done` to
  be invented by us.
- **Read before you ask.** This rule forbids guessing at _intent_, not reading. Anything
  the repository can already answer — what the code does, what a command runs, what a rule
  says, what the last commit did — `MUST` be looked up and `MUST NOT` be asked. Work until
  the ambiguity is down to the one decision only the human can make, then ask about that
  one.
- **How to ask.** Ask before the code is written, not after it is delivered. Use the
  structured question tool when one is available, and put every open question in one call
  instead of a drip of them. Each question gets concrete options (2–4), what each one costs,
  and the recommended one first, labeled as recommended. With no question tool available,
  ask in the reply as a numbered list and stop there.
- **An answer is a decision, so write the decision down.** When the answer settles
  something that would be argued about later, record it in the same change — module header,
  `README.md`, or the relevant rule in `CODE_RULES.md`. The next agent should not have to
  ask again what this one settled.
- **A child that cannot ask, stops.** A subagent with no channel to the operator `MUST NOT`
  settle the ambiguity on its own initiative: it returns the ambiguity as a blocker — the
  question, the options it saw, the parts it left untouched — and the parent asks. Delegation
  moves the work, not the right to decide.
- **Silence is not an answer.** If nobody answers, the state is `blocked`, not `proceed
  with the obvious option`. Say what is blocked, what is waiting on it, and leave the code
  untouched. There is no obvious option; there is only the one that was not asked about.

This is not a license to stall. A requirement that is stated clearly gets implemented,
and the gate in `CODE_RULES.md` (Definition of done) is still what ends a task — this
rule governs what happens before the first line of an unclear change, not how the
clear ones are verified.

## Delegation to subagents

Applies to every agent working in this repository, including subagents spawned by another
agent.

- **Read these two files yourself, first.** Before touching code, open `AGENTS.md` and
  [`CODE_RULES.md`](./CODE_RULES.md) from disk. A delegated task that does not say so is
  still bound by them: they govern the repository, not the prompt that handed you work.
- **The parent does not copy the rules into the task.** `MUST NOT` paste, summarize or
  paraphrase the contents of these files into a subagent prompt, and `MUST NOT` quote them
  back into the conversation either — cite the rule ID (`CR E-5`, `CR B-3`, `CR NAME-1`).
  The ID is a few tokens; the prose behind it is not, and a prompt is re-sent on every
  turn while a file read happens once and can be dropped afterwards.
- **What a handoff contains:** the repository path, the files or directories in scope, the
  goal, how the result will be verified, and the instruction to read the two documents. Not
  their contents, and not a digest of the rules that happen to be relevant — the child
  decides relevance from the real file.
- **Why the copy is the bad option even when it looks shorter.** A pasted summary is a
  second source of truth that starts rotting the moment one rule changes here, and it
  silently degrades: the child never sees the rule nobody thought to repeat. Reading from
  disk gives the child the current text, the rule IDs it has to cite in a waiver, and the
  rules the parent forgot.
- **A child that cannot read them is a blocker, not a reason to inline the rules.** No
  read tool, wrong working directory, missing file: report it and stop. Do not work around
  it by smuggling the policy into the prompt.
- **Rules that cannot travel with the prompt still bind the work.** If a subagent result
  violates `CODE_RULES.md`, the parent fixes it or records a waiver (`CODE_RULES.md` →
  Waivers); delegation moves the work, never the standard.

## JavaScript / ESM configuration

`package.json`: `"type": "module"`. There is no `tsconfig` or build output. Modules are
ESM ES2023+; `ecmaVersion: "latest"` in the ESLint config. Node globals used by the
server (`process`, `fetch`, `Buffer`, timers, `structuredClone`) are enumerated in
`eslint.config.js` so `no-undef` stays on for real typos. Browser globals are enumerated
only in the `public/**/*.js` block. Imports always carry the `.js` extension.

## Git

- Branch `main`. **Never** commit `node_modules/`, `.env*` (except `.env.example`),
  `data/cards/*`, or the gitignored artifacts (`coverage/`, `plans/`, `docs/`, `wiki/`)
  — see the committed `.gitignore`.
- Format only the files your change touched. There is no formatter to batch-run; if a
  mechanical reformat is unavoidable, make it its own commit (`CHG-8`).

### Git hooks (`.githooks/`, committed)

`core.hooksPath` points at `.githooks/`, so the checks run on every commit and push from
any worktree — nothing external to install, no husky, no lint-staged. `npm install` runs
`prepare`, which sets the path, so a fresh clone is protected as soon as dependencies are
installed. Verify with `git config --get core.hooksPath`. On environments whose git does not pipe the commit message into the hook's stdin, `commit-msg` notes the gap and exits 0 rather than blocking; the subject contract is then covered by `pre-push`, CI, and review.

| Hook         | Runs                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `pre-commit` | the fast gate: `npm run lint` + `npm run check:lang` (lint + language guard, no tests)            |
| `pre-push`   | the full gate: `npm run check` (lint + language guard + all tests) — the net for `--no-verify`   |
| `commit-msg` | subject contract (`CR GIT-1` mechanical half): non-empty, ≤ 72 chars, no trailing period, ASCII only, no placeholder |

Escape hatches, both loud, both requiring a recorded waiver (`CODE_RULES.md` → Waivers):
`git commit --no-verify`, `git push --no-verify`. A failing check is fixed, not skipped;
skipping is for emergencies where the tree must land before the gate can be repaired. The
`pre-push` hook runs the full gate again, so a `--no-verify` commit is caught before it
leaves the machine — treat the push as the moment to fix it. A gate that cannot run
(missing `node_modules/`) blocks too: "could not check" is never "checked".

`.github/workflows/ci.yml` runs `npm ci`, `npm run lint`, `npm run check:lang`, and
`npm run test:coverage:ci` on Node 24 for pushes to `main`, pull requests, and manual
dispatch — the server-side net, because `git push --no-verify` skips the local hook. If the
client hooks and CI ever disagree, fix the hooks; the gate list itself lives in `npm run
check`.

## When finishing a task

Use the definition of done in `CODE_RULES.md`. Report which files changed, how you
verified (`npm run lint` / `npm run check:lang` / `npm test` / a real request over
Socket.IO), what was **not** verified, and any newly added dependency.
