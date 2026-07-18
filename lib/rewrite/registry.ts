/**
 * The rewrite registry — a process-local, in-memory owner of in-flight rewrites
 * (the one new seam for durable background rewrites). It runs an injected runner
 * to completion **detached from any HTTP response**, so a generation survives
 * the client navigating away or reloading; it accumulates streamed tokens for
 * broadcast to connected/reconnecting clients; and it exposes a coarse per-job
 * snapshot for the always-visible cross-page status indicator.
 *
 * It is deliberately NOT a second datastore: it holds only transient lifecycle
 * state. The durable result (rewritten LaTeX, diff, history) continues to live
 * in SQLite via the runner (`runRewrite` → `RecordRewrite` command). The
 * registry never persists and has no Anthropic dependency — the runner is
 * injected (the route passes a thunk over `runRewrite`; tests pass a fake).
 *
 * See jobfinder-docs.md "Rewrite Module" and .scratch/durable-background-rewrites/spec.md.
 */
import type { RewriteRunResult } from './run';

/** Coarse lifecycle phase surfaced to the cross-page indicator. */
export type RewritePhase = 'running' | 'done' | 'truncated' | 'error';

/** One tracked job's coarse state — enough to render and link the indicator. */
export interface RewriteSnapshotEntry {
  jobId: number;
  company: string;
  title: string;
  phase: RewritePhase;
}

/** The terminal result handed to subscribers: either the runner's result or the
 *  error it threw. The route maps this to its SSE event so the run-result → SSE
 *  mapping stays in one place (and off the generic registry). */
export type RewriteOutcome =
  | { ok: true; result: RewriteRunResult }
  | { ok: false; error: Error };

/** The injected unit of work. Receives the registry's token sink and resolves
 *  to the run result; the route wraps `runRewrite`, tests pass a fake. */
export type RewriteRunner = (onToken: (text: string) => void) => Promise<RewriteRunResult>;

/** Identity carried into the snapshot so the indicator can render/link a job
 *  without a second DB read. */
export interface RewriteMeta {
  company: string;
  title: string;
}

export interface RewriteRegistry {
  /**
   * Begin a background rewrite for `jobId`. **Idempotent per job:** if one is
   * already running, this attaches to it (the runner is NOT invoked again) so a
   * reconnecting request can't race a second generation into the same job.
   */
  start(jobId: number, runner: RewriteRunner, meta: RewriteMeta): void;
  /** Coarse per-job state for the cross-page indicator. Terminal entries linger
   *  briefly (so a returning page can see "just finished") then clear. */
  snapshot(): RewriteSnapshotEntry[];
  /**
   * Receive the live token stream and the terminal outcome for `jobId`. A late
   * subscriber to a still-running job first receives the accumulated-so-far text
   * (one replay call) then subsequent tokens; a subscriber that joins after the
   * job finished receives the full text and the terminal outcome immediately.
   * Returns an unsubscribe. A no-op for an untracked job.
   */
  subscribe(
    jobId: number,
    onToken: (text: string) => void,
    onEnd: (outcome: RewriteOutcome) => void,
  ): () => void;
}

interface Subscriber {
  onToken: (text: string) => void;
  onEnd: (outcome: RewriteOutcome) => void;
}

interface Entry {
  jobId: number;
  company: string;
  title: string;
  phase: RewritePhase;
  accumulated: string;
  subscribers: Set<Subscriber>;
  outcome?: RewriteOutcome;
}

/** How long a terminal phase (done/truncated/error) lingers in the snapshot
 *  before it is cleared — long enough for a returning page's status poll to
 *  observe "just finished," short enough not to accrete stale entries. */
const DEFAULT_LINGER_MS = 30_000;

/** Deliver one broadcast to a subscriber, swallowing any throw so a single dead
 *  client can never abort the detached generation or starve other subscribers. */
function fanout(deliver: () => void): void {
  try {
    deliver();
  } catch {
    /* a disconnected/closed sink must not affect the shared generation */
  }
}

function terminalPhase(outcome: RewriteOutcome): Exclude<RewritePhase, 'running'> {
  if (!outcome.ok) return 'error';
  switch (outcome.result.kind) {
    case 'done':
      return 'done';
    case 'truncated':
      return 'truncated';
    // Race fallbacks: the job vanished or left `rewriting` after the pre-stream
    // guard — nothing was persisted, so it reads as a failed rewrite.
    case 'not_editable':
    case 'job_not_found':
      return 'error';
  }
}

export function createRewriteRegistry(opts: { lingerMs?: number } = {}): RewriteRegistry {
  const lingerMs = opts.lingerMs ?? DEFAULT_LINGER_MS;
  const entries = new Map<number, Entry>();

  function run(entry: Entry, runner: RewriteRunner): void {
    // Detached: fire-and-forget. The runner's failure is captured as an `error`
    // outcome below, so this never becomes an unhandled rejection.
    void (async () => {
      let outcome: RewriteOutcome;
      try {
        const result = await runner((text) => {
          entry.accumulated += text;
          // Fan out in isolation: a subscriber whose sink throws (e.g. a client
          // that navigated away, so its SSE controller is closed) must NOT abort
          // the shared background generation — that would defeat the durability
          // guarantee (FR-16a). Its tokens are simply dropped.
          for (const s of entry.subscribers) fanout(() => s.onToken(text));
        });
        outcome = { ok: true, result };
      } catch (err) {
        outcome = { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
      }
      entry.phase = terminalPhase(outcome);
      entry.outcome = outcome;
      // Snapshot + clear before delivery so a throwing onEnd can't leave stale
      // subscribers, and isolate each delivery so one dead client can't starve
      // the others of their terminal event.
      const subscribers = [...entry.subscribers];
      entry.subscribers.clear();
      for (const s of subscribers) fanout(() => s.onEnd(outcome));
      // Linger, then clear — unless a fresh run has already replaced this entry.
      setTimeout(() => {
        if (entries.get(entry.jobId) === entry) entries.delete(entry.jobId);
      }, lingerMs);
    })();
  }

  return {
    start(jobId, runner, meta) {
      const existing = entries.get(jobId);
      if (existing && existing.phase === 'running') return; // attach — don't re-run
      const entry: Entry = {
        jobId,
        company: meta.company,
        title: meta.title,
        phase: 'running',
        accumulated: '',
        subscribers: new Set(),
      };
      entries.set(jobId, entry);
      run(entry, runner);
    },

    snapshot() {
      return [...entries.values()].map((e) => ({
        jobId: e.jobId,
        company: e.company,
        title: e.title,
        phase: e.phase,
      }));
    },

    subscribe(jobId, onToken, onEnd) {
      const entry = entries.get(jobId);
      if (!entry) return () => {};
      // Catch a reconnecting/late subscriber up on what already streamed. Guard
      // the replay the same way as live fan-out — a throwing sink here must not
      // reject the caller.
      if (entry.accumulated) fanout(() => onToken(entry.accumulated));
      if (entry.phase !== 'running') {
        // Already terminal — deliver the outcome now; nothing more will stream.
        if (entry.outcome) fanout(() => onEnd(entry.outcome!));
        return () => {};
      }
      const sub: Subscriber = { onToken, onEnd };
      entry.subscribers.add(sub);
      return () => entry.subscribers.delete(sub);
    },
  };
}

let singleton: RewriteRegistry | undefined;

/** The process-wide registry singleton shared by /api/rewrite and
 *  /api/rewrite/status, mirroring getDb()'s process-local pattern. */
export function getRewriteRegistry(): RewriteRegistry {
  if (!singleton) singleton = createRewriteRegistry();
  return singleton;
}
