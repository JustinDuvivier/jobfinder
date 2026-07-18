/**
 * Resolves the resume assets the AI routes run on — per file, through three
 * layers (FR-32/FR-33):
 *
 *   1. in-app  — authored in the app, stored in the `resume_assets` table
 *   2. file    — the user's private, gitignored `resume/` directory
 *   3. example — the committed generic starter in `resume-example/`
 *
 * The assets:
 *
 *   - base_resume (base_resume.tex, or base_resume.old.tex) — the canonical
 *     LaTeX resume
 *   - source_of_truth (source_of_truth.md) — factual basis for scoring/rewrites
 *   - scoring_prompt (scoring_prompt.md) — the scoring system prompt
 *   - rewrite_rules (rewrite_rules.md)  — the resume-tailoring system prompt
 *
 * An asset missing from every layer throws a clear, named error. Only the
 * filesystem layers are cached (default root only; explicit-root reads for
 * tests are not) — the in-app layer is read from SQLite on every call, so a
 * save through /api/resume-assets takes effect immediately with no cache to
 * invalidate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db';
import * as repo from '../db/repo';
import { RESUME_ASSET_NAMES } from '../types';
import type { ResumeAssetName, ResumeAssetProvenance } from '../types';

export interface ResumeAssets {
  baseResume: string;
  sourceOfTruth: string;
  scoringPrompt: string;
  rewriteRules: string;
}

/** One asset's effective content and the layer it came from. */
export interface ResolvedAsset {
  content: string;
  provenance: ResumeAssetProvenance;
}

export type ResolvedResumeAssets = Record<ResumeAssetName, ResolvedAsset>;

/** The user's private asset directory (gitignored). */
const USER_DIR = 'resume';
/** The committed generic fallback directory. */
const EXAMPLE_DIR = 'resume-example';

/** Filename candidates per asset, tried in order within each directory. */
const FILE_CANDIDATES: Record<ResumeAssetName, string[]> = {
  base_resume: ['base_resume.tex', 'base_resume.old.tex'],
  source_of_truth: ['source_of_truth.md'],
  scoring_prompt: ['scoring_prompt.md'],
  rewrite_rules: ['rewrite_rules.md'],
};

type FileAsset = { content: string; provenance: 'file' | 'example' };

let fileCache: Partial<Record<ResumeAssetName, FileAsset>> = {};

/** Read one asset from the filesystem layers: resume/ wins, else the example. */
function readFileAsset(rootDir: string, name: ResumeAssetName): FileAsset {
  for (const [dir, provenance] of [
    [USER_DIR, 'file'],
    [EXAMPLE_DIR, 'example'],
  ] as const) {
    for (const filename of FILE_CANDIDATES[name]) {
      try {
        return { content: readFileSync(join(rootDir, dir, filename), 'utf8'), provenance };
      } catch {
        // try the next candidate
      }
    }
  }
  throw new Error(`Missing resume asset: ${USER_DIR}/${FILE_CANDIDATES[name][0]}`);
}

/** One asset from the filesystem layers, cached for the default root only. */
function fileAsset(name: ResumeAssetName, rootDir?: string): FileAsset {
  if (rootDir !== undefined) return readFileAsset(rootDir, name);
  return (fileCache[name] ??= readFileAsset(process.cwd(), name));
}

/** The filesystem-only resolution (resume/ → resume-example/), as the legacy
 *  camelCase shape. Used where the in-app layer must not apply (e.g. the
 *  golden scoring eval set pins the committed/authored files). */
export function loadResumeAssets(rootDir?: string): ResumeAssets {
  return {
    baseResume: fileAsset('base_resume', rootDir).content,
    sourceOfTruth: fileAsset('source_of_truth', rootDir).content,
    scoringPrompt: fileAsset('scoring_prompt', rootDir).content,
    rewriteRules: fileAsset('rewrite_rules', rootDir).content,
  };
}

/**
 * The full three-layer resolution with provenance, per asset: an in-app row
 * (SQLite) wins, else the resume/ file, else the committed example starter.
 * The file layers are only touched for assets not authored in-app.
 */
export function resolveResumeAssets(db: DB, rootDir?: string): ResolvedResumeAssets {
  const inApp = repo.getResumeAssets(db);
  const resolved = {} as ResolvedResumeAssets;
  for (const name of RESUME_ASSET_NAMES) {
    const authored = inApp[name];
    resolved[name] =
      authored !== undefined
        ? { content: authored, provenance: 'in-app' }
        : fileAsset(name, rootDir);
  }
  return resolved;
}

/** True when the user supplied a base resume file in resume/ (either filename).
 *  The onboarding flow confirms a found file instead of demanding a paste. */
export function hasUserBaseResumeFile(rootDir: string = process.cwd()): boolean {
  return FILE_CANDIDATES.base_resume.some((filename) =>
    existsSync(join(rootDir, USER_DIR, filename)),
  );
}

/** Reset the filesystem cache (tests). */
export function clearResumeAssetsCache(): void {
  fileCache = {};
}
