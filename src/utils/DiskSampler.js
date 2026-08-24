/**
 * DiskSampler — utilitário puro para amostragem uniforme em disco (§4.2).
 *
 * Usa ângulo uniforme em 0..2π e raio por raiz quadrada do uniforme
 * para evitar viés para o centro. Compartilhado pelo gatilho de facas
 * e pelo spill do §3.5.1.
 *
 * @module DiskSampler
 */

import Logger from '../utils/Logger.js';

/** Raio padrão para triggers (5 unidades) — exportado para uso compartilhado (§3.5.1, §4.6). */
export const DEFAULT_TRIGGER_RADIUS = 5;

/**
 * Gera um ponto aleatório uniforme em disco.
 * @param {number} cx - Centro X.
 * @param {number} cy - Centro Y.
 * @param {number} radius - Raio do disco.
 * @param {() => number} [rand=Math.random] - Função geradora de random (para testes).
 * @returns {{ x: number, y: number }} Ponto dentro do disco.
 */
function sampleDiskPoint(cx, cy, radius, rand = Math.random) {
    // Guard: non-finite or non-positive radius must not produce garbage coordinates.
    if (!Number.isFinite(radius) || radius <= 0) {
        Logger.warn(`[DiskSampler] sampleDiskPoint called with invalid radius: ${radius}; returning null.`);
        return null;
    }
    const angle = rand() * 2 * Math.PI;
    // Raio por raiz quadrada do uniforme para distribuição uniforme
    const r = radius * Math.sqrt(rand());
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    return { x, y };
}

export { sampleDiskPoint };
