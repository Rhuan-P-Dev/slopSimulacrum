# BUG-024: Knife Blueprint Infinite Recursion (Stack Overflow)

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `41014fb3` (blueprint decoupling session)
- **Related Files**: `src/controllers/entityController.js` (lines 38-73)

## Symptoms

When spawning a knife entity or any entity with a leaf-only blueprint (e.g., `"knife": ["knife"]`), the server crashed with `RangeError: Maximum call stack size exceeded` in `EntityController.expandBlueprint`.

## Root Cause

The `expandBlueprint()` method treated any component name that matched a blueprint key as needing further expansion, with no cycle detection. For a leaf-only blueprint (one whose only entry is a component of the same name, e.g. `"knife": ["knife"]`), the expansion recursed into itself indefinitely until the stack overflowed.

## Fix

`expandBlueprint()` now tracks already-visited blueprint names and stops recursing when it reaches a name it has seen before, so self-referencing (leaf-only) blueprints terminate instead of overflowing the stack.

## Prevention

- Always use cycle detection (Set/visited tracking) when recursively expanding hierarchical data
- Test leaf-only blueprints (where a blueprint references itself) during entity creation
- Consider adding unit tests for edge case blueprints

## References

- Related wiki: `wiki/subMDs/entities.md` Section 2.2
- Related controller: `EntityController`
- Related wiki: `wiki/subMDs/system_map.md` Section 3.1