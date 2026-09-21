# BUG-139: Hand shotgun two-handed contract test flaked ~20% of runs — clamped-loss contract excludes cascade-removed existence

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `—`
- **Related Files**: `test/contract/handShotgunRandomSpread.contract.test.js`, `src/controllers/consequences/DamageConsequenceHandler.js`

## Symptoms

The `two-handed shot (multi-attacker path)` contract test failed roughly 1 time in 5 on otherwise-green commits (random CI red), with:

```
AssertionError: sum of per-hand reported losses equals the victim's actual loss
expected 2.62 to be close to 23 (tolerance 0.005)
```

The reported loss (sum of both hands' clamped per-pellet losses) differed from the victim's measured existence delta by **units**, not the ~1e-4 float noise the test's own comment blamed for an earlier flake (a previous fix had relaxed the tolerance from 3 to 2 decimals, which cannot explain a 20-unit gap).

## Root Cause

Two design facts collided in that one test:

1. **The clamped-loss billing contract** (documented and asserted by the `over-shreds a low-existence component` test): a pellet charges at most the target's *prior* existence, and the `removeBrokenComponent` break cascade that follows a broken component removes its dependents **without billing them** — `data.totalLoss` covers directly-struck components only (`hitIds`), by design.
2. **The two-handed test's false premise**: it asserted `Σ per-hand totalLoss == the victim's total existence loss across ALL components`, and its comment assumed the m1Droid "survives 6 pellets". It is a single-pellet value of ~0.65–0.69 per pellet against that droid's weakest components, and each hand samples 3 of 23 components *without replacement within the hand but with replacement across hands* — so a leg/head/central body can be struck **twice** (0.65 + 0.65 > 1.0) and break. The central body is the root parent: breaking it cascades to the **entire** droid (all 23 components removed). The test's before/after then counts every removed component's full 1.0 existence as "actual loss" (up to 23.0), while `totalLoss` legitimately bills only the directly-struck clamped losses (~3.5) — a multi-unit gap, hence the failure.

A second, latent problem in the same test: it claimed in its header comment that the spread RNG was "fully pinned", but **no pin existed for that test** (`DamageConsequenceHandler._randomFn` defaults to real `Math.random` in its constructor; only the other tests in the file pin it). So the test sampled with the live RNG, and the lethal-sampling outcome (≈20%) drove the flake.

The damage numbers themselves are fully deterministic (static per-component resistances × static per-pellet value) — the only randomness is *which* components the 6 pellets strike.

## Fix

- **`DamageConsequenceHandler._handleRandomComponentDamage`** now reports the uncharged cascade mass: it snapshots every component's existence before the pellet loop and, after it, sums the existence lost by components **not** in `hitIds` (the cascade-removed dependents) into a new additive `data.cascadeLoss` field. `totalLoss` semantics are unchanged (the over-shred clamped-billing contract is preserved verbatim); the result payload is now fully reconcilable: `totalLoss + cascadeLoss = the victim's true existence delta`.
- **The two-handed test** was rewritten to the invariant that actually holds for *any* sampling outcome: `Σ per-hand (totalLoss + cascadeLoss) ≈ the victim's actual total loss` (2-decimal tolerance for the per-hand `round3` noise), plus a monotonicity check (direct-billed ≤ actual loss, modulo rounding) and a post-shot coherence check (the victim either retains living components or is fully shredded/despawned — both legitimate). The misleading "RNG fully pinned" header comment was corrected to describe what is actually pinned where.

No change to the damage math, the cascade, or the clamped-billing semantics: the reported *direct* loss was correct all along; the cascade mass was simply unreported, and the test demanded an equality the design never promised.

## Prevention

- A contract test that compares a *reported* quantity against *measured* world state must use the same accounting semantics as the code under test. When the code deliberately excludes a side effect from a report (here: cascade removals), the test may only compare the report against the matching measured subset — or the report must carry the excluded mass as its own field (as now, `cascadeLoss`).
- A test that claims to pin an RNG seam must actually install the pin (the handler's `_randomFn` is set unconditionally in its constructor; a pin belongs in the test body, not in a comment).
- Invariants that "happen to hold" on the common non-lethal outcome but silently depend on a world that never breaks are flake-by-construction; prefer invariants that are algebraically true for every outcome (telescoping sums, reconciliations) over equalities that hold only while nothing dies.

## References

- `BUG-113` — the multi-attacker consequence dispatch this test guards (two-handed shot was a silent no-op before that fix).
- The `over-shreds a low-existence component (clamped loss + break cascade)` test in the same file — the authoritative statement of the clamped-billing contract preserved by this fix.
