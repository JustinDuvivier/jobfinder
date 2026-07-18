/**
 * POST /api/save — approve & save (FR-17–FR-20, invariants #1 and #4).
 *
 * Receives only an identifier (`jobId`) — never a path string (NFR-7). The
 * whole saga (compile → one-page gate → server-side path build → disk write →
 * atomic DB commit) lives in the tested approval orchestrator; this handler is
 * a thin mapper from its discriminated result to HTTP responses.
 */
import { getDb } from '@/lib/db';
import { approveAndSave } from '@/lib/approval/orchestrator';
import { requireJobId, requireOutputDir } from '@/lib/http/guards';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  // Parse only — the orchestrator owns the job lookup and every saga outcome.
  const parsed = await requireJobId(req);
  if (!parsed.ok) return parsed.response;

  const outputDir = requireOutputDir();
  if (!outputDir.ok) return outputDir.response;

  const result = await approveAndSave(getDb(), {
    jobId: parsed.jobId,
    baseDir: outputDir.baseDir,
  });
  switch (result.kind) {
    case 'approved':
      return Response.json({
        status: 'approved',
        savedPath: result.savedPath,
        relativePath: result.relativePath,
      });
    case 'job-not-found':
      return Response.json({ error: 'Job not found' }, { status: 404 });
    case 'invalid-status':
      return Response.json(
        { error: `Cannot approve a job in status "${result.status}"` },
        { status: 409 },
      );
    case 'no-latex':
      return Response.json({ error: 'No rewritten resume to approve' }, { status: 400 });
    case 'compile-error':
      return Response.json({ error: 'LaTeX failed to compile', log: result.log }, { status: 400 });
    case 'compile-failed':
      return Response.json({ error: 'Compile failed' }, { status: 500 });
    case 'not-one-page':
      return Response.json(
        {
          error: `Resume must be exactly one page (it is ${result.pageCount}). Trim it and try again.`,
        },
        { status: 422 },
      );
    case 'write-failed':
      return Response.json({ error: 'Failed to write the PDF to disk' }, { status: 500 });
    case 'db-failed':
      return Response.json(
        { error: 'Saved the PDF but failed to record the approval' },
        { status: 500 },
      );
  }
}
