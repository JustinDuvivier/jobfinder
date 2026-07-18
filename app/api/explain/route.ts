/**
 * POST /api/explain — the non-blocking "why these changes" call (FR-14).
 * Synchronous JSON {summary, bullets}, stored on the job. Inputs are the
 * job's persisted diff blocks (resume_changes — the same rows the Changes
 * panel renders, FR-13) plus the job description — the job description is
 * essential so edits can be justified, not merely described. Feeding the
 * recorded diff keeps the "why" tied to the recorded "what", including
 * markup-only edits a plain-text rendering would erase.
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { getAnthropicClient } from '@/lib/ai/client';
import { explainChanges } from '@/lib/ai/explain';
import { hasEdits } from '@/lib/diff';
import { describeJob } from '@/lib/jobs/describe';
import { requireJob } from '@/lib/http/guards';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const db = getDb();
  const guard = await requireJob(req, db);
  if (!guard.ok) return guard.response;
  const { jobId, job } = guard;
  if (!job.rewrittenLatex) {
    return Response.json({ error: 'No rewritten resume to explain' }, { status: 400 });
  }
  const changes = repo.getResumeChanges(db, jobId);
  if (!hasEdits(changes)) {
    // A rewrite identical to the base resume is a valid outcome, not an error:
    // answer benignly so the client renders an empty state, and clear any
    // rationale left over from an earlier generation — with nothing recorded
    // to explain, a stale "why" would contradict the Changes panel (FR-13/14).
    // Skip the write when nothing is stored so a no-op call doesn't bump the
    // job's updated_at (which orders the tracker listings).
    if (job.explanation) repo.setExplanation(db, jobId, null);
    return Response.json({ noChanges: true });
  }

  try {
    const result = await explainChanges(
      getAnthropicClient(),
      { changes, jobDescription: describeJob(job) },
      { db, jobId },
    );
    repo.setExplanation(db, jobId, JSON.stringify(result));
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
