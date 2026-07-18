import { describe, it, expect } from 'vitest';
import { createStrategy } from './strategy';
import { DemoStrategy } from './strategies/demo';
import { LinkedInStrategy } from './strategies/linkedin';

describe('createStrategy', () => {
  it('creates the Demo strategy', () => {
    expect(createStrategy('demo')).toBeInstanceOf(DemoStrategy);
  });

  it('creates the LinkedIn strategy', () => {
    expect(createStrategy('linkedin')).toBeInstanceOf(LinkedInStrategy);
  });

  it('passes options through to the LinkedIn strategy', () => {
    // A custom fetchFn should not throw at construction.
    const fetchFn = (async () => new Response('')) as unknown as typeof fetch;
    expect(() => createStrategy('linkedin', { linkedin: { fetchFn } })).not.toThrow();
  });

  it('throws a descriptive error for the not-yet-implemented Proxycurl fallback', () => {
    expect(() => createStrategy('proxycurl')).toThrow(/Proxycurl/);
  });
});
