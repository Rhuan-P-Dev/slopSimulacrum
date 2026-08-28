# BUG-038: Hardcoded Color Values in CSS Instead of CSS Variables

- **Severity**: MEDIUM
- **Status**: ⚠️ Known
- **Fixed In**: `—`
- **Related Files**: `public/css/actions.css`, `public/css/synergy.css`, `public/css/feedback.css`, `public/css/map.css`

## Symptoms
- Hardcoded hex colors like `#ffff00`, `#ff4444`, `#ffaa00`, `#fff` used directly in CSS rules
- These colors should use CSS variables (`--neon-green`, `--dark-green`, etc.) for consistency
- Changing a theme color requires searching through all CSS files for hex values

## Root Cause
Several CSS files (`actions.css`, `synergy.css`, `feedback.css`, `map.css`) use raw hex values in rules where theme CSS custom properties should be used, so a theme change requires hunting for hex literals across files.

## Fix (Recommended)
1. Add the missing theme variables (`--neon-yellow`, `--neon-orange`, `--error-red`) to `:root` in `base.css`
2. Replace all hardcoded hex values with the corresponding `var()` references

## Prevention
- All theme colors should be CSS variables defined in `:root`
- Hex values in CSS rules indicate hardcoded theme data
- Use CSS linting to detect raw color values outside `:root`

## References
- Related wiki: `wiki/subMDs/css_architecture.md`
- Related wiki: `wiki/code_quality_and_best_practices.md` §2.3 Avoid Magic Numbers