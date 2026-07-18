/**
 * Tests for the salary resolver — the single owner of the salary precedence
 * (explicit field → description prose → AI lookup) — and its deterministic
 * tiers, `normalizeSalary` and `extractSalaryFromText`.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  resolveSalary,
  resolveSalaryWithAi,
  normalizeSalary,
  extractSalaryFromText,
  type SalaryFacts,
  type ResolvedSalary,
} from './salary';

describe('resolveSalary precedence (deterministic tiers)', () => {
  it.each<[string, SalaryFacts, ResolvedSalary]>([
    [
      'a real field beats a prose match',
      { field: '$100k', description: 'pay range $200,000 - $250,000' },
      { salary: '$100,000', source: 'field' },
    ],
    [
      'prose is mined when the field is absent',
      { field: null, description: 'The base salary range is $140,000 - $175,000 per year.' },
      { salary: '$140,000 – $175,000', source: 'description' },
    ],
    [
      'a blank field falls through to prose',
      { field: '   ', description: 'Compensation: $90,000 - $100,000 per year.' },
      { salary: '$90,000 – $100,000', source: 'description' },
    ],
    [
      'a non-numeric field still wins (the normalizer passes it through)',
      { field: 'Competitive pay', description: 'base salary $150,000 per year' },
      { salary: 'Competitive pay', source: 'field' },
    ],
    [
      'prose without a pay signal yields none',
      { field: null, description: 'We process $5B in payments and raised $200M.' },
      { salary: null, source: 'none' },
    ],
    [
      'nothing anywhere yields none',
      { field: undefined, description: undefined },
      { salary: null, source: 'none' },
    ],
  ])('%s', (_label, facts, expected) => {
    expect(resolveSalary(facts)).toEqual(expected);
  });

  it('is idempotent over its own output, so re-resolving cannot corrupt a value', () => {
    const first = resolveSalary({ field: '$120K - $150K per year', description: null });
    const again = resolveSalary({ field: first.salary, description: null });
    expect(again.salary).toBe(first.salary);
  });
});

describe('resolveSalaryWithAi (the injected AI tier)', () => {
  it('does not consult the AI tier when the field resolves', async () => {
    const ai = vi.fn(async () => '$999,999');
    await expect(resolveSalaryWithAi({ field: '$120k', description: null }, ai)).resolves.toEqual({
      salary: '$120,000',
      source: 'field',
    });
    expect(ai).not.toHaveBeenCalled();
  });

  it('does not consult the AI tier when prose resolves', async () => {
    const ai = vi.fn(async () => '$999,999');
    const facts: SalaryFacts = { field: null, description: 'Pay range $90k - $110k /yr.' };
    await expect(resolveSalaryWithAi(facts, ai)).resolves.toEqual({
      salary: '$90,000 – $110,000',
      source: 'description',
    });
    expect(ai).not.toHaveBeenCalled();
  });

  it('fires the AI tier only when both deterministic tiers miss, normalizing its value', async () => {
    const ai = vi.fn(async () => '$120,000 - $150,000 per year');
    await expect(resolveSalaryWithAi({ field: null, description: null }, ai)).resolves.toEqual({
      salary: '$120,000 – $150,000',
      source: 'ai',
    });
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('yields none when the AI tier finds nothing', async () => {
    await expect(
      resolveSalaryWithAi({ field: null, description: null }, async () => null),
    ).resolves.toEqual({ salary: null, source: 'none' });
  });

  it('rejects AI prose without a dollar figure instead of persisting it as a salary', async () => {
    await expect(
      resolveSalaryWithAi(
        { field: null, description: null },
        async () => 'unable to verify a published range',
      ),
    ).resolves.toEqual({ salary: null, source: 'none' });
  });

  it('propagates an AI-tier error to the caller (the boundary maps it, e.g. to a 502)', async () => {
    await expect(
      resolveSalaryWithAi({ field: null, description: null }, async () => {
        throw new Error('web search unavailable');
      }),
    ).rejects.toThrow('web search unavailable');
  });

  it('yields none when no AI tier is injected', async () => {
    await expect(resolveSalaryWithAi({ field: null, description: null })).resolves.toEqual({
      salary: null,
      source: 'none',
    });
  });
});

describe('extractSalaryFromText', () => {
  it('returns null for empty or salary-free text', () => {
    expect(extractSalaryFromText(null)).toBeNull();
    expect(extractSalaryFromText('We are a fast-growing team with great culture.')).toBeNull();
  });

  it('pulls an explicit range out of prose', () => {
    expect(extractSalaryFromText('Comp is $120,000–$150,000 depending on experience.')).toBe(
      '$120,000–$150,000',
    );
    expect(extractSalaryFromText('Hiring range: $120k to $150k annually.')).toBe(
      '$120k to $150k annually',
    );
  });

  it('pulls a single amount that follows a pay keyword', () => {
    expect(extractSalaryFromText('The base salary for this role is $165,000 per year.')).toBe(
      '$165,000 per year',
    );
  });

  it('ignores unrelated figures with no pay context', () => {
    expect(
      extractSalaryFromText('We process $5B in payments and raised $200M in funding.'),
    ).toBeNull();
  });

  it('feeds normalizeSalary to a clean display value', () => {
    expect(normalizeSalary(extractSalaryFromText('Pay range $90k - $110k /yr.'))).toBe(
      '$90,000 – $110,000',
    );
  });
});

describe('normalizeSalary', () => {
  it('returns null for empty/absent input', () => {
    expect(normalizeSalary(null)).toBeNull();
    expect(normalizeSalary('   ')).toBeNull();
  });

  it('formats a single amount and drops the annual /yr suffix', () => {
    expect(normalizeSalary('$120,000/yr')).toBe('$120,000');
  });

  it('expands a K suffix and drops the annual suffix', () => {
    expect(normalizeSalary('$120K - $150K per year')).toBe('$120,000 – $150,000');
  });

  it('orders min before max regardless of input order', () => {
    expect(normalizeSalary('$150,000 to $120,000')).toBe('$120,000 – $150,000');
  });

  it('detects hourly and monthly periods', () => {
    expect(normalizeSalary('$50/hr')).toBe('$50/hr');
    expect(normalizeSalary('$8,000 - $10,000 monthly')).toBe('$8,000 – $10,000/mo');
  });

  it('returns the trimmed original when no dollar amount is present', () => {
    expect(normalizeSalary('Competitive   pay')).toBe('Competitive pay');
  });
});
