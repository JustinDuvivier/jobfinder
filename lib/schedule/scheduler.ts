/**
 * The backend auto-run scheduler — the single source of truth for *when* the
 * next scrape+score run happens (PRD §12 "Optional scheduled scraping";
 * jobfinder-docs "Scheduled scraping"). It lives in the Node process, not the
 * browser, so the countdown is authoritative and runs continue while no tab is
 * open.
 *
 * It reschedules with a fresh `setTimeout` *after* each run resolves rather than
 * on a fixed interval, which gives two properties the design calls for:
 *   - Overlap guard: a slow scrape+score can never start before the previous one
 *     finishes (`running` lock + reschedule-on-finish).
 *   - "Run now" resets the countdown: `triggerNow()` runs immediately and the
 *     post-run reschedule pushes `nextRunAt` a full interval out.
 *
 * The countdown is anchored to the *actual* last run: `configure` accepts the
 * persisted last-run time (scrape_sessions.ended_at, passed in by runner.ts)
 * and arms the timer at `lastRun + interval`, so restarts and dev recompiles
 * never reset the countdown to a full interval.
 *
 * This module is pure (no DB/AI imports) so it is unit-testable with fake
 * timers; the singleton and the real run job are wired in `runner.ts`.
 */

export interface SchedulerStatus {
  /** Configured cadence in minutes; 0 means auto-run is disabled (manual only). */
  intervalMinutes: number;
  /** Epoch ms of the next scheduled run, or null when disabled or mid-run. */
  nextRunAt: number | null;
  running: boolean;
  /** Epoch ms the last run finished, or null if none has run this process. */
  lastRunAt: number | null;
  /** Human summary of the last run (e.g. "3 new · 12 scored"). */
  lastSummary: string | null;
  /** Error message from the last run, or null if it succeeded. */
  lastError: string | null;
}

export interface SchedulerDeps {
  /** Performs one run and resolves with a human-readable summary string. */
  runJob: () => Promise<string>;
  /** Clock injection point for tests; defaults to Date.now. */
  now?: () => number;
}

export interface Scheduler {
  /**
   * Set the cadence in minutes (0 disables) and (re)arm the timer. When
   * `lastRunAt` (epoch ms of the actual last run, e.g. from the persisted
   * scrape_sessions table) is provided and newer than what the scheduler has
   * seen, the next run is anchored to it: `lastRunAt + interval`, clamped to
   * now. An overdue run therefore fires immediately, and a restart or dev
   * recompile never restarts the countdown from scratch.
   */
  configure(intervalMinutes: number, lastRunAt?: number | null): void;
  /** Run immediately (no-op if a run is already in flight) and reset the timer. */
  triggerNow(): Promise<void>;
  status(): SchedulerStatus;
  /** Cancel any pending timer (used on shutdown / reconfigure). */
  stop(): void;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? (() => Date.now());

  let intervalMs = 0;
  let nextRunAt: number | null = null;
  let running = false;
  let lastRunAt: number | null = null;
  let lastSummary: string | null = null;
  let lastError: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearPending(): void {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function reschedule(): void {
    clearPending();
    if (intervalMs <= 0) {
      nextRunAt = null;
      return;
    }
    // Anchor to the last run (in-memory or seeded from persistence) so the
    // countdown is strictly `lastRun + interval`. Clamp to now: an overdue run
    // fires immediately rather than showing a past time.
    const anchor = lastRunAt ?? now();
    nextRunAt = Math.max(now(), anchor + intervalMs);
    timer = setTimeout(() => void run(), nextRunAt - now());
  }

  async function run(): Promise<void> {
    if (running) return; // overlap guard
    running = true;
    clearPending();
    nextRunAt = null;
    try {
      lastSummary = await deps.runJob();
      lastError = null;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      lastRunAt = now();
      running = false;
      reschedule(); // resets the countdown after every run, including Run now
    }
  }

  return {
    configure(intervalMinutes: number, lastRunAtSeed?: number | null): void {
      intervalMs = Math.max(0, Math.floor(intervalMinutes)) * 60_000;
      // Adopt the persisted last-run time unless we already know a newer one
      // (an in-process run always postdates what the DB recorded before it).
      if (lastRunAtSeed != null && (lastRunAt == null || lastRunAtSeed > lastRunAt)) {
        lastRunAt = lastRunAtSeed;
      }
      // If a run is in flight, its finally-block reschedule will pick up the new
      // interval; rescheduling here too would double-arm the timer.
      if (!running) reschedule();
    },
    triggerNow(): Promise<void> {
      return run();
    },
    status(): SchedulerStatus {
      return {
        intervalMinutes: intervalMs / 60_000,
        nextRunAt,
        running,
        lastRunAt,
        lastSummary,
        lastError,
      };
    },
    stop(): void {
      clearPending();
    },
  };
}
