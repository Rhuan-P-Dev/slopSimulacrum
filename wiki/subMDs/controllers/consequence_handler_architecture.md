# Consequence Handler Architecture

## 1. Overview

The consequence handler system follows the **Single Responsibility Principle** with a dispatcher routing consequence types to their dedicated handlers. The dispatcher validates the target, resolves the target ID, and dispatches to the appropriate handler module.

## 2. Module Structure

A dispatcher module routes consequence types to dedicated handler modules: spatial, stat, damage, log, and event. Each handler is a separate file with a single responsibility.

## 3. Target Resolution

Every consequence in the action registry includes a target field indicating the scope of application. The dispatcher resolves this to a concrete target ID before dispatching:

| Target Scope | Resolves To |
|--------|-------------|
| Self | Source component from the action's fulfilling components |
| Target | Explicitly provided target component or entity ID |
| Entity | The source entity ID |

## 4. Handler Interface Contract

All handlers follow a common signature: they accept a target ID, a parameter object, and a context object, and return a result with success status, a message, and optional data.

**Context object** provides the handler with requirement values, action parameters, fulfilling component mappings, and synergy results.

## 5. Benefits

1. **SRP Compliance**: Each module has one reason to change
2. **Testability**: Individual handlers tested in isolation
3. **Maintainability**: Changes to one type don't risk others
4. **Backward Compatibility**: Existing handler map access unchanged