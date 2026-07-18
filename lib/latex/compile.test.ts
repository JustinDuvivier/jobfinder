import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileLatex, clearCompileCache, LatexCompileError } from './compile';
import { countPdfPages } from './page-count';
import { PDFLATEX_BIN } from './sandbox';

/** Is a working pdflatex available? Integration tests are skipped if not. */
const HAS_PDFLATEX = (() => {
  try {
    return spawnSync(PDFLATEX_BIN, ['--version'], { timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
})();

const GOLDEN_TEX = readFileSync(
  join(process.cwd(), 'golden', 'fixtures', 'onepage.tex'),
  'utf8',
);

const EXAMPLE_TEX = readFileSync(
  join(process.cwd(), 'resume-example', 'base_resume.tex'),
  'utf8',
);

describe.skipIf(!HAS_PDFLATEX)('compileLatex (integration — requires pdflatex)', () => {
  beforeEach(() => {
    clearCompileCache();
  });

  it('compiles the golden reference to exactly one page', async () => {
    const result = await compileLatex(GOLDEN_TEX);
    expect(result.pageCount).toBe(1);
    expect(result.cached).toBe(false);
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    // The bytes are a real PDF the page-count check can read back.
    expect(await countPdfPages(result.pdf)).toBe(1);
  }, 30000);

  it('compiles the committed starter example resume to exactly one page', async () => {
    // resume-example/base_resume.tex is the out-of-the-box base resume for a
    // fresh clone; it must satisfy the same one-page invariant /api/save
    // enforces on every approved rewrite.
    const result = await compileLatex(EXAMPLE_TEX);
    expect(result.pageCount).toBe(1);
    expect(await countPdfPages(result.pdf)).toBe(1);
  }, 30000);

  it('serves the cache on a second compile of identical source', async () => {
    const first = await compileLatex(GOLDEN_TEX);
    const second = await compileLatex(GOLDEN_TEX);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.pageCount).toBe(first.pageCount);
  }, 30000);

  it('throws LatexCompileError on invalid LaTeX', async () => {
    const broken = '\\documentclass{article}\\begin{document}\\thisCommandDoesNotExist\\end{document}';
    await expect(compileLatex(broken)).rejects.toBeInstanceOf(LatexCompileError);
  }, 30000);
});

// Always-on guard so the file has at least one active test even without TeX.
describe('compile environment', () => {
  it('reports whether pdflatex is available', () => {
    expect(typeof HAS_PDFLATEX).toBe('boolean');
  });
});
