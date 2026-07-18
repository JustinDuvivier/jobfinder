/**
 * The single owner of the score-reason payload stored in `jobs.score_reason`
 * (the scoring rationale: reasoning, "tale of the tape" comparison, chips, and
 * the deterministic experience read). The scorer (`lib/ai/score.ts`) serializes
 * through this module and the rationale component
 * (`app/components/score-reason.tsx`) parses through it, so the shape crosses
 * the server→client seam typed end to end — a field rename fails the typecheck
 * instead of silently degrading the UI.
 *
 * Client-safe by design: no Node or SDK imports.
 */

/** Whether the candidate meets a given requirement. */
export type TapeVerdict = 'match' | 'partial' | 'gap';

/** One row of the "tale of the tape": a requirement, what they want, what I have. */
export interface TapeRow {
  /** The dimension being compared, e.g. "Years of experience", "Core stack". */
  dimension: string;
  /** What the candidate brings. */
  you: string;
  /** What the role asks for. */
  them: string;
  verdict: TapeVerdict;
}

/**
 * The deterministic experience read behind the score cap (see lib/ai/score.ts).
 * Stored so the rationale can explain *why* a score was capped; the UI
 * deliberately does not render it as its own block because the comparison's
 * first row ("Years of experience") already presents the same read.
 */
export interface ExperienceRead {
  requiredQuote: string;
  candidateYears: number;
  requiredYears: number;
  /** requiredYears − candidateYears (always recomputed by asExperienceRead,
   *  never trusted from input; may be negative). */
  gapYears: number;
}

/** Everything stored in jobs.score_reason. The score itself has its own column. */
export interface ScoreReasonPayload {
  reasoning: string;
  keyMatches: string[];
  concerns: string[];
  comparison: TapeRow[];
  /** Null when the posting/model gave no usable years. */
  experience: ExperienceRead | null;
  /** True when the requirement was inferred (digit-free quote) and its gap
   *  would have capped the score below 70: the app parked the score at
   *  exactly 70 for a manual decision instead (FR-6a). */
  parkedForReview: boolean;
}

/** Serialize the rationale for the jobs.score_reason column. */
export function serializeScoreReason(payload: ScoreReasonPayload): string {
  return JSON.stringify({
    reasoning: payload.reasoning,
    keyMatches: payload.keyMatches,
    concerns: payload.concerns,
    comparison: payload.comparison,
    experience: payload.experience,
    parkedForReview: payload.parkedForReview,
  });
}

/** The chip (keyMatches/concerns) rule: keep strings, drop everything else.
 *  Owned here so the write side (model reply) and read side (stored payload)
 *  can never drift. */
export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Coerce a verdict; anything unknown becomes "partial". */
function asTapeVerdict(value: unknown): TapeVerdict {
  return value === 'match' || value === 'gap' ? value : 'partial';
}

/**
 * Validate untrusted data into tape rows, dropping rows missing a dimension or
 * with both sides empty. Used on both the model's reply and the stored payload.
 */
export function asTapeRows(value: unknown): TapeRow[] {
  if (!Array.isArray(value)) return [];
  const rows: TapeRow[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    const dimension = typeof r.dimension === 'string' ? r.dimension.trim() : '';
    const you = typeof r.you === 'string' ? r.you.trim() : '';
    const them = typeof r.them === 'string' ? r.them.trim() : '';
    if (!dimension || (!you && !them)) continue;
    rows.push({ dimension, you, them, verdict: asTapeVerdict(r.verdict) });
  }
  return rows;
}

/** The finite-number rule shared by every numeric field check on both sides
 *  of the seam (here and in lib/ai/score.ts). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The one coercion that owns the ExperienceRead shape. Both the scorer's
 * model-reply parse (after its snake_case → camelCase seam in lib/ai/score.ts)
 * and the stored-payload parse below go through it, so the shape is validated
 * in exactly one place and `gapYears` is always recomputed from
 * requiredYears − candidateYears — an inconsistent stored gap can never leak
 * into the rendered rationale or the score cap.
 */
export function asExperienceRead(value: unknown): ExperienceRead | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (
    typeof r.requiredQuote !== 'string' ||
    !isFiniteNumber(r.candidateYears) ||
    !isFiniteNumber(r.requiredYears)
  ) {
    return null;
  }
  // The subtraction of two finite numbers can still overflow to ±Infinity;
  // keep the "every field is finite" invariant by rejecting the block then.
  const gapYears = r.requiredYears - r.candidateYears;
  if (!Number.isFinite(gapYears)) return null;
  return {
    requiredQuote: r.requiredQuote,
    candidateYears: r.candidateYears,
    requiredYears: r.requiredYears,
    gapYears,
  };
}

/**
 * Parse a stored score_reason. New scores are the JSON payload above; the older
 * line-based text format ("reasoning\nKey matches: …\nConcerns: …") is still
 * understood so previously-scored jobs keep rendering. Returns null when the
 * job has no stored rationale at all.
 */
export function parseScoreReason(reason: string | null): ScoreReasonPayload | null {
  if (!reason || reason.trim().length === 0) return null;
  const trimmed = reason.trim();
  if (trimmed.startsWith('{')) {
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      return {
        reasoning: typeof o.reasoning === 'string' ? o.reasoning : '',
        keyMatches: asStringArray(o.keyMatches),
        concerns: asStringArray(o.concerns),
        comparison: asTapeRows(o.comparison),
        experience: asExperienceRead(o.experience),
        parkedForReview: o.parkedForReview === true,
      };
    } catch {
      /* fall through to legacy text parsing */
    }
  }
  // Legacy text format: reasoning + "Key matches:" / "Concerns:" lines.
  const reasoning: string[] = [];
  let keyMatches: string[] = [];
  let concerns: string[] = [];
  for (const line of reason.split('\n')) {
    const km = line.match(/^Key matches:\s*(.*)$/i);
    const cn = line.match(/^Concerns:\s*(.*)$/i);
    if (km) keyMatches = km[1].split(',').map((s) => s.trim()).filter(Boolean);
    else if (cn) concerns = cn[1].split(';').map((s) => s.trim()).filter(Boolean);
    else reasoning.push(line);
  }
  return {
    reasoning: reasoning.join(' ').trim(),
    keyMatches,
    concerns,
    comparison: [],
    experience: null,
    parkedForReview: false, // predates the park rule; never flagged
  };
}
