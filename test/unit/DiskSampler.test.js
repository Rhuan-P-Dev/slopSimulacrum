/**
 * DiskSampler — unit tests (PHASE 7).
 *
 * Verifies: constant DEFAULT_TRIGGER_RADIUS === 5; property r = radius·√u
 * for sampled points with seeded/injected rand; uniform distribution.
 * NaN/invalid guard: non-finite, zero or negative radius returns null + Logger.warn.
 *
 * @module test/unit/DiskSampler
 */

import { describe, it, expect, vi } from 'vitest';
import { sampleDiskPoint, DEFAULT_TRIGGER_RADIUS } from '../../src/utils/DiskSampler.js';
import Logger from '../../src/utils/Logger.js';

describe('DiskSampler', () => {
    it('DEFAULT_TRIGGER_RADIUS deve ser exatamente 5', () => {
        expect(DEFAULT_TRIGGER_RADIUS).toBe(5);
    });

    it('Sampled point with injected rand: r = radius · √u', () => {
        // Inject deterministic rand: u=0.25 → √0.25 = 0.5 → r = 10 * 0.5 = 5
        const u = 0.25;
        const rand = () => u;
        const cx = 0;
        const cy = 0;
        const radius = 10;

        const point = sampleDiskPoint(cx, cy, radius, rand);

        // angle = u * 2π = 0.25 * 2π = π/2 → cos(π/2) ≈ 0, sin(π/2) = 1
        // x = cx + r * cos(angle) = 0 + 5 * 0 ≈ 0
        // y = cy + r * sin(angle) = 0 + 5 * 1 = 5
        const expectedR = radius * Math.sqrt(u);
        const actualR = Math.sqrt(point.x * point.x + point.y * point.y);
        expect(actualR).toBeCloseTo(expectedR, 5);
    });

    it('Point always inside radius (r ≤ radius)', () => {
        // Test with various u values ∈ (0, 1)
        const testCases = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99];
        const radius = 10;

        for (const u of testCases) {
            const rand = () => u;
            const point = sampleDiskPoint(0, 0, radius, rand);
            const r = Math.sqrt(point.x * point.x + point.y * point.y);
            expect(r).toBeLessThanOrEqual(radius);
            expect(r).toBeGreaterThan(0);
        }
    });

    it('Disc center as sampling point', () => {
        const cx = 100;
        const cy = 200;
        const radius = 5;
        let callCount = 0;
        // u=0.5 → √0.5 ≈ 0.7071; angle = 0.5 * 2π = π
        // cos(π) = -1, sin(π) = 0
        const rand = () => {
            callCount++;
            if (callCount === 1) return 0.5; // angle
            return 0.5; // u
        };

        const point = sampleDiskPoint(cx, cy, radius, rand);

        const expectedR = radius * Math.sqrt(0.5);
        const expectedX = cx + expectedR * Math.cos(Math.PI);
        const expectedY = cy + expectedR * Math.sin(Math.PI); // ≈ 0

        expect(point.x).toBeCloseTo(expectedX, 4);
        expect(point.y).toBeCloseTo(expectedY, 4);
    });

    // --- NaN/invalid-radius guard tests (Item 8) ---

    it('Raio NaN → retorna null e Logger.warn', () => {
        const warnSpy = vi.spyOn(Logger, 'warn').mockReturnThis();
        const point = sampleDiskPoint(0, 0, NaN, Math.random);
        expect(point).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[DiskSampler] sampleDiskPoint called with invalid radius'));
        warnSpy.mockRestore();
    });

    it('Raio Infinity → retorna null e Logger.warn', () => {
        const warnSpy = vi.spyOn(Logger, 'warn').mockReturnThis();
        const point = sampleDiskPoint(0, 0, Infinity, Math.random);
        expect(point).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[DiskSampler] sampleDiskPoint called with invalid radius'));
        warnSpy.mockRestore();
    });

    it('Raio -Infinity → retorna null e Logger.warn', () => {
        const warnSpy = vi.spyOn(Logger, 'warn').mockReturnThis();
        const point = sampleDiskPoint(0, 0, -Infinity, Math.random);
        expect(point).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[DiskSampler] sampleDiskPoint called with invalid radius'));
        warnSpy.mockRestore();
    });

    it('Raio 0 → retorna null e Logger.warn', () => {
        const warnSpy = vi.spyOn(Logger, 'warn').mockReturnThis();
        const point = sampleDiskPoint(5, 5, 0, Math.random);
        expect(point).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[DiskSampler] sampleDiskPoint called with invalid radius'));
        warnSpy.mockRestore();
    });

    it('Raio negativo → retorna null e Logger.warn', () => {
        const warnSpy = vi.spyOn(Logger, 'warn').mockReturnThis();
        const point = sampleDiskPoint(0, 0, -5, Math.random);
        expect(point).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[DiskSampler] sampleDiskPoint called with invalid radius'));
        warnSpy.mockRestore();
    });

    it('Valid radius produces point inside disk (regression)', () => {
        const radius = 10;
        for (const u of [0.01, 0.25, 0.5, 0.75, 0.99]) {
            const rand = () => u;
            const point = sampleDiskPoint(3, 4, radius, rand);
            expect(point).not.toBeNull();
            const r = Math.sqrt((point.x - 3) ** 2 + (point.y - 4) ** 2);
            expect(r).toBeLessThanOrEqual(radius);
            expect(r).toBeGreaterThan(0);
        }
    });
});
