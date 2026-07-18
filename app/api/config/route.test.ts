/**
 * Tests for GET/POST /api/config — a thin mapper over parseUserConfig (the
 * coercions and FR-9a threshold semantics are table-tested in
 * lib/config/parse.test.ts). Pinned here: the 400 mapping for both parse
 * errors, that a valid body is persisted exactly as parsed, and that saving
 * re-arms the backend scheduler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repo from '@/lib/db/repo';
import { syncSchedulerFromConfig } from '@/lib/schedule/runner';
import { GET, POST } from './route';

vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('@/lib/db/repo', () => ({ getUserConfig: vi.fn(), upsertUserConfig: vi.fn() }));
vi.mock('@/lib/schedule/runner', () => ({ syncSchedulerFromConfig: vi.fn() }));

const getUserConfig = vi.mocked(repo.getUserConfig);
const upsertUserConfig = vi.mocked(repo.upsertUserConfig);
const mockedSync = vi.mocked(syncSchedulerFromConfig);

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://127.0.0.1/api/config', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/config', () => {
  it('returns the stored config, or null when none exists', async () => {
    getUserConfig.mockReturnValue(undefined);
    expect(await (await GET()).json()).toEqual({ config: null });

    getUserConfig.mockReturnValue({ ownerName: 'Alex_Candidate' } as never);
    expect(await (await GET()).json()).toEqual({ config: { ownerName: 'Alex_Candidate' } });
  });
});

describe('POST /api/config', () => {
  it('rejects an unparseable or non-object body with 400', async () => {
    const res = await post('not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON body' });
    expect(upsertUserConfig).not.toHaveBeenCalled();
  });

  it('rejects an invalid scraper strategy with 400', async () => {
    const res = await post({ scraperStrategy: 'selenium' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid scraperStrategy' });
    expect(upsertUserConfig).not.toHaveBeenCalled();
  });

  it('persists the parsed config, re-arms the scheduler, and echoes the config', async () => {
    const res = await post({ scraperStrategy: 'demo', scoreThreshold: 60, keywords: ['ai'] });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.config).toMatchObject({
      scraperStrategy: 'demo',
      scoreThreshold: 60,
      keywords: ['ai'],
    });
    expect(upsertUserConfig).toHaveBeenCalledWith(expect.anything(), json.config);
    expect(mockedSync).toHaveBeenCalledOnce();
  });
});
