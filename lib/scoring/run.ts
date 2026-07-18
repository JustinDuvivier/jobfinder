/**
 * The interactive scoring transport, factored out of the `/api/score` route so
 * the route stays a thin SSE shell. Runs the shared warm-first loop
 * (warm-first.ts) and fans the remaining per-job calls — to the configured
 * backend — through a bounded p-limit pool, streaming progress via the
 * onScore/onError callbacks as each score lands in SQLite (new → scored).
 *
 * The backend scheduler does NOT use this: its headless runs go through
 * runScheduledScoring (scheduled.ts), which routes by backend — the
 * sequential local loop by default, the Batch API's 50% discount on
 * Anthropic. Preparation, warm-first priming, persistence, and metering are
 * shared in warm-first.ts so every execution stays in lockstep; this module
 * owns only the concurrency pool.
 *
 * See jobfinder-docs.md "Scoring" and "Scoring throughput".
 */
import pLimit from 'p-limit';
import type { DB } from '@/lib/db';
import {
  runWarmFirstScoring,
  type RunScoringOptions,
  type ScoringSummary,
} from './warm-first';

const CONCURRENCY = 5;

export async function runScoring(db: DB, opts: RunScoringOptions = {}): Promise<ScoringSummary> {
  return runWarmFirstScoring(
    db,
    async (rest, exec) => {
      const limit = pLimit(CONCURRENCY);
      await Promise.all(rest.map((job) => limit(() => exec.scoreOne(job))));
    },
    opts,
  );
}
