/**
 * POST /api/rewrite — a thin edge over the rewrite registry
 * (lib/rewrite/registry). The generation is a durable, server-owned background
 * job: the route starts it in the registry (detached from this HTTP response)
 * and streams by subscribing, so the rewrite survives the client navigating
 * away or reloading.
 *
 * Two modes on one endpoint:
 *   • Default (a fresh "AI Rewrite" click): after the pre-stream guards — 400 for
 *     a missing jobId, 404 for a missing job, 409 for a non-editable status (the
 *     same shape /api/autosave uses) — the route `start`s the background job and
 *     streams it. A truncated or errored run persists nothing (enforced inside
 *     runRewrite).
 *   • `reconnect: true` (the rewrite page re-attaching on load): **attach-only.**
 *     It never `start`s a generation, so it can't double-pay or clobber a
 *     just-finished result. If the registry reports the job running, it streams
 *     the in-flight generation (the registry replays the accumulated-so-far
 *     text); otherwise it emits a single `idle` event so the client knows to
 *     auto-compile the persisted resume instead of waiting on a dead stream.
 *
 * The terminal outcome maps to the same SSE events the client already handles
 * (done / truncated / error). On client disconnect the subscription is released
 * (onCancel), while the generation itself continues in the registry.
 *
 * Body: { jobId, reconnect? }.
 */
import { getDb } from '@/lib/db';
import { getAnthropicClient } from '@/lib/ai/client';
import { runRewrite } from '@/lib/rewrite/run';
import {
  getRewriteRegistry,
  type RewriteOutcome,
  type RewriteRegistry,
} from '@/lib/rewrite/registry';
import { rewriteNotEditableMessage } from '@/lib/commands';
import { canEdit } from '@/lib/status/transitions';
import { createSseResponse } from '@/lib/http/sse';
import { requireJob } from '@/lib/http/guards';

export const runtime = 'nodejs';

/** Map a background outcome to the SSE event the client already handles. Keeps
 *  the run-result → SSE mapping in one place; the registry stays generic. */
function outcomeToEvent(jobId: number, outcome: RewriteOutcome): Record<string, unknown> {
  if (!outcome.ok) return { type: 'error', message: outcome.error.message };
  switch (outcome.result.kind) {
    case 'done':
      return { type: 'done' };
    case 'truncated':
      return { type: 'truncated' };
    case 'not_editable':
      // The job left `rewriting` between the pre-stream 409 check and the run.
      return { type: 'error', message: rewriteNotEditableMessage(jobId, outcome.result.status) };
    case 'job_not_found':
      // The job vanished between the 404 check and the run.
      return { type: 'error', message: 'Job not found' };
  }
}

/** Stream a job's background generation by subscribing to the registry. The
 *  subscription is released if the client disconnects; the generation lives on. */
function streamSubscription(registry: RewriteRegistry, jobId: number): Response {
  return createSseResponse(
    (sink) =>
      new Promise<void>((resolve) => {
        const unsubscribe = registry.subscribe(
          jobId,
          (text) => sink.send({ type: 'token', text }),
          (outcome) => {
            sink.send(outcomeToEvent(jobId, outcome));
            resolve();
          },
        );
        sink.onCancel(() => {
          unsubscribe();
          resolve();
        });
      }),
  );
}

export async function POST(req: Request): Promise<Response> {
  const db = getDb();
  const guard = await requireJob(req, db);
  if (!guard.ok) return guard.response;
  const { jobId, job, body } = guard;
  const registry = getRewriteRegistry();

  if (body.reconnect === true) {
    // Attach-only: the page is re-opening the live view on load. Never start a
    // generation here — that would double-pay and overwrite a result that
    // finished while away. The running check and the subscribe below run in the
    // same synchronous tick (createSseResponse's start callback fires during
    // construction), so the job cannot slip from running to cleared between them.
    const running = registry.snapshot().some((e) => e.jobId === jobId && e.phase === 'running');
    if (!running) {
      return createSseResponse(async (sink) => {
        sink.send({ type: 'idle' });
      });
    }
    return streamSubscription(registry, jobId);
  }

  if (!canEdit(job.status)) {
    return Response.json(
      { error: rewriteNotEditableMessage(jobId, job.status) },
      { status: 409 },
    );
  }
  // Resolved before the SSE response so a missing API key fails at the HTTP
  // layer (500), not as a mid-stream error event.
  const client = getAnthropicClient();

  // Start (or, if one is already running, attach to) the background generation,
  // then stream it. Survival no longer depends on this request staying open.
  registry.start(jobId, (onToken) => runRewrite(db, jobId, { client, onToken }), {
    company: job.company,
    title: job.title,
  });
  return streamSubscription(registry, jobId);
}
