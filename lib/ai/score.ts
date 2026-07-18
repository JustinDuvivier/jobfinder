/**
 * Scoring call — rates a job for resume fit (FR-6, FR-7). Runs on Haiku 4.5
 * against a plain-text resume. The scoring system prompt is the user's authored
 * scoring_prompt.md (experience-gap-driven), passed in by the route, followed by
 * SCORING_CONTRACT (code-owned; see its docstring). The stable prefix (system
 * prompt + contract + Source of Truth + resume) is cached with a 1-hour TTL so
 * scheduled runs within the hour re-read it; only the job posting varies after
 * the breakpoint.
 *
 * The model returns the user's prompt shape: {score, reasoning, comparison,
 * key_matches, concerns}. We map it to the jobs table's score + score_reason
 * (the JSON payload owned by lib/score-reason.ts, written via its
 * serializeScoreReason).
 *
 * See jobfinder-docs.md "Scoring prompt" and resume/scoring_prompt.md.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { SCORING_MODEL, SCORING_MAX_TOKENS, SCORING_CACHE_TTL } from './models';
import { extractText, extractJsonObject } from './parse';
import { meteredCreate, type AiTelemetry } from './telemetry';
import {
  asStringArray,
  asTapeRows,
  asExperienceRead,
  isFiniteNumber,
  type ExperienceRead,
  type ScoreReasonPayload,
} from '@/lib/score-reason';

export interface ScoreInput {
  /** The scoring system prompt (resume/scoring_prompt.md). */
  systemPrompt: string;
  sourceOfTruth: string;
  /** Plain-text extraction of the resume — not the LaTeX source. */
  resumePlainText: string;
  jobDescription: string;
}

/**
 * The scoring outcome: the persisted rationale payload (type, serialization,
 * and parsing owned by lib/score-reason.ts) plus the score, which lives in its
 * own jobs-table column.
 */
export interface ScoreResult extends ScoreReasonPayload {
  score: number;
}

/**
 * The application's parsing contract, appended after the user's scoring prompt
 * (which is editable in Settings and can drift). It serves two purposes at once:
 *
 * 1. **Parse hardening.** It restates, verbatim from the code's point of view,
 *    exactly what validateScore / experienceFromModelReply / asTapeRows /
 *    gapScoreCap enforce — so the output shape survives even if the user rewrites their
 *    scoring prompt. Like REWRITE_OUTPUT_OVERRIDE, it comes after the user's
 *    prompt so it wins on conflicts.
 * 2. **Cache floor.** Haiku 4.5 silently refuses to cache prefixes under 4096
 *    tokens — no error, `cache_creation_input_tokens: 0`, full price on every
 *    call. The user-configurable prefix (prompt + Source of Truth + resume)
 *    measured ~3.4-4.2k tokens: straddling the floor, so FR-7's caching lever
 *    was likely never engaging. This block's size pushes the stable prefix
 *    reliably past the floor. Do not slim it below ~3000 characters without
 *    re-measuring (scripts/diagnose-cache.mts --live); the size guard in
 *    score.test.ts exists for this reason.
 */
export const SCORING_CONTRACT = `
## Application parsing contract (highest priority — do not deviate)

JobFinder parses your reply mechanically. A reply that violates this contract is
discarded and the job must be re-scored at full cost, so these rules override any
conflicting instruction above.

Reply with ONLY one JSON object: the first character of your reply must be "{"
and the last must be "}". No markdown code fences, no prose before or after, no
trailing commentary. Use exactly these lowercase field names:

{
  "experience": {
    "required_quote": "<the posting's experience requirement copied word for word — never paraphrased, digits never altered; exactly 'none stated' when the posting names none>",
    "candidate_years": <number - the candidate's relevant professional years>,
    "required_years": <number - the smallest number appearing in required_quote: "10+ years" is 10, "3-5 years" is 3, "7 to 10 years" is 7>,
    "gap_years": <number - required_years minus candidate_years; negative when the candidate exceeds the bar>
  },
  "score": <integer 0-100>,
  "reasoning": "<1-2 sentences, about 40 words maximum, leading with the experience comparison>",
  "comparison": [
    {"dimension": "Years of experience", "you": "<candidate's years>", "them": "<required years>", "verdict": "<match|partial|gap>"},
    {"dimension": "<a dimension that decides this match>", "you": "<6 words max>", "them": "<6 words max>", "verdict": "<match|partial|gap>"}
  ],
  "key_matches": ["<2-4 short noun phrases>"],
  "concerns": ["<1-3 short noun phrases>"]
}

How the application treats each field — account for this:

- "score" must be a finite number and "reasoning" a non-empty string, or the
  entire reply is rejected outright.
- "verdict" must be exactly "match" (meets or exceeds), "partial" (close), or
  "gap" (falls short); anything else is coerced to "partial". A comparison row
  missing "dimension", or missing both "you" and "them", is dropped.
- "comparison" is a 4-6 row "tale of the tape". The first row is always
  "Years of experience" and must agree with the "experience" object.
- The application re-derives required_years from the digits inside your copied
  required_quote and recomputes gap_years itself, then caps the score:
  gap of 0 or less = no cap; 1-2 years short = capped at 70; 3-4 years short =
  capped at 50; 5 or more years short = capped at 30. Copy the quote faithfully
  and score consistently with these caps - the cap binds regardless of the
  score you wrote.
- Exception: when your required_quote contains no readable years figure (no
  digits that could be years - "none stated", a percentage, a calendar year),
  the requirement was inferred, not stated; if the cap would land below 70 the
  application does not apply it - it parks the persisted score at exactly 70
  and flags the job "requirement inferred - review", so a guessed requirement
  never hides a job. Still report your honest read and score consistently with
  the caps; the application supersedes your number when it parks.
- "score" is rounded to the nearest integer and clamped to 0-100 before the gap
  cap is applied. "reasoning" is trimmed of surrounding whitespace.
- Entries in "key_matches" and "concerns" that are not strings are silently
  dropped, so never emit objects or numbers inside those arrays.
- When the posting states no explicit years, set required_quote to "none stated"
  and infer required_years from the title's seniority (Intern/Junior about 1,
  Mid about 3, Senior about 6, Staff/Principal/Lead about 9).
- "candidate_years" is the figure the profile states explicitly (the "Years of
  experience" line in the candidate profile) — copy it, never re-derive it from
  dates. Only when the profile states no figure, treat the candidate as
  early-career (0-1 years) unless the profile clearly shows more.
- Keep the whole reply comfortably concise; a reply cut off at the token limit
  is rejected, not repaired.

Reference reply (posting requires "5+ years of backend experience"; candidate
has about 2 years):

{"experience": {"required_quote": "5+ years of backend experience", "candidate_years": 2, "required_years": 5, "gap_years": 3}, "score": 48, "reasoning": "Candidate has ~2 years against a 5+ year requirement (3-year gap), which caps the fit despite a strong stack match.", "comparison": [{"dimension": "Years of experience", "you": "~2 yrs", "them": "5+ yrs", "verdict": "gap"}, {"dimension": "Core stack", "you": "Node, TypeScript, SQL", "them": "Node, TypeScript", "verdict": "match"}, {"dimension": "Domain", "you": "Fintech tooling", "them": "Payments platform", "verdict": "partial"}, {"dimension": "Work mode", "you": "Remote-ready", "them": "Hybrid NYC", "verdict": "partial"}], "key_matches": ["Node + TypeScript", "SQL at scale"], "concerns": ["needs 5+ yrs, has ~2", "hybrid location"]}
`;

/**
 * Build the scoring request. The system prompt + contract + Source of Truth +
 * resume form the cached stable prefix; the per-job posting goes in the user
 * message after the breakpoint.
 */
export function buildScoreRequest(input: ScoreInput): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: SCORING_MODEL,
    max_tokens: SCORING_MAX_TOKENS,
    system: [
      { type: 'text', text: input.systemPrompt },
      { type: 'text', text: SCORING_CONTRACT },
      {
        type: 'text',
        text:
          `Candidate professional profile.\n\n` +
          `Source of truth (real accomplishments, metrics, skills):\n${input.sourceOfTruth}\n\n` +
          `Resume (plain text):\n${input.resumePlainText}`,
        cache_control: { type: 'ephemeral', ttl: SCORING_CACHE_TTL },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Score this job against the candidate above.\n\nJob description:\n${input.jobDescription}`,
      },
    ],
  };
}

/**
 * The minimum plausible years figure named in a requirement phrase: "10+ years"
 * → 10, "3-5 years" → 3 (the floor of a range is the real bar), "Senior" → null.
 * Reading the number from the model's copied quote in code sidesteps the small
 * model's habit of shrinking "10+" to "1-3".
 */
export function requiredYearsFromQuote(quote: string): number | null {
  const nums = (quote.match(/\d+(?:\.\d+)?/g) ?? [])
    .map(Number)
    .filter((n) => isFiniteNumber(n) && n >= 0 && n <= 50);
  return nums.length > 0 ? Math.min(...nums) : null;
}

/**
 * Experience-gap → maximum allowed score. Mirrors the caps documented in
 * resume/scoring_prompt.md, but enforced here so the gap actually binds the
 * score regardless of what the model returned.
 */
export function gapScoreCap(gapYears: number): number {
  if (gapYears <= 0) return 100; // meets or exceeds the requirement
  if (gapYears <= 2) return 70;
  if (gapYears <= 4) return 50;
  return 30; // 5+ years short — fundamentally underqualified
}

/**
 * Where an inferred-requirement score is parked (FR-6a). When the copied quote
 * has no digits, the requirement — and therefore the gap — is a model guess; a
 * guess is never allowed to push a job below the FR-9a auto-filter. Parking at
 * 70 keeps the job visible in the decision queue with a review flag: a couple
 * of jobs parked too high cost one manual look each, a hidden real match costs
 * the opportunity.
 */
export const PARKED_REVIEW_SCORE = 70;

/**
 * The one snake_case → camelCase seam: map the model's experience block onto
 * the stored shape and apply scoring *policy* — prefer the years parsed from
 * the model's copied quote over its own `required_years` field, so a small
 * model never has to read a multi-digit number correctly (see models.ts for
 * why). Shape validation and the gap recompute belong to the payload's owner
 * (asExperienceRead in lib/score-reason.ts). Returns null when either side
 * yields no usable number.
 */
function experienceFromModelReply(value: unknown): ExperienceRead | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const quote = typeof r.required_quote === 'string' ? r.required_quote.trim() : '';
  return asExperienceRead({
    requiredQuote: quote,
    candidateYears: r.candidate_years,
    requiredYears: requiredYearsFromQuote(quote) ?? r.required_years,
  });
}

function validateScore(obj: unknown): ScoreResult {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('Score response is not a JSON object');
  }
  const record = obj as Record<string, unknown>;
  if (!isFiniteNumber(record.score)) {
    throw new Error('Score response missing a numeric "score"');
  }
  // The prompt asks for "reasoning"; tolerate "reason" as a fallback key.
  const reasoning =
    typeof record.reasoning === 'string'
      ? record.reasoning
      : typeof record.reason === 'string'
        ? record.reason
        : '';
  if (reasoning.trim().length === 0) {
    throw new Error('Score response missing a non-empty "reasoning"');
  }
  const experience = experienceFromModelReply(record.experience);
  let score = Math.max(0, Math.min(100, Math.round(record.score)));
  let parkedForReview = false;
  if (experience) {
    const cap = gapScoreCap(experience.gapYears);
    if (cap < PARKED_REVIEW_SCORE && requiredYearsFromQuote(experience.requiredQuote) === null) {
      // The quote carries no readable years figure, so the crushing gap rests
      // on an inferred requirement: park at exactly 70 and flag for review
      // (FR-6a) instead of letting a guess hide the job below the FR-9a
      // threshold.
      score = PARKED_REVIEW_SCORE;
      parkedForReview = true;
    } else {
      // Enforce the experience-gap cap in code so an underqualified candidate
      // can't score high even if the model's own number didn't bind it.
      score = Math.min(score, cap);
    }
  } else if (typeof record.experience === 'object' && record.experience !== null) {
    // Same quote coercion as experienceFromModelReply, so the two paths agree.
    const q = (record.experience as Record<string, unknown>).required_quote;
    const quote = typeof q === 'string' ? q.trim() : '';
    if (requiredYearsFromQuote(quote) === null && score < PARKED_REVIEW_SCORE) {
      // The reply named a requirement without a readable years figure but its
      // numbers were unusable, so no gap is computable — yet the prompt tells
      // the model to self-cap inferred big gaps, so a low raw score here may
      // be a self-applied cap the app cannot supersede through the normal
      // path. Park rather than trust it (FR-6a).
      score = PARKED_REVIEW_SCORE;
      parkedForReview = true;
    }
  }
  return {
    score,
    reasoning: reasoning.trim(),
    keyMatches: asStringArray(record.key_matches),
    concerns: asStringArray(record.concerns),
    comparison: asTapeRows(record.comparison),
    experience,
    parkedForReview,
  };
}

/**
 * Parse and validate a scoring reply's text — the one pipeline every backend
 * flows through (quote re-derive, gap cap, FR-6a park), so scores behave
 * identically whether Haiku or the local model produced them.
 */
export function parseScoreText(text: string): ScoreResult {
  return validateScore(extractJsonObject(text));
}

/** Parse and validate a scoring response. Truncation is an error, not a score. */
export function parseScoreResponse(message: Anthropic.Message): ScoreResult {
  if (message.stop_reason === 'max_tokens') {
    throw new Error('Scoring response was truncated (max_tokens); retry.');
  }
  return parseScoreText(extractText(message));
}

/**
 * Score one job. The client is injected so tests can mock it. When a telemetry
 * context is given, the metering seam lands the call in the ai_calls ledger
 * (FR-27) — usage on success (even if parsing then rejects it: the tokens were
 * spent), an error row when the API call itself throws.
 */
export async function scoreJob(
  client: Anthropic,
  input: ScoreInput,
  telemetry?: AiTelemetry,
): Promise<ScoreResult> {
  const message = await meteredCreate(client, 'score', buildScoreRequest(input), telemetry);
  return parseScoreResponse(message);
}
