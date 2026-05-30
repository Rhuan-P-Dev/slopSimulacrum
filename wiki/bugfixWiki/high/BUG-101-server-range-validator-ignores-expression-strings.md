# BUG-101: Server RangeValidator Ignores Range Expression Strings

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/actions/RangeValidator.js`, `src/utils/PlaceholderResolver.js`

## Symptoms

When `data/actions.json` defines a range expression like `":Physical.strength*2"`, the server throws a `TypeError` in `RangeChecker.checkGrabRange()`:

```
TypeError: Invalid maxRange: must be a positive number.
```

Because `RangeValidator.checkGrabRange()` passes the raw string value directly to `RangeChecker`, which validates `typeof maxRange !== 'number'` and rejects any non-number.

This means any action with an expression `range` field silently fails on the server, even though the client-side may correctly resolve the expression for UI purposes.

## Root Cause

`RangeValidator.checkGrabRange()` at line 41 of the original file passed `maxRange` directly to `checkGrabRange()` from `RangeChecker`:

```javascript
return checkGrabRange(sourceEntity, targetEntity, maxRange);
```

`RangeChecker.checkGrabRange()` at line 35 validates:
```javascript
if (typeof maxRange !== 'number' || maxRange <= 0 || !isFinite(maxRange)) {
    throw new TypeError('Invalid maxRange: must be a positive number.');
}
```

There was no expression resolution on the server side — `PlaceholderResolver.resolvePlaceholders()` was only used for consequence parameters, not for the `range` field.

## Fix

Modified `RangeValidator.js` to:

1. Import `resolvePlaceholders` from `PlaceholderResolver`
2. In `checkGrabRange()`, check if `maxRange` is a string. If so, resolve it:
   ```javascript
   if (typeof maxRange === 'string') {
       const requirementValues = this._resolveRequirementValues(sourceEntityId);
       const resolved = resolvePlaceholders(maxRange, requirementValues);
       maxRange = typeof resolved === 'number' ? resolved : Number(resolved);
   }
   ```
3. Added `_resolveRequirementValues()` private method that gathers all `"trait.stat"` → `value` pairs from the source entity's components, using the same pattern as `RequirementResolver.resolveRequirementValues()`.

This ensures range, consequences, and failureConsequences all share the **same** `PlaceholderResolver` expression resolution mechanism.

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