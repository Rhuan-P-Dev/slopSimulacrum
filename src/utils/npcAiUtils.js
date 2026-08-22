/**
 * Utility functions for NPC AI predicate checks.
 *
 * @module npcAiUtils
 */

/**
 * Determines whether the entity is driven by a deterministic NPC brain
 * (i.e., it has an `npcConfig.ai` object with a non-empty `behavior` string).
 *
 * When this returns `true`, the LLM agent path must skip the entity so the
 * deterministic AI brain handles it instead.
 *
 * @param {Object|undefined} entity — the game entity to inspect
 * @returns {boolean} `true` if the entity has a valid deterministic brain config
 */
export function hasDeterministicBrain(entity) {
    const ai = entity?.npcConfig?.ai;
    return typeof ai?.behavior === 'string' && ai.behavior !== '';
}
