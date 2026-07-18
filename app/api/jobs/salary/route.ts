/**
 * POST /api/jobs/salary — manually set (or clear) a job's salary. The AI lookup
 * lives at `/api/salary`; this is the user typing in a value they found. An
 * empty/whitespace string clears the salary (stores null).
 *
 * Body: { jobId: number, salary: string }.
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { requireJob } from '@/lib/http/guards';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const db = getDb();
  const guard = await requireJob(req, db);
  if (!guard.ok) return guard.response;
  const { jobId, body } = guard;
  const raw = typeof body.salary === 'string' ? body.salary.trim() : '';
  const salary = raw.length > 0 ? raw : null;

  repo.setSalary(db, jobId, salary);
  return Response.json({ ok: true, salary });
}
