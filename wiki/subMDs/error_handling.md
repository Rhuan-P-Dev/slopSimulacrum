# ⚠️ Error Handling Standard

## 1. Overview
To ensure maintainability and consistency across the system, all controllers must follow a structured approach to error reporting. Instead of returning plain strings, errors must be represented as structured objects that can be easily parsed by the system and formatted for the end-user.

## 2. Error Object Structure
All error responses must follow this schema:

```javascript
{
    code: "ERROR_CODE_UPPER_SNAKE_CASE",
    message: "Human-readable message (template)",
    details: {
        // Contextual data used to populate the message template
        key: value
    },
    level: "INFO" | "WARN" | "ERROR" | "CRITICAL"
}
```

### 2.1. Logging Levels
- **INFO**: Informational messages that do not indicate a problem.
- **WARN**: Non-critical issues that may require attention but don't stop the process.
- **ERROR**: Significant failures that prevent a specific operation from completing.
- **CRITICAL**: System-wide failures that may cause crashes or data loss.

## 3. Error Resolution Process
Controllers should separate **Error Detection** from **Error Formatting**.

1.  **Detection**: The logic identifies a failure and returns a structured error object with a `code` and `details`.
2.  **Formatting**: A generic resolver (or a dedicated ErrorController) takes the `code` and `details` to produce the final human-readable string.

## 4. Action System Error Codes
Common codes used in `ActionController`:
- `ENTITY_NOT_FOUND`: The requested entity ID does not exist in the world state.
- `ACTION_NOT_FOUND`: The requested action name is not registered.
- `MISSING_TRAIT_STAT`: The entity lacks the required trait or stat for the action.
- `INSUFFICIENT_DURABILITY`: The entity has the trait but lacks minimum durability.
- `UNKNOWN_REQUIREMENT_FAILURE`: A requirement check failed for an unspecified reason.
- `CONSEQUENCE_EXECUTION_FAILED`: An error occurred during the execution of an action's consequences.
- `SYSTEM_RUNTIME_ERROR`: An unexpected exception occurred during processing.

## 5. Template Syntax
Templates use curly braces for variable injection:
`"Entity {entityId} not found."` $\rightarrow$ `details: { entityId: "uuid-123" }`
