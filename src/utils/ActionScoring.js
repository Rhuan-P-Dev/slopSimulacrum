/**
 * ActionScoring — Shared scoring constants and utilities for action-component compatibility.
 * This module provides a single source of truth for all scoring-related constants
 * used across ActionController and ComponentController.
 * 
 * Per wiki/code_quality_and_best_practices.md §2.3: Avoid "Magic Numbers"
 * All threshold and scoring values are defined here as named constants.
 */

/**
 * Scoring constants for component-action compatibility evaluation.
 * @readonly
 * @enum {number}
 */
export const ACTION_SCORING = {
    /** Score awarded when a component fully meets a requirement */
    REQUIREMENT_MET: 1.0,
    
    /** Bonus score multiplier for significantly exceeding the threshold */
    REQUIREMENT_EXCEEDED_BONUS: 0.1,
    
    /** Penalty applied when a component is close to (but below) the threshold */
    CLOSE_TO_THRESHOLD_PENALTY: -0.2,
    
    /** Ratio above which a value is considered "significantly exceeding" the threshold */
    EXCEEDED_THRESHOLD_MULTIPLIER: 2.0,
};

/**
 * Factor used to determine if a value is "close" to a threshold.
 * A value is considered close if: value / minValue > (1 / CLOSE_TO_THRESHOLD_FACTOR)
 * @type {number}
 */
export const CLOSE_TO_THRESHOLD_FACTOR = 1.25;
