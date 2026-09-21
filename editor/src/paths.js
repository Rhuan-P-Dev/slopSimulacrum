/**
 * paths — Project-root and file-path resolution for the action editor.
 *
 * WHY this exists:
 *   The editor is a *separate project* living in `<projectRoot>/editor/`, but it
 *   must read the game's source-of-truth files (data/actions.json) and shared
 *   vocabularies (shared/*.js) from the parent project. Centralising the path
 *   math here keeps every other module from hard-coding relative strings, so a
 *   move of the editor directory is a one-line change.
 *
 *   All paths are resolved from `__file` (the location of this file), not from
 *   `process.cwd()`, so the server can be started from any directory and always
 *   finds the same files.
 *
 * @module paths
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The directory this file lives in: <projectRoot>/editor/src. */
const __file = fileURLToPath(import.meta.url);

/** The editor project root: <projectRoot>/editor. */
const EDITOR_DIR = path.dirname(path.dirname(__file));

/** The parent game project root: <projectRoot>. */
const PROJECT_ROOT = path.dirname(EDITOR_DIR);

/** The shared/vocabulary modules dir: <projectRoot>/shared. */
const SHARED_DIR = path.join(PROJECT_ROOT, 'shared');

/** The game's live action registry: <projectRoot>/data/actions.json. */
const LIVE_ACTIONS_FILE = path.join(PROJECT_ROOT, 'data', 'actions.json');

/** The editor's local, editable store: <editorRoot>/data/actions.json. */
const LOCAL_STORE_FILE = path.join(EDITOR_DIR, 'data', 'actions.json');

/** Where pre-apply backups of the live registry are written: <editorRoot>/data/backups. */
const BACKUP_DIR = path.join(EDITOR_DIR, 'data', 'backups');

/**
 * Resolved path set for the rest of the editor.
 * @type {Object}
 */
export const paths = {
    projectRoot: PROJECT_ROOT,
    editorDir: EDITOR_DIR,
    sharedDir: SHARED_DIR,
    actionVocabularyFile: path.join(SHARED_DIR, 'ActionVocabulary.js'),
    statVocabularyFile: path.join(SHARED_DIR, 'StatVocabulary.js'),
    rangeResolverFile: path.join(SHARED_DIR, 'RangeResolver.js'),
    liveActionsFile: LIVE_ACTIONS_FILE,
    localStoreFile: LOCAL_STORE_FILE,
    backupDir: BACKUP_DIR,
};

export default paths;
