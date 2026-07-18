/**
 * normalizeCompanyName is the equality key for the blocklist (pipeline filter +
 * blocked_companies rows) and for company comparison generally, so these tests
 * pin the canonical form exactly: trim, collapse internal whitespace,
 * lowercase — and nothing else. Punctuation is deliberately preserved, so
 * "Acme, Inc." and "Acme Inc" remain distinct companies; a false positive here
 * would silently drop scrapable jobs, a false negative would let a blocked
 * company through to cost scoring tokens.
 */
import { describe, it, expect } from 'vitest';
import { normalizeCompanyName } from './companies';

describe('normalizeCompanyName', () => {
  it('lowercases', () => {
    expect(normalizeCompanyName('STRIPE')).toBe('stripe');
    expect(normalizeCompanyName('McKinsey & Company')).toBe('mckinsey & company');
  });

  it('trims and collapses internal whitespace', () => {
    expect(normalizeCompanyName('  Acme   Corp  ')).toBe('acme corp');
    expect(normalizeCompanyName('\tAcme\n\nCorp ')).toBe('acme corp');
  });

  it('is idempotent', () => {
    const once = normalizeCompanyName('  Acme   Corp  ');
    expect(normalizeCompanyName(once)).toBe(once);
  });

  it('matches casing and whitespace variants of the same company', () => {
    const variants = ['Acme Corp', 'acme corp', 'ACME CORP', ' Acme  Corp '];
    const keys = new Set(variants.map(normalizeCompanyName));
    expect(keys.size).toBe(1);
  });

  it('preserves punctuation, so punctuation variants stay distinct', () => {
    expect(normalizeCompanyName('Acme, Inc.')).toBe('acme, inc.');
    expect(normalizeCompanyName('Acme, Inc.')).not.toBe(normalizeCompanyName('Acme Inc'));
  });

  it('does not conflate different companies', () => {
    expect(normalizeCompanyName('Stripe')).not.toBe(normalizeCompanyName('Striped'));
    expect(normalizeCompanyName('Acme Corp')).not.toBe(normalizeCompanyName('Acme Corporation'));
  });

  it('normalizes empty and whitespace-only names to the empty string', () => {
    expect(normalizeCompanyName('')).toBe('');
    expect(normalizeCompanyName('   \t\n')).toBe('');
  });
});
