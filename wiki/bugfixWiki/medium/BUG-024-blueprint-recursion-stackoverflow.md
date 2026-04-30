# BUG-024: Knife Blueprint Infinite Recursion (Stack Overflow)

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `41014fb3` (blueprint decoupling session)
- **Related Files**: `src/controllers/entityController.js` (lines 38-73)

## Symptoms

When spawning a knife entity or any entity with a leaf-only blueprint (e.g., `"knife": ["knife"]`), the server crashed with:

```
RangeError: Maximum call stack size exceeded
    at EntityController.expandBlueprint (file:///src/controllers/entityController.js:39:20)
    at EntityController.expandBlueprint (file:///src/controllers/entityController.js:69:45)
    at EntityController.expandBlueprint (file:///src/controllers/entityController.js:69:45)
    ...
```

The stack overflow occurred because `expandBlueprint()` recursively called itself when it detected that the component name matched a blueprint key, with no cycle detection.

## Root Cause

The `expandBlueprint()` method treated all component names that matched a blueprint key as needing further expansion. For leaf-only blueprints like:

```json
"knife": ["knife"]
```

The method would:
1. Process `"knife"` (the item in the array)
2. Detect `this.blueprints["knife"]` exists
3. Recursively call `expandBlueprint("knife")`
4. Repeat indefinitely → stack overflow

## Fix

Added a `visited: Set<string>` parameter to `expandBlueprint()` to track already-visited blueprint names and prevent infinite recursion:

```javascript
expandBlueprint(blueprintName, visited = new Set()) {
    if (visited.has(blueprintName)) {
        // Prevent infinite recursion for leaf-only blueprints (e.g., knife)
        return [];
    }
    visited.add(blueprintName);
    // ... rest of method passes visited to recursive calls
}
```

## Prevention

- Always use cycle detection (Set/visited tracking) when recursively expanding hierarchical data
- Test leaf-only blueprints (where a blueprint references itself) during entity creation
- Consider adding unit tests for edge case blueprints

## References

- Related wiki: `wiki/subMDs/entities.md` Section 2.2
- Related controller: `EntityController`
- Related wiki: `wiki/subMDs/system_map.md` Section 3.1