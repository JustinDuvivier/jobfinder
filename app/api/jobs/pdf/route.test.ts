/**
 * Tests for GET /api/jobs/pdf — the FR-35 approved-PDF stream. Pinned here:
 * the request contract (400 bad id / 500 unconfigured / 404 no job / 404 no
 * approved PDF / 404 file gone), that the path comes from SQLite and the base
 * directory from the environment (NFR-7 — never the client), that a stored
 * path escaping the base is rejected without touching the disk (real
 * `isWithinBase`, not a mock), and the success headers + bytes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import type { Job } from '@/lib/types';
import * as repo from '@/lib/db/repo';
import { GET } from './route';

vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('@/lib/db/repo', () => ({ getJobById: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

const getJobById = vi.mocked(repo.getJobById);
const mockedReadFile = vi.mocked(readFile);

const BASE = resolve(tmpdir(), 'jobfinder-out');
const PDF_PATH = join(BASE, '20260618', 'Stripe_AI_Engineer_a1b2c3', 'Alex_Candidate_Resume.pdf');
const PDF_BYTES = Buffer.from('%PDF-1.5 fake body');

function get(query: string): Promise<Response> {
  return GET(new Request(`http://127.0.0.1/api/jobs/pdf${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('JOBFINDER_OUTPUT_DIR', BASE);
  getJobById.mockReturnValue({ id: 7, approvedPdfPath: PDF_PATH } as Job);
  mockedReadFile.mockResolvedValue(PDF_BYTES);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/jobs/pdf', () => {
  it('streams the approved PDF inline with the pdf content type and the exact bytes', async () => {
    const res = await get('?jobId=7');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toBe(
      'inline; filename="Alex_Candidate_Resume.pdf"',
    );
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PDF_BYTES);
    // The path read from disk is the SQLite-stored one — never the request's.
    expect(mockedReadFile).toHaveBeenCalledWith(PDF_PATH);
  });

  it('rejects a missing or non-numeric jobId with 400 before any lookup', async () => {
    for (const query of ['', '?jobId=', '?jobId=abc', '?jobId=7.5']) {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Missing numeric "jobId"' });
    }
    expect(getJobById).not.toHaveBeenCalled();
  });

  it('ignores any client-supplied path parameter and serves only the stored path', async () => {
    const res = await get(`?jobId=7&path=${encodeURIComponent('C:\\evil\\x.pdf')}`);
    expect(res.status).toBe(200);
    expect(mockedReadFile).toHaveBeenCalledWith(PDF_PATH);
  });

  it('returns 500 when the output directory is not configured', async () => {
    vi.stubEnv('JOBFINDER_OUTPUT_DIR', '');
    const res = await get('?jobId=7');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'JOBFINDER_OUTPUT_DIR is not configured' });
  });

  it('returns 404 when the job does not exist', async () => {
    getJobById.mockReturnValue(undefined);
    const res = await get('?jobId=7');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Job not found' });
  });

  it('returns 404 when the job has no approved PDF, without touching the disk', async () => {
    getJobById.mockReturnValue({ id: 7, approvedPdfPath: null } as Job);
    const res = await get('?jobId=7');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Job has no approved PDF' });
    expect(mockedReadFile).not.toHaveBeenCalled();
  });

  it('refuses to stream a stored path that escapes the output directory (real containment check)', async () => {
    getJobById.mockReturnValue({
      id: 7,
      approvedPdfPath: join(BASE, '..', 'secret', 'passwords.pdf'),
    } as Job);
    const res = await get('?jobId=7');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Refusing to serve a path outside the output directory',
    });
    expect(mockedReadFile).not.toHaveBeenCalled();
  });

  it('refuses a sibling directory that merely shares the base prefix', async () => {
    getJobById.mockReturnValue({
      id: 7,
      approvedPdfPath: resolve(tmpdir(), 'jobfinder-out-other', 'r.pdf'),
    } as Job);
    const res = await get('?jobId=7');
    expect(res.status).toBe(400);
    expect(mockedReadFile).not.toHaveBeenCalled();
  });

  it('returns 404 when the approved PDF is missing from disk', async () => {
    mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const res = await get('?jobId=7');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Approved PDF not found on disk' });
  });
});
