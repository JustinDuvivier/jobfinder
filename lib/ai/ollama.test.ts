/**
 * Local scoring backend tests (FR-6) — the HTTP transport is mocked (global
 * fetch), everything else is real: request construction (prompt assembly
 * identical to buildScoreRequest, thinking off, temperature 0, context
 * sizing), response handling (token counts into the ledger at zero cost,
 * truncation as an error, error mapping), and the shared parse pipeline
 * (the FR-6a park applies regardless of backend). Never calls a live model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDatabase, type DB } from '@/lib/db';
import { insertTestJob } from '@/lib/test-fixtures';
import { DEFAULT_OLLAMA_BASE_URL } from '@/lib/env/ollama';
import { OLLAMA_NUM_CTX, SCORING_MAX_TOKENS } from './models';
import { buildScoreRequest, PARKED_REVIEW_SCORE, type ScoreInput } from './score';
import { buildOllamaScoreBody, ensureOllamaModel, scoreJobOllama } from './ollama';

const INPUT: ScoreInput = {
  systemPrompt: 'You are a job matching expert. Score the candidate.',
  sourceOfTruth: 'Shipped a payments service handling 10k rps.',
  resumePlainText: 'Alex Candidate — Software Engineer.',
  jobDescription: 'AI Engineer at Stripe. Build LLM features.',
};

const MODEL = 'batiai/qwen3.6-27b:iq3';
const VALID_REPLY = '{"score": 82, "reasoning": "Strong fit.", "key_matches": ["Python"], "concerns": ["No Go"]}';

const fetchMock = vi.fn();

/** A completed /api/chat response envelope. */
function chatResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => ({
      message: { content: VALID_REPLY },
      done_reason: 'stop',
      prompt_eval_count: 5500,
      eval_count: 300,
      ...overrides,
    }),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('buildOllamaScoreBody', () => {
  it('carries the exact buildScoreRequest text: joined system blocks, same user message', () => {
    const body = buildOllamaScoreBody(MODEL, INPUT);
    const anthropic = buildScoreRequest(INPUT);
    const blocks = (anthropic.system as Array<{ text: string }>).map((b) => b.text);

    expect(body.messages[0]).toEqual({ role: 'system', content: blocks.join('\n\n') });
    expect(body.messages[1]).toEqual({ role: 'user', content: anthropic.messages[0].content });
    // The per-job posting sits only in the user message, exactly as on Anthropic.
    expect(body.messages[0].content).not.toContain(INPUT.jobDescription);
    expect(body.messages[1].content).toContain(INPUT.jobDescription);
  });

  it('runs deterministically with thinking off and the sized context window', () => {
    const body = buildOllamaScoreBody(MODEL, INPUT);
    expect(body.model).toBe(MODEL);
    expect(body.stream).toBe(false);
    expect(body.think).toBe(false);
    expect(body.options).toEqual({
      temperature: 0,
      num_ctx: OLLAMA_NUM_CTX,
      num_predict: SCORING_MAX_TOKENS,
    });
  });
});

describe('scoreJobOllama', () => {
  it('POSTs /api/chat and parses the reply through the shared pipeline', async () => {
    fetchMock.mockResolvedValue(chatResponse());
    const result = await scoreJobOllama(MODEL, INPUT);
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_OLLAMA_BASE_URL}/api/chat`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(buildOllamaScoreBody(MODEL, INPUT));
    expect(result.score).toBe(82);
    expect(result.reasoning).toBe('Strong fit.');
  });

  it('targets the OLLAMA_BASE_URL endpoint when set, for scoring and the model check', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://ollama-host:9999/');
    fetchMock.mockResolvedValue(chatResponse());
    await scoreJobOllama(MODEL, INPUT);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://ollama-host:9999/api/chat',
      expect.objectContaining({ method: 'POST' }),
    );
    await ensureOllamaModel(MODEL);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://ollama-host:9999/api/show',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('names the configured endpoint in the unreachable-server error', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://ollama-host:9999');
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(scoreJobOllama(MODEL, INPUT)).rejects.toThrow(
      /unreachable at http:\/\/ollama-host:9999/,
    );
  });

  it('applies the FR-6a park exactly as the Anthropic path would', async () => {
    const parked =
      '{"experience": {"required_quote": "none stated", "candidate_years": 1, "required_years": 6, "gap_years": 5},' +
      ' "score": 50, "reasoning": "x"}';
    fetchMock.mockResolvedValue(chatResponse({ message: { content: parked } }));
    const result = await scoreJobOllama(MODEL, INPUT);
    expect(result.score).toBe(PARKED_REVIEW_SCORE);
    expect(result.parkedForReview).toBe(true);
  });

  it('strips an inline <think> block before parsing', async () => {
    fetchMock.mockResolvedValue(
      chatResponse({ message: { content: `<think>hmm, let me see</think>\n${VALID_REPLY}` } }),
    );
    await expect(scoreJobOllama(MODEL, INPUT)).resolves.toMatchObject({ score: 82 });
  });

  it('treats a length-cut reply as an error, never a score', async () => {
    fetchMock.mockResolvedValue(chatResponse({ done_reason: 'length' }));
    await expect(scoreJobOllama(MODEL, INPUT)).rejects.toThrow(/truncated/);
  });

  it('maps an unreachable server to an actionable error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(scoreJobOllama(MODEL, INPUT)).rejects.toThrow(/Ollama server unreachable/);
  });

  it('surfaces HTTP failures and Ollama-reported errors', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    await expect(scoreJobOllama(MODEL, INPUT)).rejects.toThrow(/Ollama HTTP 500: boom/);

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ error: 'model requires more memory' }) });
    await expect(scoreJobOllama(MODEL, INPUT)).rejects.toThrow(/model requires more memory/);
  });
});

describe('scoreJobOllama telemetry', () => {
  let db: DB;
  let jobId: number;
  beforeEach(() => {
    db = openDatabase(':memory:');
    jobId = insertTestJob(db, 'j1', {}); // ai_calls.job_id is a foreign key
  });
  const ledgerRow = () => db.prepare(`SELECT * FROM ai_calls`).get() as Record<string, unknown>;

  it('ledgers real token counts at zero cost, with no cache columns', async () => {
    fetchMock.mockResolvedValue(chatResponse());
    await scoreJobOllama(MODEL, INPUT, { db, jobId });
    expect(ledgerRow()).toMatchObject({
      call_type: 'score',
      model: MODEL,
      job_id: jobId,
      input_tokens: 5500,
      output_tokens: 300,
      cache_creation_tokens: null,
      cache_read_tokens: null,
      cost_usd: 0,
      stop_reason: 'stop',
      error: null,
    });
  });

  it("maps Ollama's 'length' to 'max_tokens' so the truncation badge fires", async () => {
    fetchMock.mockResolvedValue(chatResponse({ done_reason: 'length' }));
    await expect(scoreJobOllama(MODEL, INPUT, { db, jobId })).rejects.toThrow();
    // The row was written before the parse step threw — the tokens were spent.
    expect(ledgerRow()).toMatchObject({ stop_reason: 'max_tokens', cost_usd: 0 });
  });

  it('records an error row when the transport fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(scoreJobOllama(MODEL, INPUT, { db, jobId })).rejects.toThrow();
    expect(ledgerRow()).toMatchObject({
      call_type: 'score',
      model: MODEL,
      input_tokens: null,
      cost_usd: null,
    });
    expect(String(ledgerRow().error)).toMatch(/unreachable/);
  });
});

describe('ensureOllamaModel', () => {
  it('resolves when the model is present', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await expect(ensureOllamaModel(MODEL)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_OLLAMA_BASE_URL}/api/show`,
      expect.objectContaining({ body: JSON.stringify({ model: MODEL }) }),
    );
  });

  it('names the missing model and the pull command', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(ensureOllamaModel(MODEL)).rejects.toThrow(new RegExp(`ollama pull ${MODEL}`));
  });

  it('fails loudly when the server is down', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(ensureOllamaModel(MODEL)).rejects.toThrow(/Ollama server unreachable/);
  });
});
