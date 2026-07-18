import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GreenhouseStrategy,
  mapActiveAtsResponse,
  timeFrameForLookback,
  ACTIVE_ATS_ENDPOINT,
} from './greenhouse';
import type { RawJob } from '../pipeline';

async function collect(it: AsyncIterable<RawJob>): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for await (const job of it) out.push(job);
  return out;
}

/** One Active Jobs DB item with the fields the mapper reads. */
function item(id: number | string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Software Engineer ${id}`,
    organization: `Org ${id}`,
    url: `https://boards.greenhouse.io/org/jobs/${id}`,
    locations_derived: ['New York, New York, United States'],
    date_posted: '2026-07-13T16:00:00',
    description_text: `Build things at Org ${id}.`,
    ...overrides,
  };
}

/** JSON Response, mirroring how the live endpoint replies with a bare array. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Build a mock fetch serving pages keyed by (title, location, offset). Each key
 * maps to the array of ids on that page; an unlisted key serves an empty page.
 */
interface PageKey {
  title: string;
  location: string;
  offset: number;
}
function pagedFetch(pageFor: (key: PageKey) => Array<number | string>): typeof fetch {
  return (async (url: string) => {
    const u = new URL(url);
    const ids = pageFor({
      title: u.searchParams.get('title') ?? '',
      location: u.searchParams.get('location') ?? '',
      offset: Number(u.searchParams.get('offset') ?? '0'),
    });
    return jsonResponse(ids.map((id) => item(id)));
  }) as unknown as typeof fetch;
}

const noopSleep = async () => {};
const oneSearch = { keywords: ['A'], locations: ['X'] };
const baseOpts = { apiKey: 'test-key', sleep: noopSleep };

describe('mapActiveAtsResponse', () => {
  it('namespaces the id as gh:<id> and always populates the real Greenhouse url', () => {
    const jobs = mapActiveAtsResponse([
      item(2255394709, { url: 'https://boards.greenhouse.io/cloudflare/jobs/7377424?gh_jid=7377424' }),
    ]);
    expect(jobs).toEqual([
      {
        jobId: 'gh:2255394709',
        title: 'Software Engineer 2255394709',
        company: 'Org 2255394709',
        url: 'https://boards.greenhouse.io/cloudflare/jobs/7377424?gh_jid=7377424',
        location: 'New York, New York, United States',
        description: 'Build things at Org 2255394709.',
        postedAt: '2026-07-13T16:00:00',
      },
    ]);
  });

  it('maps organization → company and description_text → description', () => {
    const [job] = mapActiveAtsResponse([
      item(1, { organization: 'Anthropic', description_text: 'Safety research tooling.' }),
    ]);
    expect(job.company).toBe('Anthropic');
    expect(job.description).toBe('Safety research tooling.');
  });

  it('uses the first derived location string', () => {
    const [job] = mapActiveAtsResponse([
      item(1, { locations_derived: ['Boston, Massachusetts, United States', 'Remote'] }),
    ]);
    expect(job.location).toBe('Boston, Massachusetts, United States');
  });

  it('maps a string salary and omits salary when absent/null', () => {
    const [withSalary] = mapActiveAtsResponse([item(1, { salary: '$150,000 - $190,000' })]);
    expect(withSalary.salary).toBe('$150,000 - $190,000');
    const [withoutSalary] = mapActiveAtsResponse([item(2, { salary: null })]);
    expect('salary' in withoutSalary).toBe(false);
  });

  it('drops items with no id and omits empty/whitespace fields', () => {
    const jobs = mapActiveAtsResponse([
      { title: 'No id', organization: 'X', url: 'https://x' },
      item(5, { title: '   ', locations_derived: [], description_text: '' }),
    ]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobId).toBe('gh:5');
    expect('title' in jobs[0]).toBe(false);
    expect('location' in jobs[0]).toBe(false);
    expect('description' in jobs[0]).toBe(false);
  });

  it('returns [] for non-array input', () => {
    expect(mapActiveAtsResponse(null)).toEqual([]);
    expect(mapActiveAtsResponse({ error: 'nope' })).toEqual([]);
  });
});

describe('timeFrameForLookback', () => {
  it('buckets hours into the smallest covering time_frame', () => {
    expect(timeFrameForLookback(1)).toBe('1h');
    expect(timeFrameForLookback(2)).toBe('24h');
    expect(timeFrameForLookback(24)).toBe('24h');
    expect(timeFrameForLookback(48)).toBe('7d');
    expect(timeFrameForLookback(24 * 30)).toBe('6m');
  });

  it('falls back to the default bucket for non-positive/NaN input', () => {
    expect(timeFrameForLookback(0)).toBe('1h');
    expect(timeFrameForLookback(Number.NaN)).toBe('1h');
  });
});

describe('GreenhouseStrategy.scrape — request construction', () => {
  it('sends the Bearer key and the greenhouse/text/time_frame params', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      expect(u.origin + u.pathname).toBe(ACTIVE_ATS_ENDPOINT);
      expect(u.searchParams.get('source')).toBe('greenhouse');
      expect(u.searchParams.get('description_format')).toBe('text');
      expect(u.searchParams.get('time_frame')).toBe('24h');
      expect(u.searchParams.get('title')).toBe('AI Engineer');
      expect(u.searchParams.get('location')).toBe('New York');
      expect(u.searchParams.get('limit')).toBe('100');
      expect(u.searchParams.get('offset')).toBe('0');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer secret-123');
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    const strategy = new GreenhouseStrategy({
      fetchFn,
      sleep: noopSleep,
      apiKey: 'secret-123',
      lookbackHours: 24,
      pageSize: 100,
    });
    await collect(strategy.scrape({ keywords: ['AI Engineer'], locations: ['New York'] }, 10));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('GreenhouseStrategy.scrape — pagination', () => {
  it('walks offsets by pageSize until a short/empty page ends the search', async () => {
    const fetchFn = pagedFetch(({ offset }) => {
      if (offset === 0) return [1, 2]; // full page (pageSize 2) → keep going
      if (offset === 2) return [3]; // short page → last page
      return [];
    });
    const strategy = new GreenhouseStrategy({ ...baseOpts, fetchFn, pageSize: 2 });
    const jobs = await collect(strategy.scrape(oneSearch, 100));
    expect(jobs.map((j) => j.jobId)).toEqual(['gh:1', 'gh:2', 'gh:3']);
  });

  it('stops at maxCount mid-page', async () => {
    const fetchFn = pagedFetch(({ offset }) => (offset === 0 ? [1, 2, 3, 4, 5] : []));
    const strategy = new GreenhouseStrategy({ ...baseOpts, fetchFn, pageSize: 10 });
    const jobs = await collect(strategy.scrape(oneSearch, 2));
    expect(jobs).toHaveLength(2);
  });
});

describe('GreenhouseStrategy.scrape — dedup across searches (FR-3)', () => {
  it('yields each job id once even when multiple searches surface it', async () => {
    // 2 keywords × 1 location = 2 searches, both returning the same ids.
    const fetchFn = pagedFetch(({ offset }) => (offset === 0 ? [10, 20] : []));
    const strategy = new GreenhouseStrategy({ ...baseOpts, fetchFn, pageSize: 10 });
    const jobs = await collect(strategy.scrape({ keywords: ['A', 'B'], locations: ['X'] }, 100));
    expect(jobs.map((j) => j.jobId)).toEqual(['gh:10', 'gh:20']);
  });
});

describe('GreenhouseStrategy.scrape — 429 backoff', () => {
  it('retries after a 429 and then succeeds', async () => {
    let calls = 0;
    const fetchFn = (async (url: string) => {
      const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
      if (offset === 0 && calls++ === 0) {
        return new Response('', { status: 429, headers: { 'retry-after': '1' } });
      }
      return jsonResponse(offset === 0 ? [item(99)] : []);
    }) as unknown as typeof fetch;
    const sleep = vi.fn(async () => {});
    const strategy = new GreenhouseStrategy({ apiKey: 'k', fetchFn, sleep, pageSize: 10 });
    const jobs = await collect(strategy.scrape(oneSearch, 100));
    expect(jobs.map((j) => j.jobId)).toEqual(['gh:99']);
    expect(sleep).toHaveBeenCalled();
  });

  it('throws after exhausting retries', async () => {
    const fetchFn = (async () => new Response('', { status: 429 })) as unknown as typeof fetch;
    const strategy = new GreenhouseStrategy({ ...baseOpts, fetchFn, maxRetries: 2 });
    await expect(collect(strategy.scrape(oneSearch, 100))).rejects.toThrow(/429/);
  });
});

describe('GreenhouseStrategy.scrape — error handling', () => {
  it('treats a non-ok status as the end of the search rather than aborting', async () => {
    const fetchFn = (async () => new Response('err', { status: 500 })) as unknown as typeof fetch;
    const strategy = new GreenhouseStrategy({ ...baseOpts, fetchFn });
    expect(await collect(strategy.scrape(oneSearch, 100))).toEqual([]);
  });

  it('treats a malformed JSON body as the end of the search', async () => {
    const fetchFn = (async () =>
      new Response('not json', { status: 200 })) as unknown as typeof fetch;
    const strategy = new GreenhouseStrategy({ ...baseOpts, fetchFn });
    expect(await collect(strategy.scrape(oneSearch, 100))).toEqual([]);
  });
});

describe('GreenhouseStrategy.fetchDetail', () => {
  it('is a no-op returning an empty object (search response is complete)', async () => {
    const strategy = new GreenhouseStrategy({ ...baseOpts, fetchFn: vi.fn() as unknown as typeof fetch });
    expect(await strategy.fetchDetail('gh:123')).toEqual({});
  });
});

/**
 * Golden round-trip: the fixture is a real Active Jobs DB response captured on
 * 2026-07-13 (source=greenhouse; see the fixture's `capture` header). Running the
 * mapper on its verbatim `response` items must reproduce the committed golden
 * RawJob[] exactly. When the mapping intentionally changes, update the golden
 * deliberately and review the diff — never auto-overwrite it to pass.
 */
describe('golden: greenhouse.parse', () => {
  const GOLDEN_DIR = join(process.cwd(), 'golden');
  const fixture = JSON.parse(
    readFileSync(join(GOLDEN_DIR, 'fixtures', 'greenhouse-active-ats.json'), 'utf8'),
  ) as { response: unknown };
  const golden = JSON.parse(
    readFileSync(join(GOLDEN_DIR, 'greenhouse.parse.golden.json'), 'utf8'),
  ) as RawJob[];

  it('matches the committed golden RawJob[] exactly', () => {
    expect(mapActiveAtsResponse(fixture.response)).toEqual(golden);
  });

  it('every mapped job is namespaced gh: and carries a real greenhouse.io url', () => {
    const jobs = mapActiveAtsResponse(fixture.response);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job.jobId).toMatch(/^gh:/);
      expect(job.url).toMatch(/greenhouse\.io/);
    }
  });
});
