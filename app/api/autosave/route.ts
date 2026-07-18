/**
 * POST /api/autosave — persists an in-progress LaTeX edit (FR-15). Appends an
 * `autosave` version row, updates the denormalized rewritten_latex, and
 * recomputes the persisted diff (resume_changes) in one transaction, so edits
 * survive a crash, undo has version rows to restore, and the recorded diff
 * stays live with the document — the Changes panel (FR-13) and /api/explain
 * always describe the LaTeX as it stands now, not the generation it started
 * from. Allowed only while the job is being rewritten.
 *
 * Body: { jobId, latex }.
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { refreshResumeDiff } from '@/lib/diff/persist';
import { canEdit } from '@/lib/status/transitions';
import { requireJobId, lookupJob } from '@/lib/http/guards';

export const runtime = 'nodejs';

const BAD_REQUEST_ERROR = 'Missing "jobId" (number) and "latex" (string)';

export async function POST(req: Request): Promise<Response> {
  const parsed = await requireJobId(req, BAD_REQUEST_ERROR);
  if (!parsed.ok) return parsed.response;
  const { jobId } = parsed;
  const latex = parsed.body.latex;
  if (typeof latex !== 'string') {
    return Response.json({ error: BAD_REQUEST_ERROR }, { status: 400 });
  }

  const db = getDb();
  const found = lookupJob(db, jobId);
  if (!found.ok) return found.response;
  const { job } = found;
  if (!canEdit(job.status)) {
    return Response.json({ error: `Cannot edit a job in status "${job.status}"` }, { status: 409 });
  }

  db.transaction(() => {
    repo.appendRewriteVersion(db, jobId, latex, 'autosave');
    repo.setRewrittenLatex(db, jobId, latex);
    refreshResumeDiff(db, jobId, latex);
  })();

  return Response.json({ ok: true });
}
