/**
 * POST /api/salary — find the salary for a job that is missing one. Resolves
 * through the salary resolver (lib/salary): explicit field → description prose
 * → AI web-search lookup, with the AI tier injected so the cheap deterministic
 * paths always run first. Persists a newly found value and returns
 * { salary, source }. Body: { jobId: number }.
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { getAnthropicClient } from '@/lib/ai/client';
import { lookupSalary } from '@/lib/ai/salary';
import { resolveSalaryWithAi } from '@/lib/salary';
import { requireJob } from '@/lib/http/guards';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const db = getDb();
  const guard = await requireJob(req, db);
  if (!guard.ok) return guard.response;
  const { jobId, job } = guard;

  try {
    const resolved = await resolveSalaryWithAi(
      { field: job.salary, description: job.description },
      () =>
        lookupSalary(
          getAnthropicClient(),
          { title: job.title, company: job.company, location: job.location },
          { db, jobId },
        ).then((result) => result.salary),
    );
    // 'field' means the row already had a value: report it verbatim (not the
    // resolver's normalization) so the response never diverges from the DB,
    // and don't persist. Only newly found values are written back.
    if (resolved.source === 'field') {
      return Response.json({ salary: job.salary, source: 'field' });
    }
    if (resolved.salary) repo.setSalary(db, jobId, resolved.salary);
    return Response.json({ salary: resolved.salary, source: resolved.source });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
