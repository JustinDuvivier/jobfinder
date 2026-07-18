/**
 * Tests for the Settings scoring-dropdown mapping (FR-6b) — the lossless
 * round-trip between the four dropdown options and the two persisted config
 * fields, plus the pull-progress formatter.
 */
import { describe, it, expect } from 'vitest';
import {
  CURATED_OLLAMA_MODELS,
  DEFAULT_OLLAMA_MODEL,
  LARGE_OLLAMA_MODEL,
} from '@/lib/ai/models';
import type { PullProgress } from '@/lib/ai/ollama-pull';
import {
  choiceFromConfig,
  configFromChoice,
  formatPullProgress,
  localTagForChoice,
  type ScoringConfig,
} from './scoring-choice';

const CUSTOM_TAG = 'llama3.1:8b-instruct-q4_K_M';

describe('the curated list', () => {
  it('offers exactly the small default (recommended) and the tuned 27B', () => {
    expect(CURATED_OLLAMA_MODELS.map((m) => m.tag)).toEqual([
      DEFAULT_OLLAMA_MODEL,
      LARGE_OLLAMA_MODEL,
    ]);
    expect(CURATED_OLLAMA_MODELS.filter((m) => m.recommended).map((m) => m.tag)).toEqual([
      DEFAULT_OLLAMA_MODEL,
    ]);
  });

  it('labels the 27B with its download size and GPU guidance', () => {
    const large = CURATED_OLLAMA_MODELS.find((m) => m.tag === LARGE_OLLAMA_MODEL);
    expect(large?.pullSize).toContain('11 GB');
    expect(large?.hardware).toMatch(/16 GB GPU/);
    expect(large?.hardware).toMatch(/slow on CPU/i);
  });
});

describe('choiceFromConfig', () => {
  it('maps the Anthropic backend to the Claude option regardless of tag', () => {
    expect(choiceFromConfig({ scoringBackend: 'anthropic', ollamaModel: CUSTOM_TAG })).toBe(
      'anthropic',
    );
  });

  it('maps ollama + a curated tag to that curated option', () => {
    expect(choiceFromConfig({ scoringBackend: 'ollama', ollamaModel: DEFAULT_OLLAMA_MODEL })).toBe(
      DEFAULT_OLLAMA_MODEL,
    );
    expect(choiceFromConfig({ scoringBackend: 'ollama', ollamaModel: LARGE_OLLAMA_MODEL })).toBe(
      LARGE_OLLAMA_MODEL,
    );
  });

  it('maps ollama + any other tag to the custom option', () => {
    expect(choiceFromConfig({ scoringBackend: 'ollama', ollamaModel: CUSTOM_TAG })).toBe('custom');
  });
});

describe('configFromChoice', () => {
  it('persists a curated selection as ollama + that exact tag', () => {
    expect(configFromChoice(LARGE_OLLAMA_MODEL, CUSTOM_TAG)).toEqual({
      scoringBackend: 'ollama',
      ollamaModel: LARGE_OLLAMA_MODEL,
    });
  });

  it('persists the custom selection with the trimmed typed tag, defaulting when blank', () => {
    expect(configFromChoice('custom', `  ${CUSTOM_TAG}  `)).toEqual({
      scoringBackend: 'ollama',
      ollamaModel: CUSTOM_TAG,
    });
    expect(configFromChoice('custom', '   ')).toEqual({
      scoringBackend: 'ollama',
      ollamaModel: DEFAULT_OLLAMA_MODEL,
    });
  });

  it('the Claude option keeps the tag, so switching to Claude and back loses nothing', () => {
    expect(configFromChoice('anthropic', CUSTOM_TAG)).toEqual({
      scoringBackend: 'anthropic',
      ollamaModel: CUSTOM_TAG,
    });
  });

  it('round-trips every existing install losslessly', () => {
    const stored: ScoringConfig[] = [
      { scoringBackend: 'ollama', ollamaModel: DEFAULT_OLLAMA_MODEL },
      { scoringBackend: 'ollama', ollamaModel: LARGE_OLLAMA_MODEL },
      { scoringBackend: 'ollama', ollamaModel: CUSTOM_TAG },
      { scoringBackend: 'anthropic', ollamaModel: CUSTOM_TAG },
    ];
    for (const config of stored) {
      expect(configFromChoice(choiceFromConfig(config), config.ollamaModel)).toEqual(config);
    }
  });
});

describe('localTagForChoice', () => {
  it('is the curated tag, the trimmed custom tag, or null for Claude', () => {
    expect(localTagForChoice(DEFAULT_OLLAMA_MODEL, CUSTOM_TAG)).toBe(DEFAULT_OLLAMA_MODEL);
    expect(localTagForChoice('custom', ` ${CUSTOM_TAG} `)).toBe(CUSTOM_TAG);
    expect(localTagForChoice('anthropic', CUSTOM_TAG)).toBeNull();
  });
});

describe('formatPullProgress', () => {
  const base: PullProgress = {
    tag: DEFAULT_OLLAMA_MODEL,
    status: 'pulling manifest',
    completed: null,
    total: null,
    done: false,
    error: null,
  };

  it('renders byte counts with a percentage when Ollama reports them', () => {
    expect(formatPullProgress({ ...base, completed: 1_200_000_000, total: 11_000_000_000 })).toBe(
      '1.2 GB / 11.0 GB (11%)',
    );
  });

  it('caps the percentage at 100 and falls back to the status text otherwise', () => {
    expect(formatPullProgress({ ...base, completed: 12_000_000_000, total: 11_000_000_000 })).toBe(
      '12.0 GB / 11.0 GB (100%)',
    );
    expect(formatPullProgress(base)).toBe('pulling manifest');
    expect(formatPullProgress({ ...base, completed: 5, total: 0 })).toBe('pulling manifest');
  });
});
