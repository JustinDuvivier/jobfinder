import { describe, it, expect, vi } from 'vitest';
import { LinkedInStrategy } from './linkedin';
import type { RawJob } from '../pipeline';

async function collect(it: AsyncIterable<RawJob>): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for await (const job of it) out.push(job);
  return out;
}

/** Render a guest search page containing one card per id. */
function searchPage(ids: string[]): string {
  return ids
    .map(
      (id) =>
        `<li><div data-entity-urn="urn:li:jobPosting:${id}">` +
        `<a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/role-${id}"></a>` +
        `<h3 class="base-search-card__title">Role ${id}</h3>` +
        `<h4 class="base-search-card__subtitle">Co ${id}</h4>` +
        `</div></li>`,
    )
    .join('');
}

interface PageKey {
  keywords: string;
  location: string;
  start: number;
}

/** Build a mock fetch that serves search pages from a (search,start) → ids map. */
function searchFetch(pageFor: (key: PageKey) => string[]): typeof fetch {
  return (async (url: string) => {
    const u = new URL(url);
    const ids = pageFor({
      keywords: u.searchParams.get('keywords') ?? '',
      location: u.searchParams.get('location') ?? '',
      start: Number(u.searchParams.get('start') ?? '0'),
    });
    return new Response(searchPage(ids), { status: 200 });
  }) as unknown as typeof fetch;
}

const noopSleep = async () => {};
const oneSearch = { keywords: ['A'], locations: ['X'] };

describe('LinkedInStrategy.scrape — pagination', () => {
  it('walks pages until an empty page ends the search', async () => {
    const fetchFn = searchFetch(({ start }) => {
      if (start === 0) return ['s0a', 's0b'];
      if (start === 25) return ['s25a'];
      return [];
    });
    const strategy = new LinkedInStrategy({ fetchFn, sleep: noopSleep });
    const jobs = await collect(strategy.scrape(oneSearch, 100));
    expect(jobs.map((j) => j.jobId)).toEqual(['s0a', 's0b', 's25a']);
  });

  it('stops at maxCount mid-page', async () => {
    const fetchFn = searchFetch(({ start }) => (start === 0 ? ['a', 'b', 'c', 'd', 'e'] : []));
    const strategy = new LinkedInStrategy({ fetchFn, sleep: noopSleep });
    const jobs = await collect(strategy.scrape(oneSearch, 2));
    expect(jobs).toHaveLength(2);
  });
});

describe('LinkedInStrategy.scrape — dedup across searches (FR-3)', () => {
  it('yields each job id once even when multiple searches surface it', async () => {
    // 2 keywords × 1 location = 2 searches, both returning the same ids on page 0.
    const fetchFn = searchFetch(({ start }) => (start === 0 ? ['dup1', 'dup2'] : []));
    const strategy = new LinkedInStrategy({
      fetchFn,
      sleep: noopSleep,
    });
    const jobs = await collect(strategy.scrape({ keywords: ['A', 'B'], locations: ['X'] }, 100));
    expect(jobs.map((j) => j.jobId)).toEqual(['dup1', 'dup2']);
  });
});

describe('LinkedInStrategy.scrape — 429 backoff', () => {
  it('retries after a 429 and then succeeds', async () => {
    let calls = 0;
    const fetchFn = (async (url: string) => {
      const u = new URL(url);
      const start = Number(u.searchParams.get('start') ?? '0');
      if (start === 0 && calls++ === 0) {
        return new Response('', { status: 429, headers: { 'retry-after': '1' } });
      }
      return new Response(searchPage(start === 0 ? ['ok1'] : []), { status: 200 });
    }) as unknown as typeof fetch;
    const sleep = vi.fn(async () => {});
    const strategy = new LinkedInStrategy({ fetchFn, sleep });
    const jobs = await collect(strategy.scrape(oneSearch, 100));
    expect(jobs.map((j) => j.jobId)).toEqual(['ok1']);
    expect(sleep).toHaveBeenCalled(); // backed off at least once
  });

  it('throws after exhausting retries', async () => {
    const fetchFn = (async () =>
      new Response('', { status: 429 })) as unknown as typeof fetch;
    const strategy = new LinkedInStrategy({ fetchFn, sleep: noopSleep, maxRetries: 2 });
    await expect(collect(strategy.scrape(oneSearch, 100))).rejects.toThrow(/429/);
  });
});

describe('LinkedInStrategy.scrape — non-429 errors', () => {
  it('treats a non-ok status as the end of the search rather than aborting', async () => {
    const fetchFn = (async () =>
      new Response('error', { status: 500 })) as unknown as typeof fetch;
    const strategy = new LinkedInStrategy({ fetchFn, sleep: noopSleep });
    const jobs = await collect(strategy.scrape(oneSearch, 100));
    expect(jobs).toEqual([]);
  });
});

describe('LinkedInStrategy.fetchDetail', () => {
  it('parses description and salary from the detail page', async () => {
    const detailHtml = `
      <div class="description__text">
        <div class="show-more-less-html__markup">Build LLM features for payments.</div>
      </div>
      <div class="salary compensation__salary">$160,000 - $210,000</div>
    `;
    const fetchFn = (async () =>
      new Response(detailHtml, { status: 200 })) as unknown as typeof fetch;
    const strategy = new LinkedInStrategy({ fetchFn, sleep: noopSleep });
    const detail = await strategy.fetchDetail('4012345678');
    expect(detail.description).toContain('Build LLM features for payments.');
    expect(detail.salary).toContain('$160,000');
  });

  it('returns an empty object on a non-ok detail response', async () => {
    const fetchFn = (async () =>
      new Response('', { status: 404 })) as unknown as typeof fetch;
    const strategy = new LinkedInStrategy({ fetchFn, sleep: noopSleep });
    expect(await strategy.fetchDetail('x')).toEqual({});
  });
});
