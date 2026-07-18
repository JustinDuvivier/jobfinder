import { describe, it, expect, vi, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import { openDatabase, type DB } from '@/lib/db';
import { SCORING_MODEL, REWRITE_MODEL, SALARY_MODEL, EXPLAIN_MODEL } from './models';
import { makeTextMessage } from './mock-message';
import { scoreJob, type ScoreInput } from './score';
import { lookupSalary } from './salary';
import { explainChanges } from './explain';
import {
  estimateCostUsd,
  messageEntry,
  ollamaEntry,
  recordAiCall,
  meterCall,
  meteredCreate,
  meterBatchItem,
  type CostUsage,
} from './telemetry';

const NO_TOKENS: CostUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

function insertJob(db: DB): number {
  const info = db
    .prepare(`INSERT INTO jobs (job_id, company, title, url) VALUES ('j1', 'Acme', 'Engineer', 'u')`)
    .run();
  return Number(info.lastInsertRowid);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('estimateCostUsd', () => {
  it('prices Haiku at $1/$5 per MTok (scoring + salary models)', () => {
    const usage = { ...NO_TOKENS, inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(estimateCostUsd(SCORING_MODEL, usage)).toBeCloseTo(6.0);
    expect(estimateCostUsd(SALARY_MODEL, usage)).toBeCloseTo(6.0);
  });

  it('prices Sonnet at $3/$15 list per MTok (rewrite + explain models)', () => {
    const usage = { ...NO_TOKENS, inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(estimateCostUsd(REWRITE_MODEL, usage)).toBeCloseTo(18.0);
    expect(estimateCostUsd(EXPLAIN_MODEL, usage)).toBeCloseTo(18.0);
  });

  it('bills cache reads at 0.1x the input rate', () => {
    const usage = { ...NO_TOKENS, cacheReadTokens: 1_000_000 };
    expect(estimateCostUsd(SCORING_MODEL, usage)).toBeCloseTo(0.1);
  });

  it('bills cache writes at 1.25x (5m default) and 2x (1h TTL) the input rate', () => {
    const usage = { ...NO_TOKENS, cacheCreationTokens: 1_000_000 };
    expect(estimateCostUsd(SCORING_MODEL, usage)).toBeCloseTo(1.25);
    expect(estimateCostUsd(SCORING_MODEL, usage, { cacheWriteTtl: '5m' })).toBeCloseTo(1.25);
    // The scoring prefix uses the 1-hour TTL, which bills the write at 2x.
    expect(estimateCostUsd(SCORING_MODEL, usage, { cacheWriteTtl: '1h' })).toBeCloseTo(2.0);
  });

  it('halves everything for batch calls, cache multipliers included', () => {
    const usage: CostUsage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    };
    // (1 + 5 + 0.1 + 2) / 2 on Haiku with the 1h write TTL.
    expect(estimateCostUsd(SCORING_MODEL, usage, { batch: true, cacheWriteTtl: '1h' })).toBeCloseTo(
      4.05,
    );
  });

  it('returns null for an unknown model', () => {
    expect(estimateCostUsd('some-future-model', { ...NO_TOKENS, inputTokens: 100 })).toBeNull();
  });

  it('scales per token', () => {
    const usage = { ...NO_TOKENS, inputTokens: 800, outputTokens: 200 };
    // 800 * $1/MTok + 200 * $5/MTok = $0.0018
    expect(estimateCostUsd(SCORING_MODEL, usage)).toBeCloseTo(0.0018, 10);
  });
});

describe('messageEntry', () => {
  it('captures the four token counts, model, stop reason, latency, and cost', () => {
    const message = makeTextMessage('{}', 'end_turn', {
      model: SCORING_MODEL,
      usage: {
        input_tokens: 500,
        output_tokens: 200,
        cache_creation_input_tokens: 4000,
        cache_read_input_tokens: 0,
      },
    });
    const entry = messageEntry('score', 7, message, 1234, { cacheWriteTtl: '1h' });
    expect(entry).toEqual({
      callType: 'score',
      jobId: 7,
      model: SCORING_MODEL,
      inputTokens: 500,
      outputTokens: 200,
      cacheCreationTokens: 4000,
      cacheReadTokens: 0,
      costUsd: estimateCostUsd(
        SCORING_MODEL,
        { inputTokens: 500, outputTokens: 200, cacheCreationTokens: 4000, cacheReadTokens: 0 },
        { cacheWriteTtl: '1h' },
      ),
      latencyMs: 1234,
      stopReason: 'end_turn',
    });
  });

  it('records a truncation stop reason and a null cost for an unknown model', () => {
    const entry = messageEntry('rewrite', 3, makeTextMessage('x', 'max_tokens'), null);
    expect(entry.stopReason).toBe('max_tokens');
    expect(entry.costUsd).toBeNull(); // model 'test' is not in the price map
    expect(entry.latencyMs).toBeNull();
  });
});

describe('ollamaEntry (the local backend, FR-6)', () => {
  it('records real token counts at a flat zero cost with no cache columns', () => {
    const entry = ollamaEntry(
      'score',
      7,
      'batiai/qwen3.6-27b:iq3',
      { prompt_eval_count: 5500, eval_count: 300, done_reason: 'stop' },
      8200,
    );
    expect(entry).toEqual({
      callType: 'score',
      jobId: 7,
      model: 'batiai/qwen3.6-27b:iq3',
      inputTokens: 5500,
      outputTokens: 300,
      cacheCreationTokens: null, // a local model has no billed cache
      cacheReadTokens: null,
      costUsd: 0, // zero cost is a property of the backend, never a price lookup
      latencyMs: 8200,
      stopReason: 'stop',
    });
  });

  it("maps 'length' to 'max_tokens' and missing counts to null (unknown, not zero)", () => {
    const entry = ollamaEntry('score', 7, 'qwen3.5:9b', { done_reason: 'length' }, null);
    expect(entry.stopReason).toBe('max_tokens'); // the ledger's truncation badge fires
    expect(entry.inputTokens).toBeNull(); // Ollama may omit counts on KV-cached prompts
    expect(entry.outputTokens).toBeNull();
    expect(entry.costUsd).toBe(0);
  });
});

describe('recordAiCall', () => {
  it('inserts one row with all fields', () => {
    const db = openDatabase(':memory:');
    const jobId = insertJob(db);
    recordAiCall(db, {
      callType: 'score',
      model: SCORING_MODEL,
      jobId,
      inputTokens: 500,
      outputTokens: 200,
      cacheCreationTokens: 0,
      cacheReadTokens: 4000,
      costUsd: 0.0019,
      latencyMs: 900,
      stopReason: 'end_turn',
    });

    const row = db.prepare(`SELECT * FROM ai_calls`).get() as Record<string, unknown>;
    expect(row.call_type).toBe('score');
    expect(row.model).toBe(SCORING_MODEL);
    expect(row.job_id).toBe(jobId);
    expect(row.input_tokens).toBe(500);
    expect(row.output_tokens).toBe(200);
    expect(row.cache_creation_tokens).toBe(0);
    expect(row.cache_read_tokens).toBe(4000);
    expect(row.cost_usd).toBeCloseTo(0.0019);
    expect(row.latency_ms).toBe(900);
    expect(row.stop_reason).toBe('end_turn');
    expect(row.error).toBeNull();
    expect(row.created_at).toBeTruthy();
  });

  it('records an error row with null token fields', () => {
    const db = openDatabase(':memory:');
    const jobId = insertJob(db);
    recordAiCall(db, { callType: 'salary', model: SALARY_MODEL, jobId, error: 'rate limited' });

    const row = db.prepare(`SELECT * FROM ai_calls`).get() as Record<string, unknown>;
    expect(row.error).toBe('rate limited');
    expect(row.input_tokens).toBeNull();
    expect(row.cost_usd).toBeNull();
  });

  it('nulls job_id when the job row is later deleted (trace rows outlive jobs)', () => {
    const db = openDatabase(':memory:');
    const jobId = insertJob(db);
    recordAiCall(db, { callType: 'score', model: SCORING_MODEL, jobId });
    db.prepare(`DELETE FROM jobs WHERE id = ?`).run(jobId);

    const row = db.prepare(`SELECT job_id FROM ai_calls`).get() as { job_id: number | null };
    expect(row.job_id).toBeNull();
  });

  it('never throws — a failed insert is logged and swallowed', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bare = new Database(':memory:'); // no schema — the insert must fail
    expect(() =>
      recordAiCall(bare as DB, { callType: 'score', model: SCORING_MODEL }),
    ).not.toThrow();
    expect(error).toHaveBeenCalledOnce();
  });
});

// The metering matrix (FR-27): every call type lands its ledger row through the
// meter — success with the call type's cost flags, an error row on a thrown
// call, streaming final-message usage, and the batch discount. The call
// functions are the real ones; only the Anthropic client is mocked, so these
// tests pin the exact rows each call type writes.
describe('metering seam (FR-27)', () => {
  const SCORE_INPUT: ScoreInput = {
    systemPrompt: 'Score the candidate.',
    sourceOfTruth: 'Shipped X.',
    resumePlainText: 'Engineer.',
    jobDescription: 'Build things.',
  };

  const seed = (): { db: DB; jobId: number } => {
    const db = openDatabase(':memory:');
    return { db, jobId: insertJob(db) };
  };

  const clientReturning = (message: Anthropic.Message): Anthropic =>
    ({ messages: { create: vi.fn().mockResolvedValue(message) } }) as unknown as Anthropic;

  const oneRow = (db: DB): Record<string, unknown> =>
    db.prepare(`SELECT * FROM ai_calls`).get() as Record<string, unknown>;

  it('scoreJob lands the score row with the 1h-TTL cache-write cost', async () => {
    const { db, jobId } = seed();
    const message = makeTextMessage('{"score": 82, "reasoning": "fits"}', 'end_turn', {
      model: SCORING_MODEL,
      usage: {
        input_tokens: 500,
        output_tokens: 200,
        cache_creation_input_tokens: 4000,
        cache_read_input_tokens: 100,
      },
    });

    await scoreJob(clientReturning(message), SCORE_INPUT, { db, jobId });

    const row = oneRow(db);
    expect(row.call_type).toBe('score');
    expect(row.job_id).toBe(jobId);
    expect(row.model).toBe(SCORING_MODEL);
    expect(row.input_tokens).toBe(500);
    expect(row.output_tokens).toBe(200);
    expect(row.cache_creation_tokens).toBe(4000);
    expect(row.cache_read_tokens).toBe(100);
    // Haiku $1/$5; the scoring prefix writes on the 1h TTL (2x), reads at 0.1x.
    expect(row.cost_usd).toBeCloseTo((500 * 1 + 200 * 5 + 4000 * 1 * 2 + 100 * 0.1) / 1_000_000, 10);
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
    expect(row.stop_reason).toBe('end_turn');
    expect(row.error).toBeNull();
  });

  it('scoreJob records usage even when the truncated reply then fails parsing', async () => {
    const { db, jobId } = seed();
    const message = makeTextMessage('{"score":', 'max_tokens', { model: SCORING_MODEL });

    await expect(scoreJob(clientReturning(message), SCORE_INPUT, { db, jobId })).rejects.toThrow(
      /truncated/,
    );

    // Tokens were spent regardless — the truncation lands as stop_reason.
    const row = oneRow(db);
    expect(row.stop_reason).toBe('max_tokens');
    expect(row.error).toBeNull();
  });

  it('lookupSalary and explainChanges land their rows at the default cost options', async () => {
    const { db, jobId } = seed();
    const salaryMsg = makeTextMessage('{"found": true, "salary": "$130k/yr"}', 'end_turn', {
      model: SALARY_MODEL,
      usage: { input_tokens: 300, output_tokens: 40 },
    });
    const explainMsg = makeTextMessage('{"summary": "s", "bullets": ["b"]}', 'end_turn', {
      model: EXPLAIN_MODEL,
      usage: { input_tokens: 2000, output_tokens: 150, cache_creation_input_tokens: 900 },
    });

    await lookupSalary(clientReturning(salaryMsg), { title: 'Eng', company: 'Acme', location: null }, { db, jobId });
    await explainChanges(
      clientReturning(explainMsg),
      { changes: [{ blockType: 'insert', content: 'a', seq: 0 }], jobDescription: 'c' },
      { db, jobId },
    );

    const rows = db
      .prepare(`SELECT * FROM ai_calls ORDER BY id`)
      .all() as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.call_type)).toEqual(['salary', 'explain']);
    expect(rows[0].model).toBe(SALARY_MODEL);
    expect(rows[0].cost_usd).toBeCloseTo((300 * 1 + 40 * 5) / 1_000_000, 10);
    expect(rows[1].model).toBe(EXPLAIN_MODEL);
    // Sonnet $3/$15; no batch discount, cache writes at the default 5m rate (1.25x).
    expect(rows[1].cost_usd).toBeCloseTo((2000 * 3 + 150 * 15 + 900 * 3 * 1.25) / 1_000_000, 10);
  });

  it('meterCall records a streamed rewrite from its final message', async () => {
    const { db, jobId } = seed();
    const finalMessage = makeTextMessage('\\documentclass{article}\\end{document}', 'end_turn', {
      model: REWRITE_MODEL,
      usage: {
        input_tokens: 1200,
        output_tokens: 2500,
        cache_creation_input_tokens: 900,
        cache_read_input_tokens: 0,
      },
    });

    // The rewrite route consumes the SSE stream inside the thunk and resolves
    // with the accumulated final message — the meter only sees that resolution.
    const message = await meterCall({ db, jobId }, 'rewrite', REWRITE_MODEL, async () => finalMessage);

    expect(message).toBe(finalMessage);
    const row = oneRow(db);
    expect(row.call_type).toBe('rewrite');
    expect(row.job_id).toBe(jobId);
    expect(row.model).toBe(REWRITE_MODEL);
    expect(row.output_tokens).toBe(2500);
    // Sonnet $3/$15; the rewrite prefix caches on the default 5m TTL (1.25x).
    expect(row.cost_usd).toBeCloseTo((1200 * 3 + 2500 * 15 + 900 * 3 * 1.25) / 1_000_000, 10);
    expect(row.stop_reason).toBe('end_turn');
    expect(row.error).toBeNull();
  });

  it('records an error row and rethrows when the wrapped call throws', async () => {
    const { db, jobId } = seed();
    const client = {
      messages: { create: vi.fn().mockRejectedValue(new Error('rate limited')) },
    } as unknown as Anthropic;

    await expect(scoreJob(client, SCORE_INPUT, { db, jobId })).rejects.toThrow('rate limited');

    const row = oneRow(db);
    expect(row.call_type).toBe('score');
    expect(row.job_id).toBe(jobId);
    expect(row.model).toBe(SCORING_MODEL);
    expect(row.error).toBe('rate limited');
    expect(row.input_tokens).toBeNull();
    expect(row.cost_usd).toBeNull();
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('records a failed stream as an error row and rethrows', async () => {
    const { db, jobId } = seed();

    await expect(
      meterCall({ db, jobId }, 'rewrite', REWRITE_MODEL, async () => {
        throw new Error('connection reset');
      }),
    ).rejects.toThrow('connection reset');

    const row = oneRow(db);
    expect(row.call_type).toBe('rewrite');
    expect(row.model).toBe(REWRITE_MODEL);
    expect(row.error).toBe('connection reset');
    expect(row.input_tokens).toBeNull();
  });

  it('meterBatchItem bills a succeeded batch item at the batch discount with the 1h TTL', () => {
    const { db, jobId } = seed();
    const message = makeTextMessage('{"score": 70, "reasoning": "fits"}', 'end_turn', {
      model: SCORING_MODEL,
      usage: {
        input_tokens: 500,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 4000,
      },
    });

    meterBatchItem({ db, jobId }, 'score_batch', SCORING_MODEL, { type: 'succeeded', message });

    const row = oneRow(db);
    expect(row.call_type).toBe('score_batch');
    expect(row.job_id).toBe(jobId);
    // Half of everything: batch items bill at 50%, cache multipliers included.
    expect(row.cost_usd).toBeCloseTo(((500 * 1 + 200 * 5 + 4000 * 0.1) / 1_000_000) * 0.5, 10);
    expect(row.latency_ms).toBeNull(); // no per-item latency inside a batch
    expect(row.stop_reason).toBe('end_turn');
    expect(row.error).toBeNull();
  });

  it('meterBatchItem records a non-succeeded batch result as an error row', () => {
    const { db, jobId } = seed();

    meterBatchItem({ db, jobId }, 'score_batch', SCORING_MODEL, {
      type: 'errored',
      error: { type: 'error', error: { type: 'api_error', message: 'boom' } },
    } as unknown as Anthropic.Messages.MessageBatchResult);

    const row = oneRow(db);
    expect(row.call_type).toBe('score_batch');
    expect(row.model).toBe(SCORING_MODEL);
    expect(row.error).toBe('batch result errored');
    expect(row.input_tokens).toBeNull();
  });

  it('runs the call unmetered when no meter is given', async () => {
    const message = makeTextMessage('{}', 'end_turn', { model: SCORING_MODEL });
    const create = vi.fn().mockResolvedValue(message);
    const client = { messages: { create } } as unknown as Anthropic;
    const request = {
      model: SCORING_MODEL,
      max_tokens: 8,
      messages: [],
    } as unknown as Anthropic.MessageCreateParamsNonStreaming;

    await expect(meteredCreate(client, 'score', request)).resolves.toBe(message);
    expect(create).toHaveBeenCalledWith(request);
  });
});
