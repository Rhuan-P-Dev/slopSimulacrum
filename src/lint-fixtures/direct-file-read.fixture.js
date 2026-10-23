/**
 * Intentionally BAD fixture for cr/no-direct-file-read (CR B-3).
 *
 * Imports `fs` from outside the data seam; the rule must report the import.
 * (Allowed seam: src/utils/DataLoader.js, src/utils/PngCharaReader.js,
 *  src/controllers/logic/CardSpawnLogic.js — all configured in eslint.config.js.)
 *
 * @see test/lint-rules.test.js
 */
import fs from 'fs';

export const readOne = (p) => fs.readFileSync(p, 'utf-8');
