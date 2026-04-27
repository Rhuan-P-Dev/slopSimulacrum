import crypto from 'crypto';

/**
 * Generates a cryptographically strong unique identifier (UUID v4).
 * @returns {string} A unique random ID.
 */
export function generateUID() {
    return crypto.randomUUID();
}

export default generateUID;