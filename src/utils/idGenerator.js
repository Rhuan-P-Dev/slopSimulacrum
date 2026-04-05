const crypto = require('crypto');

/**
 * Generates a cryptographically strong unique identifier (UUID v4).
 * @returns {string} A unique random ID.
 */
function generateUID() {
    return crypto.randomUUID();
}

module.exports = { generateUID };
