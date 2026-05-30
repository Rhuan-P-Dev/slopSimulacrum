# BUG-100: ClientApp Constructor Ordering Bug — `this.dispatcher`/`this.executor`/`this.socket` Used Before Definition

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: pending
- **Related Files**: `public/js/App.js` (lines 55-100)

## Symptoms

The `ClientApp` constructor had a critical ordering bug where dependent objects were created before their dependencies:

1. `this.dispatcher` (EventDispatcher) was created on line ~100 but used on line ~66 by `DropSelectorController`
2. `this.socket` was referenced by the dispatcher but defined on line ~97
3. `this.executor` was referenced in dispatcher callbacks but defined after the dispatcher

At runtime, `DropSelectorController` received `undefined` as its `dispatcher` parameter, and the dispatcher itself had `undefined` for both `socket` and `executor`.

## Root Cause

The constructor was written in logical grouping order rather than dependency order. The developer grouped modules by type (controllers, then UI modules, then infrastructure) without considering that the dispatcher callbacks reference `this.socket`, `this.dispatcher`, and `this.executor`.

## Fix

Reordered constructor to follow strict dependency order:

```
1. Available actions cache
2. Core modules (WorldState, UIManager, ErrorController, ActionManager)
3. Controllers (Selection, Synergy)
4. UI modules (StatBars, ComponentViewer, NavActions, WorldMap, Inventory)
5. Socket connection ← must be first for EventDispatcher
6. ActionExecutor ← must be before dispatcher (dispatcher callbacks reference this.executor)
7. EventDispatcher ← must be before DropSelectorController
8. DropSelectorController ← depends on dispatcher
9. OverlayManager
10. PickUpOverlayController
11. Event listeners
12. State variables
```

## Prevention

When constructing objects with cross-references:
- Map out dependencies before writing constructor code
- Use topological sort: dependencies must be initialized before dependents
- Document dependency order in comments (e.g., `// 6. Action executor (must be before EventDispatcher — dispatcher callbacks reference this.executor)`)

## References
- Related wiki: `wiki/project_rules.md` (Section 2: Critical Architectural Constraints)
- Related controller: `ClientApp` (public/js/App.js)