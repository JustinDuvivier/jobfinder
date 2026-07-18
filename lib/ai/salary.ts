/**
 * Salary lookup — an on-demand AI fallback for when a posting carries no salary
 * and none could be mined from its description. Runs on Haiku with the web
 * search server tool, asks the model to find the published pay range (or a
 * credible market range) for the role, and returns a normalized salary string
 * or null.
 *
 * This is the AI tier of the salary resolver (lib/salary), injected into
 * `resolveSalaryWithAi` so it fires only when the deterministic tiers (explicit
 * field, then description prose) miss. It is mocked in tests like the other AI
 * calls — we assert request construction and response handling, never exact
 * model output.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { SALARY_MODEL, SALARY_MAX_TOKENS } from './models';
import { extractText, extractJsonObject } from './parse';
import { meteredCreate, type AiTelemetry } from './telemetry';

export interface SalaryInput {
  title: string;
  company: string;
  location: string | null;
}

export interface SalaryResult {
  /** The found/estimated salary, raw text for the normalizer; null if unknown. */
  salary: string | null;
  /** True when the model reported a credible figure. */
  found: boolean;
}

/** Basic web search tool — the variant that older models (Haiku 4.5) support. */
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 } as const;

const SYSTEM = [
  'You research compensation for job postings. Given a role, find the salary range.',
  'Use web search to find the posted pay range, or a credible market range for that title and location.',
  'Reply with ONLY a JSON object and nothing else:',
  '{"found": <boolean>, "salary": "<e.g. $120,000 - $150,000/yr, or null>"}',
  'Set "found" to false and "salary" to null if you cannot find a credible figure. Prefer annual USD ranges. Be brief.',
].join('\n');

/** Build the salary lookup request (Haiku + web search). */
export function buildSalaryRequest(input: SalaryInput): Anthropic.MessageCreateParamsNonStreaming {
  const where = input.location ? ` in ${input.location}` : '';
  return {
    model: SALARY_MODEL,
    max_tokens: SALARY_MAX_TOKENS,
    system: SYSTEM,
    tools: [WEB_SEARCH_TOOL] as unknown as Anthropic.MessageCreateParamsNonStreaming['tools'],
    messages: [
      {
        role: 'user',
        content: `Find the salary for: ${input.title} at ${input.company}${where}.`,
      },
    ],
  };
}

function validate(obj: unknown): SalaryResult {
  if (typeof obj !== 'object' || obj === null) return { salary: null, found: false };
  const record = obj as Record<string, unknown>;
  const found = record.found === true;
  const salary =
    typeof record.salary === 'string' && record.salary.trim().length > 0
      ? record.salary.trim()
      : null;
  // "found" and a real salary must agree; otherwise treat as not found.
  if (!found || salary === null) return { salary: null, found: false };
  return { salary, found: true };
}

/**
 * Parse a salary response. A truncated or still-paused (server tool loop hit its
 * cap) response is treated as "not found" rather than an error — the caller just
 * leaves the salary blank.
 */
export function parseSalaryResponse(message: Anthropic.Message): SalaryResult {
  // Cast to string so the comparison doesn't depend on the SDK's stop_reason
  // union including 'pause_turn' (added for server-tool loops).
  const stop = message.stop_reason as string | null;
  if (stop === 'max_tokens' || stop === 'pause_turn') {
    return { salary: null, found: false };
  }
  try {
    return validate(extractJsonObject(extractText(message)));
  } catch {
    return { salary: null, found: false };
  }
}

/**
 * Look up one job's salary. The client is injected so tests can mock it. With
 * a telemetry context, the metering seam lands the call in the ai_calls
 * ledger (FR-27).
 */
export async function lookupSalary(
  client: Anthropic,
  input: SalaryInput,
  telemetry?: AiTelemetry,
): Promise<SalaryResult> {
  const message = await meteredCreate(client, 'salary', buildSalaryRequest(input), telemetry);
  return parseSalaryResponse(message);
}
