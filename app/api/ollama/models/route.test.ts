/**
 * Tests for GET/POST /api/ollama/models — a thin mapper over the pull manager
 * and the installed probe (both faked; their behavior lives in
 * lib/ai/ollama-pull.test.ts). Pinned here: the reported tag set (curated +
 * stored custom, deduped), the reachable/unreachable GET shapes, and POST's
 * tag validation (format check, curated-or-stored allowlist), 202/409 mapping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repo from '@/lib/db/repo';
import {
  CURATED_OLLAMA_MODELS,
  DEFAULT_OLLAMA_MODEL,
  LARGE_OLLAMA_MODEL,
} from '@/lib/ai/models';
import { getPullManager, isOllamaModelInstalled, type PullProgress } from '@/lib/ai/ollama-pull';
import { GET, POST } from './route';

vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('@/lib/db/repo', () => ({ getUserConfig: vi.fn() }));
vi.mock('@/lib/ai/ollama-pull', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/ollama-pull')>()),
  getPullManager: vi.fn(),
  isOllamaModelInstalled: vi.fn(),
}));

const getUserConfig = vi.mocked(repo.getUserConfig);
const mockedInstalled = vi.mocked(isOllamaModelInstalled);
const mockedManager = vi.mocked(getPullManager);
const manager = { start: vi.fn(), snapshot: vi.fn() };

const CUSTOM_TAG = 'llama3.1:8b';

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://127.0.0.1/api/ollama/models', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedManager.mockReturnValue(manager);
  manager.snapshot.mockReturnValue(null);
  manager.start.mockReturnValue({ started: true });
  getUserConfig.mockReturnValue({ ollamaModel: CUSTOM_TAG } as never);
  mockedInstalled.mockResolvedValue(false);
});

describe('GET /api/ollama/models', () => {
  it('reports every curated tag plus the stored custom tag with installed status', async () => {
    mockedInstalled.mockImplementation(async (tag) => tag === DEFAULT_OLLAMA_MODEL);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reachable: true,
      models: [
        { tag: DEFAULT_OLLAMA_MODEL, installed: true },
        { tag: LARGE_OLLAMA_MODEL, installed: false },
        { tag: CUSTOM_TAG, installed: false },
      ],
      pulling: null,
    });
  });

  it('dedupes when the stored tag is itself curated, and tolerates no config row', async () => {
    getUserConfig.mockReturnValue({ ollamaModel: DEFAULT_OLLAMA_MODEL } as never);
    let json = await (await GET()).json();
    expect(json.models).toHaveLength(CURATED_OLLAMA_MODELS.length);

    getUserConfig.mockReturnValue(undefined);
    json = await (await GET()).json();
    expect(json.models).toHaveLength(CURATED_OLLAMA_MODELS.length);
  });

  it('includes the active pull record', async () => {
    const pulling: PullProgress = {
      tag: LARGE_OLLAMA_MODEL,
      status: 'pulling abc',
      completed: 10,
      total: 100,
      done: false,
      error: null,
    };
    manager.snapshot.mockReturnValue(pulling);
    expect((await (await GET()).json()).pulling).toEqual(pulling);
  });

  it('answers 200 with reachable: false when Ollama is down — Settings still loads', async () => {
    mockedInstalled.mockRejectedValue(new Error('Ollama server unreachable at http://x'));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reachable: false,
      error: 'Ollama server unreachable at http://x',
      models: [],
      pulling: null,
    });
  });
});

describe('POST /api/ollama/models', () => {
  it('rejects a missing or malformed tag with 400', async () => {
    for (const body of ['not json', {}, { tag: 42 }, { tag: 'has space' }, { tag: 'a|b' }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Missing or malformed "tag"' });
    }
    expect(manager.start).not.toHaveBeenCalled();
  });

  it('rejects a well-formed tag that is neither curated nor the stored custom tag', async () => {
    const res = await post({ tag: 'mistral:7b' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown model tag/);
    expect(manager.start).not.toHaveBeenCalled();
  });

  it('starts a pull for a curated tag and for the stored custom tag (202)', async () => {
    for (const tag of [LARGE_OLLAMA_MODEL, CUSTOM_TAG]) {
      const res = await post({ tag });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, tag });
      expect(manager.start).toHaveBeenCalledWith(tag);
    }
  });

  it('maps an already-running pull to 409 with the manager error', async () => {
    manager.start.mockReturnValue({ started: false, error: 'A download is already running' });
    const res = await post({ tag: DEFAULT_OLLAMA_MODEL });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'A download is already running' });
  });
});
