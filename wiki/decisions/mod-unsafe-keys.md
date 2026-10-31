# Decision: A mod package may not carry `__proto__`, and the refusal is package-wide

Date: 2026-10-31 (recorded in the commit that implements this)

## Context

`wiki/decisions/mod-system.md` decision 1 makes one promise and the whole mod system rests
on it: a mod is DATA ONLY, no code is read, imported or executed. That is what makes it safe
to drop a directory from somebody else into `data/mods/`.

The promise has a hole, and it is not in the "no code" rule. It is in the merge that rule
made necessary.

`JSON.parse` creates an **own** enumerable `__proto__` key:

```js
const parsed = JSON.parse('{"a": {"__proto__": {"pollutedByMod": true}}}');
Object.keys(parsed.a);        // ["__proto__"]  - an own key, walking it finds it
Object.prototype.pollutedByMod; // undefined     - not yet
mergeRegistryPatch({ a: {} }, parsed);
Object.prototype.pollutedByMod; // true          - after
```

The recursive merge asks a reasonable question — "does this key already exist here, and is it
an object, so I can patch into it?" — and for `__proto__` the answer is yes. `target[key]`
does not return `undefined`, it returns `Object.prototype`, which is a plain object by every
test the merge applies. So the merge does what it was told and writes into the ancestor of
every object in the process.

What that buys an author is not one property. Once `Object.prototype` carries a key, every
`hasOwnProperty` check in the server answers for every entity, the client renders a phantom
definition on every anonymous entity card, and any `for..in` or prototype-escaping read
in the process sees the value. A package of pure JSON changed program-wide semantics without
executing a line of code. It is the same class of bug as the `data-*` attribute confusion in
the client (`dataset.__proto__` resolves to the prototype instead of the `data-__proto__`
attribute): one language subtlety, hit in three places, none of them malicious-looking.

Two things about the existing code are worth recording, because they explain how this got
past review.

`mergeRegistryPatch` skips top-level keys beginning with `_`, for `_comment`-style headers.
That skip happens to reject a top-level `__proto__`. It was never a security rule, and
`mergeNested` drops it deliberately — the comment says so, and says the right reason: a
`_`-prefixed key *inside* a definition is data, not a file header. So the only thing standing
between a third-party file and `Object.prototype` was a readability filter, and it was
switched off exactly where the recursion goes deep.

And the obvious repair does not work. Tightening `isPlainObject` so that "a plain object"
means "an object whose prototype is `Object.prototype` or `null`" — the textbook way to spot
a host object — still accepts `Object.prototype`, because its prototype is `null`. The
recursion walks straight in. **The check has to be on the key, not on the value.** That is
the single most load-bearing fact in this note, and it is why the guard is a name test and
not a type test.

## Decision

### 1. The key is refused at every write site, in the merge itself

`__proto__`, `constructor` and `prototype` are never definitions. All three assignment sites
in `src/services/ModLoader.js` skip them: `mergeRegistryPatch` (top level), `mergeNested`
(every level below), and `deepClone` (where the first contribution is copied — assigning
there would set the clone's prototype rather than a property).

The guard lives in `ModLoader.js` and is not extracted. `CODE_RULES.md` `CHG-2` says do not
abstract the first time a shape appears, and this is the first time. If a second module ever
merges third-party JSON, it extracts then, with two callers to check the abstraction against.

### 2. The edge refuses the package, not the file

`build()` reads **every** content file of a package before merging any of it, scans each for
the three keys (`findUnsafeKeys`), and refuses the whole package when one is found. The
refusal cannot be decided after the merge, because `mergeRegistryPatch` mutates the
accumulated candidate in place — a change of mind would have to un-merge.

Package-wide rather than per-file is the deliberate half. A file that cannot be read is an
accident, and the cost is that one kind; the mod's other files are what their author wrote
and they land. A poisoned key is not an accident, it is a property of the package, and
half-installing a refused package ships the half that was not refused — which is the
"shipping half a package set" failure `mod-system.md` already refuses for `requires`.

The scan walks iteratively, never recursively: it descends a file nobody validated, and a
recursive descent would add a stack-overflow surface of its own. Findings are capped
(`MODS.md`, `A-7`), and the cap is reported as truncated rather than going quiet.

### 3. A refusal is reported, never silent

Every kind of a refused package is named in `invalid` with `MOD_UNSAFE_KEY` — including the
kinds of that package which are perfectly fine, because a silence there reads as an install.
Each finding is additionally reported with its location (`$` as the file root, so
`$.knife.detail.__proto__`) under a new `unsafeKeys` field on `build()`, on
`ModService.plan()` and on the `applyNow()` report, and warned by `Logger`.

This is the same discipline the module already applies to shadowing, quarantine and blocked
requirements. `normalizeRegistryContent` in this file states the principle and rejects the
alternative out loud: silently discarding content somebody wrote is the failure the module
exists to avoid. A silent `continue` on an unsafe key would have been exactly that.

### 4. Not extended to manifests, and not extended to the client

Manifests are narrowed field by field in `parseManifest` and never merged, so a `__proto__`
in `mod.json` is inert. Scanning it would refuse packages for a key that cannot do anything,
which spends the one thing this change buys — trust that a refusal means something.

The client is not touched here. The `dataset.__proto__` bug in `public/js/entities.js` is the
same language subtlety hit from the other side, is not reachable by this fix, and is its own
change.

## Alternatives considered

- **Harden `isPlainObject` instead.** The intuitive repair, and it does not work:
  `Object.getPrototypeOf(Object.prototype)` is `null`, so a value-side test still admits
  `Object.prototype` and the recursion still enters it. Rejected as unsound, not merely
  worse.
- **A `JSON.parse` reviver that deletes the key.** Pushes the rule into the reader, where
  nothing else about mod content is validated, and it would silently rewrite content for
  every other consumer of `DataLoader`. `B-3` keeps the reader dumb for a reason.
- **Freeze `Object.prototype` at boot.** Would blunt this one vector and change semantics for
  every module in the process, including the ones that do not deal with untrusted data. A
  world-wide side effect to fix a data-path bug is the wrong shape of fix.
- **Throw on an unsafe key.** Decision 6 of `mod-system.md` exists to stop one bad directory
  from bricking a server. A hostile file is precisely the input that rule was written for.
- **Skip only the offending kind.** Cheaper, and it leaves the package's clean files
  installed. Rejected above: it installs the part nobody refused.
- **Drop it silently.** Three lines, and the operator never learns that a package they
  installed is malformed or hostile. Rejected by the module's own stated principle.

## Consequences

- A new machine-readable code, `MOD_UNSAFE_KEY`, joins the `invalid` codes in `MODS.md`.
- `build()`, `plan()` and the apply report carry one more field. The 21 shipped packages were
  checked and none of them uses these keys, so nothing official is refused by this and no
  boot behaviour changes.
- The three merge guards are now load-bearing for a security property, and the regression
  tests pin them: `test/unit/ModLoader.test.js` walks a real `__proto__` through
  `mergeRegistryPatch` and through a full `build()`, and asserts `Object.prototype` is clean
  afterwards. Before the fix those tests failed with `expected true to be undefined`.
- A guard that nothing can break is not pinned, so each layer of this defense was deleted on
  its own and the suite checked for the scream: `mergeNested` (5 fail), `deepClone` (1), the
  edge scan (7), all of it at once (11). That run found two layers the suite could not see,
  and they are pinned now — the top-level guard, whose failure mode is not pollution at all
  but a registry holder gaining an own key named `constructor` (which the store would then
  hold as a definition, and which no prototype-clean assertion can see), and the scanner's
  descent into arrays, whose payload arrives through `deepClone` and so would install
  unreported. Recording the mutation numbers is the point: they are how the next reader tells
  which guard a given test is protecting.
- Two known warts left in place, both pre-existing and both out of this change: `GET /mods`
  reports discovery-level `invalid` only (so `MOD_UNSAFE_KEY`, found at build time, shows up
  in `plan` and `apply` and not in the list view), and `applyNow()`'s `mods:` count counts an
  enabled-but-refused package as a mod.
- The security finding that `POST /mods/plan` is unauthenticated and write-limited only at
  `/mods/apply` is untouched. This change makes the plan report more honest; it does not make
  the plan cheaper to invoke.
