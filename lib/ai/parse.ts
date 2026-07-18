/**
 * Deterministic post-processing helpers shared by the AI calls: pulling text
 * out of a response and robustly extracting a JSON object from model output
 * (tolerating markdown fences or stray prose around it).
 */
import type Anthropic from '@anthropic-ai/sdk';

/** Concatenate all text blocks of a message into one string. */
export function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** Strip markdown code fences (```/```json) from a string. */
export function stripCodeFences(text: string): string {
  return text.replace(/```(?:json|latex)?/gi, '');
}

/**
 * Extract and parse the first top-level JSON object from model text. Tolerates
 * code fences and surrounding prose by slicing from the first `{` to the last
 * `}`. Throws if no object is present or it does not parse.
 */
export function extractJsonObject(text: string): unknown {
  const cleaned = stripCodeFences(text);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON object found in model response');
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}
