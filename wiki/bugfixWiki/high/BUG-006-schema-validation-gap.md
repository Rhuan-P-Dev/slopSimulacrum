# BUG-006: Schema Validation Gap — LLM Response Processing

- **Severity**: HIGH
- **Status**: ✅ Documented (process fix, not code fix)
- **Fixed In**: — (governance standard)
- **Related Files**: `src/controllers/LLMController.js`

## Symptoms

When the LLM returned malformed or incomplete JSON responses:
- The system attempted to process invalid data structures
- Cascading errors occurred downstream in controllers
- Error messages were unclear due to missing validation

## Root Cause

Communication between the LLM backend and the system lacked schema validation at the integration boundary. The `LLMController` did not validate LLM responses against a defined schema before passing data to downstream controllers.

## Fix (Process)

Documented the mandatory schema validation requirement in `wiki/code_quality_and_best_practices.md` Section 3.2:

> **Schema Validation**: All communication between the LLM and the system must pass through a schema validator (e.g., Pydantic, Zod, or JSON Schema). If the data is incorrect, the system must reject the input and request a correction rather than attempting to process incomplete or malformed data.

## Prevention

- Always define JSON schemas for LLM response formats
- Use validation libraries (Zod for JavaScript) to validate responses before processing
- Implement retry logic for malformed LLM responses
- Follow the **Strong Typing and Validation** principle from `wiki/code_quality_and_best_practices.md` Section 2.2

## References

- Related wiki: `wiki/subMDs/llm_integration.md`
- Related controller: `LLMController`
- Related bug: [BUG-002](../critical/BUG-002-malformed-consequence-error.md)
- Related bug: [BUG-007](../high/BUG-007-graceful-degradation.md)