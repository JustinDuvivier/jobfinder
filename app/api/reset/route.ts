/**
 * POST /api/reset — wipe all job and pipeline data for a fresh start. Keeps
 * Settings (resume, Source of Truth, prompts) and the company blocklist. Returns
 * { deleted } (number of jobs removed).
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';

export const runtime = 'nodejs';

export async function POST(): Promise<Response> {
  const deleted = repo.resetPipeline(getDb());
  return Response.json({ deleted });
}
