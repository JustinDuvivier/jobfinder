/**
 * Server-side Ollama model management for the Settings scoring selector
 * (FR-6b): installed checks over /api/show, and one in-process `ollama pull`
 * at a time whose NDJSON progress stream (/api/pull) is consumed here into an
 * in-memory record that GET /api/ollama/models snapshots. The client uses
 * start-then-poll refetch — SSE stays reserved for the three streaming routes.
 *
 * The record is process-local by design: a server restart mid-pull forgets the
 * progress record (the download itself continues or completes inside the
 * Ollama daemon), and the next status GET simply reflects the actual installed
 * state. A finished pull — success or failure — is reported by exactly one
 * snapshot and then cleared, so a failure surfaces once instead of sticking.
 */
import { ollamaFetch } from './ollama';

/**
 * Sane-shape gate for a model tag before it reaches Ollama: dotted/dashed name
 * segments, optional registry/namespace path parts, one optional `:tag`.
 * Matches real tags like `qwen3:4b-instruct-2507-q4_K_M` and
 * `batiai/qwen3.6-27b:iq3`; rejects whitespace, shell metacharacters, and
 * empty strings. The route additionally restricts pulls to curated or stored
 * tags — this pattern is only the format check.
 */
export const OLLAMA_TAG_PATTERN = /^[\w.-]+(\/[\w.-]+)*(:[\w.-]+)?$/;

/** The progress record GET /api/ollama/models returns while a pull runs. */
export interface PullProgress {
  tag: string;
  /** Ollama's latest status line ("pulling manifest", "verifying sha256 digest", "success"). */
  status: string;
  /** Bytes downloaded of the layer currently transferring, when Ollama reports them. */
  completed: number | null;
  /** Total bytes of that layer, when reported. */
  total: number | null;
  done: boolean;
  /** Set when the pull failed; null on success or while running. */
  error: string | null;
}

export interface OllamaPullManager {
  /** Start pulling `tag`; refused while another pull is still running. */
  start(tag: string): { started: true } | { started: false; error: string };
  /**
   * The current record for polling GETs. A finished pull is returned exactly
   * once — the snapshot that sees `done: true` clears the record.
   */
  snapshot(): PullProgress | null;
}

/** Whether Ollama has the model — the same /api/show probe scoring preflights with. */
export async function isOllamaModelInstalled(tag: string): Promise<boolean> {
  return (await ollamaFetch('/api/show', { model: tag })).ok;
}

/** One NDJSON line of Ollama's /api/pull stream. */
interface PullStreamLine {
  status?: string;
  completed?: number;
  total?: number;
  error?: string;
}

/** Fold one stream line into the record; returns true once "success" is seen. */
function applyLine(record: PullProgress, line: PullStreamLine): boolean {
  if (line.error) {
    record.error = line.error;
    return false;
  }
  if (line.status) record.status = line.status;
  if (typeof line.completed === 'number') record.completed = line.completed;
  if (typeof line.total === 'number') record.total = line.total;
  return line.status === 'success';
}

/** Consume the pull stream to completion, mutating the shared record. */
async function runPull(record: PullProgress): Promise<void> {
  try {
    const res = await ollamaFetch('/api/pull', { model: record.tag, stream: true });
    if (!res.ok) {
      record.error = `Ollama HTTP ${res.status}: ${await res.text()}`;
      return;
    }
    if (!res.body) {
      record.error = 'Ollama returned no pull stream';
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let succeeded = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) succeeded = applyLine(record, JSON.parse(line) as PullStreamLine) || succeeded;
      }
    }
    const tail = buffer.trim();
    if (tail) succeeded = applyLine(record, JSON.parse(tail) as PullStreamLine) || succeeded;
    if (!record.error && !succeeded) {
      record.error = 'Pull stream ended without success — check the Ollama server log.';
    }
  } catch (err) {
    record.error = (err as Error).message;
  } finally {
    record.done = true;
  }
}

export function createPullManager(): OllamaPullManager {
  let current: PullProgress | null = null;

  return {
    start(tag) {
      if (current && !current.done) {
        return {
          started: false,
          error: `A download is already running (${current.tag}) — wait for it to finish.`,
        };
      }
      current = { tag, status: 'starting', completed: null, total: null, done: false, error: null };
      void runPull(current);
      return { started: true };
    },
    snapshot() {
      const record = current;
      if (record?.done) current = null;
      return record;
    },
  };
}

let singleton: OllamaPullManager | undefined;

/** The process-wide pull manager shared by GET and POST /api/ollama/models,
 *  mirroring getRewriteRegistry()'s process-local pattern. */
export function getPullManager(): OllamaPullManager {
  if (!singleton) singleton = createPullManager();
  return singleton;
}
