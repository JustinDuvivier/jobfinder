/**
 * Resolves the effective prompts/resume the AI routes use: DB config (edited in
 * Settings) takes precedence; an empty field falls back to the authored asset in
 * resume/ (or, per file, the committed resume-example/ starter). This lets the
 * user edit everything from the UI while keeping the files as out-of-the-box
 * defaults.
 */
import type { UserConfig } from '../types';
import { loadResumeAssets } from '../resume/load';

export interface EffectiveConfig {
  resumeLatex: string;
  sourceOfTruth: string;
  scoringPrompt: string;
  rewriteRules: string;
}

function pick(configured: string | undefined, fallback: string): string {
  return configured && configured.trim().length > 0 ? configured : fallback;
}

export function effectiveConfig(config: UserConfig | undefined): EffectiveConfig {
  let assets = { baseResume: '', sourceOfTruth: '', scoringPrompt: '', rewriteRules: '' };
  try {
    assets = loadResumeAssets();
  } catch {
    // Neither resume/ nor the committed resume-example/ has the assets (a
    // broken checkout) — rely on whatever is in config.
  }
  return {
    resumeLatex: pick(config?.resumeLatex, assets.baseResume),
    sourceOfTruth: pick(config?.sourceOfTruth, assets.sourceOfTruth),
    scoringPrompt: pick(config?.scoringPrompt, assets.scoringPrompt),
    rewriteRules: pick(config?.rewriteRules, assets.rewriteRules),
  };
}
