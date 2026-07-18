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
 * Default local scoring model (FR-6): the IQ3 quant fits an 11GB footprint on
 * a 16GB GPU. Eval evidence: 151/158 golden checks at ~8s/job, and its one
 * recall miss (an invented "Senior ≈ 6 years" requirement) is neutralized by
 * the FR-6a park rule — see golden/score.golden.json + scripts/eval-score-golden.mts.
 * User-overridable in Settings (user_config.ollama_model).
 */
export const DEFAULT_OLLAMA_MODEL = 'batiai/qwen3.6-27b:iq3';
/**
 * Ollama context window for scoring. Sized from measured data, not the eval's
 * 8192: the stable prefix is ~5.5k tokens and the longest captured real
 * posting (~17.8k chars) pushes the full prompt to ~9.3-10.7k tokens, so 8192
 * would silently truncate the input on long postings. 16384 leaves the full
 * SCORING_MAX_TOKENS reply headroom at the observed maximum (~3.7k tokens
 * spare); the KV-cache cost fits next to the 11GB default model on 16GB VRAM.
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
