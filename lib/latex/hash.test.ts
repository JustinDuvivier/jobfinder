import { describe, it, expect } from 'vitest';
import { hashLatex } from './hash';

describe('hashLatex', () => {
  it('is deterministic for identical input', () => {
    expect(hashLatex('\\documentclass{article}')).toBe(hashLatex('\\documentclass{article}'));
  });

  it('differs for different input', () => {
    expect(hashLatex('a')).not.toBe(hashLatex('b'));
  });

  it('produces a 64-char hex SHA-256 string', () => {
    expect(hashLatex('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
