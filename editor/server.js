/**
 * server — The action editor's own HTTP server.
 *
 * WHY a separate server:
 *   The user asked for a *separate project*. This server lives entirely in
 *   editor/ and serves the web UI (static public/) plus a small JSON API that
 *   reads the game's data/vocabularies, manages the local action store, and —
 *   only on explicit confirm — applies the store to the game's
 *   data/actions.json (with a pre-apply backup).
 *
 * @module server
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import buildVocabulary from './src/vocabulary.js';
import {
    readLiveRegistry,
    readLocalStore,
    saveLocalStore,
    applyToLive,
    revertLive,
    listBackups,
    diffRegistries,
} from './src/repo.js';
import { validateRegistry, validateRange } from './src/schema.js';
import { paths } from './src/paths.js';

const __file = fileURLToPath(import.meta.url);
const EDITOR_DIR = path.dirname(__file);
const PUBLIC_DIR = path.join(EDITOR_DIR, 'public');

const Vocab = buildVocabulary();

const app = express();
app.use(express.json());

// Serve the static UI.
app.use(express.static(PUBLIC_DIR));

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * GET /api/vocabulary — the pickers' data + the "how actions execute" reference.
 */
app.get('/api/vocabulary', (_req, res) => {
    res.json(Vocab);
});

/**
 * GET /api/store — the local editable action registry.
 */
app.get('/api/store', (_req, res) => {
    res.json(readLocalStore());
});

/**
 * POST /api/validate — validate a registry against the schema (no write).
 * Used by the client's live validation panel.
 */
app.post('/api/validate', (_req, res) => {
    const registry = _req.body?.registry;
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
        return res.json({
            ok: false,
            validation: { valid: false, count: 0, issues: [{ action: null, field: 'registry', message: 'registry ausente', type: 'error' }] },
        });
    }
    const validation = validateRegistry(registry);
    res.json({ ok: true, validation });
});

/**
 * POST /api/store — save the local editable registry (body: { registry }).
 * Validates, then writes to the local store. Does NOT touch the live file.
 */
app.post('/api/store', (_req, res) => {
    const registry = _req.body?.registry;
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
        return res.status(400).json({ ok: false, error: 'body.registry must be a non-empty object' });
    }
    const validation = validateRegistry(registry);
    const saved = saveLocalStore(registry);
    res.json({
        ok: saved.ok,
        saved,
        validation,
    });
});

/**
 * GET /api/live — the game's current action registry (for diff/reference).
 */
app.get('/api/live', (_req, res) => {
    res.json(readLiveRegistry() ?? null);
});

/**
 * GET /api/diff — compare the local store to the live registry.
 */
app.get('/api/diff', (_req, res) => {
    const diff = diffRegistries(readLocalStore(), readLiveRegistry() ?? {});
    res.json(diff);
});

/**
 * POST /api/apply — copy the local store over the game's data/actions.json.
 * Validates and backs up the live file before overwriting.
 */
app.post('/api/apply', (_req, res) => {
    const registry = _req.body?.registry ?? readLocalStore();
    if (!registry || typeof registry !== 'object' || Array.isArray(registry) || Object.keys(registry).length === 0) {
        return res.status(400).json({ ok: false, error: 'registry must be a non-empty object' });
    }
    const validation = validateRegistry(registry);
    // Refuse to apply a store that has *hard* schema errors.
    if (!validation.valid) {
        return res.status(400).json({
            ok: false,
            error: 'local store has schema errors; fix them before applying',
            validation,
        });
    }
    const result = applyToLive(registry);
    res.json({ ok: result.ok, result, validation });
});

/**
 * POST /api/reload-local — overwrite the local store with a fresh copy of the
 * live registry (discard local edits).
 */
app.post('/api/reload-local', (_req, res) => {
    const live = readLiveRegistry() ?? {};
    const saved = saveLocalStore({ ...live });
    res.json({ ok: saved.ok, saved, local: readLocalStore() });
});

/**
 * GET /api/backups — list pre-apply backups.
 */
app.get('/api/backups', (_req, res) => {
    res.json(listBackups());
});

/**
 * POST /api/revert — restore the most recent (or a named) backup over live.
 */
app.post('/api/revert', (_req, res) => {
    const backupPath = _req.body?.backupPath;
    const result = revertLive(backupPath ?? 'latest');
    res.json({ ok: result.ok, result });
});

/**
 * POST /api/validate-range — validate a single range value/expr against the
 * game's RangeResolver (same grammar the engine uses at run time).
 */
app.post('/api/validate-range', (_req, res) => {
    const result = validateRange(_req.body?.range);
    res.json({ ok: true, result });
});

// 404 handler for unknown API routes (the static fall-through covers everything else).
app.get('/api/:unknown', (_req, res) => {
    res.status(404).json({ ok: false, error: 'unknown endpoint' });
});

const PORT = process.env.ACTION_EDITOR_PORT
    ? Number(process.env.ACTION_EDITOR_PORT)
    : 8380; // avoids colliding with the game's default
app.listen(PORT, () => {
    // Log to stdout only — the editor has no Logger dependency of the game.
    console.log(`[action-editor] listening on http://127.0.0.1:${PORT}`);
    console.log(`[action-editor] local store: ${paths.localStoreFile}`);
    console.log(`[action-editor] live registry : ${paths.liveActionsFile}`);
    console.log(`[action-editor] backups dir   : ${paths.backupDir}`);
});
