/**
 * Tests for POST /api/open-folder — a thin mapper over the shared prologue and
 * the tested lib/fs/open-folder containment check. Pinned here: the request
 * contract (400 / 500-unconfigured / 404 / 400-no-pdf), that the path comes
 * from SQLite and the base directory from the environment (NFR-7 — never the
 * client), and that a containment failure maps to a 400 with the message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from '@/lib/types';
import * as repo from '@/lib/db/repo';
import { containedDir, openContainingFolder } from '@/lib/fs/open-folder';
import { POST } from './route';

vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('@/lib/db/repo', () => ({ getJobById: vi.fn() }));
vi.mock('@/lib/fs/open-folder', () => ({ openContainingFolder: vi.fn(), containedDir: vi.fn() }));

const getJobById = vi.mocked(repo.getJobById);
const mockedOpen = vi.mocked(openContainingFolder);
const mockedContainedDir = vi.mocked(containedDir);

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://127.0.0.1/api/open-folder', { method: 'POST', body: JSON.stringify(body) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('JOBFINDER_OUTPUT_DIR', 'C:\\out');
  getJobById.mockReturnValue({ id: 7, approvedPdfPath: 'C:\\out\\a\\resume.pdf' } as Job);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/open-folder', () => {
  it('rejects a missing or non-numeric jobId with 400', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing numeric "jobId"' });
  });

  it('returns 500 when the output directory is not configured', async () => {
    vi.stubEnv('JOBFINDER_OUTPUT_DIR', '');
    const res = await post({ jobId: 7 });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'JOBFINDER_OUTPUT_DIR is not configured' });
  });

  it('returns 404 when the job does not exist', async () => {
    getJobById.mockReturnValue(undefined);
    const res = await post({ jobId: 7 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Job not found' });
  });

  it('returns 400 when the job has no saved PDF', async () => {
    getJobById.mockReturnValue({ id: 7, approvedPdfPath: null } as Job);
    const res = await post({ jobId: 7 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Job has no saved PDF' });
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  it('opens the folder using the stored path and the server-side base directory', async () => {
    mockedOpen.mockReturnValue('C:\\out\\a');
    const res = await post({ jobId: 7, path: 'C:\\evil' });
    expect(mockedOpen).toHaveBeenCalledWith('C:\\out\\a\\resume.pdf', 'C:\\out');
    expect(await res.json()).toEqual({ opened: true, dir: 'C:\\out\\a' });
  });

  it('maps a containment/open failure to a 400 with the message', async () => {
    mockedOpen.mockImplementation(() => {
      throw new Error('Path escapes the output directory');
    });
    const res = await post({ jobId: 7 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Path escapes the output directory' });
  });
});

describe('POST /api/open-folder in container mode (JOBFINDER_CONTAINER=1)', () => {
  beforeEach(() => {
    vi.stubEnv('JOBFINDER_CONTAINER', '1');
  });

  it('never spawns a folder open; returns { opened: false } with the verified dir for copy-path', async () => {
    mockedContainedDir.mockReturnValue('C:\\out\\a');
    const res = await post({ jobId: 7 });
    expect(mockedOpen).not.toHaveBeenCalled();
    expect(mockedContainedDir).toHaveBeenCalledWith('C:\\out\\a\\resume.pdf', 'C:\\out');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ opened: false, dir: 'C:\\out\\a' });
  });

  it('still maps a containment failure to a 400 with the message', async () => {
    mockedContainedDir.mockImplementation(() => {
      throw new Error('Refusing to open a path outside the output directory');
    });
    const res = await post({ jobId: 7 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Refusing to open a path outside the output directory',
    });
  });

  it('still rejects a job with no saved PDF before touching the filesystem layer', async () => {
    getJobById.mockReturnValue({ id: 7, approvedPdfPath: null } as Job);
    const res = await post({ jobId: 7 });
    expect(res.status).toBe(400);
    expect(mockedContainedDir).not.toHaveBeenCalled();
    expect(mockedOpen).not.toHaveBeenCalled();
  });
});
