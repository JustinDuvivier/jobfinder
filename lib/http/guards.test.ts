/**
 * Tests for the shared route prologue (lib/http/guards): the jobId parse →
 * 400 and job lookup → 404 shaping that the job-scoped routes repeat, and the
 * output-directory check shared by /api/save and /api/open-folder. The exact
 * status codes and error strings are the routes' public contract — they are
 * pinned here once instead of implicitly per route.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from '@/lib/types';
import type { DB } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { requireJobId, lookupJob, requireJob, requireOutputDir } from './guards';

vi.mock('@/lib/db/repo', () => ({ getJobById: vi.fn() }));

const getJobById = vi.mocked(repo.getJobById);
const db = {} as DB;

function post(body: unknown): Request {
  return new Request('http://127.0.0.1/api/test', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireJobId', () => {
  it('rejects a missing, mistyped, or absent-body jobId with 400 and the standard error', async () => {
    for (const req of [post({}), post({ jobId: '7' }), post({ jobId: null }), post('not json')]) {
      const result = await requireJobId(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(400);
        expect(await result.response.json()).toEqual({ error: 'Missing numeric "jobId"' });
      }
    }
  });

  it('rejects with a caller-supplied error string when one is given', async () => {
    const result = await requireJobId(post({}), 'Missing "jobId" (number) and "latex" (string)');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(await result.response.json()).toEqual({
        error: 'Missing "jobId" (number) and "latex" (string)',
      });
    }
  });

  it('returns the jobId and the parsed body so routes can read their extra fields', async () => {
    const result = await requireJobId(post({ jobId: 7, latex: '\\x' }));
    expect(result).toMatchObject({ ok: true, jobId: 7, body: { jobId: 7, latex: '\\x' } });
  });
});

describe('lookupJob', () => {
  it('rejects a missing job with 404 and the standard error', async () => {
    getJobById.mockReturnValue(undefined);
    const result = lookupJob(db, 7);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(404);
      expect(await result.response.json()).toEqual({ error: 'Job not found' });
    }
  });

  it('returns the job when it exists', () => {
    const job = { id: 7, title: 'AI Engineer' } as Job;
    getJobById.mockReturnValue(job);
    expect(lookupJob(db, 7)).toEqual({ ok: true, job });
    expect(getJobById).toHaveBeenCalledWith(db, 7);
  });
});

describe('requireJob', () => {
  it('rejects a bad jobId with 400 before touching the database', async () => {
    const result = await requireJob(post({}), db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
    expect(getJobById).not.toHaveBeenCalled();
  });

  it('rejects a missing job with 404', async () => {
    getJobById.mockReturnValue(undefined);
    const result = await requireJob(post({ jobId: 7 }), db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
  });

  it('returns jobId, job, and body on the happy path', async () => {
    const job = { id: 7 } as Job;
    getJobById.mockReturnValue(job);
    const result = await requireJob(post({ jobId: 7, salary: '$1' }), db);
    expect(result).toEqual({ ok: true, jobId: 7, job, body: { jobId: 7, salary: '$1' } });
  });
});

describe('requireOutputDir', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects with 500 and the standard error when the variable is unset or empty', async () => {
    for (const value of [undefined, '']) {
      vi.stubEnv('JOBFINDER_OUTPUT_DIR', value as string);
      const result = requireOutputDir();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(500);
        expect(await result.response.json()).toEqual({
          error: 'JOBFINDER_OUTPUT_DIR is not configured',
        });
      }
    }
  });

  it('returns the configured base directory', () => {
    vi.stubEnv('JOBFINDER_OUTPUT_DIR', 'C:\\out');
    expect(requireOutputDir()).toEqual({ ok: true, baseDir: 'C:\\out' });
  });
});
