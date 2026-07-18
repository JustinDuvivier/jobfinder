/**
 * POST /api/jobs/clear — empty the decision queue (delete all new/scored jobs).
 * Jobs already in progress (rewriting/approved) or tracked are left alone. The
 * next scrape repopulates the queue. Returns { deleted }.
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';

export const runtime = 'nodejs';

export async function POST(): Promise<Response> {
  const deleted = repo.clearDecisionQueue(getDb());
  return Response.json({ deleted });
}
