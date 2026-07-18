/**
 * Runner tests — the wiring between the pure scheduler and the real run job:
 * the process-wide singleton, the run job's orchestration (scrape, then the
 * scheduled scoring, then a human summary recorded on the scheduler), the
 * FR-28 toast summarizing a run's notable scores, the failure toast fired
 * when a run rejects, and configuring from saved config
 * anchored to the persisted last scrape. Scrape/scoring/DB/notifier are
 * mocked; the scheduler underneath is the real one (its timer mechanics are
 * covered by scheduler.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  getDbMock,
  getUserConfigMock,
  getLastScrapeEndedAtMock,
  runScrapeMock,
  runScheduledScoringMock,
  fireNotifierMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserConfigMock: vi.fn(),
  getLastScrapeEndedAtMock: vi.fn(),
  runScrapeMock: vi.fn(),
  runScheduledScoringMock: vi.fn(),
  fireNotifierMock: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ getDb: getDbMock }));
vi.mock('@/lib/db/repo', () => ({
  getUserConfig: getUserConfigMock,
  getLastScrapeEndedAt: getLastScrapeEndedAtMock,
}));
vi.mock('@/lib/scrape/run', () => ({ runScrape: runScrapeMock }));
vi.mock('@/lib/scoring/scheduled', () => ({ runScheduledScoring: runScheduledScoringMock }));
// The notifier spawns a real process — always injected here (no real toasts).
vi.mock('@/lib/notify/notifier', () => ({ fireNotifier: fireNotifierMock }));

import { emptyNotables, type RunNotables } from '@/lib/notify/run-toast';
import {
  getScheduler,
  syncSchedulerFromConfig,
  ensureSchedulerStarted,
  resetSchedulerForTests,
  withFailureToast,
} from './runner';

const FAKE_DB = { fake: 'db' };

/** A scoring summary with nothing notable unless a test says otherwise. */
const scoringSummary = (over: { titleFiltered?: number; notables?: RunNotables } = {}) => ({
  scored: 12,
  failed: [],
  titleFiltered: 0,
  notables: emptyNotables(),
  ...over,
});

beforeEach(() => {
  getDbMock.mockReset().mockReturnValue(FAKE_DB);
  getUserConfigMock.mockReset().mockReturnValue(undefined);
  getLastScrapeEndedAtMock.mockReset().mockReturnValue(null);
  runScrapeMock.mockReset().mockResolvedValue({ inserted: 3 });
  runScheduledScoringMock.mockReset().mockResolvedValue(scoringSummary());
  fireNotifierMock.mockReset();
});

afterEach(() => {
  resetSchedulerForTests();
});

describe('getScheduler', () => {
  it('returns the same process-wide instance on every call', () => {
    const first = getScheduler();
    expect(getScheduler()).toBe(first);
  });
});

describe('the run job', () => {
  it('scrapes first, then runs the scheduled scoring, against the same DB', async () => {
    const order: string[] = [];
    runScrapeMock.mockImplementation(async () => {
      order.push('scrape');
      return { inserted: 3 };
    });
    runScheduledScoringMock.mockImplementation(async () => {
      order.push('score');
      return scoringSummary();
    });

    await getScheduler().triggerNow();

    expect(order).toEqual(['scrape', 'score']);
    expect(runScrapeMock).toHaveBeenCalledWith(FAKE_DB);
    expect(runScheduledScoringMock).toHaveBeenCalledWith(FAKE_DB);
  });

  it('records the run summary on the scheduler', async () => {
    await getScheduler().triggerNow();
    const status = getScheduler().status();
    expect(status.lastSummary).toBe('3 new · 12 scored');
    expect(status.lastError).toBeNull();
  });

  it('appends the title-filtered count only when nonzero', async () => {
    runScheduledScoringMock.mockResolvedValue(scoringSummary({ titleFiltered: 2 }));
    await getScheduler().triggerNow();
    expect(getScheduler().status().lastSummary).toBe('3 new · 12 scored · 2 title-filtered');
  });

  it('records a scrape failure as the run error and never reaches scoring', async () => {
    await getScheduler().triggerNow(); // a prior successful run
    runScrapeMock.mockRejectedValue(new Error('guest API returned 429'));
    runScheduledScoringMock.mockClear();

    await getScheduler().triggerNow();

    const status = getScheduler().status();
    expect(status.lastError).toBe('guest API returned 429');
    // Failure sets lastError only; the previous run's summary is retained.
    expect(status.lastSummary).toBe('3 new · 12 scored');
    expect(runScheduledScoringMock).not.toHaveBeenCalled();
  });

  it('records a scoring failure as the run error even after a successful scrape', async () => {
    runScheduledScoringMock.mockRejectedValue(new Error('batch create failed'));
    await getScheduler().triggerNow();
    expect(runScrapeMock).toHaveBeenCalled();
    expect(getScheduler().status().lastError).toBe('batch create failed');
  });
});

describe('withFailureToast', () => {
  it('passes a successful result through without toasting', async () => {
    const notify = vi.fn();
    const job = withFailureToast(async () => '3 new · 12 scored', notify);

    await expect(job()).resolves.toBe('3 new · 12 scored');
    expect(notify).not.toHaveBeenCalled();
  });

  it('fires exactly one toast with the error message, then rethrows the original error', async () => {
    const notify = vi.fn();
    const boom = new Error('fetch ECONNREFUSED');
    const job = withFailureToast(async () => {
      throw boom;
    }, notify);

    await expect(job()).rejects.toBe(boom);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('⚠️ Scheduled run failed', 'fetch ECONNREFUSED');
  });

  it('truncates the toast message to 500 characters', async () => {
    const notify = vi.fn();
    const longMessage = 'x'.repeat(600);
    const job = withFailureToast(async () => {
      throw new Error(longMessage);
    }, notify);

    await expect(job()).rejects.toThrow();
    expect(notify).toHaveBeenCalledWith('⚠️ Scheduled run failed', 'x'.repeat(500));
  });

  it('stringifies a non-Error rejection for the toast', async () => {
    const notify = vi.fn();
    const job = withFailureToast(async () => {
      throw 'plain string failure';
    }, notify);

    await expect(job()).rejects.toBe('plain string failure');
    expect(notify).toHaveBeenCalledWith('⚠️ Scheduled run failed', 'plain string failure');
  });

  it('rethrows the run error even when the notifier itself throws synchronously', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notify = vi.fn(() => {
      throw new Error('spawn EPERM');
    });
    const boom = new Error('fetch ECONNREFUSED');
    const job = withFailureToast(async () => {
      throw boom;
    }, notify);

    await expect(job()).rejects.toBe(boom);
    expect(errorSpy).toHaveBeenCalledTimes(1); // swallowed but logged, not invisible
    errorSpy.mockRestore();
  });

  it('rethrows the original rejection even when its message cannot be derived', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notify = vi.fn();
    // String() throws on a null-prototype value (no toString/valueOf); that
    // must not replace the run's own rejection with a stringification error.
    const unstringifiable = Object.create(null) as object;
    const job = withFailureToast(async () => {
      throw unstringifiable;
    }, notify);

    await expect(job()).rejects.toBe(unstringifiable);
    expect(notify).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('the scheduled-run toast (FR-28)', () => {
  it('fires exactly one toast per run, composed from the run\'s notables', async () => {
    runScheduledScoringMock.mockResolvedValue(
      scoringSummary({
        notables: {
          strongMatches: 1,
          bestStrong: { company: 'Acme', title: 'Senior Dev', score: 91 },
          parkedForReview: 0,
          firstParked: null,
        },
      }),
    );

    await getScheduler().triggerNow();

    expect(fireNotifierMock).toHaveBeenCalledTimes(1);
    expect(fireNotifierMock).toHaveBeenCalledWith(
      '💯 Strong match',
      'Acme — Senior Dev · fit 91/100',
    );
  });

  it('stays silent when the run scored nothing notable', async () => {
    await getScheduler().triggerNow(); // the default summary has no notables
    expect(fireNotifierMock).not.toHaveBeenCalled();
  });

  it('a synchronous notifier failure never fails the run', async () => {
    runScheduledScoringMock.mockResolvedValue(
      scoringSummary({
        notables: {
          strongMatches: 0,
          bestStrong: null,
          parkedForReview: 1,
          firstParked: { company: 'Acme', title: 'Senior Dev' },
        },
      }),
    );
    fireNotifierMock.mockImplementation(() => {
      throw new Error('spawn EPERM');
    });

    await getScheduler().triggerNow();

    const status = getScheduler().status();
    expect(status.lastError).toBeNull();
    expect(status.lastSummary).toBe('3 new · 12 scored');
  });
});

describe('scheduled-run failure toasts (wired singleton)', () => {
  it('a run whose job rejects fires exactly one failure toast via the shared notifier', async () => {
    runScrapeMock.mockRejectedValue(new Error('guest API returned 429'));

    await getScheduler().triggerNow();

    expect(fireNotifierMock).toHaveBeenCalledTimes(1);
    expect(fireNotifierMock).toHaveBeenCalledWith('⚠️ Scheduled run failed', 'guest API returned 429');
  });

  it('a notifier that throws never breaks the loop: lastError recorded, next run rescheduled', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getUserConfigMock.mockReturnValue({ runIntervalMinutes: 30 });
    syncSchedulerFromConfig();
    fireNotifierMock.mockImplementation(() => {
      throw new Error('spawn EPERM');
    });
    runScrapeMock.mockRejectedValue(new Error('fetch ECONNREFUSED'));

    await getScheduler().triggerNow();

    const status = getScheduler().status();
    expect(status.lastError).toBe('fetch ECONNREFUSED');
    expect(status.nextRunAt).not.toBeNull();
    errorSpy.mockRestore();
  });
});

describe('syncSchedulerFromConfig', () => {
  it('applies the saved cadence anchored to the persisted last scrape', () => {
    const lastEnded = Date.now();
    getUserConfigMock.mockReturnValue({ runIntervalMinutes: 30 });
    getLastScrapeEndedAtMock.mockReturnValue(lastEnded);

    syncSchedulerFromConfig();

    const status = getScheduler().status();
    expect(status.intervalMinutes).toBe(30);
    expect(status.nextRunAt).toBe(lastEnded + 30 * 60_000);
  });

  it('disables auto-run when no config row exists', () => {
    syncSchedulerFromConfig();
    const status = getScheduler().status();
    expect(status.intervalMinutes).toBe(0);
    expect(status.nextRunAt).toBeNull();
  });
});

describe('ensureSchedulerStarted', () => {
  it('configures from saved config exactly once per process', () => {
    ensureSchedulerStarted();
    ensureSchedulerStarted();
    expect(getUserConfigMock).toHaveBeenCalledTimes(1);
  });

  it('is a no-op after an explicit sync', () => {
    syncSchedulerFromConfig();
    ensureSchedulerStarted();
    expect(getUserConfigMock).toHaveBeenCalledTimes(1);
  });
});
