/**
 * The scheduler's scoring path (FR-6, NFR-2): route by the configured backend.
 *
 * Anthropic → the Message Batches transport (batch.ts) at the 50% discount —
 * nobody watches a scheduled run, so its latency is free money. Local (the
 * default) → the shared warm-first loop with a strictly sequential executor:
 * the Batch API doesn't exist on Ollama, a discount on $0 is meaningless, and
 * the GPU sets the pace (~8s/job is fine when nobody is waiting). One job in
 * flight also keeps the Ollama queue empty, so a crash mid-run wastes at most
 * one call.
 *
 * Both arms share preparation, warm-first priming, persistence, metering, and
 * crash semantics through runWarmFirstScoring: an interrupted run leaves the
 * unscored jobs `new` for the next scheduled run, and the scheduler's overlap
 * guard (lib/schedule) keeps runs from ever overlapping.
 */
import type { DB } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { runWarmFirstScoring, type ScoringSummary } from './warm-first';
import { runScoringBatch, type RunScoringBatchOptions } from './batch';

/** Score every `new` job the way a headless run should for the configured backend. */
export async function runScheduledScoring(
  db: DB,
  opts: RunScoringBatchOptions = {},
): Promise<ScoringSummary> {
  if (repo.getUserConfig(db)?.scoringBackend === 'anthropic') {
    return runScoringBatch(db, opts);
  }
  return runWarmFirstScoring(db, async (rest, exec) => {
    for (const job of rest) await exec.scoreOne(job);
  });
}
