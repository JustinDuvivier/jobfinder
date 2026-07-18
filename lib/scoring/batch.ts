/**
 * The scheduler's Anthropic-backend scoring transport (NFR-2, G6), routed to
 * by runScheduledScoring (scheduled.ts) when the Anthropic backend is
 * selected. Nobody is watching a scheduled run, so latency is free — it runs
 * the shared warm-first loop (warm-first.ts) and sends the remaining per-job
 * calls through the Message Batches API at 50% of standard token prices
 * instead of the interactive p-limit fan-out in run.ts. This module owns only
 * that transport: submit one batch, poll it to `ended`, and settle each
 * result; preparation, warm-first priming, persistence, and metering are
 * shared. The local backend never comes here — the Batch API doesn't exist on
 * Ollama — and a direct call on a non-Anthropic config refuses loudly before
 * any scoring work.
 *
 * Cache interplay: cache hits *inside* a batch are best-effort, so the shared
 * loop's warm-first call matters doubly here — it writes/refreshes the shared
 * 1-hour prefix entry, which the batch items then read near-certainly,
 * stacking the batch discount on top of the cache-read rate.
 *
 * Resilience: if the process dies mid-poll, the batched jobs simply stay `new`
 * and the next scheduled run re-submits them (NFR-8's reconcile-by-rerun
 * spirit); nothing tracks batch ids across restarts. The API guarantees a batch
 * ends within 24 hours, and the scheduler's overlap guard means a slow batch
 * only delays the next run, never overlaps it.
 *
 * See jobfinder-docs.md "Scoring throughput — concurrency vs. the Batch API".
 */
import type { DB } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { buildScoreRequest, parseScoreResponse } from '@/lib/ai/score';
import { SCORING_MODEL } from '@/lib/ai/models';
import { meterBatchItem } from '@/lib/ai/telemetry';
import { runWarmFirstScoring, type ScoringSummary } from './warm-first';

/** Scheduled runs have no one waiting; 30s keeps polling chatter negligible. */
const DEFAULT_POLL_MS = 30_000;

export interface RunScoringBatchOptions {
  /** Poll cadence while the batch processes; tests pass 0. */
  pollIntervalMs?: number;
}

const CUSTOM_ID_PREFIX = 'job-';

/** The batch request id for a job row — parseable back to the row id. */
export function toCustomId(jobId: number): string {
  return `${CUSTOM_ID_PREFIX}${jobId}`;
}

/** Recover the job row id from a batch result's custom_id, or null. */
export function fromCustomId(customId: string): number | null {
  if (!customId.startsWith(CUSTOM_ID_PREFIX)) return null;
  const suffix = customId.slice(CUSTOM_ID_PREFIX.length);
  // Digits only — Number('') is 0, which would misroute a malformed id.
  return /^\d+$/.test(suffix) ? Number(suffix) : null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Score every `new` job via the warm-first call + one Message Batch. */
export async function runScoringBatch(
  db: DB,
  opts: RunScoringBatchOptions = {},
): Promise<ScoringSummary> {
  // The Message Batches API is Anthropic-only. Refuse the local backend
  // BEFORE the warm-first loop runs — otherwise the warm job would already be
  // scored through Ollama inside a "refused" run. Failing here leaves every
  // job `new` for the next run; never a silent fallback to Anthropic.
  if (repo.getUserConfig(db)?.scoringBackend !== 'anthropic') {
    throw new Error('Batch scoring requires the Anthropic backend.');
  }
  return runWarmFirstScoring(db, async (rest, exec) => {
    if (exec.backend.kind !== 'anthropic') {
      throw new Error('Batch scoring requires the Anthropic backend.');
    }
    const client = exec.backend.client;
    let batch = await client.messages.batches.create({
      requests: rest.map((job) => ({
        custom_id: toCustomId(job.id),
        params: buildScoreRequest(exec.prep.inputFor(job)),
      })),
    });

    const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    while (batch.processing_status !== 'ended') {
      await sleep(pollMs);
      batch = await client.messages.batches.retrieve(batch.id);
    }

    // Results arrive in arbitrary order — match by custom_id, never position.
    for await (const entry of await client.messages.batches.results(batch.id)) {
      const jobId = fromCustomId(entry.custom_id);
      if (jobId === null) continue;
      // Ledger the item before parsing — the tokens were spent either way, and a
      // truncated reply still records its stop_reason.
      meterBatchItem({ db, jobId }, 'score_batch', SCORING_MODEL, entry.result);
      if (entry.result.type !== 'succeeded') {
        exec.fail(jobId, `batch result ${entry.result.type}`);
        continue;
      }
      try {
        // parseScoreResponse enforces the same truncation-is-an-error rule (FR-7)
        // as the interactive path.
        exec.settle(jobId, parseScoreResponse(entry.result.message));
      } catch (err) {
        exec.fail(jobId, (err as Error).message);
      }
    }
  });
}
