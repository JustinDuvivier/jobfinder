/**
 * runScoringBatch tests — the batch transport only: request construction
 * (custom_ids + real buildScoreRequest params), polling to `ended`, unordered
 * result matching by custom_id, the errored/truncated failure paths, and the
 * score_batch telemetry rows. Warm-first ordering, the title filter, and
 * threshold flagging are the shared loop's behavior, asserted once in
 * warm-first.test.ts. The Anthropic client is mocked; parse and build
 * functions are the real ones.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase, type DB } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { SCORING_MODEL } from '@/lib/ai/models';
import { makeTextMessage } from '@/lib/ai/mock-message';
import { CONFIG, RESULT, insertTestJob } from '@/lib/test-fixtures';

const { scoreJobMock, scoreJobOllamaMock, batchesCreate, batchesRetrieve, batchesResults } =
  vi.hoisted(() => ({
    scoreJobMock: vi.fn(),
    scoreJobOllamaMock: vi.fn(),
    batchesCreate: vi.fn(),
    batchesRetrieve: vi.fn(),
    batchesResults: vi.fn(),
  }));
vi.mock('@/lib/ai/score', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/score')>();
  return { ...actual, scoreJob: scoreJobMock };
});
vi.mock('@/lib/ai/ollama', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/ollama')>();
  return {
    ...actual,
    scoreJobOllama: scoreJobOllamaMock,
    ensureOllamaModel: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('@/lib/ai/client', () => ({
  getAnthropicClient: () => ({
    messages: {
      batches: { create: batchesCreate, retrieve: batchesRetrieve, results: batchesResults },
    },
  }),
}));

import { runScoringBatch, toCustomId, fromCustomId } from './batch';

/** A parseable model reply carrying the given score. */
const replyJson = (score: number) => `{"score": ${score}, "reasoning": "fits"}`;

async function* iterate<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

function succeeded(jobId: number, score: number, stop?: 'max_tokens') {
  return {
    custom_id: toCustomId(jobId),
    result: { type: 'succeeded' as const, message: makeTextMessage(replyJson(score), stop) },
  };
}

let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
  repo.upsertUserConfig(db, CONFIG);
  scoreJobMock.mockReset();
  scoreJobMock.mockResolvedValue(RESULT);
  scoreJobOllamaMock.mockReset();
  scoreJobOllamaMock.mockResolvedValue(RESULT);
  batchesCreate.mockReset();
  batchesRetrieve.mockReset();
  batchesResults.mockReset();
  batchesCreate.mockResolvedValue({ id: 'batch_1', processing_status: 'ended' });
  batchesResults.mockResolvedValue(iterate([]));
});

const insertJob = (jobId: string, title?: string) => insertTestJob(db, jobId, { title });

describe('runScoringBatch', () => {
  it('refuses the local backend before any scoring work: the Message Batches API is Anthropic-only', async () => {
    repo.upsertUserConfig(db, { ...CONFIG, scoringBackend: 'ollama' });
    const a = insertTestJob(db, 'j1', {});
    const b = insertTestJob(db, 'j2', {});

    // Fails loudly rather than silently falling back to Anthropic; the
    // sequential local scheduled path is ticket 04's work.
    await expect(runScoringBatch(db, { pollIntervalMs: 0 })).rejects.toThrow(
      /requires the Anthropic backend/,
    );

    // The refusal happens before the warm-first call: no job was scored — not
    // even the warm one — and every job stays `new` for the next run.
    expect(batchesCreate).not.toHaveBeenCalled();
    expect(scoreJobOllamaMock).not.toHaveBeenCalled();
    expect(repo.getJobById(db, a)?.status).toBe('new');
    expect(repo.getJobById(db, b)?.status).toBe('new');
  });

  it('submits one batch carrying the non-warm jobs with real scoring-request params', async () => {
    insertJob('j1'); // goes warm-first through the shared loop
    const b = insertJob('j2');
    const c = insertJob('j3');
    batchesResults.mockResolvedValue(iterate([succeeded(b, 70), succeeded(c, 55)]));

    const summary = await runScoringBatch(db, { pollIntervalMs: 0 });

    expect(batchesCreate).toHaveBeenCalledTimes(1);
    const { requests } = batchesCreate.mock.calls[0][0];
    expect(requests.map((r: { custom_id: string }) => r.custom_id)).toEqual([
      toCustomId(b),
      toCustomId(c),
    ]);
    for (const req of requests) {
      expect(req.params.model).toBe(SCORING_MODEL);
      expect(req.params.messages[0].content).toContain('Build things.');
    }

    expect(summary.scored).toBe(3);
    expect(summary.failed).toEqual([]);
    expect(repo.getJobById(db, b)?.status).toBe('scored');
    expect(repo.getJobById(db, c)?.status).toBe('scored');
  });

  it('polls until the batch has ended', async () => {
    insertJob('j1');
    const b = insertJob('j2');
    batchesCreate.mockResolvedValue({ id: 'batch_1', processing_status: 'in_progress' });
    batchesRetrieve
      .mockResolvedValueOnce({ id: 'batch_1', processing_status: 'in_progress' })
      .mockResolvedValueOnce({ id: 'batch_1', processing_status: 'ended' });
    batchesResults.mockResolvedValue(iterate([succeeded(b, 70)]));

    const summary = await runScoringBatch(db, { pollIntervalMs: 0 });

    expect(batchesRetrieve).toHaveBeenCalledTimes(2);
    expect(batchesRetrieve).toHaveBeenCalledWith('batch_1');
    expect(summary.scored).toBe(2);
  });

  it('matches unordered results by custom_id, never by position', async () => {
    insertJob('j1');
    const b = insertJob('j2');
    const c = insertTestJob(db, 'j3', { company: 'BestCo', title: 'Dev' });
    // Results arrive in reverse submission order with distinct scores.
    batchesResults.mockResolvedValue(iterate([succeeded(c, 91), succeeded(b, 42)]));

    const summary = await runScoringBatch(db, { pollIntervalMs: 0 });

    expect(repo.getJobById(db, b)?.score).toBe(42);
    expect(repo.getJobById(db, c)?.score).toBe(91);
    // Batch-settled results feed the scheduled-run toast tally too (FR-28):
    // the warm 80 and the batch 91 clear the 60 threshold; the 42 does not.
    expect(summary.notables.strongMatches).toBe(2);
    expect(summary.notables.bestStrong).toEqual({ company: 'BestCo', title: 'Dev', score: 91 });
  });

  it('treats errored results and truncated replies as failures, not scores', async () => {
    insertJob('j1');
    const b = insertJob('j2');
    const c = insertJob('j3');
    batchesResults.mockResolvedValue(
      iterate([
        { custom_id: toCustomId(b), result: { type: 'errored', error: { type: 'api_error' } } },
        succeeded(c, 88, 'max_tokens'), // truncation is an error, not a score (FR-7)
      ]),
    );

    const summary = await runScoringBatch(db, { pollIntervalMs: 0 });

    expect(summary.scored).toBe(1); // the warm-first job only
    expect(summary.failed.sort()).toEqual([b, c].sort());
    expect(repo.getJobById(db, b)?.status).toBe('new'); // still eligible for the next run
    expect(repo.getJobById(db, c)?.status).toBe('new');
  });

  it('records score_batch telemetry rows for batch results (FR-27)', async () => {
    insertJob('j1'); // warm-first — its telemetry lives inside scoreJob, mocked here
    const b = insertJob('j2');
    const c = insertJob('j3');
    batchesResults.mockResolvedValue(
      iterate([
        succeeded(b, 70),
        { custom_id: toCustomId(c), result: { type: 'errored', error: { type: 'api_error' } } },
      ]),
    );

    await runScoringBatch(db, { pollIntervalMs: 0 });

    const rows = db
      .prepare(`SELECT * FROM ai_calls WHERE call_type = 'score_batch' ORDER BY job_id`)
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0].job_id).toBe(b);
    expect(rows[0].error).toBeNull();
    expect(rows[0].stop_reason).toBe('end_turn');
    expect(rows[1].job_id).toBe(c);
    expect(rows[1].error).toBe('batch result errored');
    expect(rows[1].input_tokens).toBeNull();
  });

  it('skips results whose custom_id is not a job id', async () => {
    insertJob('j1');
    const b = insertJob('j2');
    batchesResults.mockResolvedValue(
      iterate([
        { custom_id: 'request-7', result: { type: 'succeeded', message: makeTextMessage(replyJson(99)) } },
        succeeded(b, 70),
      ]),
    );

    const summary = await runScoringBatch(db, { pollIntervalMs: 0 });

    expect(summary.scored).toBe(2);
    expect(summary.failed).toEqual([]);
    expect(repo.getJobById(db, b)?.score).toBe(70);
  });
});

describe('custom id round-trip', () => {
  it('encodes and decodes job row ids', () => {
    expect(fromCustomId(toCustomId(123))).toBe(123);
  });

  it('rejects foreign or malformed custom ids', () => {
    expect(fromCustomId('request-7')).toBeNull();
    expect(fromCustomId('job-')).toBeNull();
    expect(fromCustomId('job-abc')).toBeNull();
    expect(fromCustomId('job-1.5')).toBeNull();
  });
});
