/**
 * The local Ollama scoring backend (FR-6): the same prompt assembly, parse
 * pipeline, and metering as the Anthropic path, over Ollama's /api/chat.
 *
 * The request is built by reusing buildScoreRequest and joining its system
 * blocks the way the model-comparison eval did (scripts/eval-score-golden.mts),
 * so the two backends can never drift on prompt content. Thinking is disabled
 * and temperature is 0 — the eval showed thinking burns the output budget
 * before any JSON appears, and deterministic decoding keeps scores comparable
 * across runs. The context window (OLLAMA_NUM_CTX) is sized so the longest
 * captured real postings fit with full reply headroom; a reply that still hits
 * the token limit is an error, never a persisted score (FR-7's rule).
 *
 * Failures are loud by design: an unreachable server or missing model throws
 * with a actionable message and no Anthropic fallback — the affected jobs stay
 * `new` for the next run (see ensureOllamaModel, called before any scoring).
 */
import type Anthropic from '@anthropic-ai/sdk';
import { getOllamaBaseUrl } from '@/lib/env/ollama';
import { OLLAMA_NUM_CTX, SCORING_MAX_TOKENS } from './models';
import {
  buildScoreRequest,
  parseScoreText,
  type ScoreInput,
  type ScoreResult,
} from './score';
import { meterOllamaCall, type AiTelemetry, type OllamaUsage } from './telemetry';

export interface OllamaChatResponse extends OllamaUsage {
  message?: { content?: string; thinking?: string };
  error?: string;
}

/**
 * The /api/chat body for one scoring call: buildScoreRequest's exact text,
 * with the adjacent Anthropic system blocks joined into one system message.
 */
export function buildOllamaScoreBody(model: string, input: ScoreInput) {
  const request = buildScoreRequest(input);
  const system = (request.system as Anthropic.TextBlockParam[]).map((b) => b.text).join('\n\n');
  return {
    model,
    stream: false,
    think: false,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: request.messages[0].content as string },
    ],
    options: {
      temperature: 0,
      num_ctx: OLLAMA_NUM_CTX,
      num_predict: SCORING_MAX_TOKENS,
    },
  };
}

/**
 * The single Ollama HTTP transport (POST JSON to `${OLLAMA_BASE_URL}${path}`),
 * shared with the model-management module (lib/ai/ollama-pull.ts) so every
 * call site resolves the endpoint and reports unreachability the same way.
 */
export async function ollamaFetch(path: string, body: unknown): Promise<Response> {
  const baseUrl = getOllamaBaseUrl();
  try {
    return await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Ollama server unreachable at ${baseUrl} — is it running? ` +
        `(Set OLLAMA_BASE_URL if it runs elsewhere.) ${(err as Error).message}`,
    );
  }
}

/**
 * Preflight for a scoring run on the local backend: fail the whole run loudly
 * — before any job is attempted — when the server is down or the configured
 * model is not pulled. No silent fallback to Anthropic; unscored jobs stay
 * `new` for the next run.
 */
export async function ensureOllamaModel(model: string): Promise<void> {
  const res = await ollamaFetch('/api/show', { model });
  if (!res.ok) {
    throw new Error(
      `Ollama model "${model}" is not available (HTTP ${res.status}). ` +
        `Pull it with \`ollama pull ${model}\` or change the scoring model in Settings.`,
    );
  }
}

async function ollamaChat(body: unknown): Promise<OllamaChatResponse> {
  const res = await ollamaFetch('/api/chat', body);
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as OllamaChatResponse;
  if (data.error) throw new Error(`Ollama: ${data.error}`);
  return data;
}

/** Drop an inline <think> block — Ollama usually separates thinking into
 *  message.thinking, but some models leak it into the visible content. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Score one job on the local model: metered call, then the exact same parse /
 * validate pipeline as the Anthropic path (parseScoreText — quote re-derive,
 * gap cap, FR-6a park). The ledger row is written before parsing, mirroring
 * meteredCreate: the tokens were spent even when the reply is rejected.
 */
export async function scoreJobOllama(
  model: string,
  input: ScoreInput,
  telemetry?: AiTelemetry,
): Promise<ScoreResult> {
  const response = await meterOllamaCall(telemetry, 'score', model, () =>
    ollamaChat(buildOllamaScoreBody(model, input)),
  );
  if (response.done_reason === 'length') {
    throw new Error('Scoring response was truncated (num_predict); retry.');
  }
  return parseScoreText(stripThinking(response.message?.content ?? ''));
}
