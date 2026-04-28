# 📐 Bug Report Template

Use this template when creating new bug reports for the bugfixWiki.

## Severity Definitions

| Level | Description |
|-------|-------------|
| **CRITICAL** | Data corruption, system crashes, core functionality broken |
| **HIGH** | Major feature impairment, incorrect behavior with workarounds |
| **MEDIUM** | Partial functionality loss, UI issues, performance problems |
| **LOW** | Minor UI glitches, cosmetic issues, edge cases |
| **ARCHITECTURAL** | Design pattern violations, code quality debt, maintainability |

---

## Contributing New Bug Reports

When fixing a bug, document it here:

1. Determine severity level
2. Create file: `bugfixWiki/{severity}/BUG-XXX-{slug-title}.md`
3. Use this template
4. Increment BUG-XXX numbering
5. Add entry to the index table in [README.md](README.md)
6. Update the related wiki if needed

### Bug Report Template

```markdown
# BUG-XXX: [Title]

- **Severity**: CRITICAL / HIGH / MEDIUM / LOW
- **Status**: ✅ Fixed / ⚠️ Known / 🔴 Open
- **Fixed In**: `commit_hash` or `—`
- **Related Files**: `path/to/file.js` (lines N-M)

## Symptoms
What the bug manifested as.

## Root Cause
Why it happened.

## Fix
How it was resolved (with code snippets if relevant).

## Prevention
How to avoid this class of bug in the future.

## References
- Related wiki: `wiki/subMDs/...`
- Related controller: `ControllerName`