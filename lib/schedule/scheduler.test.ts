import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createScheduler } from './scheduler';

const START = new Date('2026-01-01T00:00:00.000Z').getTime();
const FIVE_MIN = 5 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createScheduler', () => {
  it('arms nextRunAt one interval out when configured', () => {
    const runJob = vi.fn(async () => 'ok');
    const s = createScheduler({ runJob });
    s.configure(5);
    const st = s.status();
    expect(st.intervalMinutes).toBe(5);
    expect(st.nextRunAt).toBe(START + FIVE_MIN);
    expect(st.running).toBe(false);
    expect(runJob).not.toHaveBeenCalled();
  });

  it('fires on the interval and reschedules a full interval out', async () => {
    const runJob = vi.fn(async () => '2 new · 5 scored');
    const s = createScheduler({ runJob });
    s.configure(5);

    await vi.advanceTimersByTimeAsync(FIVE_MIN);

    expect(runJob).toHaveBeenCalledTimes(1);
    const st = s.status();
    expect(st.lastRunAt).toBe(START + FIVE_MIN);
    expect(st.lastSummary).toBe('2 new · 5 scored');
    expect(st.nextRunAt).toBe(START + FIVE_MIN * 2);

    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(runJob).toHaveBeenCalledTimes(2);
  });

  it('triggerNow runs immediately and resets the countdown', async () => {
    const runJob = vi.fn(async () => 'ok');
    const s = createScheduler({ runJob });
    s.configure(5);

    // Advance partway so the original nextRunAt would have been sooner.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await s.triggerNow();

    expect(runJob).toHaveBeenCalledTimes(1);
    // The countdown is now a full interval from the manual run, not the old one.
    expect(s.status().nextRunAt).toBe(START + 2 * 60_000 + FIVE_MIN);
  });

  it('does not start a second run while one is in flight (overlap guard)', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => {
      resolve = r;
    });
    const runJob = vi.fn(async () => {
      await gate;
      return 'ok';
    });
    const s = createScheduler({ runJob });
    s.configure(5);

    const first = s.triggerNow();
    expect(s.status().running).toBe(true);
    // A second trigger while the first is pending is a no-op.
    await s.triggerNow();
    expect(runJob).toHaveBeenCalledTimes(1);

    resolve();
    await first;
    expect(s.status().running).toBe(false);
    expect(runJob).toHaveBeenCalledTimes(1);
  });

  it('anchors the countdown to a persisted last run passed to configure', () => {
    const runJob = vi.fn(async () => 'ok');
    const s = createScheduler({ runJob });
    // Last run recorded 2 minutes ago → next run 3 minutes out, not 5.
    s.configure(5, START - 2 * 60_000);

    const st = s.status();
    expect(st.lastRunAt).toBe(START - 2 * 60_000);
    expect(st.nextRunAt).toBe(START + 3 * 60_000);
    expect(runJob).not.toHaveBeenCalled();
  });

  it('fires an overdue run immediately instead of showing a past time', async () => {
    const runJob = vi.fn(async () => 'ok');
    const s = createScheduler({ runJob });
    // Last run a full hour ago with a 5-minute cadence → clamp to now and run.
    s.configure(5, START - 60 * 60_000);

    expect(s.status().nextRunAt).toBe(START);
    await vi.advanceTimersByTimeAsync(0);
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(s.status().nextRunAt).toBe(START + FIVE_MIN);
  });

  it('ignores a stale seed older than a run the scheduler already performed', async () => {
    const runJob = vi.fn(async () => 'ok');
    const s = createScheduler({ runJob });
    s.configure(5);
    await vi.advanceTimersByTimeAsync(FIVE_MIN); // runs at START + 5m

    // Re-configuring with an older persisted time must not rewind the anchor.
    s.configure(5, START - 60_000);
    expect(s.status().lastRunAt).toBe(START + FIVE_MIN);
    expect(s.status().nextRunAt).toBe(START + FIVE_MIN * 2);
  });

  it('re-anchors to the last run when the interval changes mid-countdown', async () => {
    const runJob = vi.fn(async () => 'ok');
    const s = createScheduler({ runJob });
    s.configure(5);
    await vi.advanceTimersByTimeAsync(FIVE_MIN); // runs at START + 5m

    s.configure(10);
    // Next run is lastRun + 10m, not now + 10m.
    expect(s.status().nextRunAt).toBe(START + FIVE_MIN + 10 * 60_000);
  });

  it('configure(0) disables auto-run and cancels the pending timer', async () => {
    const runJob = vi.fn(async () => 'ok');
    const s = createScheduler({ runJob });
    s.configure(5);
    s.configure(0);

    expect(s.status().nextRunAt).toBeNull();
    expect(s.status().intervalMinutes).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runJob).not.toHaveBeenCalled();
  });

  it('records the error and still reschedules when a run throws', async () => {
    const runJob = vi.fn(async () => {
      throw new Error('scrape blew up');
    });
    const s = createScheduler({ runJob });
    s.configure(5);

    await vi.advanceTimersByTimeAsync(FIVE_MIN);

    const st = s.status();
    expect(st.lastError).toBe('scrape blew up');
    expect(st.nextRunAt).toBe(START + FIVE_MIN * 2); // still armed for next time
  });
});
