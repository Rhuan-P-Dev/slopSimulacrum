#!/usr/bin/env node
/**
 * check-pt.mjs — Portuguese language regression scanner.
 *
 * Walks the repo tree, detects accented characters (with false-positive allowlist)
 * and unambiguous Portuguese words.  Fails (exit 1) if any matches are found.
 *
 * Usage:
 *   node scripts/check-pt.mjs                  # scan project root
 *   node scripts/check-pt.mjs src/ test/       # scan specific paths
 */

import { readdir, stat, readFile, open as openFile } from 'node:fs/promises';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── Configuration ────────────────────────────────────────────────────────────

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_PATH = fileURLToPath(import.meta.url);

/** Extensions considered binary (skip these files). */
const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'kra', 'ico', 'woff', 'woff2', 'ttf',
  'otf', 'pdf', 'zip', 'mp3', 'wav', 'bin',
]);

/** Directories to skip entirely. */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** Files (by basename) to skip — self-exclusion for scanner + test files. */
const SKIP_FILES = new Set(['check-pt.mjs', 'ptLanguageRegression.test.js']);

/** Accented-char regex (Portuguese-specific diacritics). */
const ACCENTED_RE = /[áéíóúâêôãõçÁÉÍÓÚÂÊÔÃÕÇ]/u;

/** Known false-positive tokens that contain accented chars but are NOT Portuguese. */
const ALLOWLIST_TOKENS = new Set(['B\u00e9zier', 'na\u00efve', 'fianc\u00e9e']);

/**
 * Unambiguous Portuguese words (word-boundary, case-insensitive).
 * Carefully curated — excludes words that also exist in English.
 */
const PT_WORDS = [
  'n\xe3o',       // não
  'voc\xea',      // você  (ç)
  'vocês',        // vocês
  'a\xe7\xe3o',   // ação
  'a\xe7\xf5es',  // ações
  'entidade',
  'entidades',
  'falha',
  'falhas',
  'falhou',
  'remover',
  'remova',
  'removido',
  'criar',
  'crie',
  'cria\xe7\xe3o', // criação
  'salvar',
  'salve',
  'carregar',
  'carrega',
  'quando',
  'onde',
  'porque',
  'sistema',
  'sistemas',
  'componentes',
  'inventario',
  'servidor',
  'dano',
  'faca',
  'cortar',
  'corte',
  'morte',
  'vida',
  'fome',
  'mundo',
  'jogo',
  'jogador',
  'jogadores',
  'turno',
  'turnos',
  'sala',
  'salas',
  'etapa',
  'etapas',
  'passo',
  'passos',
  'caixa',
  'caixas',
  'mensagem',
  'mensagens',
  'aviso',
  'avisos',
  'erro',
  'erros',
  'sucesso',
  'desconectar',
  'selecionar',
  'selecione',
  'clicar',
  'clica',
  'editar',
  'mostrar',
  'mostra',
  'pegar',
  'dropar',
  'poder',
  'ent\xe3o',    // então
  'tamb\xe9m',   // também
  'sempre',
  'nunca',
  'agora',
  'depois',
  'antes',
  'hoje',
  'ontem',
  'amanh\xe3',   // amanhã
  'noite',
  'manh\xe3',    // manhã
  'di\xe1logo',  // diálogo
  'mem\xf3ria',  // memória
  'hist\xf3ria', // história
  'narrativa',
  'controlador',
  'inimigo',
  'inimigos',
  'amigo',
  'amigos',
  'itens',
  'dados',
  'n\xfamero',   // número
  'n\xfameros',  // números
  'ponto',
  'pontos',
  'nome',
  'manipula\xe7\xe3o', // manipulação
  'durabilidade',
  'resist\xeancia',   // resistência
  'velocidade',
  'for\xe7a',         // força
  'sa\xfade',         // saúde
  'sanidade',
];

// Pre-compile word-boundary regexes for PT words (case-insensitive).
const PT_WORD_REs = PT_WORDS.map(w => new RegExp(`\\b${w}\\b`, 'i'));

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Recursively walk a directory, yielding file info objects.
 * Skips binary dirs, binary extensions, and self-excluded files.
 * @param {string} dirPath - Absolute path to directory to walk
 * @param {string} baseDir - Base directory for computing relative paths
 */
async function* walkDir(dirPath, baseDir) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkDir(join(dirPath, entry.name), baseDir);
    } else if (entry.isFile()) {
      // Skip self-excluded files by basename
      if (SKIP_FILES.has(entry.name)) continue;

      // Skip binary extensions
      const ext = entry.name.split('.').pop()?.toLowerCase();
      if (ext && BINARY_EXTS.has(ext)) continue;

      const absPath = join(dirPath, entry.name);
      const relPath = relative(baseDir, absPath);
      yield { absPath, relPath };
    }
  }
}

/**
 * Quick binary check: read first 1 KB and look for null bytes.
 * @param {string} absPath - Absolute path to file
 */
async function isBinaryFile(absPath) {
  const fd = await openFile(absPath, 'r');
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fd.read(buf, 0, 1024, 0);
    // Only check the bytes that were actually read (uninitialized buffer regions are null)
    return buf.subarray(0, bytesRead).indexOf(0x00) !== -1;
  } catch (err) {
    return false; // If we can't read it, skip gracefully
  } finally {
    await fd.close();
  }
}

/**
 * Check if an accented line is a false-positive (only contains allowlisted tokens).
 */
function isAllowlisted(line) {
  // Normalize smart quotes to regular for matching
  const normalized = line
    .replace(/\u2019/g, "'")
    .replace(/\u201c/g, '"')
    .replace(/\u201d/g, '"');

  for (const token of ALLOWLIST_TOKENS) {
    if (normalized.includes(token)) {
      // Remove all occurrences of the token and re-check for accents
      const without = normalized.split(token).join('');
      if (!ACCENTED_RE.test(without)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if a path string is absolute (works on POSIX and Windows).
 */
function isAbsolutePath(p) {
  return p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p);
}

/**
 * Core scanning logic. Returns match objects.
 * Accepts either relative paths (resolved against PROJECT_ROOT) or absolute paths.
 * @param {string[]} scanDirs - directories to scan (relative to project root OR absolute)
 * @returns {{ file: string, line: number, content: string, fileCount: number }}
 */
export async function scanForPT(scanDirs = ['.']) {
  const matches = [];
  const filesWithMatches = new Set();

  for (const scanDir of scanDirs) {
    // Determine the actual directory to walk (absolute)
    const dirPath = isAbsolutePath(scanDir) ? scanDir : join(PROJECT_ROOT, scanDir);

    for await (const { absPath, relPath } of walkDir(dirPath, dirPath)) {
      // Compute relative path from the scan base
      const relativeFromScan = relative(dirPath, absPath);

      // Skip self-excluded files by full path check too
      if (relativeFromScan === 'scripts/check-pt.mjs' || relativeFromScan === 'test/unit/ptLanguageRegression.test.js') continue;

      // Binary guard: check first 1KB for null bytes
      const isBin = await isBinaryFile(absPath);
      if (isBin) continue;

      try {
        const content = await readFile(absPath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;

          let flagged = false;

          // Check 1: Accented characters (with allowlist)
          if (ACCENTED_RE.test(line)) {
            if (!isAllowlisted(line)) {
              flagged = true;
            }
          }

          // Check 2: Portuguese word list
          if (!flagged) {
            for (const re of PT_WORD_REs) {
              if (re.test(line)) {
                flagged = true;
                break;
              }
            }
          }

          if (flagged) {
            // Report relative path from scan base
            matches.push({ file: relativeFromScan, line: i + 1, content: line });
            filesWithMatches.add(relativeFromScan);
          }
        }
      } catch {
        // Skip files we can't read
      }
    }
  }

  return { matches, fileCount: filesWithMatches.size };
}

// ── CLI entry point ──────────────────────────────────────────────────────────
// Guard: only execute when this file is the main module (run directly via `node`).

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scanDirs = process.argv.slice(2).filter(a => !a.startsWith('-'));
  if (scanDirs.length === 0) {
    scanDirs.push('.');
  }

  const { matches, fileCount } = await scanForPT(scanDirs);

  if (matches.length > 0) {
    console.error(`PT REGRESSION DETECTED: ${matches.length} occurrence(s) in ${fileCount} file(s)`);
    for (const m of matches) {
      console.error(`${m.file}:${m.line}:  ${m.content}`);
    }
    process.exit(1);
  } else {
    console.log('check:lang OK — no Portuguese detected');
    process.exit(0);
  }
}
