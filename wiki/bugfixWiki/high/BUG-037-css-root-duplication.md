# BUG-037: CSS :root Variables Duplicated Across 10 Files

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/css/*.css` (all 9 modular CSS files)

## Symptoms
- The same `:root` block (7 CSS custom properties) was duplicated in every CSS file
- `--neon-green`, `--dark-green`, `--bg-black`, `--panel-bg`, `--text-main`, `--text-dim`, `--glow` repeated 10 times
- Changing a color required updating 10 files
- Violated DRY principle and CSS architecture best practices

## Root Cause
Each CSS file was created with its own `:root` block for "independence", causing 63 redundant variable declarations across 9 files.

**All files fixed:**
- `public/css/actions.css` ✅ Fixed
- `public/css/components.css` ✅ Fixed
- `public/css/feedback.css` ✅ Fixed
- `public/css/layout.css` ✅ Fixed
- `public/css/map.css` ✅ Fixed
- `public/css/navigation.css` ✅ Fixed
- `public/css/synergy.css` ✅ Fixed
- `public/css/utilities.css` ✅ Fixed

**Single source of truth:** `public/css/base.css:6-14`

## Fix
Removed the `:root` block from all CSS files except `base.css`. The variables now cascade from the single source.

**Verification:** `grep -l ":root {" public/css/*.css` returns only `public/css/base.css`.

## Prevention
- Define all `:root` variables in one file (e.g., `base.css`)
- Modular CSS files should only contain component-specific rules
- Use CSS linting to prevent duplicate `:root` blocks

## References
- Related wiki: `wiki/subMDs/css_architecture.md`
- Related wiki: `wiki/code_quality_and_best_practices.md` §2.3 Avoid Magic Numbers