/**
 * Tests for the server-side RapidAPI key accessor — the "key-presence indicator
 * logic" the Setup UI surfaces (as a boolean, never the value). Each case saves
 * and restores process.env.RAPID_API_KEY so the cases stay isolated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getRapidApiKey, hasRapidApiKey } from './rapidapi';

const ORIGINAL = process.env.RAPID_API_KEY;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RAPID_API_KEY;
  else process.env.RAPID_API_KEY = ORIGINAL;
});

describe('getRapidApiKey / hasRapidApiKey', () => {
  it('reports a present, non-empty key', () => {
    process.env.RAPID_API_KEY = 'abc123';
    expect(getRapidApiKey()).toBe('abc123');
    expect(hasRapidApiKey()).toBe(true);
  });

  it('trims surrounding whitespace off the returned key', () => {
    process.env.RAPID_API_KEY = '  abc123  ';
    expect(getRapidApiKey()).toBe('abc123');
    expect(hasRapidApiKey()).toBe(true);
  });

  it('treats an unset variable as absent', () => {
    delete process.env.RAPID_API_KEY;
    expect(getRapidApiKey()).toBeUndefined();
    expect(hasRapidApiKey()).toBe(false);
  });

  it('treats an empty string as absent', () => {
    process.env.RAPID_API_KEY = '';
    expect(getRapidApiKey()).toBeUndefined();
    expect(hasRapidApiKey()).toBe(false);
  });

  it('treats a whitespace-only value as absent', () => {
    process.env.RAPID_API_KEY = '   ';
    expect(getRapidApiKey()).toBeUndefined();
    expect(hasRapidApiKey()).toBe(false);
  });
});
