import { describe, it, expect } from 'vitest';
import { fmtTokens, fmtUsd, fmtTimestamp } from './format';

describe('fmtTokens', () => {
  it('passes small counts through', () => {
    expect(fmtTokens(0)).toBe('0');
    expect(fmtTokens(999)).toBe('999');
  });

  it('abbreviates thousands and millions', () => {
    expect(fmtTokens(1_000)).toBe('1.0k');
    expect(fmtTokens(4_250)).toBe('4.3k');
    expect(fmtTokens(3_400_000)).toBe('3.4M');
  });
});

describe('fmtUsd', () => {
  it('uses two decimals at a cent and above, and for zero', () => {
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(0.01)).toBe('$0.01');
    expect(fmtUsd(1.5)).toBe('$1.50');
  });

  it('uses four decimals for sub-cent amounts', () => {
    expect(fmtUsd(0.0018)).toBe('$0.0018');
    expect(fmtUsd(0.0099)).toBe('$0.0099');
  });
});

describe('fmtTimestamp', () => {
  it('parses the SQLite UTC format into a short local date + time', () => {
    // Exact output is locale/timezone-dependent; assert shape, not bytes.
    const out = fmtTimestamp('2026-07-11 18:30:00');
    expect(out).toMatch(/Jul/);
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });

  it('falls back to the raw string when unparseable', () => {
    expect(fmtTimestamp('not-a-date')).toBe('not-a-date');
  });
});
