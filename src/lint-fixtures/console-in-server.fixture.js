/**
 * Intentionally BAD fixture for no-console (CR OBS-1).
 *
 * Any console.* in src/ (outside the sanctioned sinks src/utils/Logger.js and
 * shared/RangeResolver.js) must fail the gate.
 *
 * @see test/lint-rules.test.js
 */
export function logSomething() {
    console.error('placeholder diagnostic; must live in Logger (CR OBS-1)');
}
