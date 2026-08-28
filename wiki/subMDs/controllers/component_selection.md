# Component Selection System

## 1. Overview

Enforces the **"one component, one action"** rule: selected components are locked to a specific action and cannot be reused until released.

## 2. Architecture

```
Root Controller → SelectionController (injected into SynergyController, ActionController)
```

The server-side controller manages component locking with automatic TTL-based expiry. The client-side selection controller tracks the active action, selected component IDs, and cross-action selection state.

## 3. Lifecycle

A lock commits a component to exactly one action: it must survive validation and execution, and is always released once the action completes — including spatial actions, which resolve components differently. Stale selections auto-expire via TTL before they can interfere with a later action, so a forgotten selection can never block or misdirect execution.

## 4. Multi-Component Flow

Multi-component actions are assembled incrementally so the user sees a live synergy preview before anything commits — the combined effect is visible before the action executes. Committing performs a single batch lock covering all selected components: all-or-nothing, so a multi-component action can never execute with only part of its selection locked.

## 5. API Endpoints

Selection state is mutated only through dedicated server-side endpoints so the locking semantics (one component per action, batch locking, TTL expiry) cannot be bypassed by the client, while a separate preview path lets the UI evaluate a multi-component selection without executing it.

## 6. Previous Action Restoration

**Why the system tracks the previous action**: After action execution clears all selections, the user is left with no active action context. Tracking the previously active action enables rapid re-selection of the last-used action via a keyboard shortcut (Alt key), supporting workflows where users frequently re-execute the same action or alternate between two actions.

**Why `clearAllSelections()` preserves the previous action before clearing**: Action execution triggers a full selection reset, but preserving the action name allows the user to recover their last action without navigating through the UI again. Without this preservation, every action execution would force the user to manually re-select their action from the action list.

**Why `toggleComponent()` saves the current action before switching**: When the user clicks a different action in the UI, the currently active action becomes the previous action. This design ensures that navigating between actions naturally maintains a reference to the last-used action, rather than requiring explicit "save as favorite" interactions.