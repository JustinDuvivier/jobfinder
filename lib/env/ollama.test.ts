/**
 * Tests for the Ollama endpoint resolver — the single place the address comes
 * from. Each case saves and restores process.env.OLLAMA_BASE_URL so the cases
 * stay isolated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getOllamaBaseUrl, DEFAULT_OLLAMA_BASE_URL } from './ollama';

const ORIGINAL = process.env.OLLAMA_BASE_URL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = ORIGINAL;
});

describe('getOllamaBaseUrl', () => {
  it('defaults to the local 127.0.0.1 endpoint when unset', () => {
    delete process.env.OLLAMA_BASE_URL;
    expect(getOllamaBaseUrl()).toBe(DEFAULT_OLLAMA_BASE_URL);
    expect(getOllamaBaseUrl()).toBe('http://127.0.0.1:11434');
  });

  it('returns the configured endpoint when set', () => {
    process.env.OLLAMA_BASE_URL = 'http://ollama-host:11434';
    expect(getOllamaBaseUrl()).toBe('http://ollama-host:11434');
  });

  it('trims whitespace and drops trailing slashes so paths append cleanly', () => {
    process.env.OLLAMA_BASE_URL = '  http://host.docker.internal:11434/  ';
    expect(getOllamaBaseUrl()).toBe('http://host.docker.internal:11434');
  });

  it('treats an empty or whitespace-only value as unset', () => {
    process.env.OLLAMA_BASE_URL = '';
    expect(getOllamaBaseUrl()).toBe(DEFAULT_OLLAMA_BASE_URL);
    process.env.OLLAMA_BASE_URL = '   ';
    expect(getOllamaBaseUrl()).toBe(DEFAULT_OLLAMA_BASE_URL);
  });
});
