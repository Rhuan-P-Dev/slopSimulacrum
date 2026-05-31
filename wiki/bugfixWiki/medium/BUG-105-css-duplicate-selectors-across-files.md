# BUG-105: CSS Duplicate Selectors Across Multiple Files

- **Severity**: LOW
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: 
  - `public/css/layout.css` (.overlay-panel, .add-stat-dialog, .add-stat-dialog-overlay)
  - `public/css/components.css` (removed duplicates)
  - `public/css/floating-windows.css` (removed .overlay-panel transition)

## Symptoms

Multiple CSS class selectors were defined in more than one file:

1. **`.overlay-panel`** — Defined in layout.css (full definition), components.css (duplicate, slightly different), and floating-windows.css (transition only)
2. **`.add-stat-dialog`** — Defined in layout.css and components.css with slight differences (min-width: 340px vs 300px)
3. **`.add-stat-dialog-overlay`** — Exact duplicate definitions in layout.css and components.css

## Root Cause

CSS files were created by different developers at different times without cross-file selector registration. The `components.css` file was likely extracted from `layout.css` during a refactoring but the original definitions were not removed.

## Fix

1. Kept authoritative definitions in `layout.css` (the layout/structure file)
2. Removed duplicate `.overlay-panel` and `.add-stat-dialog`/`.add-stat-dialog-overlay` from `components.css`
3. Merged `.overlay-panel` transition from `floating-windows.css` into the authoritative definition in `layout.css`
4. Removed empty `.overlay-panel` block from `floating-windows.css`

## Prevention

The CSS architecture document (`wiki/subMDs/frontend/css_architecture.md`) states "modular CSS philosophy, single-responsibility rationale." Each selector should belong to exactly one file. When extracting styles, ensure the original is removed.

## References

- Related wiki: `wiki/subMDs/frontend/css_architecture.md`
- Related project rule: `wiki/project_rules.md` (Code Quality Standards)