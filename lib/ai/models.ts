/**
 * Model routing, token budgets, and cache TTLs for the Anthropic calls.
 *
 * Scoring runs on Claude Haiku 4.5 — cheap and fast for the highest-frequency
 * call. Haiku alone used to misread the experience requirement (e.g. "10+ years"
 * as "1-3") and overscore; the fix is to stop relying on Haiku's arithmetic.
 * The prompt makes it *quote* the requirement phrase verbatim and show its
 * experience math, and lib/ai/score.ts then re-derives the required years from
 * that quote and caps the score by the gap deterministically (see gapScoreCap).
 * Copying a phrase is reliable for a small model; the brittle number-reading and
 * subtraction now happen in code, so scoring stays accurate at Haiku's price.
 * Rewrite and explanation run on Sonnet 5.
 *
 * See jobfinder-docs.md "AI Prompt Design" and "Cost & Token Optimization".
 */

/** Cheap tier for the high-frequency scoring call; accuracy comes from the
 *  quote-and-cap post-processing in score.ts rather than the model's arithmetic. */
export const SCORING_MODEL = 'claude-haiku-4-5-20251001';
/**
 * Default local scoring model (FR-6): a ~2.5GB q4 4B pull a CPU-only machine
 * can run (~4-5GB RAM with the 16k context). Eval evidence (2026-07-17,
 * docs/scoring-model-eval.md): best small model of five candidates at 134/158
 * golden checks, 0 recall misses, 0 overscores, and the app-persisted score
 * in range on all 12 cases — its residual raw-reply misses (flipped gap sign,
 * inferred-requirement quotes) are exactly what the code-side quote re-derive,
 * gap cap, and FR-6a park correct. Users with a 16GB GPU can restore the
 * previous tuned default, `batiai/qwen3.6-27b:iq3` (11GB, 151/158 checks), in
 * Settings (user_config.ollama_model).
 */
export const DEFAULT_OLLAMA_MODEL = 'qwen3:4b-instruct-2507-q4_K_M';
/** The higher-accuracy tuned 27B local option (docs/scoring-model-eval.md). */
export const LARGE_OLLAMA_MODEL = 'batiai/qwen3.6-27b:iq3';

/** One curated local scoring model as the Settings dropdown presents it (FR-6b). */
export interface CuratedOllamaModel {
  /** The exact Ollama tag the backend pulls and scores with. */
  tag: string;
  /** Short human name shown in the dropdown. */
  label: string;
  /** Approximate download size, shown so the user consents to the pull. */
  pullSize: string;
  /** Hardware guidance (RAM/GPU) shown alongside the option. */
  hardware: string;
  /** Exactly one curated model is the recommended default. */
  recommended: boolean;
}

/**
 * The curated local models the Settings scoring dropdown offers (FR-6b), in
 * display order. Both are pinned by the golden-set eval in
 * docs/scoring-model-eval.md; anything else goes through the custom-tag
 * escape hatch, which keeps the any-tag capability.
 */
export const CURATED_OLLAMA_MODELS = [
  {
    tag: DEFAULT_OLLAMA_MODEL,
    label: 'Qwen3 4B Instruct — small, recommended',
    pullSize: '~2.5 GB download',
    hardware: 'runs on CPU-only machines (~5 GB RAM)',
    recommended: true,
  },
  {
    tag: LARGE_OLLAMA_MODEL,
    label: 'Tuned Qwen3.6 27B — higher accuracy',
    pullSize: '~11 GB download',
    hardware: 'wants a ~16 GB GPU; slow on CPU',
    recommended: false,
  },
] as const satisfies readonly CuratedOllamaModel[];

/** The literal union of curated tags (used by the Settings choice mapping). */
export type CuratedOllamaTag = (typeof CURATED_OLLAMA_MODELS)[number]['tag'];
/**
 * Ollama context window for scoring. Sized from measured data, not the eval's
 * 8192: the stable prefix is ~5.5k tokens and the longest captured real
 * posting (~17.8k chars) pushes the full prompt to ~9.3-10.7k tokens, so 8192
 * would silently truncate the input on long postings. 16384 leaves the full
 * SCORING_MAX_TOKENS reply headroom at the observed maximum (~3.7k tokens
 * spare); the KV-cache cost (~1-2GB on the 4B default) keeps the total
 * footprint CPU-friendly, and fits next to the 11GB 27B override on 16GB VRAM.
 */
export const OLLAMA_NUM_CTX = 16384;
/** Quality tier for the creative rewrite. */
export const REWRITE_MODEL = 'claude-sonnet-5';
/** Quality tier for the change explanation. */
export const EXPLAIN_MODEL = 'claude-sonnet-5';
/** Cheap tier for the on-demand salary web lookup. */
export const SALARY_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Covers a 0-100 score, a concise reasoning, and the key_matches / concerns
 * arrays. 512 was too tight: a verbose reasoning plus both arrays could exceed
 * it and trip the max_tokens truncation guard (FR-7). 1024 gives comfortable
 * headroom while the prompt keeps the output concise.
 */
export const SCORING_MAX_TOKENS = 1024;
/** A short JSON answer ({salary, found}) after a web search or two. */
export const SALARY_MAX_TOKENS = 1024;
/**
 * Generous ceiling for a full one-page resume, comfortably above the worst
 * case. If the stream still ends with stop_reason "max_tokens", the document is
 * truncated and the rewrite must be regenerated rather than persisted.
 */
export const REWRITE_MAX_TOKENS = 8192;
/** A short summary plus a handful of bullets. */
export const EXPLAIN_MAX_TOKENS = 1024;

/**
 * Cache TTL for the scoring prefix — set on the request's cache breakpoint
 * (buildScoreRequest) and priced by the telemetry meter. The 1-hour TTL costs a
 * 2x write (vs 1.25x for 5m) but stays warm across scheduled runs — every run
 * within the hour that scores at least one job re-reads (and refreshes) the
 * same entry, so the write is paid roughly once instead of once per run. When
 * runs are further apart the downside is only the extra 0.75x write on a
 * ~4k-token Haiku prefix.
 */
export const SCORING_CACHE_TTL = '1h' as const;
