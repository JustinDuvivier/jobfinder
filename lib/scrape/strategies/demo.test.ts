import { describe, it, expect } from 'vitest';
import { DemoStrategy } from './demo';
import { DEFAULT_SEARCH_CONFIG } from '../search';
import type { RawJob } from '../pipeline';

async function collect(it: AsyncIterable<RawJob>): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for await (const job of it) out.push(job);
  return out;
}

describe('DemoStrategy', () => {
  it('is named "demo"', () => {
    expect(new DemoStrategy().name).toBe('demo');
  });

  it('yields complete sample jobs', async () => {
    const jobs = await collect(new DemoStrategy().scrape(DEFAULT_SEARCH_CONFIG, 100));
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job.jobId).toBeTruthy();
      expect(job.title).toBeTruthy();
      expect(job.company).toBeTruthy();
      expect(job.description).toBeTruthy(); // demo records are complete
    }
  });

  it('respects maxCount', async () => {
    const jobs = await collect(new DemoStrategy().scrape(DEFAULT_SEARCH_CONFIG, 2));
    expect(jobs).toHaveLength(2);
  });

  it('fetchDetail returns nothing to enrich', async () => {
    expect(await new DemoStrategy().fetchDetail('demo-1001')).toEqual({});
  });
});
