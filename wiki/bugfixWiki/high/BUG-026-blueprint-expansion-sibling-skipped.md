# BUG-026: Blueprint Expansion Skips Sibling Components

**Status:** ✅ Fixed
**Severity:** Critical
**Date Fixed:** 2026-04-30

## Problem

When a client incarnated entity (using `smallBallDroid` → `centralBall` blueprint) was spawned, the **right arm** components (`droidArm`, `droidHand`, `humanoidDroidFinger`) were not being created. Only the left arm components existed.

## Root Cause

The `expandBlueprint()` method in `src/controllers/entityController.js` used a **single shared `visited` set** across all recursive expansion branches. When the `centralBall` blueprint expands both the left and right `droidArm`:

1. The left arm expands `droidArm` and marks it as visited
2. The right arm attempts to expand `droidArm`, but the shared visited check short-circuits it to an empty result

This meant the right arm's children were **never expanded**: the visited set was meant to stop infinite recursion through a blueprint *cycle*, but because it was shared, it also blocked the same blueprint from legitimately appearing in a **sibling** branch.

## Fix

Changed `expandBlueprint()` to use a **per-branch `visited` set** so sibling blueprints can be expanded independently. The rationale: cycle protection and sibling exclusion are different concerns, and a shared set conflated them — every sibling occurrence of an already-visited blueprint was silently dropped. Scoping the visited set to a single branch keeps recursion safe while allowing the same blueprint to appear in multiple sibling positions.

## Files Modified
- `src/controllers/entityController.js` — `expandBlueprint()` method (lines 48-67)

## Impact
- All entities using multi-component blueprints with sibling components now correctly spawn
- `droidArm` (left/right), `droidRollingBall` (left/right), `humanoidDroidFinger` (left/middle/right) all expand properly