import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../db';
import * as repo from '../db/repo';
import {
  loadResumeAssets,
  resolveResumeAssets,
  hasUserBaseResumeFile,
  clearResumeAssetsCache,
} from './load';

const EXAMPLE_SRC = join(process.cwd(), 'resume-example');

/** A temp root seeded with the repo's committed resume-example/. */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jobfinder-load-'));
  cpSync(EXAMPLE_SRC, join(root, 'resume-example'), { recursive: true });
  return root;
}

let root: string;
let db: DB;

beforeEach(() => {
  clearResumeAssetsCache();
  root = makeRoot();
  db = openDatabase(':memory:');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadResumeAssets (filesystem layers)', () => {
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
    const cwd = process.cwd();
    try {
      process.chdir(root);
      const a = loadResumeAssets();
      expect(a.baseResume).toContain('\\documentclass');
      // Cached: a file change after the first default read is not observed…
      writeFileSync(join(root, 'resume-example', 'base_resume.tex'), 'CHANGED');
      expect(loadResumeAssets().baseResume).toBe(a.baseResume);
      // …until the cache is reset.
      clearResumeAssetsCache();
      expect(loadResumeAssets().baseResume).toBe('CHANGED');
    } finally {
      process.chdir(cwd);
      clearResumeAssetsCache();
    }
  });
});

describe('resolveResumeAssets (in-app → file → example, with provenance)', () => {
  it('reports example provenance for every asset on a fresh install', () => {
    const resolved = resolveResumeAssets(db, root);
    for (const asset of Object.values(resolved)) {
      expect(asset.provenance).toBe('example');
      expect(asset.content.length).toBeGreaterThan(0);
    }
  });

  it('reports file provenance for user files, per asset', () => {
    mkdirSync(join(root, 'resume'));
    writeFileSync(join(root, 'resume', 'base_resume.tex'), 'USER TEX');
    const resolved = resolveResumeAssets(db, root);
    expect(resolved.base_resume).toEqual({ content: 'USER TEX', provenance: 'file' });
    expect(resolved.source_of_truth.provenance).toBe('example');
  });

  it('lets an in-app asset win over both file and example, per asset', () => {
    mkdirSync(join(root, 'resume'));
    writeFileSync(join(root, 'resume', 'base_resume.tex'), 'USER TEX');
    repo.setResumeAsset(db, 'base_resume', 'IN-APP TEX');
    repo.setResumeAsset(db, 'scoring_prompt', 'IN-APP PROMPT');

    const resolved = resolveResumeAssets(db, root);
    expect(resolved.base_resume).toEqual({ content: 'IN-APP TEX', provenance: 'in-app' });
    expect(resolved.scoring_prompt).toEqual({ content: 'IN-APP PROMPT', provenance: 'in-app' });
    expect(resolved.source_of_truth.provenance).toBe('example');
    expect(resolved.rewrite_rules.provenance).toBe('example');
  });

  it('reflects a save immediately and a revert falls back to the file layer', () => {
    mkdirSync(join(root, 'resume'));
    writeFileSync(join(root, 'resume', 'source_of_truth.md'), 'FILE SOT');

    repo.setResumeAsset(db, 'source_of_truth', 'IN-APP SOT');
    expect(resolveResumeAssets(db, root).source_of_truth).toEqual({
      content: 'IN-APP SOT',
      provenance: 'in-app',
    });

    repo.deleteResumeAsset(db, 'source_of_truth');
    expect(resolveResumeAssets(db, root).source_of_truth).toEqual({
      content: 'FILE SOT',
      provenance: 'file',
    });
  });

  it('does not require file fallbacks for assets authored in-app', () => {
    rmSync(join(root, 'resume-example', 'rewrite_rules.md'));
    repo.setResumeAsset(db, 'rewrite_rules', 'IN-APP RULES');
    const resolved = resolveResumeAssets(db, root);
    expect(resolved.rewrite_rules.content).toBe('IN-APP RULES');
    // …but a missing asset with no in-app row still fails loudly.
    repo.deleteResumeAsset(db, 'rewrite_rules');
    expect(() => resolveResumeAssets(db, root)).toThrow(
      'Missing resume asset: resume/rewrite_rules.md',
    );
  });
});

describe('hasUserBaseResumeFile', () => {
  it('is false without a resume/ base resume, true with either filename', () => {
    expect(hasUserBaseResumeFile(root)).toBe(false);
    mkdirSync(join(root, 'resume'));
    writeFileSync(join(root, 'resume', 'base_resume.old.tex'), 'x');
    expect(hasUserBaseResumeFile(root)).toBe(true);
    writeFileSync(join(root, 'resume', 'base_resume.tex'), 'x');
    expect(hasUserBaseResumeFile(root)).toBe(true);
  });
});
