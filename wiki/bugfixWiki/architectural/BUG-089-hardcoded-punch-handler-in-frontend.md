# BUG-089: Hardcoded Punch Handler in Frontend — Not Generic for New Attack Types

- **Severity**: ARCHITECTURAL
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `public/js/App.js`, `public/js/EventDispatcher.js`, `public/js/ActionExecutor.js`

## Symptoms

Adding a new component-targeted attack action to `data/actions.json` required modifying frontend code: each new attack needed a new handler branch in `EventDispatcher.js`, a new callback in `App.js`, and a new dedicated method in `ActionExecutor.js`. This violated the Single Responsibility Principle and the project's data-driven design goal.

## Root Cause

The frontend had hardcoded action-name branching logic in `EventDispatcher.js` that checked for the specific action name `"droid punch"` to dispatch to `executePunch`. Each attack type had its own dedicated handler method instead of a unified handler that reads `targetingType` from the action definition at runtime. This meant the dispatcher had knowledge of individual action names, creating tight coupling between routing logic and specific action definitions.

## Fix

Replaced all three hardcoded elements (dispatcher branch, app-level callback, dedicated executor method) with a single generic handler that routes on the action definition's `targetingType: 'component'` and reads `range` from the available-actions registry, so any new component-targeted attack works without frontend changes.

## Prevention

To avoid this class of bug in the future:

1. **Frontend routing must never check specific action names** — routing decisions must be based on structural properties (`targetingType`, `range`, etc.) from the action definition.
2. **New attack actions require only `data/actions.json` changes** — if adding a new attack requires frontend code changes, this is a bug.
3. **Document the handler chain** — the wiki documents which file handles which step of the action pipeline.

## References

- Related wiki: `wiki/subMDs/architecture/attack_system.md`
- Related wiki: `wiki/subMDs/architecture/action_system.md`
- Related wiki: `wiki/project_rules.md` (Data-Driven Design)
- Related controller: `ActionExecutor`, `EventDispatcher`