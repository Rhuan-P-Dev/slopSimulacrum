/**
 * Logger — `LOG_LEVEL` threshold gate (server-side environment knob).
 *
 * Seam (same pattern as test/unit/KillerLlmDroneSpawn.test.js): the environment
 * variable is the only external input, so every test snapshots the ambient
 * value and restores it in `afterEach` — a gate-ON verification cannot leak
 * into tests that expect the unset state. The sink is spied per test because
 * the Logger is the one module allowed to write to `console.*`, and the gate
 * is observable purely as which console method (and how often) each call
 * chooses.
 *
 * Covers the gate matrix (row = LOG_LEVEL, emitted levels):
 *   - unset / DEBUG          : DEBUG INFO WARN ERROR CRITICAL
 *   - INFO                   : (DEBUG) INFO WARN ERROR CRITICAL
 *   - WARN                   : (DEBUG INFO) WARN ERROR CRITICAL
 *   - ERROR                  : (DEBUG INFO WARN) ERROR CRITICAL
 *   - CRITICAL               : (DEBUG INFO WARN ERROR) CRITICAL
 *   - "  info  "             : same as INFO (case and whitespace insensitive)
 *   - unrecognized value     : falls back to DEBUG (everything emitted) plus
 *                              a single process-lifetime diagnostic warning,
 *                              never a silent degradation;
 *   - unknown level argument : emitted via the legacy default path (the gate
 *                              only knows about DEBUG..CRITICAL), format
 *                              unchanged.
 *
 * @module test/unit/Logger.logFilter
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Logger from '../../src/utils/Logger.js';

/**
 * Environment value inherited by the process (undefined in a clean test env,
 * possibly set by a harness). Snapped before the first test, restored after
 * every test, so ambient state cannot leak between the matrix cases.
 */
const AMBIENT_LOG_LEVEL = process.env.LOG_LEVEL;

/**
 * Pairs each console sink used by the Logger with a no-op implementation, so
 * a gate can be asserted by per-method call count instead of terminal text.
 *
 * @returns {{ log: typeof vi.Spy, debug: typeof vi.Spy, warn: typeof vi.Spy, error: typeof vi.Spy }}
 * @private
 */
function spyConsole() {
    return {
        log: vi.spyOn(console, 'log').mockImplementation(() => {}),
        debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
        warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
        error: vi.spyOn(console, 'error').mockImplementation(() => {})
    };
}

/**
 * Restores `process.env.LOG_LEVEL` to the ambient value captured at module
 * load.
 * @private
 */
function restoreEnv() {
    if (AMBIENT_LOG_LEVEL === undefined) {
        delete process.env.LOG_LEVEL;
    } else {
        process.env.LOG_LEVEL = AMBIENT_LOG_LEVEL;
    }
}

beforeEach(() => {
    if (AMBIENT_LOG_LEVEL === undefined) {
        delete process.env.LOG_LEVEL;
    }
});

afterEach(() => {
    restoreEnv();
});

describe('gate: unset or DEBUG (pre-gate default)', () => {
    it('emits all five levels when LOG_LEVEL is unset', () => {
        const sink = spyConsole();
        Logger.debug('d');
        Logger.info('i');
        Logger.warn('w');
        Logger.error('e');
        Logger.critical('c');
        expect(sink.log).toHaveBeenCalledTimes(2); // debug + info
        expect(sink.warn).toHaveBeenCalledTimes(1);
        expect(sink.error).toHaveBeenCalledTimes(2); // error + critical
        Object.values(sink).forEach(s => s.mockRestore());
    });

    it('emits all five levels when LOG_LEVEL is DEBUG', () => {
        const sink = spyConsole();
        process.env.LOG_LEVEL = 'debug';
        Logger.debug('d');
        Logger.info('i');
        Logger.warn('w');
        Logger.error('e');
        Logger.critical('c');
        expect(sink.log).toHaveBeenCalledTimes(2);
        expect(sink.warn).toHaveBeenCalledTimes(1);
        expect(sink.error).toHaveBeenCalledTimes(2);
        Object.values(sink).forEach(s => s.mockRestore());
    });

    it('falls back to DEBUG for an unrecognized value, with a one-shot diagnostic', () => {
        const sink = spyConsole();
        process.env.LOG_LEVEL = 'TRACE-ISH';
        Logger.info('i'); // first resolve() fires the diagnostic (console.warn)
        Logger.error('e');
        Logger.info('i2'); // a later resolve() must not repeat the diagnostic
        expect(sink.log).toHaveBeenCalledTimes(2);
        expect(sink.error).toHaveBeenCalledTimes(1);
        expect(sink.warn).toHaveBeenCalledTimes(1); // one-shot: only the diagnostic
        Object.values(sink).forEach(s => s.mockRestore());
    });
});

describe('gate: minimum-level threshold', () => {
    // Ascending severity, same ordering as Logger.LEVEL_RANKS — the expectation
    // for a gate is derived from it, so the test doubles as a regression
    // check that the gate honors the severity ordering.
    const SEVERITY_ORDER = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'];

    const atOrAbove = gate =>
        SEVERITY_ORDER.filter(
            l =>
                SEVERITY_ORDER.indexOf(l) >=
                SEVERITY_ORDER.indexOf(gate.trim().toUpperCase())
        );

    it.each(
        ['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL', '  info  ']
    )(
        'emits %j and every more severe level (LOG_LEVEL)',
        (gate) => {
            const emitted = atOrAbove(gate);
            const sink = spyConsole();
            process.env.LOG_LEVEL = gate;
            Logger.debug('d');
            Logger.info('i');
            Logger.warn('w');
            Logger.error('e');
            Logger.critical('c');
            expect(
                sink.log,
                `INFO/DEBUG sink count for LOG_LEVEL=${JSON.stringify(gate)}`
            ).toHaveBeenCalledTimes(emitted.filter(l => l === 'INFO' || l === 'DEBUG').length);
            expect(
                sink.warn,
                `WARN sink count for LOG_LEVEL=${JSON.stringify(gate)}`
            ).toHaveBeenCalledTimes(emitted.filter(l => l === 'WARN').length);
            expect(
                sink.error,
                `ERROR/CRITICAL sink count for LOG_LEVEL=${JSON.stringify(gate)}`
            ).toHaveBeenCalledTimes(emitted.filter(l => l === 'ERROR' || l === 'CRITICAL').length);
            Object.values(sink).forEach(s => s.mockRestore());
        }
    );
});

describe('output format (above the gate)', () => {
    it('keeps the "❌ ERROR: [ts] [ERROR] message | Context" shape', () => {
        const sink = spyConsole();
        process.env.LOG_LEVEL = 'ERROR';
        Logger.error('boom', { a: 1, b: 2 });
        expect(sink.error).toHaveBeenCalledTimes(1);
        const line = sink.error.mock.calls[0][0];
        expect(line).toContain('❌ ERROR: ');
        expect(
            line,
            'timestamp + level tag + message + serialized context must be intact'
        ).toMatch(
            /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[ERROR\] boom \| Context: \{"a":1,"b":2\}$/
        );
        Object.values(sink).forEach(s => s.mockRestore());
    });
});

describe('unknown level arguments', () => {
    it('emits via the legacy default path (gate only knows DEBUG..CRITICAL)', () => {
        const sink = spyConsole();
        process.env.LOG_LEVEL = 'ERROR';
        Logger.log('TRACE', 't'); // unknown level -> not gated -> default sink
        Logger.debug('d');        // known level -> gated out at ERROR
        expect(sink.log).toHaveBeenCalledTimes(1);
        expect(sink.error).toHaveBeenCalledTimes(0);
        expect(
            sink.log.mock.calls[0][0],
            'unknown levels must not be rewritten to an INFO tag'
        ).toMatch(/\[TRACE\] t/);
        Object.values(sink).forEach(s => s.mockRestore());
    });
});
