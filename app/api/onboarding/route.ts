/**
 * POST /api/onboarding — mark the guided first-run flow finished (FR-33).
 * Sets the single user_config row's onboarding_complete flag; the (pipeline)
 * route-group gate stops redirecting to /setup once this is set (or once a
 * user base resume exists — see lib/resume/onboarding.ts).
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';

export const runtime = 'nodejs';

export async function POST(): Promise<Response> {
  repo.setOnboardingComplete(getDb());
  return Response.json({ ok: true });
}
