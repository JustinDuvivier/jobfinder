/**
 * Tests for POST /api/explain — the route is a thin boundary over the explain
 * call. Pinned here: the request/response contract, and the FR-13/FR-14
 * consistency guarantee — the explainer receives exactly the persisted
 * resume_changes blocks the Changes panel renders, so the "why" is always
 * about the recorded "what". The prompt assembly itself is tested in
 * lib/ai/explain.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from '@/lib/types';
import type { DiffBlock } from '@/lib/diff';
import * as repo from '@/lib/db/repo';
import { explainChanges } from '@/lib/ai/explain';
import { describeJob } from '@/lib/jobs/describe';
import { POST } from './route';

vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('@/lib/db/repo', () => ({
  getJobById: vi.fn(),
  getResumeChanges: vi.fn(),
  setExplanation: vi.fn(),
}));
vi.mock('@/lib/ai/client', () => ({ getAnthropicClient: vi.fn(() => ({})) }));
vi.mock('@/lib/ai/explain', () => ({ explainChanges: vi.fn() }));

const getJobById = vi.mocked(repo.getJobById);
const getResumeChanges = vi.mocked(repo.getResumeChanges);
const setExplanation = vi.mocked(repo.setExplanation);
const mockedExplain = vi.mocked(explainChanges);

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 7,
    title: 'AI Engineer',
    company: 'Stripe',
    location: 'New York, NY',
    rewrittenLatex: '\\documentclass{article}',
    ...overrides,
  } as Job;
}

// A markup-only edit: bolding a metric is a recorded change and must reach
// the explainer even though a plain-text rendering would erase it.
const CHANGES: DiffBlock[] = [
  { blockType: 'equal', content: 'Cut p99 latency by ', seq: 0 },
  { blockType: 'insert', content: '\\textbf{', seq: 1 },
  { blockType: 'equal', content: '40%', seq: 2 },
  { blockType: 'insert', content: '}', seq: 3 },
];

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://127.0.0.1/api/explain', { method: 'POST', body: JSON.stringify(body) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/explain', () => {
  it('rejects a missing or non-numeric jobId with 400', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ jobId: '7' })).status).toBe(400);
  });

  it('returns 404 when the job does not exist', async () => {
    getJobById.mockReturnValue(undefined);
    expect((await post({ jobId: 7 })).status).toBe(404);
  });

  it('returns 400 when the job has no rewritten resume', async () => {
    getJobById.mockReturnValue(job({ rewrittenLatex: null }));
    expect((await post({ jobId: 7 })).status).toBe(400);
    expect(mockedExplain).not.toHaveBeenCalled();
  });

  // A rewrite that lands identical to the base resume is a valid outcome, not
  // an error: the route answers with a benign 200 so the client's post-stream
  // auto-explain renders an empty state instead of an error banner.
  it('returns 200 {noChanges: true} when the recorded diff has no edits, without calling the AI', async () => {
    getJobById.mockReturnValue(job());
    getResumeChanges.mockReturnValue([{ blockType: 'equal', content: 'same', seq: 0 }]);

    const res = await post({ jobId: 7 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ noChanges: true });
    expect(mockedExplain).not.toHaveBeenCalled();
  });

  it('returns 200 {noChanges: true} when no diff rows are persisted at all', async () => {
    getJobById.mockReturnValue(job());
    getResumeChanges.mockReturnValue([]);

    const res = await post({ jobId: 7 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ noChanges: true });
    expect(mockedExplain).not.toHaveBeenCalled();
  });

  // FR-13/FR-14 consistency: with nothing recorded to explain, a rationale
  // from an earlier generation is stale and must not survive a reload.
  it('clears any stored explanation when there is nothing to explain', async () => {
    getJobById.mockReturnValue(job({ explanation: '{"summary":"old","bullets":[]}' }));
    getResumeChanges.mockReturnValue([{ blockType: 'equal', content: 'same', seq: 0 }]);

    await post({ jobId: 7 });

    expect(setExplanation).toHaveBeenCalledWith(expect.anything(), 7, null);
  });

  it('skips the clearing write when no explanation is stored (no updated_at bump)', async () => {
    getJobById.mockReturnValue(job({ explanation: null }));
    getResumeChanges.mockReturnValue([{ blockType: 'equal', content: 'same', seq: 0 }]);

    const res = await post({ jobId: 7 });

    expect(res.status).toBe(200);
    expect(setExplanation).not.toHaveBeenCalled();
  });

  it('feeds the explainer exactly the persisted diff blocks the Changes panel renders', async () => {
    const theJob = job();
    getJobById.mockReturnValue(theJob);
    getResumeChanges.mockReturnValue(CHANGES);
    mockedExplain.mockResolvedValue({ summary: 's', bullets: ['b'] });

    const res = await post({ jobId: 7 });

    expect(res.status).toBe(200);
    expect(mockedExplain).toHaveBeenCalledWith(
      expect.anything(),
      { changes: CHANGES, jobDescription: describeJob(theJob) },
      expect.objectContaining({ jobId: 7 }),
    );
  });

  it('persists the explanation as JSON on the job and returns it', async () => {
    getJobById.mockReturnValue(job());
    getResumeChanges.mockReturnValue(CHANGES);
    mockedExplain.mockResolvedValue({ summary: 's', bullets: ['b'] });

    const res = await post({ jobId: 7 });

    expect(await res.json()).toEqual({ summary: 's', bullets: ['b'] });
    expect(setExplanation).toHaveBeenCalledWith(
      expect.anything(),
      7,
      JSON.stringify({ summary: 's', bullets: ['b'] }),
    );
  });

  it('maps an explain failure to a 502 and persists nothing', async () => {
    getJobById.mockReturnValue(job());
    getResumeChanges.mockReturnValue(CHANGES);
    mockedExplain.mockRejectedValue(new Error('overloaded'));

    const res = await post({ jobId: 7 });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'overloaded' });
    expect(setExplanation).not.toHaveBeenCalled();
  });
});
