/**
 * The shared route prologue. Every job-scoped mutating route starts the same
 * way — parse a numeric `jobId` from the JSON body (400) and look the job up
 * (404) — and /api/save and /api/open-folder both need the configured output
 * directory (500). These guards own that request contract and its response
 * shaping in one place; routes stay thin mappers over lib.
 *
 * `requireJob` is the whole prologue. `requireJobId` and `lookupJob` are its
 * two halves, exposed for the routes that only need one of them: /api/save and
 * /api/command parse the id but leave the not-found answer to the layer below,
 * and /api/autosave validates `latex` between the parse and the lookup.
 */
import * as repo from '@/lib/db/repo';
import type { DB } from '@/lib/db';
import type { Job } from '@/lib/types';

/** A failed guard carries the exact HTTP response the route must return. */
type Rejected = { ok: false; response: Response };

export type JobIdGuard = { ok: true; jobId: number; body: Record<string, unknown> } | Rejected;
export type JobLookupGuard = { ok: true; job: Job } | Rejected;
export type JobGuard =
  | { ok: true; jobId: number; job: Job; body: Record<string, unknown> }
  | Rejected;
export type OutputDirGuard = { ok: true; baseDir: string } | Rejected;

/**
 * Parse the JSON body and require a numeric `jobId` (400 otherwise). The parsed
 * body is returned so routes can read their extra fields without re-parsing.
 */
export async function requireJobId(
  req: Request,
  missingIdError = 'Missing numeric "jobId"',
): Promise<JobIdGuard> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const jobId = body?.jobId;
  if (typeof jobId !== 'number') {
    return { ok: false, response: Response.json({ error: missingIdError }, { status: 400 }) };
  }
  return { ok: true, jobId, body: body as Record<string, unknown> };
}

/** Require the job to exist (404 otherwise). */
export function lookupJob(db: DB, jobId: number): JobLookupGuard {
  const job = repo.getJobById(db, jobId);
  if (!job) {
    return { ok: false, response: Response.json({ error: 'Job not found' }, { status: 404 }) };
  }
  return { ok: true, job };
}

/** The full prologue: jobId parse (400) then job lookup (404). */
export async function requireJob(req: Request, db: DB): Promise<JobGuard> {
  const parsed = await requireJobId(req);
  if (!parsed.ok) return parsed;
  const found = lookupJob(db, parsed.jobId);
  if (!found.ok) return found;
  return { ok: true, jobId: parsed.jobId, job: found.job, body: parsed.body };
}

/** Require the output base directory to be configured (500 otherwise, NFR-7). */
export function requireOutputDir(): OutputDirGuard {
  const baseDir = process.env.JOBFINDER_OUTPUT_DIR;
  if (!baseDir) {
    return {
      ok: false,
      response: Response.json({ error: 'JOBFINDER_OUTPUT_DIR is not configured' }, { status: 500 }),
    };
  }
  return { ok: true, baseDir };
}
