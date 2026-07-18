/**
 * Loads the resume assets the AI routes run on, so editing the `.md` / `.tex`
 * files takes effect without a rebuild:
 *
 *   - base_resume.tex (or base_resume.old.tex) — the canonical LaTeX resume
 *   - source_of_truth.md — factual basis for scoring and rewrites
 *   - scoring_prompt.md — the scoring system prompt
 *   - rewrite_rules.md  — the resume-tailoring system prompt
 *
 * Each asset is resolved per file: the user's private, gitignored `resume/`
 * directory wins; when a file is absent there, the committed generic starter
 * in `resume-example/` is the out-of-the-box fallback, so a fresh clone works
 * with zero configuration. Missing from both throws a clear, named error.
 *
 * The default-root read is cached; explicit-root reads (tests) are not.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ResumeAssets {
  baseResume: string;
  sourceOfTruth: string;
  scoringPrompt: string;
  rewriteRules: string;
}

/** The user's private asset directory (gitignored). */
const USER_DIR = 'resume';
/** The committed generic fallback directory. */
const EXAMPLE_DIR = 'resume-example';

let cache: ResumeAssets | null = null;

/** Read the first existing candidate (paths relative to rootDir). */
function readFirst(rootDir: string, candidates: string[], missing: string): string {
  for (const rel of candidates) {
    try {
      return readFileSync(join(rootDir, rel), 'utf8');
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`Missing resume asset: ${missing}`);
}

function readAsset(rootDir: string, name: string): string {
  return readFirst(
    rootDir,
    [join(USER_DIR, name), join(EXAMPLE_DIR, name)],
    `${USER_DIR}/${name}`,
  );
}

function readBaseResume(rootDir: string): string {
  return readFirst(
    rootDir,
    [
      join(USER_DIR, 'base_resume.tex'),
      join(USER_DIR, 'base_resume.old.tex'),
      join(EXAMPLE_DIR, 'base_resume.tex'),
    ],
    `${USER_DIR}/base_resume.tex`,
  );
}

function readAll(rootDir: string): ResumeAssets {
  return {
    baseResume: readBaseResume(rootDir),
    sourceOfTruth: readAsset(rootDir, 'source_of_truth.md'),
    scoringPrompt: readAsset(rootDir, 'scoring_prompt.md'),
    rewriteRules: readAsset(rootDir, 'rewrite_rules.md'),
  };
}

export function loadResumeAssets(rootDir?: string): ResumeAssets {
  if (rootDir !== undefined) return readAll(rootDir);
  cache ??= readAll(process.cwd());
  return cache;
}

/** Reset the cache (tests). */
export function clearResumeAssetsCache(): void {
  cache = null;
}
