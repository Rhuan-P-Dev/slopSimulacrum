# BUG-017: Dual State Bug — Internal Controller Instantiation

- **Severity**: ARCHITECTURAL
- **Status**: ✅ Fixed
- **Fixed In**: — (enforced via architectural pattern)
- **Related Files**: All controllers

## Symptoms

The system maintained two different views of the same state:
- `WorldStateController` had one set of entities
- A sub-controller had a completely different set of entities
- Operations on one controller didn't affect the other
- Save/Load produced inconsistent results

Entities created through the root controller were invisible to sub-controllers that owned their own duplicate state — the "ghost entity" symptom.

## Root Cause

Controllers were instantiating their dependencies internally using the `new` keyword. This created **dual state** — two `ComponentController` instances with different `this.components` objects, both supposed to manage the same game state.

## Fix

Enforced the **Dependency Injection** pattern across all controllers: each controller receives its dependencies via constructor arguments, and the root controller creates and shares a single instance of each, so no duplicate state can exist.

## Prevention

- **Never** instantiate dependencies inside controllers using `new`
- All dependencies must be passed via constructor arguments
- `WorldStateController` is the **only** place where `new Controller()` is called
- Follow the **Dependency Injection** pattern from `wiki/subMDs/controller_patterns.md` Section 2
- Follow the **Root Injector Pattern** from `wiki/subMDs/controller_patterns.md` Section 3

## References

- Related wiki: `wiki/subMDs/controller_patterns.md` Sections 2, 3
- Related wiki: `wiki/map.md` Section 1
- Related controller: All controllers
- Related bug: [BUG-009](../high/BUG-009-server-direct-access.md)