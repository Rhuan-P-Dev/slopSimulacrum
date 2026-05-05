import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Logger from './Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * DataLoader provides a centralized way to load JSON configuration files.
 * This ensures that controllers remain generic interpreters of data
 * and are not tightly coupled to the filesystem.
 */
class DataLoader {
    /**
     * Loads a JSON file from the specified relative path.
     * @param {string} relativePath - Path relative to the project root.
     * @returns {any} The parsed JSON content.
     * @throws {Error} If the file cannot be read or parsed.
     */
    static loadJson(relativePath) {
        try {
            const absolutePath = path.resolve(__dirname, '..', '..', relativePath);
            const data = fs.readFileSync(absolutePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            Logger.error(`[DataLoader] Failed to load file at ${relativePath}:`, error.stack || error);
            throw new Error(`[DataLoader] Failed to load file at ${relativePath}: ${error.message}`, { cause: error });
        }
    }

    /**
     * Safely loads a JSON file, returning a default value if loading fails.
     * @param {string} relativePath - Path relative to the project root.
     * @param {any} defaultValue - Value to return on failure.
     * @returns {any}
     */
    static loadJsonSafe(relativePath, defaultValue = {}) {
        try {
            return this.loadJson(relativePath);
        } catch (error) {
            Logger.warn(`[DataLoader] Failed to load ${relativePath}, using default: ${error.message}`);
            return defaultValue;
        }
    }
}

export default DataLoader;
