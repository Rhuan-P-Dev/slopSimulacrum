/**
 * Intentionally BAD fixture for cr/fetch-requires-signal (CR E-5).
 *
 * `fetch()` without an AbortSignal; the rule must report it.
 *
 * @see test/lint-rules.test.js
 */
export async function post(url, payload) {
    // Deliberately no signal: this is what the gate must catch.
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    return response.text();
}
