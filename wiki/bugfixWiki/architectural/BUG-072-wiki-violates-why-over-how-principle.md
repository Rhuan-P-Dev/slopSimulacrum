# BUG-072: Wiki Violates "Why Over How" Documentation Principle

- **Severity**: ARCHITECTURAL
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `wiki/subMDs/controllers/internal_component_controller.md`, `wiki/subMDs/data/components_and_entities.md`, `wiki/subMDs/systems/synergy.md`, `wiki/subMDs/systems/movement_system.md`, `wiki/subMDs/frontend/css_architecture.md`, `wiki/subMDs/systems/world_map.md`, `wiki/subMDs/networking/communication.md`, `wiki/subMDs/controllers/controller_patterns.md`, `wiki/subMDs/frontend/client_action_execution.md`, `wiki/project_rules.md`, `wiki/subMDs/index.md`

## Symptoms

Multiple wiki documentation files contained excessive implementation details ("how") instead of design intent ("why"):

- Code snippets (JSON schemas, JavaScript code blocks) that duplicate what the code already explains
- Line-by-line method explanations redundant with JSDoc comments
- Step-by-step processing flow descriptions that belong in code comments
- API endpoint tables that are implementation contracts, not design rationale
- Field-by-field registry schema tables that are self-evident from reading the JSON

This violated the [Code Quality Standards](../../code_quality_and_best_practices.md) Section 4.1: *"Comments should explain **why** a certain design decision was made... The code should explain **how** it works."*

## Root Cause

Wiki documentation was created by describing implementation details rather than design intent. New agents (and humans) documented "how the code works" instead of "why the code exists", treating the wiki as a tutorial rather than an architectural reference.

No explicit rule prevented this — the wiki writing standard was implied but never codified.

## Fix

### 1. Added Wiki Writing Standards Rule (Section 8 of `project_rules.md`)

Created explicit prohibition on wiki content that duplicates code:

| Rule | Description |
|------|-------------|
| No code snippets | The code IS the implementation documentation |
| No JSON schemas | Data structures are self-evident from the JSON |
| No method-by-method explanations | Method names and JSDoc explain themselves |
| No step-by-step processing flow | Describe purpose, not iteration order |
| No API endpoint tables | API contracts belong in code comments |
| No calculation formulas | The math is self-evident from code |

Self-check checklist added for all future wiki contributors.

### 2. Rewritten Wiki Files (11 files)

| File | Before | After | Reduction |
|------|--------|-------|-----------|
| `internal_component_controller.md` | ~186 lines, 75% how | ~70 lines, 90% why | 62% |
| `components_and_entities.md` | ~171 lines, 65% how | ~85 lines, 90% why | 50% |
| `synergy.md` | ~70 lines, 65% how | ~65 lines, 90% why | 7% |
| `movement_system.md` | ~29 lines, 70% how | ~28 lines, 90% why | 3% |
| `css_architecture.md` | ~46 lines, 60% how | ~30 lines, 90% why | 35% |
| `world_map.md` | ~34 lines, 55% how | ~30 lines, 90% why | 12% |
| `communication.md` | ~80 lines, 55% how | ~35 lines, 90% why | 56% |
| `controller_patterns.md` | ~84 lines, 50% how | ~75 lines, 90% why | 11% |
| `client_action_execution.md` | ~22 lines, 50% how | ~35 lines, 90% why | 0%* |
| `project_rules.md` | Code example block | Pattern description | 100% code removed |
| `subMDs/index.md` | "How" descriptions | "Why" descriptions | Updated |

*client_action_execution.md expanded slightly because the new descriptions focus on purpose (why), not just flow (how).

## Prevention

1. All future wiki contributions must follow Section 8 of `project_rules.md`
2. The self-check list must be completed before submitting wiki changes
3. Reviewers should verify wiki content explains design intent, not implementation

## References

- Related rule: `wiki/project_rules.md` Section 8 (Wiki Writing Standards)
- Related standard: `wiki/code_quality_and_best_practices.md` Section 4.1 (Documenting "Why", Not "How")
- Related: `wiki/CORE.md` (Wiki-first workflow requirement)