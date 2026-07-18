import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAnthropicClient } from './client';

describe('getAnthropicClient', () => {
  const original = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
  });

  it('throws a helpful error when the API key is not set', () => {
    expect(() => getAnthropicClient()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('returns a singleton once the key is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    const first = getAnthropicClient();
    const second = getAnthropicClient();
    expect(first).toBe(second);
  });
});
