/**
 * Tests for the Ollama model-management module (FR-6b) — the tag-format gate,
 * the /api/show installed probe, and the pull manager's NDJSON stream
 * consumption into the in-memory progress record: progress updates, the
 * single-pull lock, report-once-then-clear on completion, and every failure
 * mode (HTTP error, Ollama error line, unreachable server, dead stream).
 * The HTTP transport (global fetch) is mocked; no live Ollama is used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_OLLAMA_BASE_URL } from '@/lib/env/ollama';
import {
  createPullManager,
  isOllamaModelInstalled,
  OLLAMA_TAG_PATTERN,
  type PullProgress,
} from './ollama-pull';

const TAG = 'qwen3:0.6b';
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fake /api/pull response whose NDJSON lines we enqueue by hand. */
function streamedResponse(): {
  response: { ok: boolean; body: ReadableStream<Uint8Array> };
  push: (line: object) => void;
  close: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: { ok: true, body },
    push: (line) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)),
    close: () => controller.close(),
  };
}

/** Poll the manager until the finished record appears (it is cleared on read). */
async function finalSnapshot(manager: ReturnType<typeof createPullManager>): Promise<PullProgress> {
  let final: PullProgress | null = null;
  await vi.waitFor(() => {
    const snap = manager.snapshot();
    if (snap?.done) final = snap;
    expect(final).not.toBeNull();
  });
  return final!;
}

describe('OLLAMA_TAG_PATTERN', () => {
  it('accepts real Ollama tags', () => {
    for (const tag of ['qwen3:4b-instruct-2507-q4_K_M', 'batiai/qwen3.6-27b:iq3', 'llama3', TAG]) {
      expect(tag).toMatch(OLLAMA_TAG_PATTERN);
    }
  });

  it('rejects empty, whitespace, and metacharacter strings', () => {
    for (const tag of ['', 'has space', 'a|b', 'a;rm -rf', 'a:b:c', 'a//b', 'tag\n']) {
      expect(tag).not.toMatch(OLLAMA_TAG_PATTERN);
    }
  });
});

describe('isOllamaModelInstalled', () => {
  it('probes /api/show and maps ok / not-ok to installed / absent', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    await expect(isOllamaModelInstalled(TAG)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_OLLAMA_BASE_URL}/api/show`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ model: TAG }) }),
    );

    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(isOllamaModelInstalled(TAG)).resolves.toBe(false);
  });

  it('throws loudly when the server is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(isOllamaModelInstalled(TAG)).rejects.toThrow(/Ollama server unreachable/);
  });
});

describe('createPullManager', () => {
  it('streams progress into the record and finishes on the success line', async () => {
    const { response, push, close } = streamedResponse();
    fetchMock.mockResolvedValue(response);
    const manager = createPullManager();

    expect(manager.start(TAG)).toEqual({ started: true });
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_OLLAMA_BASE_URL}/api/pull`,
      expect.objectContaining({ body: JSON.stringify({ model: TAG, stream: true }) }),
    );

    push({ status: 'pulling manifest' });
    push({ status: 'pulling abc123', completed: 100, total: 500 });
    await vi.waitFor(() => {
      expect(manager.snapshot()).toMatchObject({
        tag: TAG,
        status: 'pulling abc123',
        completed: 100,
        total: 500,
        done: false,
        error: null,
      });
    });

    push({ status: 'success' });
    close();
    expect(await finalSnapshot(manager)).toMatchObject({
      tag: TAG,
      status: 'success',
      done: true,
      error: null,
    });
  });

  it('refuses a second pull while one runs, and allows one after it finishes', async () => {
    const { response, push, close } = streamedResponse();
    fetchMock.mockResolvedValue(response);
    const manager = createPullManager();

    expect(manager.start(TAG)).toEqual({ started: true });
    expect(manager.start('llama3')).toEqual({
      started: false,
      error: expect.stringContaining(TAG),
    });

    push({ status: 'success' });
    close();
    await finalSnapshot(manager);

    const next = streamedResponse();
    fetchMock.mockResolvedValue(next.response);
    expect(manager.start('llama3')).toEqual({ started: true });
  });

  it('reports a finished pull exactly once, then clears', async () => {
    const { response, push, close } = streamedResponse();
    fetchMock.mockResolvedValue(response);
    const manager = createPullManager();
    manager.start(TAG);
    push({ status: 'success' });
    close();

    await finalSnapshot(manager);
    expect(manager.snapshot()).toBeNull();
  });

  it("surfaces Ollama's in-stream error line as the pull failure", async () => {
    const { response, push, close } = streamedResponse();
    fetchMock.mockResolvedValue(response);
    const manager = createPullManager();
    manager.start('no/such-model');
    push({ error: 'pull model manifest: file does not exist' });
    close();

    expect(await finalSnapshot(manager)).toMatchObject({
      done: true,
      error: 'pull model manifest: file does not exist',
    });
  });

  it('fails on a non-2xx pull response with the HTTP status and body', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'disk full' });
    const manager = createPullManager();
    manager.start(TAG);
    expect((await finalSnapshot(manager)).error).toBe('Ollama HTTP 500: disk full');
  });

  it('fails loudly when the server is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const manager = createPullManager();
    manager.start(TAG);
    expect((await finalSnapshot(manager)).error).toMatch(/Ollama server unreachable/);
  });

  it('treats a stream that ends without success as a failure', async () => {
    const { response, push, close } = streamedResponse();
    fetchMock.mockResolvedValue(response);
    const manager = createPullManager();
    manager.start(TAG);
    push({ status: 'pulling manifest' });
    close();
    expect((await finalSnapshot(manager)).error).toMatch(/ended without success/);
  });
});
