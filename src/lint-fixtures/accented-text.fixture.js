/**
 * Intentionally BAD fixture for cr/no-accented-text (CR NAME-1).
 *
 * 'cafe' here carries an accented letter; the rule must report it.
 * This file is excluded from check:lang (check-pt SKIP_DIRS) and from the
 * gate lint (`npm run lint`), because it is a counter-example, not source.
 *
 * @see test/lint-rules.test.js
 */
export const sample = 'café au lait';
