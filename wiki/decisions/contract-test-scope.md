# Decision: a contract pin scopes to the shipped package set, never to the install directory

## Context

Three tests were red on a developer machine and green in CI:

- `test/contract/actionProse.contract.test.js` — the allowlist of actions that speak
  instrumentally, against the live action registry;
- `test/contract/worldStateController.contract.test.js` — the action-name snapshot in
  `(b2) getActionsForEntity() shape`, against the live controller;
- `test/integration/modServiceIntegration.test.js` — the mod order assertion, against
  the live `ModService` view.

All three read `data/mods/` through the real loader. `data/mods/` is not a fixture: it
is an install directory, gitignored with only the `core-*` packages re-included
(`.gitignore`). One locally authored package on that machine — `system-fire-punch`,
which adds an action with a `prose.instrumental` entry and carries no entry in
`loadorder.json` — was enough to fail all three.

The failing assertion in the first two was written to be strict: *"a new entry has to be
named here too, so an act cannot start claiming an instrument on its own."* That intent is
right, and it survives. What was wrong is the population it quantified over. An
`AGENTS.md`-level contradiction made it visible: adding content at runtime is the
product's central feature (`wiki/decisions/mod-system.md`), so a gate that turns red when
somebody installs a mod treats the feature as a defect. The suite was pinning this
repository's content while reading somebody's laptop.

The third failure was a different bug wearing the same clothes, and scoping would not
have fixed it. That assertion compared the mod list to a plain string sort:

```js
expect(mods.map((mod) => mod.id)).toEqual([...mods.map((mod) => mod.id)].sort());
```

The loader's promise is not the alphabet. `sortModsForLoad`
(`src/services/ModLoader.js`) sorts by `loadOrder` ascending with ties broken by id.
`DEFAULT_LOAD_ORDER` is `1000`, and `core-actions` is at `1000` in
`data/mods/loadorder.json`, so a package nobody ordered ties with it and loads
*second* — while a string sort puts it last. The two orders are different promises, and
that test had silently substituted one for the other. It was already wrong before any
overlay existed; the overlay only made it visible.

## Decision

### 1. A contract pin quantifies over the shipped set

The assertions that speak for *this repository's content* — registry allowlists, action
name snapshots, prose wording, per-kind counts — run against a world built from the
official packages only. The scope is the loader's own `official` flag, derived from the
reserved `core-` prefix (`isOfficialModId`), never from a manifest field: an overlay
cannot claim its way into the shipped set, and a new `core-*` package joins the scope by
existing, with no allowlist to update.

`test/helpers/officialPackageWorld.js` is the single place that expresses it:
`officialOnly(discovered)` (the filter), `OfficialPackageModLoader` (a `ModLoader` whose
`discover()` applies it), and `buildOfficialWorld(tickSystem?)` (the composition root,
fed through its existing `modLoader` option). No production code changed, and none knows
a test exists.

### 2. `ModService` stays scoped to the install directory, because that is its job

The boundary matters as much as the scope. `ModService` answers "what is installed
here", and a service view scoped to `core-*` would stop testing what the service does.
So `test/integration/modServiceIntegration.test.js` keeps its unscoped world: it asserts
the official subset *of* a real install, and asserts the whole install where the
whole install is the subject.

### 3. Order is asserted as `(loadOrder, id)`

```js
const loadOrder = sortModsForLoad(service.discover().discovered)
    .map((mod) => mod.manifest.id);
expect(mods.map((mod) => mod.id)).toEqual(loadOrder);
```

The service's public view agrees with the loader's exported comparator, for everything
installed, overlays included. The property "the loader's order is not the alphabet" is
pinned in `test/contract/officialPackageScope.contract.test.js`, where it can be
pinned deterministically — with a fabricated package whose `loadOrder` makes the two
disagree. Asserting it against a real install would depend on what that machine happens
to have, which is the defect being removed.

### 4. The proving test fabricates its overlay; it never writes into `data/mods/`

`test/contract/officialPackageScope.contract.test.js` injects a third-party package in
memory (a `ModLoader` subclass that appends one entry to `discover()` and answers
`_readPackage` for it) and asserts four things: the overlay reaches an unscoped build —
so the pin was genuinely at risk, not vacuously safe; the official scope drops it from
both the definition and the composed world; an overlay shadowing an official key cannot
move a shipped value into a scoped world; and the load-order promise holds whatever the
overlay carries.

Writing the fixture package into `data/mods/` was rejected (below).

## Alternatives considered

- **Add the overlay's action to the allowlists.** Rejected: it makes the shipped set
  mean "whatever this machine has", and the next machine with a different mod is red
  again.
- **Filter the assertions by a hardcoded list of official ids.** Rejected: 22 ids
  duplicated per test file, desynchronising the moment a `core-*` package is added —
  a second source of truth for a fact the loader already derives.
- **An `onlyOfficial` option on production `ModLoader`.** Rejected: an option only the
  suite uses is an abstraction born of test convenience (`CHG-1`), and it puts a
  test-time privilege in the code path that serves players.
- **Write a temporary package into `data/mods/` in `beforeAll`.** Rejected: invisible in
  CI (the directory is gitignored, so the test would assert nothing where it is meant to
  protect), and a crashed run leaves residue in a real user's world. Reuse the loader
  seam with an in-memory package instead — same assertion, every machine, nothing to
  clean up (`TST-2`).
- **Treat an installed overlay as unsupported and require the directory be clean.**
  Rejected: that is a waiver against the product's central feature, and a gate nobody
  can run while using the thing it tests is not a gate.

## Consequences

- The three tests are green with an overlay installed, and stay green without one: the
  proof no longer depends on the machine running it.
- The non-vacuity of the fix is mechanical. Neutralizing `officialOnly` (returning
  `discovered` unchanged) fails 5 tests — 2 of them the original bug reports and 3 in
  the new contract file. A scoping helper that three tests fail without is not dead
  weight.
- `test/helpers/` is a new directory, and a rule of thumb came with it: a helper is
  created on the third occurrence (`CHG-2`), and this one has exactly three call sites.
- Contract pins no longer catch an overlay that *shadows* shipped content on this
  machine. That was never their job, and it is not lost: `GET /mods` reports every
  shadow with both owners (`ModLoader`'s `shadowed`), and
  `test/integration/modServiceIntegration.test.js` pins that report verbatim against the
  loader. A pin guards the shipped words; the endpoint guards the install.
- Any future pin over `data/mods/` should reach the same conclusion by the same route.
  `test/contract/officialMods.contract.test.js` stated the principle first; this note and
  the helper make it reusable instead of a copyable comment.
