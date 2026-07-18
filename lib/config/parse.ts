/**
 * Pure body → UserConfig coercion for POST /api/config (FR-25). Owns the
 * request-shape validation and every field coercion — most importantly the
 * FR-9a auto-filter threshold: an explicit 0 is honored as "disable filtering"
 * rather than coerced away, a missing/non-numeric value defaults to 50, and
 * the rest is floored and clamped to 0–100. The route maps the returned error
 * to a 400 and persists the config; nothing here touches the database.
 */
import { DEFAULT_OWNER_NAME } from '@/lib/types';
import type { UserConfig, ScraperStrategyName, ScoringBackendName } from '@/lib/types';
import { DEFAULT_OLLAMA_MODEL } from '@/lib/ai/models';

const STRATEGIES: readonly ScraperStrategyName[] = ['demo', 'linkedin', 'proxycurl'];
const BACKENDS: readonly ScoringBackendName[] = ['ollama', 'anthropic'];

const DEFAULT_SCORE_THRESHOLD = 50;

export type ParsedUserConfig = { ok: true; config: UserConfig } | { ok: false; error: string };

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * FR-9a: explicit 0 disables filtering; anything that is not a number or a
 * non-blank numeric string (missing, '', junk) defaults; floor + clamp. The
 * explicit type check matters: Number('') and Number([]) are 0, which would
 * silently disable the filter instead of falling back to the default.
 */
function coerceScoreThreshold(raw: unknown): number {
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : NaN;
  if (Number.isNaN(value)) return DEFAULT_SCORE_THRESHOLD;
  return Math.min(100, Math.max(0, Math.floor(value)));
}

export function parseUserConfig(body: unknown): ParsedUserConfig {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid JSON body' };
  }
  const raw = body as Record<string, unknown>;
  const strategy = raw.scraperStrategy as ScraperStrategyName;
  if (!STRATEGIES.includes(strategy)) {
    return { ok: false, error: 'Invalid scraperStrategy' };
  }
  // Missing defaults to the local backend (FR-6) — the field postdates the
  // form's other keys — but a present, unknown value is a caller bug.
  const backend = (raw.scoringBackend ?? 'ollama') as ScoringBackendName;
  if (!BACKENDS.includes(backend)) {
    return { ok: false, error: 'Invalid scoringBackend' };
  }

  const config: UserConfig = {
    resumeLatex: String(raw.resumeLatex ?? ''),
    sourceOfTruth: String(raw.sourceOfTruth ?? ''),
    searchUrl: String(raw.searchUrl ?? ''),
    scraperStrategy: strategy,
    greenhouseEnabled: raw.greenhouseEnabled === true,
    ownerName: String(raw.ownerName ?? '').trim() || DEFAULT_OWNER_NAME,
    keywords: asStringArray(raw.keywords),
    locations: asStringArray(raw.locations),
    excludedTitleTerms: asStringArray(raw.excludedTitleTerms),
    scoringPrompt: String(raw.scoringPrompt ?? ''),
    rewriteRules: String(raw.rewriteRules ?? ''),
    runIntervalMinutes: Math.max(0, Math.floor(Number(raw.runIntervalMinutes) || 0)),
    searchLookbackHours: Math.max(1, Math.floor(Number(raw.searchLookbackHours) || 1)),
    scoreThreshold: coerceScoreThreshold(raw.scoreThreshold),
    scoringBackend: backend,
    ollamaModel: String(raw.ollamaModel ?? '').trim() || DEFAULT_OLLAMA_MODEL,
  };
  return { ok: true, config };
}
