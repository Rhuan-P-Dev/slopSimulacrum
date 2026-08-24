import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanForPT } from '../../scripts/check-pt.mjs';

describe('Portuguese Language Regression Scanner', () => {
  let tempDir = null;

  afterEach(async () => {
    // Clean up temp directory if created
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch { /* ignore cleanup errors */ }
      tempDir = null;
    }
  });

  it('integration: should find no Portuguese in the clean repo', async () => {
    const projectRoot = join(import.meta.url, '../../..').replace(/\/index\.js$/, '');
    // Use '.' to scan from project root (scanForPT resolves relative to PROJECT_ROOT internally)
    const { matches } = await scanForPT(['.']);
    expect(matches).toHaveLength(0);
  });

  it('detection: should flag PT words but NOT allowlisted false-positives', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pt-check-'));
    
    // File with a Portuguese line AND a Bézier false-positive line
    const testFile = join(tempDir, 'test-file.js');
    await writeFile(testFile, [
      'const x = "quando o componente falha";',       // PT: should be flagged
      '// Draws a curved (Bézier) path',               // False positive: should NOT be flagged
      '// Bézier curve with naïve algorithm',          // False positives: should NOT be flagged
      'const y = "fiancée"',                            // False positive: should NOT be flagged
      'const z = "hello world"',                       // English: should NOT be flagged
    ].join('\n'));

    const { matches } = await scanForPT([tempDir]);
    
    // Should find exactly 1 match (the PT line)
    expect(matches).toHaveLength(1);
    expect(matches[0].content).toContain('quando');
    expect(matches[0].content).not.toContain('Bézier');
    expect(matches[0].content).not.toContain('naïve');
    expect(matches[0].content).not.toContain('fiancée');
  });
});
