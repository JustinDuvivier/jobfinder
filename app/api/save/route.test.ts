/**
 * Tests for POST /api/save — a thin mapper from the approval orchestrator's
 * discriminated result to HTTP responses (the saga itself is tested in
 * lib/approval/orchestrator.test.ts). Pinned here: the request contract
 * (400 / 500-unconfigured), the identifier-only input (NFR-7 — baseDir comes
 * from the environment, never the client), and the status code and error
 * string for every result kind.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { approveAndSave } from '@/lib/approval/orchestrator';
import { POST } from './route';

vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('@/lib/approval/orchestrator', () => ({ approveAndSave: vi.fn() }));

const mockedApprove = vi.mocked(approveAndSave);

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://127.0.0.1/api/save', { method: 'POST', body: JSON.stringify(body) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('JOBFINDER_OUTPUT_DIR', 'C:\\out');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/save', () => {
  it('rejects a missing or non-numeric jobId with 400', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing numeric "jobId"' });
    expect(mockedApprove).not.toHaveBeenCalled();
  });

  it('returns 500 when the output directory is not configured', async () => {
    vi.stubEnv('JOBFINDER_OUTPUT_DIR', '');
    const res = await post({ jobId: 7 });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'JOBFINDER_OUTPUT_DIR is not configured' });
    expect(mockedApprove).not.toHaveBeenCalled();
  });

  it('passes only the identifier and the server-side base directory to the saga', async () => {
    mockedApprove.mockResolvedValue({
      kind: 'approved',
      savedPath: 'C:\\out\\x.pdf',
      relativePath: 'x.pdf',
    } as never);

    const res = await post({ jobId: 7, baseDir: 'C:\\evil' });

    expect(mockedApprove).toHaveBeenCalledWith(expect.anything(), {
      jobId: 7,
      baseDir: 'C:\\out',
    });
    expect(await res.json()).toEqual({
      status: 'approved',
      savedPath: 'C:\\out\\x.pdf',
      relativePath: 'x.pdf',
    });
  });

  it.each([
    ['job-not-found', {}, 404, 'Job not found'],
    ['invalid-status', { status: 'passed' }, 409, 'Cannot approve a job in status "passed"'],
    ['no-latex', {}, 400, 'No rewritten resume to approve'],
    ['compile-error', { log: 'boom' }, 400, 'LaTeX failed to compile'],
    ['compile-failed', {}, 500, 'Compile failed'],
    [
      'not-one-page',
      { pageCount: 2 },
      422,
      'Resume must be exactly one page (it is 2). Trim it and try again.',
    ],
    ['write-failed', {}, 500, 'Failed to write the PDF to disk'],
    ['db-failed', {}, 500, 'Saved the PDF but failed to record the approval'],
  ])('maps a %s result to its documented response', async (kind, extra, status, error) => {
    mockedApprove.mockResolvedValue({ kind, ...extra } as never);

    const res = await post({ jobId: 7 });

    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error });
  });
});
