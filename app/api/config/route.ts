/**
 * GET/POST /api/config — read and save the Setup configuration (FR-25): resume
 * LaTeX, Source of Truth, owner name, scraper strategy, saved-search keywords ×
 * locations (FR-2), and the Proxycurl search URL. One row (id = 1).
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { syncSchedulerFromConfig } from '@/lib/schedule/runner';
import { parseUserConfig } from '@/lib/config/parse';

export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  return Response.json({ config: repo.getUserConfig(getDb()) ?? null });
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const parsed = parseUserConfig(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  repo.upsertUserConfig(getDb(), parsed.config);
  // Apply the (possibly changed) auto-run cadence to the backend scheduler.
  syncSchedulerFromConfig();
  return Response.json({ ok: true, config: parsed.config });
}
