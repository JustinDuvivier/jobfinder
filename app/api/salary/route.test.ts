/**
 * Tests for POST /api/salary — the route is a thin boundary over the salary
 * resolver. Pinned here: the request/response contract, that the field tier
 * reports the stored value verbatim and never persists, that newly found
 * values (description, AI) do persist, and that an AI-tier failure maps to
 * a 502. The precedence itself is tested in lib/salary.test.ts; the AI call
 * itself in lib/ai/salary.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from '@/lib/types';
import * as repo from '@/lib/db/repo';
import { lookupSalary } from '@/lib/ai/salary';
import { POST } from './route';

vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('@/lib/db/repo', () => ({ getJobById: vi.fn(), setSalary: vi.fn() }));
vi.mock('@/lib/ai/client', () => ({ getAnthropicClient: vi.fn(() => ({})) }));
vi.mock('@/lib/ai/salary', () => ({ lookupSalary: vi.fn() }));

const getJobById = vi.mocked(repo.getJobById);
const setSalary = vi.mocked(repo.setSalary);
const mockedLookup = vi.mocked(lookupSalary);

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 7,
    title: 'AI Engineer',
    company: 'Stripe',
    location: 'New York, NY',
    salary: null,
    description: null,
    ...overrides,
  } as Job;
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://127.0.0.1/api/salary', { method: 'POST', body: JSON.stringify(body) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/salary', () => {
  it('rejects a missing or non-numeric jobId with 400', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ jobId: '7' })).status).toBe(400);
  });

  it('returns 404 when the job does not exist', async () => {
    getJobById.mockReturnValue(undefined);
    expect((await post({ jobId: 7 })).status).toBe(404);
  });

  it('reports an already-stored salary verbatim without persisting or calling the AI', async () => {
    getJobById.mockReturnValue(job({ salary: '$120K - $150K per year' }));

    const res = await post({ jobId: 7 });

    expect(await res.json()).toEqual({ salary: '$120K - $150K per year', source: 'field' });
    expect(setSalary).not.toHaveBeenCalled();
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('persists a salary mined from the description without calling the AI', async () => {
    getJobById.mockReturnValue(
      job({ description: 'The base salary range is $140,000 - $175,000 per year.' }),
    );

    const res = await post({ jobId: 7 });

    expect(await res.json()).toEqual({ salary: '$140,000 – $175,000', source: 'description' });
    expect(setSalary).toHaveBeenCalledWith(expect.anything(), 7, '$140,000 – $175,000');
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('falls back to the AI lookup and persists its normalized value', async () => {
    getJobById.mockReturnValue(job());
    mockedLookup.mockResolvedValue({ salary: '$120,000 - $150,000 per year', found: true });

    const res = await post({ jobId: 7 });

    expect(await res.json()).toEqual({ salary: '$120,000 – $150,000', source: 'ai' });
    expect(setSalary).toHaveBeenCalledWith(expect.anything(), 7, '$120,000 – $150,000');
  });

  it('returns none and persists nothing when the AI finds nothing', async () => {
    getJobById.mockReturnValue(job());
    mockedLookup.mockResolvedValue({ salary: null, found: false });

    const res = await post({ jobId: 7 });

    expect(await res.json()).toEqual({ salary: null, source: 'none' });
    expect(setSalary).not.toHaveBeenCalled();
  });

  it('maps an AI-tier failure to a 502', async () => {
    getJobById.mockReturnValue(job());
    mockedLookup.mockRejectedValue(new Error('web search unavailable'));

    const res = await post({ jobId: 7 });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'web search unavailable' });
    expect(setSalary).not.toHaveBeenCalled();
  });
});
