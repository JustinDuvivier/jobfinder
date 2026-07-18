/**
 * Wires the pure scheduler (scheduler.ts) to the real run job and exposes a
 * process-wide singleton. Kept separate from scheduler.ts so the scheduler's
 * unit tests don't pull in the DB / scraping / AI dependency graph.
 *
 * The run job is the headless equivalent of clicking Scrape then Score all:
 * scrape new postings, then score the freshly inserted `new` rows through
 * runScheduledScoring (lib/scoring/scheduled), which routes by the configured
 * backend — the sequential local loop by default, the Batch API's 50%
 * discount on Anthropic (NFR-2). New jobs and scores land in SQLite; the Jobs
 * view refetches (it is not an SSE route). A run that scored anything notable
 * (strong matches, FR-6a parks) additionally fires exactly one native toast
 * through the shared notifier (FR-28), and a run that rejects fires a native
 * failure toast (withFailureToast) — headless runs have no UI to surface
 * either otherwise.
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { fireNotifier } from '@/lib/notify/notifier';
import { composeRunToast } from '@/lib/notify/run-toast';
import { runScrape } from '@/lib/scrape/run';
import { runScheduledScoring } from '@/lib/scoring/scheduled';
import { createScheduler, type Scheduler } from './scheduler';

// The singleton lives on globalThis, not module scope: Next.js dev recompiles
// modules on navigation/HMR, and a module-scoped singleton would be silently
// replaced by a fresh scheduler whose countdown restarts from a full interval.
const g = globalThis as typeof globalThis & {
  __jobFinderScheduler?: Scheduler;
  __jobFinderSchedulerStarted?: boolean;
};

async function defaultRunJob(): Promise<string> {
  const db = getDb();
  const scrape = await runScrape(db);
  const scoring = await runScheduledScoring(db);
  // At most one native toast per headless run, summarizing this run's notable
  // scores (FR-28); a run with nothing notable stays silent. Fire-and-forget:
  // fireNotifier can throw synchronously, and a missed toast must never fail
  // the run.
  const toast = composeRunToast(scoring.notables);
  if (toast) {
    try {
      fireNotifier(toast.title, toast.message);
    } catch {
      /* a missed toast never fails the run */
    }
  }
  const filtered = scoring.titleFiltered > 0 ? ` · ${scoring.titleFiltered} title-filtered` : '';
  return `${scrape.inserted} new · ${scoring.scored} scored${filtered}`;
}

const FAILURE_TOAST_TITLE = '⚠️ Scheduled run failed';
/** Mirrors the /api/notify route's toast-safe message cap. */
const FAILURE_TOAST_MESSAGE_MAX = 500;

/**
 * Wrap a run job so a rejection fires one native failure toast via the shared
 * notifier before rethrowing — a headless run has no UI attached, so without
 * the toast the error would sit invisibly in `lastError` until the next visit.
 * Rethrowing keeps the scheduler's failure semantics untouched (it records
 * `lastError` and reschedules). The notifier call is fire-and-forget and can
 * throw synchronously (spawn setup), so it is wrapped: a missed toast must
 * never break the scheduler loop or mask the run's own error.
 */
export function withFailureToast(
  runJob: () => Promise<string>,
  notify: typeof fireNotifier = fireNotifier,
): () => Promise<string> {
  return async () => {
    try {
      return await runJob();
    } catch (err) {
      try {
        // Message derivation stays inside the guard: String(err) itself can
        // throw (e.g. on a null-prototype rejection value), and nothing on
        // this path may replace the run's own error.
        const message = err instanceof Error ? err.message : String(err);
        notify(FAILURE_TOAST_TITLE, message.slice(0, FAILURE_TOAST_MESSAGE_MAX));
      } catch (notifyErr) {
        // Swallowed by design — the run's own error (rethrown below) is the
        // signal that matters — but logged so a permanently broken notifier
        // is not itself invisible.
        console.error('scheduled-run failure toast failed:', (notifyErr as Error)?.message ?? notifyErr);
      }
      throw err;
    }
  };
}

export function getScheduler(): Scheduler {
  if (!g.__jobFinderScheduler) {
    g.__jobFinderScheduler = createScheduler({ runJob: withFailureToast(defaultRunJob) });
  }
  return g.__jobFinderScheduler;
}

/**
 * Apply the saved cadence to the scheduler, anchored to the last recorded
 * scrape run so the countdown derives from persisted history rather than
 * restarting from now. Call after config changes.
 */
export function syncSchedulerFromConfig(): void {
  g.__jobFinderSchedulerStarted = true;
  const db = getDb();
  const config = repo.getUserConfig(db);
  getScheduler().configure(config?.runIntervalMinutes ?? 0, repo.getLastScrapeEndedAt(db));
}

/** Configure the scheduler from saved config exactly once per process. */
export function ensureSchedulerStarted(): void {
  if (g.__jobFinderSchedulerStarted) return;
  syncSchedulerFromConfig();
}

/** Drop the process-wide scheduler and started flag (tests). */
export function resetSchedulerForTests(): void {
  g.__jobFinderScheduler?.stop();
  delete g.__jobFinderScheduler;
  delete g.__jobFinderSchedulerStarted;
}
