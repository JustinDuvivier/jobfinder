/**
 * Registry tests — external behavior only: what snapshot() reports and what
 * subscribe delivers, driven by an injected fake runner (the same DI pattern
 * run.test.ts uses to fake Anthropic). Never asserts private fields. A tiny
 * deferred helper lets a test hold a runner open (still "running") and resolve
 * it on demand, so lifecycle transitions are observed deterministically without
 * real timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RewriteRunResult } from './run';
import { createRewriteRegistry, type RewriteRegistry, type RewriteRunner } from './registry';

/** A runner the test resolves/rejects by hand, capturing the injected onToken. */
function deferredRunner(): {
  runner: RewriteRunner;
  emit: (text: string) => void;
  resolve: (result: RewriteRunResult) => void;
  reject: (err: Error) => void;
  started: () => boolean;
} {
  let emit: (text: string) => void = () => {};
  let resolve!: (result: RewriteRunResult) => void;
  let reject!: (err: Error) => void;
  let started = false;
  const runner: RewriteRunner = (onToken) => {
    started = true;
    emit = onToken;
    return new Promise<RewriteRunResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  };
  return {
    runner,
    emit: (t) => emit(t),
    resolve: (r) => resolve(r),
    reject: (e) => reject(e),
    started: () => started,
  };
}

/** Resolves once the microtask queue drains, so a settled runner's terminal
 *  bookkeeping (phase, onEnd fan-out) has run before we assert. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const META_A = { company: 'Stripe', title: 'AI Engineer' };
const META_B = { company: 'Ramp', title: 'ML Engineer' };

let registry: RewriteRegistry;

beforeEach(() => {
  registry = createRewriteRegistry({ lingerMs: 10_000 });
});

describe('rewrite registry', () => {
  it('reports a job running while the runner is in flight, done when it completes', async () => {
    const d = deferredRunner();
    registry.start(1, d.runner, META_A);

    expect(registry.snapshot()).toEqual([{ jobId: 1, ...META_A, phase: 'running' }]);

    d.resolve({ kind: 'done' });
    await flush();

    expect(registry.snapshot()).toEqual([{ jobId: 1, ...META_A, phase: 'done' }]);
  });

  it('surfaces truncated when the runner reports truncation (not done)', async () => {
    const d = deferredRunner();
    registry.start(1, d.runner, META_A);
    d.resolve({ kind: 'truncated' });
    await flush();

    expect(registry.snapshot()[0].phase).toBe('truncated');
  });

  it('surfaces error when the runner throws (not done)', async () => {
    const d = deferredRunner();
    registry.start(1, d.runner, META_A);
    d.reject(new Error('stream died'));
    await flush();

    expect(registry.snapshot()[0].phase).toBe('error');
  });

  it('surfaces error for a race-fallback result kind (not_editable / job_not_found)', async () => {
    const a = deferredRunner();
    const b = deferredRunner();
    registry.start(1, a.runner, META_A);
    registry.start(2, b.runner, META_B);
    a.resolve({ kind: 'not_editable', status: 'approved' });
    b.resolve({ kind: 'job_not_found' });
    await flush();

    const byId = Object.fromEntries(registry.snapshot().map((e) => [e.jobId, e.phase]));
    expect(byId).toEqual({ 1: 'error', 2: 'error' });
  });

  it('tracks two jobs independently — one finishing does not change the other', async () => {
    const a = deferredRunner();
    const b = deferredRunner();
    registry.start(1, a.runner, META_A);
    registry.start(2, b.runner, META_B);

    a.resolve({ kind: 'done' });
    await flush();

    const byId = Object.fromEntries(registry.snapshot().map((e) => [e.jobId, e.phase]));
    expect(byId).toEqual({ 1: 'done', 2: 'running' });
  });

  it('is idempotent per job — a second start while running attaches, not re-runs', async () => {
    const first = deferredRunner();
    const second = vi.fn();
    registry.start(1, first.runner, META_A);
    registry.start(1, second as unknown as RewriteRunner, META_A);

    expect(second).not.toHaveBeenCalled();
    expect(registry.snapshot()).toEqual([{ jobId: 1, ...META_A, phase: 'running' }]);
  });

  it('subscribe delivers streamed tokens in order and the terminal event', async () => {
    const d = deferredRunner();
    registry.start(1, d.runner, META_A);

    const tokens: string[] = [];
    const ends: unknown[] = [];
    registry.subscribe(1, (t) => tokens.push(t), (o) => ends.push(o));

    d.emit('\\sec');
    d.emit('tion');
    d.resolve({ kind: 'done' });
    await flush();

    expect(tokens.join('')).toBe('\\section');
    expect(ends).toEqual([{ ok: true, result: { kind: 'done' } }]);
  });

  it('replays accumulated text to a late subscriber, then streams the rest and completion', async () => {
    const d = deferredRunner();
    registry.start(1, d.runner, META_A);
    d.emit('early');

    // Subscribe AFTER some tokens already streamed — a reconnecting client.
    const tokens: string[] = [];
    const ends: unknown[] = [];
    registry.subscribe(1, (t) => tokens.push(t), (o) => ends.push(o));

    d.emit('-late');
    d.resolve({ kind: 'done' });
    await flush();

    expect(tokens.join('')).toBe('early-late');
    expect(ends).toEqual([{ ok: true, result: { kind: 'done' } }]);
  });

  it('delivers the terminal outcome immediately to a subscriber that joins after completion', async () => {
    const d = deferredRunner();
    registry.start(1, d.runner, META_A);
    d.emit('all-of-it');
    d.resolve({ kind: 'done' });
    await flush();

    const tokens: string[] = [];
    const ends: unknown[] = [];
    registry.subscribe(1, (t) => tokens.push(t), (o) => ends.push(o));

    expect(tokens.join('')).toBe('all-of-it');
    expect(ends).toEqual([{ ok: true, result: { kind: 'done' } }]);
  });

  it('an error outcome is delivered to subscribers with the thrown error', async () => {
    const d = deferredRunner();
    registry.start(1, d.runner, META_A);
    const ends: Array<{ ok: boolean; error?: Error }> = [];
    registry.subscribe(1, () => {}, (o) => ends.push(o as never));
    d.reject(new Error('boom'));
    await flush();

    expect(ends).toHaveLength(1);
    expect(ends[0].ok).toBe(false);
    expect(ends[0].error?.message).toBe('boom');
  });

  it('unsubscribe stops further token delivery', async () => {
    const d = deferredRunner();
    registry.start(1, d.runner, META_A);
    const tokens: string[] = [];
    const unsub = registry.subscribe(1, (t) => tokens.push(t), () => {});

    d.emit('one');
    unsub();
    d.emit('two');
    d.resolve({ kind: 'done' });
    await flush();

    expect(tokens).toEqual(['one']);
  });

  it('subscribe to an untracked job is a no-op that never throws', () => {
    expect(() => registry.subscribe(999, () => {}, () => {})()).not.toThrow();
  });

  it('isolates a throwing subscriber so it neither aborts the generation nor starves other subscribers', async () => {
    const d = deferredRunner();
    registry.start(1, d.runner, META_A);

    // A dead client whose sink throws on every token and on completion.
    registry.subscribe(
      1,
      () => {
        throw new Error('controller closed');
      },
      () => {
        throw new Error('controller closed');
      },
    );
    // A healthy client that must still receive everything.
    const tokens: string[] = [];
    const ends: unknown[] = [];
    registry.subscribe(1, (t) => tokens.push(t), (o) => ends.push(o));

    d.emit('a');
    d.emit('b');
    d.resolve({ kind: 'done' });
    await flush();

    // The generation ran to completion (done, not error) despite the throwing
    // subscriber, and the healthy subscriber got its tokens and terminal event.
    expect(registry.snapshot()[0].phase).toBe('done');
    expect(tokens.join('')).toBe('ab');
    expect(ends).toEqual([{ ok: true, result: { kind: 'done' } }]);
  });

  it('clears a terminal entry after the linger window elapses', async () => {
    vi.useFakeTimers();
    try {
      const reg = createRewriteRegistry({ lingerMs: 5_000 });
      const d = deferredRunner();
      reg.start(1, d.runner, META_A);
      d.resolve({ kind: 'done' });
      await vi.advanceTimersByTimeAsync(0);
      expect(reg.snapshot()[0].phase).toBe('done');

      await vi.advanceTimersByTimeAsync(5_000);
      expect(reg.snapshot()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fresh start after a terminal linger replaces the old entry and runs again', async () => {
    const first = deferredRunner();
    registry.start(1, first.runner, META_A);
    first.resolve({ kind: 'done' });
    await flush();
    expect(registry.snapshot()[0].phase).toBe('done');

    const second = deferredRunner();
    registry.start(1, second.runner, META_A);
    expect(second.started()).toBe(true);
    expect(registry.snapshot()[0].phase).toBe('running');
  });
});

afterEach(() => {
  vi.useRealTimers();
});
