/**
 * POST /api/scrape — the interactive scrape: runs the shared scrape execution
 * (lib/scrape/run) and streams each inserted job over SSE (FR-1–FR-5). The same
 * execution runs headlessly from the backend scheduler. A scrape_sessions row
 * tracks the run; startup reconciliation (in db/index) clears a run interrupted
 * by a restart.
 */
import { getDb } from '@/lib/db';
import { runScrape } from '@/lib/scrape/run';
import { createSseResponse } from '@/lib/http/sse';

export const runtime = 'nodejs';

export async function POST(): Promise<Response> {
  const db = getDb();
  return createSseResponse(async (sink) => {
    const summary = await runScrape(db, {
      onJob: (job) => sink.send({ type: 'job', ...job }),
    });
    sink.send({
      type: 'done',
      found: summary.found,
      blocked: summary.blocked,
      inserted: summary.inserted,
      bySource: summary.bySource,
      warnings: summary.warnings,
    });
  });
}
