/**
 * POST /api/open-folder — opens the saved folder for a tracked job (FR-24).
 *
 * Receives a `jobId` only. The saved path is read from SQLite (never from the
 * request), verified to be inside the configured output base directory, and its
 * containing folder is opened in Explorer/Finder (NFR-7).
 */
import { getDb } from '@/lib/db';
import { openContainingFolder } from '@/lib/fs/open-folder';
import { requireJobId, lookupJob, requireOutputDir } from '@/lib/http/guards';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const parsed = await requireJobId(req);
  if (!parsed.ok) return parsed.response;

  const outputDir = requireOutputDir();
  if (!outputDir.ok) return outputDir.response;

  const found = lookupJob(getDb(), parsed.jobId);
  if (!found.ok) return found.response;
  const { job } = found;
  if (!job.approvedPdfPath) {
    return Response.json({ error: 'Job has no saved PDF' }, { status: 400 });
  }

  try {
    const dir = openContainingFolder(job.approvedPdfPath, outputDir.baseDir);
    return Response.json({ opened: true, dir });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
