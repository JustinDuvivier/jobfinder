/**
 * Resolves the effective prompts/resume the AI routes use, as one camelCase
 * bundle over the per-asset resolution in lib/resume/load.ts: an in-app-
 * authored asset (SQLite, FR-33) wins; else the user's `resume/` file; else
 * the committed `resume-example/` starter (FR-32).
 */
import type { DB } from '../db';
import { resolveResumeAssets } from '../resume/load';

export interface EffectiveConfig {
  resumeLatex: string;
  sourceOfTruth: string;
  scoringPrompt: string;
  rewriteRules: string;
}

export function effectiveConfig(db: DB): EffectiveConfig {
  try {
    const assets = resolveResumeAssets(db);
    return {
      resumeLatex: assets.base_resume.content,
      sourceOfTruth: assets.source_of_truth.content,
      scoringPrompt: assets.scoring_prompt.content,
      rewriteRules: assets.rewrite_rules.content,
    };
  } catch {
    // An asset is missing from every layer (a broken checkout with nothing
    // authored in-app). Empty strings let callers fail on their own terms.
    return { resumeLatex: '', sourceOfTruth: '', scoringPrompt: '', rewriteRules: '' };
  }
}
