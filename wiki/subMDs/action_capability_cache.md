# 🗂️ Action Capability Cache System

## 1. Overview

The capability cache maps each **action name** to an **array of all qualifying component entries**, sorted by score (best first). Every component that meets an action's requirements gets its own entry.

**Key behavior**:
- **All qualifying components** are tracked, not just the best one
- **Automatic re-evaluation** on stat changes, entity spawn/despawn
- **Event-driven notifications** via a pub/sub pattern per action
- **Reverse index** maps trait-stat combinations to dependent actions for efficient incremental updates

## 2. Data Structure

Each entry in the cache stores the component identity, its computed score, which requirements it fulfills, and the resolved role it plays for the action (source, target, spatial, or self-target). A special removal marker is emitted to subscribers when entries are deleted.

## 3. Scoring Algorithm

A numeric score is computed per component per action. Satisfied requirements contribute a base score. Exceeding thresholds by a large margin adds a small bonus. Being close to a threshold (but not meeting it) applies a penalty. Components that fail all requirements receive a score of zero and are not cached.

## 4. Event Subscription

Actions emit change events when components gain or lose capability. Subscribers receive either a new/updated entry or a removal marker. Events fire on stat changes, entity spawn/despawn, and component add/remove.

## 5. Stat Change Flow

When a component stat changes, the reverse index identifies which actions depend on that trait-stat combination. Only those actions are re-evaluated for the affected component. Updated or removed entries trigger re-sorting and subscriber notification.

## 6. Public API

The controller provides methods for full cache scans, individual entry re-evaluation, entity-scoped re-evaluation, cache lookups by action/entity/action-for-entity, and event subscription.

An HTTP API exposes read-only access to the cache and a refresh endpoint.

## 7. Internal Component Impact

The repair system modifies component durability over time. Actions that depend on durability may become newly capable or lose capability as durability fluctuates across repair ticks.