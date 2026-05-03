/**
 * Range checking utility for entity proximity validation.
 * Handles Euclidean distance calculations for actions like grab.
 * 
 * Responsibility: Calculate distances between entities and validate proximity.
 * This logic was extracted from ActionController to adhere to the Single Responsibility Principle (SRP).
 * 
 * @module RangeChecker
 */

import Logger from './Logger.js';

/**
 * Checks if a target entity is within range of a source entity.
 * Used for grab actions to verify the item is close enough to pick up.
 *
 * @param {Object} sourceEntity - The source entity (with spatial data).
 * @param {Object} targetEntity - The target entity (with spatial data).
 * @param {number} maxRange - The maximum allowed distance (must be a positive number).
 * @returns {{ success: boolean, error?: string, distance?: number }}
 * @throws {TypeError} If sourceEntity, targetEntity is not an object, or maxRange is not a positive number.
 */
export function checkGrabRange(sourceEntity, targetEntity, maxRange) {
    // Validate sourceEntity
    if (!sourceEntity || typeof sourceEntity !== 'object') {
        throw new TypeError('Invalid sourceEntity: must be an object.');
    }

    // Validate targetEntity
    if (!targetEntity || typeof targetEntity !== 'object') {
        throw new TypeError('Invalid targetEntity: must be an object.');
    }

    // Validate maxRange is a positive number
    if (typeof maxRange !== 'number' || maxRange <= 0 || !isFinite(maxRange)) {
        throw new TypeError('Invalid maxRange: must be a positive number.');
    }

    // Both entities must have spatial data
    if (!sourceEntity.spatial || !targetEntity.spatial) {
        return { success: false, error: 'One or both entities lack spatial data.' };
    }

    // Calculate Euclidean distance
    const dx = sourceEntity.spatial.x - targetEntity.spatial.x;
    const dy = sourceEntity.spatial.y - targetEntity.spatial.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > maxRange) {
        const error = `Item is too far away (${Math.round(distance)} units, max range: ${maxRange}). Move closer to grab it.`;
        Logger.warn(`[RangeChecker] Grab range check failed: distance=${distance.toFixed(1)}, maxRange=${maxRange}`);
        return { success: false, error, distance: Math.round(distance) };
    }

    Logger.info(`[RangeChecker] Grab range check passed: distance=${distance.toFixed(1)}, maxRange=${maxRange}`);
    return { success: true, distance: Math.round(distance) };
}