/**
 * Tests for POST /api/autosave — the route is a thin boundary over the repo
 * write. Pinned here: the request contract (400/404), that editing is gated by
 * the canEdit guard (409 with the documented error shape for every
 * non-rewriting status), and that a valid autosave appends a version row,
 * updates the denormalized LaTeX, and recomputes the persisted diff — all
 * inside the db.transaction wrapper (the mock flags each write with whether a
 * transaction was open), so resume_changes stays live with the document.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JOB_STATUSES } from '@/lib/types';
import type { Job } from '@/lib/types';
import * as repo from '@/lib/db/repo';
import { refreshResumeDiff } from '@/lib/diff/persist';
import { POST } from './route';

// Tracks the transaction boundary: the mocked db.transaction sets
// `inTransaction` while the wrapped callback runs, and each mocked repo write
// records the flag, so a write escaping the transaction fails the test.
const tx = vi.hoisted(() => ({
  inTransaction: false,
  writes: [] as Array<[name: string, inTransaction: boolean]>,
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({
    transaction: (fn: () => void) => () => {
      tx.inTransaction = true;
      try {
        fn();
      } finally {
        tx.inTransaction = false;
      }
    },
  })),
}));
vi.mock('@/lib/db/repo', () => ({
  getJobById: vi.fn(),
  appendRewriteVersion: vi.fn(() => tx.writes.push(['appendRewriteVersion', tx.inTransaction])),
  setRewrittenLatex: vi.fn(() => tx.writes.push(['setRewrittenLatex', tx.inTransaction])),
}));
vi.mock('@/lib/diff/persist', () => ({
  refreshResumeDiff: vi.fn(() => tx.writes.push(['refreshResumeDiff', tx.inTransaction])),
}));

const getJobById = vi.mocked(repo.getJobById);
const appendRewriteVersion = vi.mocked(repo.appendRewriteVersion);
const setRewrittenLatex = vi.mocked(repo.setRewrittenLatex);
const refreshResumeDiffMock = vi.mocked(refreshResumeDiff);

function job(overrides: Partial<Job> = {}): Job {
  return { id: 7, status: 'rewriting', ...overrides } as Job;
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://127.0.0.1/api/autosave', { method: 'POST', body: JSON.stringify(body) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  tx.inTransaction = false;
  tx.writes = [];
});

describe('POST /api/autosave', () => {
  it('rejects a missing or mistyped jobId/latex with 400', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ jobId: '7', latex: 'x' })).status).toBe(400);
    expect((await post({ jobId: 7 })).status).toBe(400);
  });

  it('returns 404 when the job does not exist', async () => {
    getJobById.mockReturnValue(undefined);
    expect((await post({ jobId: 7, latex: 'x' })).status).toBe(404);
  });

  it.each(JOB_STATUSES.filter((s) => s !== 'rewriting'))(
    'returns 409 with the documented error shape for a job in %s',
    async (status) => {
      getJobById.mockReturnValue(job({ status }));

      const res = await post({ jobId: 7, latex: 'x' });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: `Cannot edit a job in status "${status}"` });
      expect(appendRewriteVersion).not.toHaveBeenCalled();
      expect(setRewrittenLatex).not.toHaveBeenCalled();
      expect(refreshResumeDiffMock).not.toHaveBeenCalled();
    },
  );

  it('appends an autosave version, updates the denormalized LaTeX, and refreshes the persisted diff in one transaction', async () => {
    getJobById.mockReturnValue(job());

    const res = await post({ jobId: 7, latex: '\\section{Edited}' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(appendRewriteVersion).toHaveBeenCalledWith(
      expect.anything(),
      7,
      '\\section{Edited}',
      'autosave',
    );
    expect(setRewrittenLatex).toHaveBeenCalledWith(expect.anything(), 7, '\\section{Edited}');
    // resume_changes is recomputed for the edited document, so the Changes
    // panel and /api/explain describe the LaTeX as it stands now (FR-13).
    expect(refreshResumeDiffMock).toHaveBeenCalledWith(expect.anything(), 7, '\\section{Edited}');
    // All three writes happened, and none escaped the transaction.
    expect(tx.writes).toEqual([
      ['appendRewriteVersion', true],
      ['setRewrittenLatex', true],
      ['refreshResumeDiff', true],
    ]);
  });
});
