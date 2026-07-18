/**
 * The Anthropic client singleton. The API key stays server-side and never
 * leaves the process (NFR-7). The AI call functions (scoreJob, explainChanges,
 * and the rewrite route) take a client argument so tests inject a mock instead
 * of hitting the network; route handlers pass `getAnthropicClient()`.
 */
import Anthropic from '@anthropic-ai/sdk';

let singleton: Anthropic | null = null;

/** The process-wide Anthropic client, constructed from ANTHROPIC_API_KEY. */
export function getAnthropicClient(): Anthropic {
  if (singleton) return singleton;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to .env.local (native) or .env (docker compose) — see the README.',
    );
  }
  singleton = new Anthropic({ apiKey });
  return singleton;
}
