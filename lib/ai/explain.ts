/**
 * Explanation call — a separate, non-blocking call that states *why* each change
 * was made (FR-14). Runs on Sonnet 5 and returns synchronous JSON
 * {summary, bullets}. It is deliberately separate from the rewrite stream so it
 * never blocks editing.
 *
 * The explainer is fed the *recorded* change set — the persisted diff blocks the
 * Changes panel renders (FR-13) — not a plain-text rendering of the two resumes.
 * The diff is computed over LaTeX source, so markup-only edits (e.g. bolding a
 * metric) are part of the input and the "why" can cover every edit the "what"
 * panel shows. It also keeps the prompt small: long unchanged runs are elided
 * down to context.
 *
 * Passing the job description is essential: without it the model can only
 * describe the edits, not justify them against specific job requirements.
 *
 * See jobfinder-docs.md "Explanation prompt".
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { DiffBlock } from '../diff';
import { EXPLAIN_MODEL, EXPLAIN_MAX_TOKENS } from './models';
import { extractText, extractJsonObject } from './parse';
import { meteredCreate, type AiTelemetry } from './telemetry';

export interface ExplainInput {
  /** The persisted diff blocks (resume_changes) the Changes panel renders. */
  changes: DiffBlock[];
  jobDescription: string;
}

export interface ExplainResult {
  summary: string;
  bullets: string[];
}

/** Unchanged text kept on each side of an edit when an equal block is elided. */
const EQUAL_CONTEXT_CHARS = 200;

/**
 * Render the recorded diff blocks as the annotated document the explainer
 * reads: edits marked inline with <removed>/<added>, unchanged text kept as
 * context but elided in the middle when long. Deterministic and lossless for
 * every insert/delete block — only equal runs are shortened.
 */
export function formatChangesForPrompt(changes: DiffBlock[]): string {
  return changes
    .map((block) => {
      if (block.blockType === 'delete') return `<removed>${block.content}</removed>`;
      if (block.blockType === 'insert') return `<added>${block.content}</added>`;
      const text = block.content;
      if (text.length <= EQUAL_CONTEXT_CHARS * 2) return text;
      return `${text.slice(0, EQUAL_CONTEXT_CHARS)} […] ${text.slice(-EQUAL_CONTEXT_CHARS)}`;
    })
    .join('');
}

export const EXPLAIN_SYSTEM_PROMPT =
  'You explain the edits a career coach made to tailor a LaTeX resume to a ' +
  'specific job. You are given the recorded change log: the resume with every ' +
  'edit marked inline — deleted text in <removed>…</removed>, inserted text in ' +
  '<added>…</added> — and unchanged text (possibly elided with […]) as context. ' +
  'Respond with ONLY a JSON object — no prose, no markdown fences — of this ' +
  'exact shape: {"summary": "<one or two sentences>", "bullets": ["<reason>", ...]}. ' +
  'Each bullet ties a specific edit to a specific job requirement (e.g. why a ' +
  'metric was surfaced or a skill re-emphasized). Be concise and non-generic; do ' +
  'not invent changes that were not made.';

/** Build the explanation request (synchronous; the explanation is short). */
export function buildExplainRequest(input: ExplainInput): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: EXPLAIN_MODEL,
    max_tokens: EXPLAIN_MAX_TOKENS,
    system: [{ type: 'text', text: EXPLAIN_SYSTEM_PROMPT }],
    messages: [
      {
        role: 'user',
        content:
          `Recorded resume changes:\n${formatChangesForPrompt(input.changes)}\n\n` +
          `Job description:\n${input.jobDescription}\n\n` +
          'Explain why each change was made, tied to this job.',
      },
    ],
  };
}

function validateExplanation(obj: unknown): ExplainResult {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('Explanation response is not a JSON object');
  }
  const record = obj as Record<string, unknown>;
  const { summary, bullets } = record;
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    throw new Error('Explanation response missing a non-empty "summary"');
  }
  if (
    !Array.isArray(bullets) ||
    !bullets.every((bullet) => typeof bullet === 'string')
  ) {
    throw new Error('Explanation response missing a "bullets" array of strings');
  }
  return {
    summary: summary.trim(),
    bullets: bullets.map((bullet) => bullet.trim()).filter((bullet) => bullet.length > 0),
  };
}

/** Parse and validate an explanation response. Truncation is an error. */
export function parseExplainResponse(message: Anthropic.Message): ExplainResult {
  if (message.stop_reason === 'max_tokens') {
    throw new Error('Explanation response was truncated (max_tokens); retry.');
  }
  return validateExplanation(extractJsonObject(extractText(message)));
}

/**
 * Generate the change explanation. The client is injected so tests can mock
 * it. With a telemetry context, the metering seam lands the call in the
 * ai_calls ledger (FR-27).
 */
export async function explainChanges(
  client: Anthropic,
  input: ExplainInput,
  telemetry?: AiTelemetry,
): Promise<ExplainResult> {
  const message = await meteredCreate(client, 'explain', buildExplainRequest(input), telemetry);
  return parseExplainResponse(message);
}
