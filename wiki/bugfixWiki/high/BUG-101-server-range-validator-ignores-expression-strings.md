# BUG-101: Server RangeValidator Ignores Range Expression Strings

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/actions/RangeValidator.js`, `src/utils/PlaceholderResolver.js`

## Symptoms

When `data/actions.json` defines a range expression like `":Physical.strength*2"`, the server throws a `TypeError` in `RangeChecker.checkGrabRange()` ("Invalid maxRange: must be a positive number").

Because `RangeValidator.checkGrabRange()` passes the raw string value directly to `RangeChecker`, which validates `typeof maxRange !== 'number'` and rejects any non-number.

This means any action with an expression `range` field silently fails on the server, even though the client-side may correctly resolve the expression for UI purposes.

## Root Cause

`RangeValidator.checkGrabRange()` passed the raw `maxRange` value directly to `RangeChecker`, which rejects anything that is not a positive finite number. There was no expression resolution on the server side — `PlaceholderResolver.resolvePlaceholders()` was only used for consequence parameters, not for the `range` field.

## Fix

`RangeValidator` now resolves string range expressions before validation, gathering the source entity's trait values and resolving the expression through the shared `PlaceholderResolver` — the same mechanism used for consequence parameters. Rationale: range, consequences, and failureConsequences must all share a single expression-resolution mechanism; separate per-field resolution paths are what allowed `range` to be the only field that never resolved expressions server-side.

## Prevention

- All data-driven numeric fields that accept `:Trait.stat` expressions must use `resolvePlaceholders()` for resolution
- The `range` field is no longer assumed to be a plain number — it can be an expression string
- Server-side range validation receives only resolved numeric values

## References

- Related wiki: `wiki/subMDs/controllers/range_validator.md` — Range expression resolution documentation
- Related wiki: `wiki/subMDs/architecture/action_system.md` — Range expressions section
- Related controller: `ActionController`
- Related utility: `PlaceholderResolver`, `RangeChecker`
- Related bug: BUG-084 (client-side range expression resolution) — complementary fix