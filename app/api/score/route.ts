/**
 * POST /api/score — the interactive scoring pass: runs the shared scoring
 * execution (lib/scoring/run) and streams each result over SSE (FR-6–FR-8). The
 * same execution runs headlessly from the backend scheduler over the freshly
 * scraped `new` rows.
 *
 * Body: { jobIds?: number[] } — specific jobs, or all `new` jobs when omitted.
 */
import { getDb } from '@/lib/db';
import { runScoring } from '@/lib/scoring/run';
import { createSseResponse } from '@/lib/http/sse';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const db = getDb();
  const jobIds: number[] | undefined = Array.isArray(body?.jobIds)
    ? body.jobIds.filter((x: unknown): x is number => typeof x === 'number')
    : undefined;

  return createSseResponse(async (sink) => {
    const summary = await runScoring(db, {
      jobIds,
      onScore: (event) => sink.send({ type: 'score', ...event }),
      onError: (jobId, message) => sink.send({ type: 'score_error', jobId, message }),
    });
    sink.send({ type: 'done', scored: summary.scored, titleFiltered: summary.titleFiltered });
  });
}
