/**
 * Shared client-side plumbing for the resume-asset editors (FR-33): per-asset
 * display metadata and the /api/resume-assets calls, used by both the guided
 * onboarding flow and the post-onboarding Documents card so the two cannot
 * drift. Save errors keep the compiler log so the base-resume editor can show
 * why a paste was refused.
 */
import type { ResumeAssetName, ResumeAssetProvenance } from '@/lib/types';

/** One asset as the GET/DELETE responses shape it: effective content + layer. */
export interface AssetView {
  content: string;
  provenance: ResumeAssetProvenance;
}

export type AssetViews = Record<ResumeAssetName, AssetView>;

export interface AssetMeta {
  label: string;
  hint: string;
  mono: boolean;
  rows: number;
}

export const ASSET_META: Record<ResumeAssetName, AssetMeta> = {
  base_resume: {
    label: 'Base resume — LaTeX source',
    hint: 'the canonical one-page document the AI tailors; never overwritten by a rewrite',
    mono: true,
    rows: 14,
  },
  source_of_truth: {
    label: 'Source of Truth',
    hint: 'real accomplishments, metrics, skills — scoring and rewrites draw only from this',
    mono: false,
    rows: 10,
  },
  scoring_prompt: {
    label: 'Scoring prompt',
    hint: 'the system prompt the fit scorer runs on',
    mono: true,
    rows: 10,
  },
  rewrite_rules: {
    label: 'Rewrite rules',
    hint: 'the tailoring rules the resume rewrite runs on',
    mono: true,
    rows: 12,
  },
};

export const PROVENANCE_LABEL: Record<ResumeAssetProvenance, string> = {
  'in-app': 'authored in-app',
  file: 'from your resume/ file',
  example: 'example default',
};

export type SaveAssetResult =
  | { ok: true; asset: AssetView }
  | { ok: false; error: string; log?: string };

/** PUT one asset. A 422 (compile failure / not one page) keeps the log. */
export async function saveAsset(name: ResumeAssetName, content: string): Promise<SaveAssetResult> {
  const res = await fetch('/api/resume-assets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    asset?: AssetView;
    error?: string;
    log?: string;
  };
  if (!res.ok || !data.asset) {
    return { ok: false, error: data.error ?? 'Save failed', log: data.log };
  }
  return { ok: true, asset: data.asset };
}

/** DELETE one asset (revert to the file/example fallback); returns the
 *  now-effective content so the editor can refill. */
export async function revertAsset(name: ResumeAssetName): Promise<AssetView> {
  const res = await fetch('/api/resume-assets', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = (await res.json().catch(() => ({}))) as { asset?: AssetView; error?: string };
  if (!res.ok || !data.asset) throw new Error(data.error ?? 'Revert failed');
  return data.asset;
}
