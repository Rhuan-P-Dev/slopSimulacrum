# BUG-030: CSS Monolith Violates Single Responsibility Principle

- **Severity**: ARCHITECTURAL
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/styles.css` → `public/css/` (9 new files)

## Symptoms

`public/styles.css` contained 785 lines of CSS with mixed responsibilities:
- CSS variables mixed with component styles
- Map visualization mixed with action list styles
- Synergy preview mixed with utility classes
- No clear separation of concerns
- Difficult for developers and AI agents to locate relevant styles
- Risk of cascading changes when modifying unrelated styles

## Root Cause

The original CSS file was created as a single monolithic file without planning for modular architecture. No SRP was applied to the stylesheet organization.

## Fix

Refactored `public/styles.css` from a 785-line monolithic file into **9 single-responsibility modules**:

| File | Lines | Responsibility |
|------|-------|----------------|
| `styles.css` | ~20 | `:root` variables + `@import` |
| `css/base.css` | ~25 | Body, h1 typography |
| `css/layout.css` | ~20 | Grid layout, panel containers |
| `css/map.css` | ~65 | SVG map visualization |
| `css/navigation.css` | ~95 | Nav buttons, detail overlays |
| `css/actions.css` | ~85 | Action list, selection states |
| `css/synergy.css` | ~110 | Synergy preview display |
| `css/components.css` | ~110 | Component HUD, tactical targeting |
| `css/utilities.css` | ~15 | Micro-utilities |
| `css/feedback.css` | ~55 | Error popups, release buttons |

**Loading mechanism**: Browser-native `@import` chaining via single `<link>` tag — no build tools required.

**Documentation**: Created `wiki/subMDs/css_architecture.md` with maintenance guidelines.

## Prevention

1. New CSS files must follow SRP — one responsibility per file
2. Each file must have a section header comment describing its purpose
3. CSS variables centralized in `:root` — never duplicated
4. Reference `wiki/subMDs/css_architecture.md` before adding new styles

## References
- Related wiki: `wiki/subMDs/css_architecture.md`
- Related standard: `wiki/code_quality_and_best_practices.md` Section 1.1 (SRP)