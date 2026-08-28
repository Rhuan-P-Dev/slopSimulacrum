# BUG-011: ActionController SRP Violation

- **Severity**: MEDIUM
- **Status**: ✅ Refactored
- **Fixed In**: — (architectural refactor)
- **Related Files**: `src/controllers/actionController.js`, `src/controllers/componentCapabilityController.js`

## Symptoms

The `ActionController` was responsible for both:
1. Action execution (requirement checking, consequence handling)
2. Capability cache management (scanning, scoring, re-evaluating component capabilities)

This made the controller:
- Overly complex and hard to understand
- Difficult to test in isolation
- Slow to respond to stat changes (needed full re-scan instead of targeted re-evaluation)

## Root Cause

The `ActionController` contained all capability cache logic internally. When stat changes occurred, the entire cache needed to be re-scanned instead of only affected actions being re-evaluated.

## Fix

Extracted capability cache management into a dedicated `ComponentCapabilityController`, which `ActionController` now delegates to via constructor injection. The split was chosen because cache maintenance (scanning, scoring, re-evaluation) is a separate reason to change from action execution, and it enables targeted re-evaluation: a stat change is routed to the capability controller, which uses a trait-stat → action index to re-evaluate only the affected actions and notify subscribers, instead of re-scanning the entire cache.

## Prevention

- Follow the **Single Responsibility Principle** from `wiki/code_quality_and_best_practices.md` Section 1.1
- If a class has more than one reason to change, split it
- Use the **Dependency Injection** pattern from `wiki/subMDs/controller_patterns.md` Section 7

## References

- Related wiki: `wiki/subMDs/action_capability_cache.md`
- Related wiki: `wiki/subMDs/controller_patterns.md` Section 7
- Related controller: `ComponentCapabilityController`
- Related bug: [BUG-017](../architectural/BUG-017-dual-state-bug.md)