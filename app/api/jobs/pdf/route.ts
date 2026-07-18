/**
 * GET /api/jobs/pdf?jobId=N — streams a job's approved PDF to the browser
 * (FR-35). A GET so the Tracker's "View PDF" affordance can be a plain link;
 * `Content-Disposition: inline` lets the browser render the PDF in the tab.
 *
 * SECURITY (NFR-7): the request carries an identifier only. The file path is
 * read from SQLite (`approved_pdf_path`) and verified to resolve inside the
 * configured output base directory before a single byte is streamed — a path
 * is never accepted from, only revealed to, the client.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { getDb } from '@/lib/db';
import { isWithinBase } from '@/lib/fs/open-folder';
import { lookupJob, requireOutputDir } from '@/lib/http/guards';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  const raw = new URL(req.url).searchParams.get('jobId');
  const jobId = raw === null || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isInteger(jobId)) {
    return Response.json({ error: 'Missing numeric "jobId"' }, { status: 400 });
  }

  const outputDir = requireOutputDir();
  if (!outputDir.ok) return outputDir.response;

  const found = lookupJob(getDb(), jobId);
  if (!found.ok) return found.response;
  const { job } = found;
  // A GET for a resource that does not exist: no approved PDF is a 404 here
  // (unlike POST /api/open-folder's 400 on a bad action request).
  if (!job.approvedPdfPath) {
    return Response.json({ error: 'Job has no approved PDF' }, { status: 404 });
  }

  if (!isWithinBase(job.approvedPdfPath, outputDir.baseDir)) {
    return Response.json(
      { error: 'Refusing to serve a path outside the output directory' },
      { status: 400 },
    );
  }

  let body: ArrayBuffer;
  try {
    // Copy into a fresh ArrayBuffer: a Node Buffer is a view over a shared
    // pool, and Response wants a plain buffer body.
    body = new Uint8Array(await readFile(job.approvedPdfPath)).buffer;
  } catch {
    // The DB says approved but the file is gone (e.g. the user pruned ./output).
    return Response.json({ error: 'Approved PDF not found on disk' }, { status: 404 });
  }

  return new Response(body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${basename(job.approvedPdfPath)}"`,
    },
  });
}
