# 🐛 Bugfix Wiki

Centralized knowledge base for all fixed bugs, known issues, and their resolutions in the `slopSimulacrum` project.

## How to Use

- Browse bugs by **severity** in the subdirectories (`critical/`, `high/`, `medium/`, `low/`, `architectural/`)
- Each bug has its own file with full details: symptoms, root cause, fix, and prevention
- Use the index table below for quick lookup

## Bug Index

### 🔴 Critical Severity

| ID | Title | Status | Fixed In | Related Files |
|----|-------|--------|----------|---------------|
| [BUG-001](critical/BUG-001-multi-attacker-punch-target-role.md) | Multi-Attacker Punch: Target Components Treated as Attackers | ✅ Fixed | `b53e0dd` | `actionController.js` |
| [BUG-002](critical/BUG-002-malformed-consequence-error.md) | CRITICAL Error: Malformed Consequence Data Access | ✅ Fixed | `b53e0dd` | `actionController.js` |
| [BUG-003](critical/BUG-003-spatial-action-lock-leak.md) | Spatial Action Component Lock Leak | ✅ Fixed | `2573bea` | `actionController.js` |

### 🟠 High Severity

| ID | Title | Status | Fixed In | Related Files |
|----|-------|--------|----------|---------------|
| [BUG-004](high/BUG-004-role-mismatch-skip.md) | Role Mismatch: Client/Server Resolution Difference | ✅ Fixed | `2573bea` | `actionController.js` |
| [BUG-005](high/BUG-005-deep-trait-merge.md) | Deep Trait-Level Merge: Stat Overwrite | ✅ Fixed | — | `componentStatsController.js` |
| [BUG-006](high/BUG-006-schema-validation-gap.md) | Schema Validation Gap for LLM Responses | ✅ Documented | — | `LLMController.js` |
| [BUG-007](high/BUG-007-graceful-degradation.md) | System Crashes from Non-Essential Module Errors | ✅ Documented | — | Architecture |
| [BUG-008](high/BUG-008-state-desync.md) | State Desynchronization Between Save/Load | ✅ Documented | — | `WorldStateController.js` |
| [BUG-009](high/BUG-009-server-direct-access.md) | Server Direct Sub-Controller Access | ✅ Fixed | — | `server.js`, `WorldStateController.js` |
| [BUG-010](high/BUG-010-self-target-resolution.md) | Self-Targeting Action Component Resolution | ✅ Fixed | `53fa440` | `actionController.js` |
| [BUG-021](high/BUG-021-spatial-action-race-condition.md) | Multi-Component Spatial Action Race Condition | ✅ Fixed | `22bf5dc` | `App.js` |
| [BUG-026](high/BUG-026-blueprint-expansion-sibling-skipped.md) | Blueprint Expansion: Sibling Components Skipped | ✅ Fixed | `41014fb3` | `entityController.js` |
| [BUG-028](high/BUG-028-socket-error-orphaned-mapping.md) | Socket Error Causes Orphaned Entity Mapping | ✅ Fixed | `pending` | `server.js` |

### 🟡 Medium Severity

| ID | Title | Status | Fixed In | Related Files |
|----|-------|--------|----------|---------------|
| [BUG-011](medium/BUG-011-srp-violation.md) | ActionController SRP Violation | ✅ Refactored | — | `actionController.js`, `componentCapabilityController.js` |
| [BUG-012](medium/BUG-012-removal-marker-null.md) | Removal Marker Sent as `null` Instead of Structured Object | ✅ Fixed | — | `componentCapabilityController.js` |
| [BUG-013](medium/BUG-013-selection-persistence.md) | Component Selection Lost on Page Refresh | ✅ Fixed | `2573bea` | `App.js`, `actionController.js` |
| [BUG-014](medium/BUG-014-defensive-copying.md) | Entity State Direct Mutation | ✅ Fixed | `d2e8c0b` | `entityController.js` |
| [BUG-015](medium/BUG-015-division-by-zero-scoring.md) | Division by Zero in Action Scoring (minValue = 0) | ⚠️ Known | — | `ActionScoring.js` |
| [BUG-019](medium/BUG-019-action-preview-name-missing.md) | Action Preview Name Missing (`_name` property) | ✅ Fixed | `22bf5dc` | `actionController.js`, `UIManager.js` |
| [BUG-020](medium/BUG-020-deltaspatial-speed-rendering.md) | deltaSpatial Speed Property Rendering | ✅ Fixed | `22bf5dc` | `UIManager.js` |
| [BUG-022](medium/BUG-022-duplicate-contributing-components.md) | Duplicate Contributing Components in Synergy Result | ✅ Fixed | `22bf5dc` | `synergyController.js` |
| [BUG-023](medium/BUG-023-range-indicator-ignores-synergy.md) | Range Indicator Ignores Synergy Multiplier | ✅ Fixed | `22bf5dc` | `App.js` |
| [BUG-024](medium/BUG-024-blueprint-recursion-stackoverflow.md) | Blueprint Recursion: Leaf-Only Blueprints Stack Overflow | ✅ Fixed | `41014fb3` | `entityController.js` |
| [BUG-027](medium/BUG-027-server-console-log-instead-of-logger.md) | Server Uses console.log Instead of Centralized Logger | ✅ Fixed | `4cf43abf` | `server.js` |

### 🟢 Low Severity

| ID | Title | Status | Fixed In | Related Files |
|----|-------|--------|----------|---------------|
| [BUG-016](low/BUG-016-ui-selection-state.md) | UI Actions Incorrectly Marked as Selected | ✅ Fixed | `bf19079` | `App.js` |
| [BUG-025](low/BUG-025-startroomid-scope-bug.md) | `startRoomId` Scope Bug in `_spawnKnifeInStartRoom()` | ✅ Fixed | `41014fb3` | `WorldStateController.js` |

### 🏗️ Architectural Fixes

| ID | Title | Status | Fixed In | Related Files |
|----|-------|--------|----------|---------------|
| [BUG-017](architectural/BUG-017-dual-state-bug.md) | Dual State Bug: Internal Controller Instantiation | ✅ Fixed | — | All controllers |
| [BUG-018](architectural/BUG-018-actions-not-generic.md) | Hardcoded Actions (Not Data-Driven) | ✅ Fixed | `462ecc5`, `be6858d` | `actions.json`, `actionController.js` |

---

## Contributing New Bug Reports

See [template.md](template.md) for severity definitions, the bug report template, and step-by-step instructions for adding new bug reports.