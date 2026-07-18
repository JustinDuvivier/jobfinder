import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadResumeAssets, clearResumeAssetsCache } from './load';

const EXAMPLE_SRC = join(process.cwd(), 'resume-example');

/** A temp root seeded with the repo's committed resume-example/. */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jobfinder-load-'));
  cpSync(EXAMPLE_SRC, join(root, 'resume-example'), { recursive: true });
  return root;
}

let root: string;

beforeEach(() => {
  clearResumeAssetsCache();
  root = makeRoot();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadResumeAssets', () => {
  it('falls back to the committed resume-example/ when resume/ is absent (fresh clone)', () => {
    const a = loadResumeAssets(root);
    // Pin the committed example templates to what the app relies on.
    expect(a.baseResume).toContain('\\documentclass');
    expect(a.baseResume).toContain('Alex Candidate');
    expect(a.sourceOfTruth).toMatch(/\*\*Years of experience[^:]*:/);
    expect(a.scoringPrompt.toLowerCase()).toContain('years of experience');
    expect(a.rewriteRules).toContain('Minimal Touch');
  });

  it('prefers user-supplied files in resume/, per file', () => {
    mkdirSync(join(root, 'resume'));
    writeFileSync(join(root, 'resume', 'base_resume.tex'), 'USER TEX');
    writeFileSync(join(root, 'resume', 'source_of_truth.md'), 'USER SOT');
    const a = loadResumeAssets(root);
    // The two supplied files win; the two absent ones fall back per file.
    expect(a.baseResume).toBe('USER TEX');
    expect(a.sourceOfTruth).toBe('USER SOT');
    expect(a.scoringPrompt.toLowerCase()).toContain('years of experience');
    expect(a.rewriteRules).toContain('Minimal Touch');
  });

  it('accepts resume/base_resume.old.tex ahead of the example fallback', () => {
    mkdirSync(join(root, 'resume'));
    writeFileSync(join(root, 'resume', 'base_resume.old.tex'), 'OLD USER TEX');
    expect(loadResumeAssets(root).baseResume).toBe('OLD USER TEX');
  });

  it('throws a named error when an asset exists in neither directory', () => {
    rmSync(join(root, 'resume-example', 'rewrite_rules.md'));
    expect(() => loadResumeAssets(root)).toThrow('Missing resume asset: resume/rewrite_rules.md');
  });

  it('resolves against the repo root and caches after the first default read', () => {
    // The committed fallback guarantees this works in a fresh clone with no resume/.
    const a = loadResumeAssets();
    expect(a.baseResume).toContain('\\documentclass');
    expect(loadResumeAssets()).toBe(a);
  });
});
