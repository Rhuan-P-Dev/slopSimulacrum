# Synergy System

## 1. Design Philosophy

The synergy system exists to reward **component diversity** and **tactical clustering**. When multiple components of the same type are positioned to work together, they should produce a compound effect greater than the sum of their parts — but not so great that it breaks game balance.

Synergies are scoped per **action type**. Each type defines its own curve, cap, and group behavior, allowing distinct design intent for movement, damage, defense, and other categories.

## 2. Scaling Curve Intent

Three curve shapes shape how synergy multipliers grow with group size:

- **Linear** — Predictable, player-friendly scaling. Each additional component adds a fixed bonus.
- **Diminishing Returns** — Prevents runaway power from large clusters while still rewarding small groups. Encourages spread-out positioning.
- **Increasing Returns** — Creates high-risk, high-reward "stack or go home" scenarios. Rewards committing to a single focused group.

Non-linear curves were chosen to prevent simple arithmetic scaling from dominating strategy. The curve shape becomes a **design lever** that developers can adjust to shape player behavior without touching code.

### Curve Configuration

Each curve is defined in `data/synergy.json` with these parameters:

| Parameter | Purpose |
|-----------|---------|
| `baseMultiplier` | Starting multiplier at 1 component |
| `perComponentBonus` | Additional multiplier per component added |
| `cap` | Maximum multiplier regardless of group size |
| `curve` | Shape function name |

## 3. Synergy Group Types

Synergy groups unify `componentType` and `groupType` into a single classification system. This unification exists because:

- **Simplified configuration**: One classification instead of two overlapping concepts
- **Clearer intent**: The group name directly expresses the synergy category
- **Easier maintenance**: Changes to group behavior require only one field update

## 4. Evaluation Paths

Components contribute to synergies through two paths:

- **Provided components**: Components that actively participate in a synergy group
- **Contribution groups**: Components that support synergy scoring without being directly involved

This dual-path design exists because some components provide passive synergy benefits while others require active participation.

## 5. Synergy Preview System

### Why Preview Exists

The preview system allows players to understand the impact of component selection before committing to an action. This serves two purposes:

- **Player feedback**: Players learn the game's mechanics through informed experimentation
- **Strategic planning**: Players can evaluate trade-offs between different component groupings

### System Flow

The preview system queries `SynergyComponentGatherer` to collect components, `SynergyCalculator` to compute multipliers, and presents results through the frontend without executing any action consequences. This decoupling ensures preview is read-only and side-effect free.