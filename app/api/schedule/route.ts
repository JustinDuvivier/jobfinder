/**
 * GET/POST /api/schedule — the backend auto-run scheduler's status and manual
 * trigger (PRD §12). GET returns the authoritative next-run time the Jobs view
 * counts down to; POST is "Run now" — it kicks off a run immediately and the
 * post-run reschedule resets the countdown. Execution lives server-side, so the
 * POST does not block on the run; the client polls GET and refetches when the
 * run completes (lastRunAt advances).
 */
import { getScheduler, ensureSchedulerStarted } from '@/lib/schedule/runner';

export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  ensureSchedulerStarted();
  return Response.json(getScheduler().status());
}

export async function POST(): Promise<Response> {
  ensureSchedulerStarted();
  // Fire and forget — triggerNow swallows run errors into status.lastError, so
  // the promise never rejects and there is no unhandled rejection.
  void getScheduler().triggerNow();
  return Response.json(getScheduler().status());
}
