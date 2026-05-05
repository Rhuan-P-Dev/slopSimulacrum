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
Several CSS files use raw hex values instead of CSS custom properties:

| File | Hardcoded Values | Should Be |
|------|-----------------|-----------|
| `actions.css:54` | `color: #ffff00;` | `color: var(--neon-yellow)` |
| `actions.css:62` | `color: #ffaa00;` | `color: var(--neon-orange)` |
| `actions.css:66` | `color: #ff4444;` | `color: var(--error-red)` |
| `synergy.css:22` | `border: 2px solid #ffff00;` | `border: 2px solid var(--neon-yellow)` |
| `feedback.css:21` | `background-color: #ff4444;` | `background-color: var(--error-red)` |
| `map.css:66` | `fill: #fff;` | `fill: var(--text-main)` |

## Fix (Recommended)
1. Add missing CSS variables to `:root` in `base.css`:
   ```css
   --neon-yellow: #ffff00;
   --neon-orange: #ffaa00;
   --error-red: #ff4444;
   ```
2. Replace all hardcoded hex values with corresponding `var()` references

## Prevention
- All theme colors should be CSS variables defined in `:root`
- Hex values in CSS rules indicate hardcoded theme data
- Use CSS linting to detect raw color values outside `:root`

## References
- Related wiki: `wiki/subMDs/css_architecture.md`
- Related wiki: `wiki/code_quality_and_best_practices.md` §2.3 Avoid Magic Numbers