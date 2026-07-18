/**
 * Tests for POST /api/jobs/salary — a thin mapper over the shared prologue and
 * one repo write. Pinned here: the request contract (400/404), that a
 * non-empty value is trimmed and stored, and that an empty/whitespace/missing
 * value clears the salary (stores null).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from '@/lib/types';
import * as repo from '@/lib/db/repo';
import { POST } from './route';

vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('@/lib/db/repo', () => ({ getJobById: vi.fn(), setSalary: vi.fn() }));

const getJobById = vi.mocked(repo.getJobById);
const setSalary = vi.mocked(repo.setSalary);

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://127.0.0.1/api/jobs/salary', { method: 'POST', body: JSON.stringify(body) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getJobById.mockReturnValue({ id: 7 } as Job);
});

describe('POST /api/jobs/salary', () => {
  it('rejects a missing or non-numeric jobId with 400', async () => {
    const res = await post({ salary: '$100K' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing numeric "jobId"' });
    expect((await post({ jobId: '7', salary: '$100K' })).status).toBe(400);
  });

  it('returns 404 when the job does not exist', async () => {
    getJobById.mockReturnValue(undefined);
    const res = await post({ jobId: 7, salary: '$100K' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Job not found' });
    expect(setSalary).not.toHaveBeenCalled();
  });

  it('stores the trimmed salary', async () => {
    const res = await post({ jobId: 7, salary: '  $120K - $150K  ' });
    expect(await res.json()).toEqual({ ok: true, salary: '$120K - $150K' });
    expect(setSalary).toHaveBeenCalledWith(expect.anything(), 7, '$120K - $150K');
  });

  it.each([['empty', ''], ['whitespace', '   '], ['missing', undefined], ['non-string', 42]])(
    'clears the salary when the value is %s',
    async (_name, salary) => {
      const res = await post({ jobId: 7, salary });
      expect(await res.json()).toEqual({ ok: true, salary: null });
      expect(setSalary).toHaveBeenCalledWith(expect.anything(), 7, null);
    },
  );
});
