/**
 * runScheduledScoring tests — the backend routing of the scheduler's scoring
 * path: the local default runs the sequential warm-first loop (every job
 * scored through scoreJobOllama, one at a time, no Anthropic batch endpoints),
 * the Anthropic backend keeps the Message Batches transport, and a mid-run
 * failure leaves the affected job `new` while the rest still score. The AI
 * calls and the Anthropic client are mocked; orchestration is real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase, type DB } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { CONFIG, RESULT, insertTestJob } from '@/lib/test-fixtures';

const { scoreJobMock, scoreJobOllamaMock, ensureOllamaModelMock, batchesCreate, batchesResults } =
  vi.hoisted(() => ({
    scoreJobMock: vi.fn(),
    scoreJobOllamaMock: vi.fn(),
    ensureOllamaModelMock: vi.fn(),
    batchesCreate: vi.fn(),
    batchesResults: vi.fn(),
  }));
vi.mock('@/lib/ai/score', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/score')>();
  return { ...actual, scoreJob: scoreJobMock };
});
vi.mock('@/lib/ai/ollama', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/ollama')>();
  return { ...actual, scoreJobOllama: scoreJobOllamaMock, ensureOllamaModel: ensureOllamaModelMock };
});
vi.mock('@/lib/ai/client', () => ({
  getAnthropicClient: () => ({
    messages: {
      batches: {
        create: batchesCreate,
        retrieve: vi.fn(),
        results: batchesResults,
      },
    },
  }),
}));

import { runScheduledScoring } from './scheduled';

async function* iterate<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
  scoreJobMock.mockReset().mockResolvedValue(RESULT);
  scoreJobOllamaMock.mockReset().mockResolvedValue(RESULT);
  ensureOllamaModelMock.mockReset().mockResolvedValue(undefined);
  batchesCreate.mockReset().mockResolvedValue({ id: 'batch_1', processing_status: 'ended' });
  batchesResults.mockReset().mockResolvedValue(iterate([]));
});

describe('runScheduledScoring on the local backend (the default)', () => {
  beforeEach(() => {
    repo.upsertUserConfig(db, { ...CONFIG, scoringBackend: 'ollama' });
  });

  it('scores every new job through the local model, one at a time, with no batch endpoints', async () => {
    const ids = [insertTestJob(db, 'j1', {}), insertTestJob(db, 'j2', {}), insertTestJob(db, 'j3', {})];
    let inFlight = 0;
    let maxInFlight = 0;
    scoreJobOllamaMock.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return RESULT;
    });

    const summary = await runScheduledScoring(db);

    expect(summary.scored).toBe(3);
    expect(scoreJobOllamaMock).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1); // strictly sequential — the GPU sets the pace
    expect(batchesCreate).not.toHaveBeenCalled();
    for (const id of ids) expect(repo.getJobById(db, id)?.status).toBe('scored');
    // The summary carries this run's notables for the scheduled toast (FR-28):
    // all three scored 80 against the 60 threshold.
    expect(summary.notables.strongMatches).toBe(3);
    expect(summary.notables.bestStrong).toEqual({ company: 'Acme', title: 'Engineer', score: 80 });
  });

  it('ledgers each call like the interactive path (the telemetry context is passed through)', async () => {
    const a = insertTestJob(db, 'j1', {});
    await runScheduledScoring(db);
    expect(scoreJobOllamaMock).toHaveBeenCalledWith(
      CONFIG.ollamaModel,
      expect.anything(),
      { db, jobId: a },
    );
  });

  it('a mid-run failure leaves that job new while the rest still score', async () => {
    insertTestJob(db, 'j1', {}); // warm-first job
    const b = insertTestJob(db, 'j2', {});
    const c = insertTestJob(db, 'j3', {});
    scoreJobOllamaMock
      .mockResolvedValueOnce(RESULT) // warm job
      .mockRejectedValueOnce(new Error('Ollama HTTP 500')) // j2
      .mockResolvedValueOnce(RESULT); // j3

    const summary = await runScheduledScoring(db);

    expect(summary.scored).toBe(2);
    expect(summary.failed).toEqual([b]);
    expect(repo.getJobById(db, b)?.status).toBe('new'); // rescored next run
    expect(repo.getJobById(db, c)?.status).toBe('scored');
  });

  it('routes locally even before Setup is ever saved (no config row)', async () => {
    const fresh = openDatabase(':memory:');
    insertTestJob(fresh, 'j1', {});
    await runScheduledScoring(fresh);
    expect(scoreJobOllamaMock).toHaveBeenCalledTimes(1);
    expect(batchesCreate).not.toHaveBeenCalled();
  });
});

describe('runScheduledScoring on the Anthropic backend', () => {
  it('goes through the Message Batches API exactly as today', async () => {
    repo.upsertUserConfig(db, { ...CONFIG, scoringBackend: 'anthropic' });
    insertTestJob(db, 'j1', {}); // warm-first job (regular metered call)
    insertTestJob(db, 'j2', {});
    insertTestJob(db, 'j3', {});

    const summary = await runScheduledScoring(db, { pollIntervalMs: 0 });

    expect(batchesCreate).toHaveBeenCalledTimes(1); // the non-warm jobs, one batch
    expect(scoreJobOllamaMock).not.toHaveBeenCalled();
    expect(summary.scored).toBe(1); // the warm job; the empty results iterator settles nothing
  });
});
