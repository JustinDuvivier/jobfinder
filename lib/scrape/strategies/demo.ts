/**
 * Demo strategy — returns a static list of sample jobs with no backend
 * dependency. The returned jobs still pass through the full scrape pipeline
 * before being written to SQLite, so this exercises the whole path offline.
 *
 * Its records are already complete (description + salary), so `fetchDetail`
 * returns nothing to enrich.
 *
 * See jobfinder-docs.md "Strategy A — Demo".
 */
import type { ScraperStrategy } from '../strategy';
import type { RawJob } from '../pipeline';
import type { JobDetail } from '../linkedin-parser';
import type { SearchConfig } from '../search';

const SAMPLE_JOBS: readonly RawJob[] = [
  {
    jobId: 'demo-1001',
    title: 'AI Engineer',
    company: 'Stripe',
    location: 'New York, NY',
    salary: '$160,000 - $210,000/yr',
    description: 'Build and ship LLM-powered features across the payments stack.',
    url: 'https://www.linkedin.com/jobs/view/demo-1001',
    postedAt: '2026-06-18',
  },
  {
    jobId: 'demo-1002',
    title: 'Machine Learning Engineer',
    company: 'Anthropic',
    location: 'New York, NY',
    salary: '$200K - $260K per year',
    description: 'Train, evaluate, and deploy models for production inference.',
    url: 'https://www.linkedin.com/jobs/view/demo-1002',
    postedAt: '2026-06-18',
  },
  {
    jobId: 'demo-1003',
    title: 'Forward Deployed Engineer',
    company: 'Palantir',
    location: 'New Jersey',
    salary: '$150,000 - $190,000',
    description: 'Embed with customers to build data integrations and workflows.',
    url: 'https://www.linkedin.com/jobs/view/demo-1003',
    postedAt: '2026-06-17',
  },
];

export class DemoStrategy implements ScraperStrategy {
  readonly name = 'demo' as const;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *scrape(_config: SearchConfig, maxCount: number): AsyncIterable<RawJob> {
    let yielded = 0;
    for (const job of SAMPLE_JOBS) {
      if (yielded >= maxCount) return;
      yield { ...job };
      yielded++;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetchDetail(_jobId: string): Promise<JobDetail> {
    return {};
  }
}
