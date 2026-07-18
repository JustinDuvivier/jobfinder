/**
 * Rewrite call — streams a tailored LaTeX resume token by token (FR-11–FR-13).
 * Runs on Sonnet 5. The system prompt is the user's authored tailoring spec
 * (resume/rewrite_rules.md — minimal-touch edits, bolding policy, Source of
 * Truth, hard zeros), passed in by the route. Those rules were written to emit a
 * ```latex block plus a chat report; JobFinder streams a single document and
 * computes the diff itself, so buildRewriteRequest appends an output-format
 * override and extractRewrite defensively trims anything after \end{document}.
 *
 * The system prompt + base resume form the cached prefix; the job varies after.
 *
 * See jobfinder-docs.md "Rewrite prompt" and resume/rewrite_rules.md.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { REWRITE_MODEL, REWRITE_MAX_TOKENS } from './models';
import { extractText, stripCodeFences } from './parse';

export interface RewriteInput {
  /** The tailoring system prompt (resume/rewrite_rules.md), which embeds the SOT. */
  systemPrompt: string;
  /** The base resume, LaTeX source — copied verbatim, content edits only. */
  resumeLatex: string;
  jobDescription: string;
}

export interface RewriteResult {
  latex: string;
  /** True if the stream ended at max_tokens — the document may be incomplete. */
  truncated: boolean;
}

/**
 * Overrides the rules' chat-oriented output format so the stream is a single
 * LaTeX document. Appended after the rules so it wins.
 */
export const REWRITE_OUTPUT_OVERRIDE =
  '\n\n## OUTPUT FORMAT (OVERRIDE — HIGHEST PRIORITY)\n' +
  'Ignore any earlier instruction to wrap the output in a code block or to append a ' +
  'chat report. Return ONLY the complete tailored LaTeX document: raw LaTeX beginning ' +
  'with \\documentclass and ending with \\end{document}. No markdown code fences, no ' +
  '"---CHAT_REPORT---" section, and no commentary before or after the document.';

export function buildRewriteRequest(input: RewriteInput): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: REWRITE_MODEL,
    max_tokens: REWRITE_MAX_TOKENS,
    system: [
      { type: 'text', text: input.systemPrompt + REWRITE_OUTPUT_OVERRIDE },
      {
        type: 'text',
        text: `Base resume (LaTeX source — copy verbatim, content edits only):\n${input.resumeLatex}`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content:
          'Tailor the base resume above to this job, following the rules exactly. Return ' +
          `only the tailored LaTeX document.\n\nJob description:\n${input.jobDescription}`,
      },
    ],
  };
}

/**
 * Extract the rewritten LaTeX from the final streamed message and report whether
 * it was truncated. Strips stray code fences and, defensively, trims anything
 * after \end{document} in case a chat report slips past the override.
 */
export function extractRewrite(message: Anthropic.Message): RewriteResult {
  let latex = stripCodeFences(extractText(message)).trim();
  const endMarker = '\\end{document}';
  const end = latex.indexOf(endMarker);
  if (end !== -1) latex = latex.slice(0, end + endMarker.length);
  return { latex, truncated: message.stop_reason === 'max_tokens' };
}
