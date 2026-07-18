/**
 * runScoring tests — the interactive transport only: every remaining job goes
 * through the shared regular call via the pool, results stream progressively
 * over onScore/onError, and failures land in the summary. Warm-first ordering,
 * the title filter, and threshold flagging are the shared loop's behavior,
 * asserted once in warm-first.test.ts. The Anthropic client and scoreJob are
 * mocked; we assert orchestration, never model output.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase, type DB } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { CONFIG, RESULT, insertTestJob } from '@/lib/test-fixtures';

// scoreJob is the only AI call; stub it and keep the module's request-building
// and parsing helpers real.
const { scoreJobMock } = vi.hoisted(() => ({ scoreJobMock: vi.fn() }));
vi.mock('@/lib/ai/score', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/score')>();
  return { ...actual, scoreJob: scoreJobMock };
});
vi.mock('@/lib/ai/client', () => ({ getAnthropicClient: () => ({}) }));

import { runScoring } from './run';

let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
  repo.upsertUserConfig(db, CONFIG);
  scoreJobMock.mockReset();
  scoreJobMock.mockResolvedValue(RESULT);
});

const insertJob = (jobId: string, title?: string) => insertTestJob(db, jobId, { title });

describe('runScoring', () => {
  it('scores every eligible job with a regular call and persists each score', async () => {
    const ids = [insertJob('j1'), insertJob('j2'), insertJob('j3')];

    const summary = await runScoring(db);

    expect(scoreJobMock).toHaveBeenCalledTimes(3);
    expect(summary.scored).toBe(3);
    expect(summary.failed).toEqual([]);
    for (const id of ids) {
      expect(repo.getJobById(db, id)?.status).toBe('scored');
    }
  });

  it('streams onScore per job and collects failures via onError (FR-8)', async () => {
    insertJob('j1');
    const b = insertJob('j2');
    const c = insertJob('j3', 'Platform Engineer');
    // The pool call for job c fails; the others score.
    scoreJobMock.mockImplementation(async (_client, input: { jobDescription: string }) => {
      if (input.jobDescription.includes('Platform Engineer')) throw new Error('rate limited');
      return RESULT;
    });
    const onScore = vi.fn();
    const onError = vi.fn();

    const summary = await runScoring(db, { onScore, onError });

    expect(onScore).toHaveBeenCalledTimes(2);
    expect(onScore).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: b, score: 80, filtered: false }),
    );
    expect(onError).toHaveBeenCalledWith(c, 'rate limited');
    expect(summary.scored).toBe(2);
    expect(summary.failed).toEqual([c]);
    expect(repo.getJobById(db, c)?.status).toBe('new'); // still eligible for retry
  });

  it('scores only the requested jobIds when given', async () => {
    insertJob('j1');
    const b = insertJob('j2');

    const summary = await runScoring(db, { jobIds: [b] });

    expect(scoreJobMock).toHaveBeenCalledTimes(1);
    expect(summary.scored).toBe(1);
    expect(repo.getJobById(db, b)?.status).toBe('scored');
  });
});
