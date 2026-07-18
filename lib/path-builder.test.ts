import { describe, it, expect } from 'vitest';
import { sep } from 'node:path';
import {
  buildResumePath,
  sanitizeSegment,
  formatDateFolder,
  disambiguator,
} from './path-builder';

const BASE = 'C:\\Users\\Alex\\Documents\\Claude\\Projects\\Extremely_Optimized_Resumes\\Jobs';

describe('sanitizeSegment', () => {
  it('replaces spaces with underscores', () => {
    expect(sanitizeSegment('AI Engineer')).toBe('AI_Engineer');
  });

  it('removes Windows-illegal characters', () => {
    expect(sanitizeSegment('AI/ML: Engineer?')).toBe('AIML_Engineer');
    expect(sanitizeSegment('a<b>c:d"e/f\\g|h?i*j')).toBe('abcdefghij');
  });

  it('preserves hyphens', () => {
    expect(sanitizeSegment('Front-End Engineer')).toBe('Front-End_Engineer');
  });

  it('collapses underscore and whitespace runs', () => {
    expect(sanitizeSegment('Senior   ML    Engineer')).toBe('Senior_ML_Engineer');
    expect(sanitizeSegment('A___B')).toBe('A_B');
  });

  it('strips leading/trailing dots, spaces, and underscores', () => {
    expect(sanitizeSegment('  Stripe.  ')).toBe('Stripe');
    expect(sanitizeSegment('...Acme...')).toBe('Acme');
    expect(sanitizeSegment('_Acme_')).toBe('Acme');
  });

  it('escapes reserved device names (case-insensitive)', () => {
    expect(sanitizeSegment('CON')).toBe('_CON');
    expect(sanitizeSegment('com1')).toBe('_com1');
    expect(sanitizeSegment('nul.txt')).toBe('_nul.txt');
  });

  it('does not escape names that merely contain a reserved token', () => {
    expect(sanitizeSegment('Condor')).toBe('Condor');
    expect(sanitizeSegment('Comcast')).toBe('Comcast');
  });

  it('returns empty string for input that sanitizes away', () => {
    expect(sanitizeSegment('   ')).toBe('');
    expect(sanitizeSegment('***')).toBe('');
  });
});

describe('formatDateFolder', () => {
  it('formats as YYYYMMDD so folders sort chronologically', () => {
    expect(formatDateFolder(new Date(2026, 5, 18))).toBe('20260618');
    expect(formatDateFolder(new Date(2026, 0, 5))).toBe('20260105');
  });

  it('orders correctly as strings', () => {
    const earlier = formatDateFolder(new Date(2026, 5, 18));
    const later = formatDateFolder(new Date(2026, 5, 25));
    expect(earlier < later).toBe(true);
  });
});

describe('disambiguator', () => {
  it('is deterministic for the same job id (stable re-approval, FR-20)', () => {
    expect(disambiguator('4012345678')).toBe(disambiguator('4012345678'));
  });

  it('differs for different job ids (collision-free distinct postings)', () => {
    expect(disambiguator('4012345678')).not.toBe(disambiguator('4012345679'));
  });

  it('is a 6-char lowercase hex string', () => {
    expect(disambiguator('anything')).toMatch(/^[0-9a-f]{6}$/);
  });
});

describe('buildResumePath — golden path', () => {
  // Golden reference: fixed inputs -> exact expected path. A deliberate change
  // to the layout should update this expectation in the same change.
  const built = buildResumePath({
    baseDir: BASE,
    jobId: '4012345678',
    company: 'Stripe',
    title: 'AI Engineer',
    ownerName: 'Alex_Candidate',
    date: new Date(2026, 5, 18),
  });
  const suffix = disambiguator('4012345678');

  it('produces the documented layout', () => {
    // Segments join with the platform separator (backslash on Windows, slash
    // in the Linux container) — the segment names themselves are identical
    // everywhere.
    expect(built.dateFolder).toBe('20260618');
    expect(built.jobFolder).toBe(`Stripe_AI_Engineer_${suffix}`);
    expect(built.fileName).toBe('Alex_Candidate_Resume.pdf');
    expect(built.filePath).toBe(
      `${BASE}${sep}20260618${sep}Stripe_AI_Engineer_${suffix}${sep}Alex_Candidate_Resume.pdf`,
    );
    expect(built.relativePath).toBe(
      `20260618${sep}Stripe_AI_Engineer_${suffix}${sep}Alex_Candidate_Resume.pdf`,
    );
  });
});

describe('buildResumePath — collision behavior', () => {
  it('two roles at the same company on the same day get different folders', () => {
    const a = buildResumePath({
      baseDir: BASE, jobId: '1', company: 'Stripe', title: 'AI Engineer',
      ownerName: 'Alex_Candidate', date: new Date(2026, 5, 18),
    });
    const b = buildResumePath({
      baseDir: BASE, jobId: '2', company: 'Stripe', title: 'Backend Engineer',
      ownerName: 'Alex_Candidate', date: new Date(2026, 5, 18),
    });
    expect(a.jobFolder).not.toBe(b.jobFolder);
  });

  it('two distinct postings with identical company+title still differ (disambiguator)', () => {
    const a = buildResumePath({
      baseDir: BASE, jobId: 'req-aaa', company: 'BigCo', title: 'SWE',
      ownerName: 'Alex_Candidate', date: new Date(2026, 5, 18),
    });
    const b = buildResumePath({
      baseDir: BASE, jobId: 'req-bbb', company: 'BigCo', title: 'SWE',
      ownerName: 'Alex_Candidate', date: new Date(2026, 5, 18),
    });
    expect(a.jobFolder).not.toBe(b.jobFolder);
  });

  it('re-approving the same job maps to the same path (intentional overwrite)', () => {
    const args = {
      baseDir: BASE, jobId: '4012345678', company: 'Stripe', title: 'AI Engineer',
      ownerName: 'Alex_Candidate', date: new Date(2026, 5, 18),
    };
    expect(buildResumePath(args).filePath).toBe(buildResumePath(args).filePath);
  });
});

describe('buildResumePath — MAX_PATH guard', () => {
  it('keeps the full path under MAX_PATH (260) and preserves the disambiguator', () => {
    const built = buildResumePath({
      baseDir: BASE,
      jobId: 'long-job-id-123',
      company: 'A'.repeat(200),
      title: 'B'.repeat(200),
      ownerName: 'Alex_Candidate',
      date: new Date(2026, 5, 18),
    });
    expect(built.filePath.length).toBeLessThan(260);
    // Disambiguator suffix is never truncated away.
    expect(built.jobFolder.endsWith(disambiguator('long-job-id-123'))).toBe(true);
  });

  it('falls back to a disambiguator-only folder when nothing else fits', () => {
    // A pathologically long (but still writable) base: long enough to squeeze
    // companyTitle to nothing, short enough that the disambiguator-only path
    // still fits under MAX_PATH. (The design assumes a ~75-char base.)
    const built = buildResumePath({
      baseDir: 'C:\\' + 'd'.repeat(222),
      jobId: 'x',
      company: 'Company',
      title: 'Title',
      ownerName: 'Owner',
      date: new Date(2026, 5, 18),
    });
    expect(built.jobFolder).toBe(disambiguator('x'));
    expect(built.filePath.length).toBeLessThan(260);
  });
});

describe('buildResumePath — owner fallback', () => {
  it('falls back to "Resume" when the owner sanitizes away', () => {
    const built = buildResumePath({
      baseDir: BASE, jobId: '1', company: 'Stripe', title: 'AI Engineer',
      ownerName: '***', date: new Date(2026, 5, 18),
    });
    expect(built.fileName).toBe('Resume_Resume.pdf');
  });
});
