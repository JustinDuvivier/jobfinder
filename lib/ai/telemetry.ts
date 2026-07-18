/**
 * AI-call telemetry — the per-request token/cost ledger (FR-27). Every
 * Anthropic call records one `ai_calls` row: call type, model, job, the four
 * usage token counts, an estimated cost snapshot, latency, stop reason, and
 * the error message when the call failed.
 *
 * This module is the single metering seam: every call type lands its ledger
 * row through `meterCall` / `meteredCreate` (interactive calls, streams) or
 * `meterBatchItem` (Message Batches results). The meter owns the protocol —
 * timing, the error row on a thrown call, the success row — and
 * CALL_COST_OPTIONS is the one place that knows each call type's cost flags.
 * Call modules only build requests and parse responses.
 *
 * Telemetry is best-effort by design: `recordAiCall` never throws, so a failed
 * insert can never fail a scrape/score/rewrite. Cost is computed at write time
 * (`estimateCostUsd`) because prices change — the stored value is a snapshot,
 * not something recomputable later.
 *
 * See jobfinder-docs.md "AI call telemetry" under Cost & Token Optimization.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { DB } from '@/lib/db';
import {
  SCORING_MODEL,
  REWRITE_MODEL,
  EXPLAIN_MODEL,
  SALARY_MODEL,
  SCORING_CACHE_TTL,
} from './models';

export type AiCallType = 'score' | 'score_batch' | 'rewrite' | 'explain' | 'salary';

/** Where a call's telemetry lands — passed through the AI-call functions to
 *  the metering seam, which captures the row where the raw response (and its
 *  `usage`) is available. */
export interface AiTelemetry {
  db: DB;
  jobId: number;
}

/** One ledger entry. Token fields are absent when the call errored. */
export interface AiCallEntry {
  callType: AiCallType;
  model: string;
  jobId?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreationTokens?: number | null;
  cacheReadTokens?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  stopReason?: string | null;
  error?: string | null;
}

/** The four token counts `estimateCostUsd` prices. */
export interface CostUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface CostOptions {
  /** Message Batches API call — 50% off all token usage. */
  batch?: boolean;
  /** TTL of the cache-write breakpoint: 5m writes bill 1.25x the input rate,
   *  1h writes bill 2x (the scoring prefix uses 1h — see SCORING_CACHE_TTL). */
  cacheWriteTtl?: '5m' | '1h';
}

/** USD per million tokens. Sonnet 5 is $3/$15 list ($2/$10 introductory
 *  through 2026-08-31 — the list price is used so estimates don't silently
 *  drop when the intro rate lapses). */
const HAIKU_PRICE = { inputPerMTok: 1.0, outputPerMTok: 5.0 };
const SONNET_PRICE = { inputPerMTok: 3.0, outputPerMTok: 15.0 };

/** Price map keyed by the model ids the app actually calls (lib/ai/models.ts).
 *  Built entry-by-entry because some routes share a model id, and TS rejects
 *  duplicate computed keys in an object literal. */
const MODEL_PRICES = new Map<string, { inputPerMTok: number; outputPerMTok: number }>([
  [SCORING_MODEL, HAIKU_PRICE],
  [SALARY_MODEL, HAIKU_PRICE],
  [REWRITE_MODEL, SONNET_PRICE],
  [EXPLAIN_MODEL, SONNET_PRICE],
]);

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER: Record<'5m' | '1h', number> = { '5m': 1.25, '1h': 2 };
const BATCH_MULTIPLIER = 0.5;

/**
 * Estimated USD cost of one call. Pure. Returns null for an unknown model —
 * the tokens still get recorded, only the cost snapshot is skipped.
 */
export function estimateCostUsd(
  model: string,
  usage: CostUsage,
  opts: CostOptions = {},
): number | null {
  const price = MODEL_PRICES.get(model);
  if (!price) return null;
  const writeMultiplier = CACHE_WRITE_MULTIPLIER[opts.cacheWriteTtl ?? '5m'];
  const perMTok =
    usage.inputTokens * price.inputPerMTok +
    usage.outputTokens * price.outputPerMTok +
    usage.cacheReadTokens * price.inputPerMTok * CACHE_READ_MULTIPLIER +
    usage.cacheCreationTokens * price.inputPerMTok * writeMultiplier;
  return (perMTok / 1_000_000) * (opts.batch ? BATCH_MULTIPLIER : 1);
}

/**
 * Build a ledger entry from a completed API response. Pure. The model comes
 * from the message (what actually served the call), and the cost snapshot is
 * computed from its usage.
 */
export function messageEntry(
  callType: AiCallType,
  jobId: number,
  message: Anthropic.Message,
  latencyMs: number | null,
  opts: CostOptions = {},
): AiCallEntry {
  const usage: CostUsage = {
    inputTokens: message.usage.input_tokens ?? 0,
    outputTokens: message.usage.output_tokens ?? 0,
    cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
  };
  return {
    callType,
    jobId,
    model: message.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    costUsd: estimateCostUsd(message.model, usage, opts),
    latencyMs,
    stopReason: message.stop_reason ?? null,
  };
}

/**
 * Insert one ledger row. Never throws — telemetry must not break the
 * user-facing operation it observes; failures are logged and swallowed.
 */
export function recordAiCall(db: DB, entry: AiCallEntry): void {
  try {
    db.prepare(
      `INSERT INTO ai_calls
         (call_type, model, job_id, input_tokens, output_tokens,
          cache_creation_tokens, cache_read_tokens, cost_usd, latency_ms,
          stop_reason, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.callType,
      entry.model,
      entry.jobId ?? null,
      entry.inputTokens ?? null,
      entry.outputTokens ?? null,
      entry.cacheCreationTokens ?? null,
      entry.cacheReadTokens ?? null,
      entry.costUsd ?? null,
      entry.latencyMs ?? null,
      entry.stopReason ?? null,
      entry.error ?? null,
    );
  } catch (err) {
    console.error('ai telemetry insert failed:', (err as Error).message);
  }
}

/**
 * Each call type's cost flags, in one place: the scoring prefix (shared by the
 * interactive and batch paths) writes its cache breakpoint on the 1-hour TTL,
 * and batch items bill at the 50% Message Batches discount. Everything else
 * prices at the defaults (5m cache writes, no discount).
 */
const CALL_COST_OPTIONS: Record<AiCallType, CostOptions> = {
  score: { cacheWriteTtl: SCORING_CACHE_TTL },
  score_batch: { batch: true, cacheWriteTtl: SCORING_CACHE_TTL },
  rewrite: {},
  explain: {},
  salary: {},
};

/**
 * The metering seam: run `call` (anything that resolves to a final Message — a
 * plain create, or a thunk that consumes a stream and resolves its accumulated
 * final message), time it, and land exactly one ledger row: an error row when
 * the call throws (which is rethrown), otherwise a usage row priced with the
 * call type's cost options. Without a meter the call just runs.
 */
export async function meterCall(
  meter: AiTelemetry | undefined,
  callType: AiCallType,
  model: string,
  call: () => Promise<Anthropic.Message>,
): Promise<Anthropic.Message> {
  const started = Date.now();
  let message: Anthropic.Message;
  try {
    message = await call();
  } catch (err) {
    if (meter) {
      recordAiCall(meter.db, {
        callType,
        model,
        jobId: meter.jobId,
        latencyMs: Date.now() - started,
        error: (err as Error).message,
      });
    }
    throw err;
  }
  if (meter) {
    recordAiCall(
      meter.db,
      messageEntry(callType, meter.jobId, message, Date.now() - started, CALL_COST_OPTIONS[callType]),
    );
  }
  return message;
}

/** The usage fields an Ollama /api/chat response reports. */
export interface OllamaUsage {
  /** Prompt tokens; Ollama may omit it when its KV cache served the prompt. */
  prompt_eval_count?: number;
  /** Generated tokens. */
  eval_count?: number;
  /** 'stop' on a clean finish, 'length' when num_predict cut the reply off. */
  done_reason?: string;
}

/**
 * Build a ledger entry from a completed Ollama response. Pure. Cost is a flat
 * 0 — zero marginal cost is a property of the local backend, not a price
 * lookup — and the cache columns stay null: a local model has no billed cache,
 * and null keeps these rows out of the Anthropic cache-hit-rate math. Ollama's
 * 'length' maps to 'max_tokens' so the truncation guard and the ledger badge
 * fire exactly as they do for Anthropic replies.
 */
export function ollamaEntry(
  callType: AiCallType,
  jobId: number,
  model: string,
  response: OllamaUsage,
  latencyMs: number | null,
): AiCallEntry {
  return {
    callType,
    jobId,
    model,
    inputTokens: response.prompt_eval_count ?? null,
    outputTokens: response.eval_count ?? null,
    cacheCreationTokens: null,
    cacheReadTokens: null,
    costUsd: 0,
    latencyMs,
    stopReason:
      response.done_reason === 'length' ? 'max_tokens' : (response.done_reason ?? null),
  };
}

/**
 * meterCall's sibling for the local backend: same protocol (time the call, an
 * error row on throw — rethrown — else one usage row), different response
 * shape and pricing.
 */
export async function meterOllamaCall<T extends OllamaUsage>(
  meter: AiTelemetry | undefined,
  callType: AiCallType,
  model: string,
  call: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  let response: T;
  try {
    response = await call();
  } catch (err) {
    if (meter) {
      recordAiCall(meter.db, {
        callType,
        model,
        jobId: meter.jobId,
        latencyMs: Date.now() - started,
        error: (err as Error).message,
      });
    }
    throw err;
  }
  if (meter) {
    recordAiCall(meter.db, ollamaEntry(callType, meter.jobId, model, response, Date.now() - started));
  }
  return response;
}

/** Run one non-streaming Messages call through the meter. */
export function meteredCreate(
  client: Anthropic,
  callType: AiCallType,
  request: Anthropic.MessageCreateParamsNonStreaming,
  meter?: AiTelemetry,
): Promise<Anthropic.Message> {
  return meterCall(meter, callType, request.model, () => client.messages.create(request));
}

/**
 * Ledger one Message Batches result item. Batch items carry no per-item
 * latency; a non-succeeded result lands as an error row. `model` names the
 * model the batch requests were built with — a failed item has no response to
 * read it from.
 */
export function meterBatchItem(
  meter: AiTelemetry,
  callType: AiCallType,
  model: string,
  result: Anthropic.Messages.MessageBatchResult,
): void {
  if (result.type !== 'succeeded') {
    recordAiCall(meter.db, {
      callType,
      model,
      jobId: meter.jobId,
      error: `batch result ${result.type}`,
    });
    return;
  }
  recordAiCall(
    meter.db,
    messageEntry(callType, meter.jobId, result.message, null, CALL_COST_OPTIONS[callType]),
  );
}
