# BUG-053: Client UI Layout SRP Violation — Monolithic Two-Column Layout

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `public/index.html`, `public/css/layout.css`, `public/js/App.js`, `public/js/UIManager.js`

## Symptoms

The client UI used a monolithic two-column grid layout with no clear separation of concerns:
- Map, navigation, and action registry were all mixed in a single layout
- No way to configure which UI elements were visible
- No support for customizable stat visualization
- Right panel was fixed and could not be hidden or moved

## Root Cause

The original layout was designed as a simple two-column grid that tightly coupled the map section with the control panel. This violated the Single Responsibility Principle by:
1. Mixing spatial visualization with action management in one static layout
2. Making it impossible to add new UI sections without major refactoring
3. No clear separation between config, view, and data panels

## Fix

Refactored the client UI into a **three-section vertical layout** with clear separation — a sticky top config bar, a middle spatial map that fills the available space, and a bottom stat-bars panel — with one manager module per UI section (config bar, component viewer, nav/actions panel, stat bars) so each section can evolve independently.

## Prevention
- Use modular managers for each UI section
- Keep DOM elements separated by section
- Define CSS variables for all colors and sizes
- Document layout architecture in wiki

## References
- Related wiki: `wiki/subMDs/client_ui.md`
- Related controller: `ClientApp`