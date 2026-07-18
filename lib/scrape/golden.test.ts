/**
 * Golden-master tests for the deterministic scrape-HTML → normalized-Job and
 * detail-HTML → JobDetail transforms — the primary golden files called out in
 * CLAUDE.md.
 *
 * The fixtures are real LinkedIn guest-API responses (randomly sampled live
 * jobs, captured verbatim on 2026-07-11 — see the header comment in each
 * fixture). The tests run the parsers on them and compare against the
 * committed golden JSON. When a change intentionally alters the output,
 * update the golden files deliberately and review the diff in the same
 * change — never auto-overwrite them just to make these tests pass.
 * Synthetic edge cases (missing fields, non-card <li>s) are covered in
 * linkedin-parser.test.ts and pipeline.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJobCards, parseJobDetail, type JobDetail } from './linkedin-parser';
import { parseFields, type NormalizedJob } from './pipeline';

const GOLDEN_DIR = join(process.cwd(), 'golden');

/** The detail fixtures: one with criteria + applicants only, one with salary
 * in description prose only, one with a dedicated salary block. */
const DETAIL_FIXTURE_IDS = ['4439394341', '4411824326', '4439558832'] as const;

function readFixture(name: string): string {
  return readFileSync(join(GOLDEN_DIR, 'fixtures', name), 'utf8');
}

function loadGolden<T>(name: string): T {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8')) as T;
}

/** Parse the fixture HTML and field-normalize, dropping incomplete cards. */
function parseCardsFixture(): NormalizedJob[] {
  return parseJobCards(readFixture('search-cards.html'))
    .map(parseFields)
    .filter((job): job is NormalizedJob => job !== null);
}

describe('golden: jobs.parse', () => {
  it('matches the committed golden Job[] exactly', () => {
    expect(parseCardsFixture()).toEqual(loadGolden<NormalizedJob[]>('jobs.parse.golden.json'));
  });

  it('parses every card in the real response (10 complete cards)', () => {
    expect(parseCardsFixture()).toHaveLength(10);
  });
});

describe('golden: job-detail.parse', () => {
  it('matches the committed golden JobDetail map exactly', () => {
    const parsed = Object.fromEntries(
      DETAIL_FIXTURE_IDS.map((id) => [id, parseJobDetail(readFixture(`job-detail-${id}.html`))]),
    );
    expect(parsed).toEqual(loadGolden<Record<string, JobDetail>>('job-detail.golden.json'));
  });

  it('captures the dedicated salary block where the employer disclosed one', () => {
    const detail = parseJobDetail(readFixture('job-detail-4439558832.html'));
    expect(detail.salary).toBe('$135,000.00/yr - $175,000.00/yr');
  });

  it('preserves description structure (paragraph breaks and bullets)', () => {
    const detail = parseJobDetail(readFixture('job-detail-4439394341.html'));
    expect(detail.description).toContain('\n\n');
    expect(detail.description).toContain('\n- ');
  });
});
