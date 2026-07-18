/**
 * Tests for POST /api/rewrite — now a thin edge over the rewrite registry
 * (lib/rewrite/registry), which owns the background generation. Pinned here: the
 * request contract (400/404/409 before any stream opens), that the Anthropic
 * client is resolved before the SSE response, that the route starts the registry
 * with a runner that wraps runRewrite, that subscribed tokens are forwarded as
 * SSE events, and that each terminal outcome maps to its documented event. The
 * registry is faked so this stays a contract-level test; its own lifecycle lives
 * in lib/rewrite/registry.test.ts, and the generation itself in run.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from '@/lib/types';
import * as repo from '@/lib/db/repo';
import { getAnthropicClient } from '@/lib/ai/client';
import { runRewrite } from '@/lib/rewrite/run';
import { getRewriteRegistry, type RewriteOutcome, type RewriteRunner } from '@/lib/rewrite/registry';
import { createSseResponse } from '@/lib/http/sse';
import { POST } from './route';

// Captures the handler passed to createSseResponse so tests can drive it with
// a fake sink instead of reading a real event stream.
const sse = vi.hoisted(() => ({
  handler: undefined as
    | ((sink: { send: (e: unknown) => void; onCancel: (cb: () => void) => void }) => Promise<void>)
    | undefined,
}));

// A fake registry: `start` records its args; `subscribe` runs a per-test script
// that emits tokens and the terminal outcome, standing in for the background
// generation the real registry would drive; `snapshot` returns the per-test
// state the reconnect path reads.
const reg = vi.hoisted(() => ({
  start: undefined as
    | ((jobId: number, runner: RewriteRunner, meta: { company: string; title: string }) => void)
    | undefined,
  script: undefined as
    | ((onToken: (t: string) => void, onEnd: (o: RewriteOutcome) => void) => void)
    | undefined,
  snapshot: [] as Array<{ jobId: number; phase: string }>,
  unsubscribe: undefined as ReturnType<typeof vi.fn> | undefined,
}));

vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('@/lib/db/repo', () => ({ getJobById: vi.fn() }));
vi.mock('@/lib/ai/client', () => ({ getAnthropicClient: vi.fn(() => ({ fake: 'client' })) }));
vi.mock('@/lib/rewrite/run', () => ({ runRewrite: vi.fn() }));
vi.mock('@/lib/rewrite/registry', () => ({
  getRewriteRegistry: vi.fn(() => ({
    start: (...args: unknown[]) => reg.start?.(...(args as Parameters<NonNullable<typeof reg.start>>)),
    snapshot: () => reg.snapshot,
    subscribe: (
      _jobId: number,
      onToken: (t: string) => void,
      onEnd: (o: RewriteOutcome) => void,
    ) => {
      reg.script?.(onToken, onEnd);
      return reg.unsubscribe ?? (() => {});
    },
  })),
}));
vi.mock('@/lib/http/sse', () => ({
  createSseResponse: vi.fn((handler) => {
    sse.handler = handler;
    return new Response('stream');
  }),
}));

const getJobById = vi.mocked(repo.getJobById);
const mockedRun = vi.mocked(runRewrite);
const mockedClient = vi.mocked(getAnthropicClient);
const mockedRegistry = vi.mocked(getRewriteRegistry);

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://127.0.0.1/api/rewrite', { method: 'POST', body: JSON.stringify(body) }),
  );
}

/** Runs the route, then drives the captured SSE handler; returns sent events. */
async function postAndStream(body: unknown): Promise<unknown[]> {
  await post(body);
  const events: unknown[] = [];
  expect(sse.handler).toBeDefined();
  await sse.handler!({ send: (e) => events.push(e), onCancel: () => {} });
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  sse.handler = undefined;
  reg.start = vi.fn();
  reg.script = undefined;
  reg.snapshot = [];
  reg.unsubscribe = undefined;
  getJobById.mockReturnValue({ id: 7, status: 'rewriting', company: 'Stripe', title: 'AI Engineer' } as Job);
});

describe('POST /api/rewrite', () => {
  it('rejects a missing or non-numeric jobId with 400 before opening a stream', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing numeric "jobId"' });
    expect(createSseResponse).not.toHaveBeenCalled();
    expect(reg.start).not.toHaveBeenCalled();
  });

  it('returns 404 when the job does not exist, before opening a stream', async () => {
    getJobById.mockReturnValue(undefined);
    const res = await post({ jobId: 7 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Job not found' });
    expect(createSseResponse).not.toHaveBeenCalled();
    expect(reg.start).not.toHaveBeenCalled();
  });

  it('rejects a non-editable job with 409 in autosave\'s error shape, before opening a stream', async () => {
    getJobById.mockReturnValue({ id: 7, status: 'approved' } as Job);
    const res = await post({ jobId: 7 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Recording a rewrite requires a job in rewriting; job 7 is approved',
    });
    expect(createSseResponse).not.toHaveBeenCalled();
    expect(mockedClient).not.toHaveBeenCalled();
    expect(reg.start).not.toHaveBeenCalled();
  });

  it('resolves the Anthropic client before the SSE response so a missing key fails at HTTP', async () => {
    await post({ jobId: 7 });
    expect(mockedClient).toHaveBeenCalledOnce();
    expect(mockedRegistry).toHaveBeenCalled();
    expect(createSseResponse).toHaveBeenCalledOnce();
  });

  it('starts the background generation with a runner that wraps runRewrite, plus job identity', async () => {
    await post({ jobId: 7 });

    expect(reg.start).toHaveBeenCalledWith(7, expect.any(Function), {
      company: 'Stripe',
      title: 'AI Engineer',
    });
    // The runner passed to the registry delegates to runRewrite with the client
    // and the registry's token sink — verified without running the model.
    const runner = vi.mocked(reg.start!).mock.calls[0][1];
    const onToken = vi.fn();
    runner(onToken);
    expect(mockedRun).toHaveBeenCalledWith(
      expect.anything(),
      7,
      expect.objectContaining({ client: { fake: 'client' }, onToken }),
    );
  });

  it('forwards subscribed tokens as SSE token events and ends with done', async () => {
    reg.script = (onToken, onEnd) => {
      onToken('\\sec');
      onToken('tion');
      onEnd({ ok: true, result: { kind: 'done' } });
    };

    const events = await postAndStream({ jobId: 7 });

    expect(events).toEqual([
      { type: 'token', text: '\\sec' },
      { type: 'token', text: 'tion' },
      { type: 'done' },
    ]);
  });

  // The not_editable and job_not_found arms are race fallbacks only: the route
  // already answered 409/404 pre-stream, so these fire when the job changed
  // between that check and the background run.
  it.each<[string, RewriteOutcome, unknown]>([
    ['truncated', { ok: true, result: { kind: 'truncated' } }, { type: 'truncated' }],
    [
      'not_editable',
      { ok: true, result: { kind: 'not_editable', status: 'approved' } },
      {
        type: 'error',
        message: 'Recording a rewrite requires a job in rewriting; job 7 is approved',
      },
    ],
    [
      'job_not_found',
      { ok: true, result: { kind: 'job_not_found' } },
      { type: 'error', message: 'Job not found' },
    ],
    ['thrown error', { ok: false, error: new Error('stream died') }, { type: 'error', message: 'stream died' }],
  ])('maps a %s outcome to its documented event', async (_label, outcome, event) => {
    reg.script = (_onToken, onEnd) => onEnd(outcome);

    const events = await postAndStream({ jobId: 7 });

    expect(events).toEqual([event]);
  });

  it('releases the subscription when the client disconnects (onCancel)', async () => {
    reg.unsubscribe = vi.fn();
    // A script that never ends — the terminal event won't fire; only cancel can
    // settle the handler.
    reg.script = () => {};
    await post({ jobId: 7 });

    let cancel: (() => void) | undefined;
    const done = sse.handler!({ send: () => {}, onCancel: (cb) => (cancel = cb) });
    expect(cancel).toBeDefined();
    cancel!();
    await done; // resolves only because onCancel ran

    expect(reg.unsubscribe).toHaveBeenCalledOnce();
  });

  describe('reconnect mode (attach-only)', () => {
    it('streams the in-flight generation without starting one when the job is running', async () => {
      reg.snapshot = [{ jobId: 7, phase: 'running' }];
      reg.script = (onToken, onEnd) => {
        onToken('live');
        onEnd({ ok: true, result: { kind: 'done' } });
      };

      const events = await postAndStream({ jobId: 7, reconnect: true });

      expect(reg.start).not.toHaveBeenCalled();
      expect(mockedClient).not.toHaveBeenCalled();
      expect(events).toEqual([{ type: 'token', text: 'live' }, { type: 'done' }]);
    });

    it('emits a single idle event (and never starts) when nothing is running', async () => {
      reg.snapshot = []; // job not tracked
      const subscribed = vi.fn();
      reg.script = subscribed;

      const events = await postAndStream({ jobId: 7, reconnect: true });

      expect(reg.start).not.toHaveBeenCalled();
      expect(subscribed).not.toHaveBeenCalled();
      expect(events).toEqual([{ type: 'idle' }]);
    });

    it('does not attach to a different job that happens to be running', async () => {
      reg.snapshot = [{ jobId: 99, phase: 'running' }];

      const events = await postAndStream({ jobId: 7, reconnect: true });

      expect(reg.start).not.toHaveBeenCalled();
      expect(events).toEqual([{ type: 'idle' }]);
    });

    it('still refuses a missing job with 404 before any stream', async () => {
      getJobById.mockReturnValue(undefined);
      const res = await post({ jobId: 7, reconnect: true });
      expect(res.status).toBe(404);
      expect(reg.start).not.toHaveBeenCalled();
    });
  });
});
