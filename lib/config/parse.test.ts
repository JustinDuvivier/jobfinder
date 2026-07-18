/**
 * Tests for parseUserConfig — the pure body → UserConfig coercion behind
 * POST /api/config (FR-25). The FR-9a auto-filter threshold semantics are the
 * heart of it: an explicit 0 is honored as "disable filtering", a missing or
 * non-numeric value defaults to 50, and everything else is floored and clamped
 * to 0–100. Table-tested here so the contract is pinned once, not implicitly
 * in the route.
 */
import { describe, it, expect } from 'vitest';
import { parseUserConfig } from './parse';

/** A minimal valid body; tests override single fields. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { scraperStrategy: 'demo', ...overrides };
}

function config(overrides: Record<string, unknown> = {}) {
  const parsed = parseUserConfig(body(overrides));
  if (!parsed.ok) throw new Error(`expected ok, got: ${parsed.error}`);
  return parsed.config;
}

describe('parseUserConfig', () => {
  it('rejects a non-object body as invalid JSON', () => {
    for (const bad of [null, undefined, 'string', 42]) {
      expect(parseUserConfig(bad)).toEqual({ ok: false, error: 'Invalid JSON body' });
    }
  });

  it('rejects an unknown or missing scraper strategy', () => {
    expect(parseUserConfig({})).toEqual({ ok: false, error: 'Invalid scraperStrategy' });
    expect(parseUserConfig({ scraperStrategy: 'selenium' })).toEqual({
      ok: false,
      error: 'Invalid scraperStrategy',
    });
  });

  it.each([
    ['explicit 0 disables filtering', 0, 0],
    ['a numeric string is honored', '60', 60],
    ['missing defaults to 50', undefined, 50],
    ['null defaults to 50', null, 50],
    ['NaN defaults to 50', 'not a number', 50],
    ['empty string defaults to 50, never "disable"', '', 50],
    ['whitespace string defaults to 50', '   ', 50],
    ['non-string non-number junk defaults to 50', [], 50],
    ['boolean junk defaults to 50', false, 50],
    ['negative clamps to 0', -10, 0],
    ['over 100 clamps to 100', 150, 100],
    ['fractional is floored', 72.9, 72],
  ])('scoreThreshold: %s', (_name, raw, expected) => {
    expect(config({ scoreThreshold: raw }).scoreThreshold).toBe(expected);
  });

  it('coerces string fields, defaulting the owner name when blank', () => {
    const parsed = config({ resumeLatex: '\\doc', ownerName: '  ' });
    expect(parsed.resumeLatex).toBe('\\doc');
    expect(parsed.sourceOfTruth).toBe('');
    expect(parsed.ownerName).toBe('Alex_Candidate');
    expect(config({ ownerName: ' Jane_Doe ' }).ownerName).toBe('Jane_Doe');
  });

  it('keeps only non-empty trimmed strings in the array fields', () => {
    const parsed = config({
      keywords: ['  ai engineer ', '', 42, 'ml'],
      locations: 'not an array',
    });
    expect(parsed.keywords).toEqual(['ai engineer', 'ml']);
    expect(parsed.locations).toEqual([]);
    expect(parsed.excludedTitleTerms).toEqual([]);
  });

  it('defaults the scoring backend to the local model (FR-6) and rejects unknown values', () => {
    expect(config({}).scoringBackend).toBe('ollama');
    expect(config({ scoringBackend: 'anthropic' }).scoringBackend).toBe('anthropic');
    expect(parseUserConfig(body({ scoringBackend: 'openai' }))).toEqual({
      ok: false,
      error: 'Invalid scoringBackend',
    });
  });

  it('defaults a missing or blank Ollama model tag and keeps a custom one', () => {
    expect(config({}).ollamaModel).toBe('qwen3:4b-instruct-2507-q4_K_M');
    expect(config({ ollamaModel: '   ' }).ollamaModel).toBe('qwen3:4b-instruct-2507-q4_K_M');
    expect(config({ ollamaModel: ' qwen3.5:9b ' }).ollamaModel).toBe('qwen3.5:9b');
  });

  it.each([
    ['boolean true enables', true, true],
    ['absent defaults to false', undefined, false],
    ['the string "true" is not a boolean', 'true', false],
    ['1 is not a boolean', 1, false],
    ['null defaults to false', null, false],
    ['boolean false stays false', false, false],
  ])('greenhouseEnabled: %s', (_name, raw, expected) => {
    expect(config({ greenhouseEnabled: raw }).greenhouseEnabled).toBe(expected);
  });

  it('coerces the cadence and lookback numbers to their documented floors', () => {
    const parsed = config({ runIntervalMinutes: -5, searchLookbackHours: 0 });
    expect(parsed.runIntervalMinutes).toBe(0);
    expect(parsed.searchLookbackHours).toBe(1);
    const other = config({ runIntervalMinutes: 30.9, searchLookbackHours: 24.5 });
    expect(other.runIntervalMinutes).toBe(30);
    expect(other.searchLookbackHours).toBe(24);
  });
});
