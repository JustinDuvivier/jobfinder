/**
 * runWarmFirstScoring tests — the one place warm-first ordering is asserted
 * (the transports in run.test.ts / batch.test.ts assume it). Also covers the
 * loop's shared behavior: the title filter running *before* any scoring call
 * (FR-4a), below-threshold flagging (FR-9a), the onScore/onError callbacks,
 * and the executor still running when the warm call fails. The Anthropic
 * client and scoreJob are mocked; we assert orchestration, never model output.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase, type DB } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { CONFIG, RESULT, insertTestJob } from '@/lib/test-fixtures';

// scoreJob / scoreJobOllama are the only AI calls; stub them per backend and
// keep the modules' request-building and parsing helpers real.
const { scoreJobMock, scoreJobOllamaMock, ensureOllamaModelMock, getClientMock } = vi.hoisted(
  () => ({
    scoreJobMock: vi.fn(),
    scoreJobOllamaMock: vi.fn(),
    ensureOllamaModelMock: vi.fn(),
    getClientMock: vi.fn(),
  }),
);
vi.mock('@/lib/ai/score', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/score')>();
  return { ...actual, scoreJob: scoreJobMock };
});
vi.mock('@/lib/ai/ollama', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/ollama')>();
  return { ...actual, scoreJobOllama: scoreJobOllamaMock, ensureOllamaModel: ensureOllamaModelMock };
});
vi.mock('@/lib/ai/client', () => ({ getAnthropicClient: getClientMock }));

import { runWarmFirstScoring, type ScoringExecutor } from './warm-first';

/** An executor that scores everything through the shared regular call. */
const scoreAll: ScoringExecutor = async (rest, exec) => {
  for (const job of rest) await exec.scoreOne(job);
};

let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
  repo.upsertUserConfig(db, CONFIG);
  scoreJobMock.mockReset();
  scoreJobMock.mockResolvedValue(RESULT);
  scoreJobOllamaMock.mockReset();
  scoreJobOllamaMock.mockResolvedValue(RESULT);
  ensureOllamaModelMock.mockReset();
  ensureOllamaModelMock.mockResolvedValue(undefined);
  getClientMock.mockReset();
  getClientMock.mockReturnValue({});
});

const insertJob = (jobId: string, title?: string) => insertTestJob(db, jobId, { title });

describe('warm-first ordering', () => {
  it('scores the first job alone with a regular call before the executor runs the rest', async () => {
    const a = insertJob('j1');
    const b = insertJob('j2');
    const c = insertJob('j3');

    const executor = vi.fn<ScoringExecutor>(async (rest) => {
      // By the time the transport gets the rest, the warm call has fully
      // completed (and persisted) — that is the whole point of the pattern.
      expect(scoreJobMock).toHaveBeenCalledTimes(1);
      expect(repo.getJobById(db, a)?.status).toBe('scored');
      expect(rest.map((j) => j.id)).toEqual([b, c]);
    });

    const summary = await runWarmFirstScoring(db, executor);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(summary.scored).toBe(1); // the warm job; the stub executor settles nothing
  });

  it('never invokes the executor when zero or one job is eligible', async () => {
    const executor = vi.fn<ScoringExecutor>(async () => {});

    let summary = await runWarmFirstScoring(db, executor);
    expect(summary.scored).toBe(0);
    expect(scoreJobMock).not.toHaveBeenCalled();

    insertJob('j1');
    summary = await runWarmFirstScoring(db, executor);
    expect(summary.scored).toBe(1); // warm-first call only
    expect(executor).not.toHaveBeenCalled();
  });

  it('still runs the executor when the warm-first call fails', async () => {
    const a = insertJob('j1');
    const b = insertJob('j2');
    scoreJobMock
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce(RESULT);

    const summary = await runWarmFirstScoring(db, scoreAll);

    expect(summary.failed).toEqual([a]);
    expect(summary.scored).toBe(1);
    expect(repo.getJobById(db, b)?.status).toBe('scored');
  });
});

describe('scoring-backend routing (FR-6)', () => {
  it('scores through the local Ollama model when the backend is ollama', async () => {
    repo.upsertUserConfig(db, { ...CONFIG, scoringBackend: 'ollama', ollamaModel: 'qwen3.5:9b' });
    insertJob('j1');

    const summary = await runWarmFirstScoring(db, scoreAll);

    expect(summary.scored).toBe(1);
    expect(ensureOllamaModelMock).toHaveBeenCalledWith('qwen3.5:9b');
    expect(scoreJobOllamaMock).toHaveBeenCalledWith('qwen3.5:9b', expect.anything(), expect.anything());
    expect(scoreJobMock).not.toHaveBeenCalled();
    expect(getClientMock).not.toHaveBeenCalled(); // no API key needed on the local backend
  });

  it('defaults to the local backend and model before Setup is ever saved', async () => {
    const fresh = openDatabase(':memory:'); // no user_config row at all
    insertTestJob(fresh, 'j1', {});

    await runWarmFirstScoring(fresh, scoreAll);

    expect(ensureOllamaModelMock).toHaveBeenCalledWith('batiai/qwen3.6-27b:iq3');
    expect(scoreJobOllamaMock).toHaveBeenCalledTimes(1);
  });

  it('keeps Anthropic scoring when the backend is anthropic', async () => {
    // The shared CONFIG fixture selects the anthropic backend.
    insertJob('j1');
    await runWarmFirstScoring(db, scoreAll);
    expect(scoreJobMock).toHaveBeenCalledTimes(1);
    expect(scoreJobOllamaMock).not.toHaveBeenCalled();
    expect(ensureOllamaModelMock).not.toHaveBeenCalled();
  });

  it('fails the whole run loudly when the local backend is unavailable — jobs stay new', async () => {
    repo.upsertUserConfig(db, { ...CONFIG, scoringBackend: 'ollama' });
    const a = insertJob('j1');
    ensureOllamaModelMock.mockRejectedValue(new Error('Ollama server unreachable'));

    await expect(runWarmFirstScoring(db, scoreAll)).rejects.toThrow(/unreachable/);

    expect(scoreJobOllamaMock).not.toHaveBeenCalled(); // no partial silent failure
    expect(repo.getJobById(db, a)?.status).toBe('new'); // rescored next run
  });
});

describe('settle and fail', () => {
  it('persists executor-settled results and flags below-threshold scores (FR-9a)', async () => {
    insertJob('j1');
    const b = insertJob('j2');

    await runWarmFirstScoring(db, async (rest, exec) => {
      exec.settle(rest[0]!.id, { ...RESULT, score: 30 }); // threshold is 60
    });

    const job = repo.getJobById(db, b);
    expect(job?.status).toBe('scored');
    expect(job?.score).toBe(30);
    expect(job?.belowThreshold).toBe(true);
  });

  it('never auto-filters a parked-for-review score, even above the threshold (FR-6a)', async () => {
    repo.upsertUserConfig(db, { ...CONFIG, scoreThreshold: 90 });
    insertJob('j1');
    const b = insertJob('j2');

    await runWarmFirstScoring(db, async (rest, exec) => {
      exec.settle(rest[0]!.id, { ...RESULT, score: 70, parkedForReview: true });
    });

    const job = repo.getJobById(db, b);
    expect(job?.score).toBe(70);
    expect(job?.belowThreshold).toBe(false); // parked jobs always reach the queue
  });

  it('streams onScore per settled job and onError per failure', async () => {
    insertJob('j1');
    const b = insertJob('j2');
    const c = insertJob('j3');
    const onScore = vi.fn();
    const onError = vi.fn();

    const summary = await runWarmFirstScoring(
      db,
      async (rest, exec) => {
        exec.settle(rest[0]!.id, RESULT);
        exec.fail(rest[1]!.id, 'truncated');
      },
      { onScore, onError },
    );

    expect(onScore).toHaveBeenCalledTimes(2); // warm job + settled job
    expect(onScore).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: b, score: 80, filtered: false }),
    );
    expect(onError).toHaveBeenCalledWith(c, 'truncated');
    expect(summary.scored).toBe(2);
    expect(summary.failed).toEqual([c]);
  });

  it('tallies this run\'s notables — warm and executor-settled alike — for the scheduled toast (FR-28)', async () => {
    // Threshold is 60 (shared CONFIG). Warm job scores 80; the executor
    // settles a 91 (the batch path's avenue) and a below-threshold 40.
    insertTestJob(db, 'j1', { company: 'WarmCo', title: 'Engineer' });
    const b = insertTestJob(db, 'j2', { company: 'BestCo', title: 'Dev' });
    const c = insertTestJob(db, 'j3', {});

    const summary = await runWarmFirstScoring(db, async (rest, exec) => {
      exec.settle(b, { ...RESULT, score: 91 });
      exec.settle(c, { ...RESULT, score: 40 });
    });

    expect(summary.notables).toEqual({
      strongMatches: 2, // the 40 is below the threshold — not notable
      bestStrong: { company: 'BestCo', title: 'Dev', score: 91 },
      parkedForReview: 0,
      firstParked: null,
    });
  });

  it('tallies FR-6a parks separately from strong matches, whatever the threshold', async () => {
    repo.upsertUserConfig(db, { ...CONFIG, scoreThreshold: 90 });
    insertTestJob(db, 'j1', {}); // warm job scores 80 — below the 90 threshold
    const b = insertTestJob(db, 'j2', { company: 'ParkedCo', title: 'Analyst' });

    const summary = await runWarmFirstScoring(db, async (rest, exec) => {
      exec.settle(b, { ...RESULT, score: 70, parkedForReview: true });
    });

    // The park counts even though 70 < 90; nothing counts as strong.
    expect(summary.notables).toEqual({
      strongMatches: 0,
      bestStrong: null,
      parkedForReview: 1,
      firstParked: { company: 'ParkedCo', title: 'Analyst' },
    });
  });
});

describe('title filter (FR-4a)', () => {
  it('drops excluded titles before scoring and never calls the model for them', async () => {
    const seniorId = insertJob('j1', 'Senior Engineer');
    const okId = insertJob('j2', 'Engineer');

    const summary = await runWarmFirstScoring(db, scoreAll);

    // The over-senior title is gone and was never scored.
    expect(repo.getJobById(db, seniorId)).toBeUndefined();
    expect(summary.titleFiltered).toBe(1);
    expect(scoreJobMock).toHaveBeenCalledTimes(1);

    // The eligible job was scored.
    expect(summary.scored).toBe(1);
    expect(repo.getJobById(db, okId)?.status).toBe('scored');
  });

  it('whole-word matches only — "Leadership" is not excluded by "lead"', async () => {
    repo.upsertUserConfig(db, { ...CONFIG, excludedTitleTerms: ['lead'] });
    insertJob('j1', 'Leadership Programs Engineer');

    const summary = await runWarmFirstScoring(db, scoreAll);

    expect(summary.titleFiltered).toBe(0);
    expect(summary.scored).toBe(1);
    expect(scoreJobMock).toHaveBeenCalledTimes(1);
  });

  it('scores every job when no exclusion terms are configured', async () => {
    repo.upsertUserConfig(db, { ...CONFIG, excludedTitleTerms: [] });
    insertJob('j1', 'Senior Engineer');
    insertJob('j2', 'Staff Engineer');

    const summary = await runWarmFirstScoring(db, scoreAll);

    expect(summary.titleFiltered).toBe(0);
    expect(summary.scored).toBe(2);
  });

  it('scores only the requested jobIds when given', async () => {
    insertJob('j1');
    const b = insertJob('j2');

    const summary = await runWarmFirstScoring(db, scoreAll, { jobIds: [b] });

    expect(summary.scored).toBe(1);
    expect(scoreJobMock).toHaveBeenCalledTimes(1);
    expect(repo.getJobById(db, b)?.status).toBe('scored');
  });
});
