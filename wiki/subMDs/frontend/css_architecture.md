# CSS Architecture

## 1. Overview

CSS is split into single-responsibility modules, each responsible for one visual domain. No file depends on another — all cross-file values are accessed via CSS custom properties in the root.

## 2. Why CSS Was Split

The monolithic stylesheet was split into modules for three reasons:

- **Single Responsibility**: Each file owns one visual concern. A change to synergy styling never affects navigation styling.
- **Collision avoidance**: Multiple agents editing the same file concurrently would cause merge conflicts. Modular files isolate edits.
- **Onboarding clarity**: New developers can open a single file to understand one visual domain without scrolling through unrelated styles.

## 3. Module Responsibilities

| Module | Responsibility |
|--------|---------------|
| `styles.css` | Global theme variables (colors, typography, spacing) |
| `base.css` | Reset, typography, heading normalization |
| `layout.css` | Top-level page grid and flex containers |
| `map.css` | SVG map visualization styles |
| `navigation.css` | Navigation controls and overlays |
| `actions.css` | Action list and selection states |
| `synergy.css` | Synergy preview and result display |
| `components.css` | Component cards, durability bars, HUD |
| `utilities.css` | Micro-utilities (text colors, alignment) |
| `feedback.css` | Error notifications, animations |
| `internal-components.css` | Internal component rendering and viewer |

## 4. Styling Philosophy

- **Theme**: Cyber-terminal aesthetic with dark background and neon accents
- **Font**: Monospaced throughout for terminal authenticity
- **Variables**: All colors via CSS custom properties in the root selector, enabling theme switching without modifying individual rules