# BUG-137: IC emitChannelDamage Dead in Production — spatial.position Shape Mismatch

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `e0cb1f2`
- **Related Files**: `src/controllers/core/InternalComponentController.js` (`_applyEmitChannelDamage`), `test/contract/worldRulesOnDamage.contract.test.js`

## Symptoms
The `corrosiveGland` internal component's documented corrosion tick (`data/internalComponents.json`: channel `corrosion`, every 10 ticks, range 50) was a **permanent silent no-op in production**. An installed gland corroded zero neighbors every interval, with no error and no dropped matter — the "overTime(emitChannelDamage): corrosion damaged N target(s)" log never fired. The defect only surfaced when a contract test seeded a phantom `spatial.position` field on the test entities to coax the range check into running; against the real entity store the range check resolved nothing.

## Root Cause
A **shape mismatch between the range check and the entity store's canonical shape**. The range check read the host and target positions as `spatial.position` (a nested object, introduced in commit `a118188`), while the entity store keeps the **flat** shape `spatial: { x, y }` (the `stateEntityController` format). Since no stored entity ever carries a `spatial.position` property, the `if (!hostPos) return false;` missing-property guard short-circuited before any target was ever examined. The feature was structurally unreachable, and there was no log to point at the missing read — the guard is the "graceful skip" path, so a dead feature looks exactly like "nobody is in range".

## Fix
Resolve both the host and each target position from the **canonical flat shape** (`spatial` itself, then `.x`/`.y`), so the range check reads the data the store actually writes. Two companion changes keep the now-resolvable range check correct:

- **Same-room guard.** The range is expressed in **room-relative coordinates** (each room's center is the origin), so a distance computed from local coordinates is meaningless across room boundaries — two entities in different rooms can both sit at local `(0,0)` and register as "adjacent". The target loop now skips any entity whose `location` differs from the host's, mirroring the room-first filtering every other range consumer already performs.
- **Unseeded regression lock.** The contract test no longer seeds `spatial.position`; it runs the corrosion tick against the store's real entity shape and additionally asserts `spatial.position` is `undefined` on both stored entities, so any future regression back to the nested read is a hard test failure rather than a silent no-op. A second test pins the room-bound invariant (a same-local-coordinate victim in a different room takes zero damage and drops zero tokens).

## Prevention
Contract tests for **periodic / tick-driven effects** must run against the **store's real entity shape**. Seeding a field the production store never writes is a defect signal, not a test convenience: it proves the test is compensating for a broken reader rather than exercising the real code path. The related lesson (same family as [BUG-132](BUG-132-channel-damage-silently-never-applied.md)) is that **"this feature never fires" is itself a testable claim** — a silent no-op in production deserves a test that would fail if the effect stops resolving, not just a test that a seeded happy-path produces the right output.

## References
- Related bug (companion defect, same method): [BUG-138](BUG-138-ic-emit-channel-damage-non-iterable-store.md)
- Related bug (same family, different defect): [BUG-132](BUG-132-channel-damage-silently-never-applied.md)
- Related design: `wiki/world_rules_onDamage_design.md` (R1, §7.5)
- Related controller: `InternalComponentController`
- Related test: `test/contract/worldRulesOnDamage.contract.test.js`
