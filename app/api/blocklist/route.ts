/**
 * GET/POST /api/blocklist — manage the company blocklist (FR-4). Adding a
 * company also removes any of its jobs still in the decision queue so they do
 * not linger and never cost scoring tokens.
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';

export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  return Response.json({ companies: repo.listBlockedCompanies(getDb()) });
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const action = body?.action;
  const name = body?.name;
  if (action !== 'add' && action !== 'remove') {
    return Response.json({ error: 'action must be "add" or "remove"' }, { status: 400 });
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    return Response.json({ error: 'Missing company "name"' }, { status: 400 });
  }

  const db = getDb();
  let removedQueuedJobs = 0;
  if (action === 'add') {
    removedQueuedJobs = repo.addBlockedCompany(db, name);
  } else {
    repo.removeBlockedCompany(db, name);
  }
  return Response.json({
    ok: true,
    removedQueuedJobs,
    companies: repo.listBlockedCompanies(db),
  });
}
