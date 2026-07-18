/**
 * /companies — the employer lens. Every scraped posting, grouped by company,
 * with per-company status breakdowns so you can see who you're targeting and
 * where each application stands. Blocking is wired to the same blocklist the
 * scraper consults, so a block here keeps future jobs out of the queue.
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { CompaniesClient, type CompanyGroup } from './CompaniesClient';
import type { JobStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default function CompaniesPage() {
  const db = getDb();
  const jobs = repo.listAllJobs(db);
  const blocked = new Set(repo.listBlockedCompanies(db));

  // Group by display company name (jobs already arrive company-ordered).
  const byCompany = new Map<string, CompanyGroup>();
  for (const job of jobs) {
    const key = job.company;
    let group = byCompany.get(key);
    if (!group) {
      group = { company: key, blocked: false, jobs: [] };
      byCompany.set(key, group);
    }
    group.jobs.push({
      id: job.id,
      title: job.title,
      status: job.status as JobStatus,
      score: job.score,
      location: job.location,
      url: job.url,
    });
  }

  // Mark blocked companies by normalized name (lowercase) match.
  const groups = [...byCompany.values()].map((g) => ({
    ...g,
    blocked: blocked.has(g.company.trim().toLowerCase()),
  }));

  return (
    <main className="container wide">
      <p className="eyebrow">Employer Lens</p>
      <h1>Companies</h1>
      <p className="muted">
        Every posting grouped by employer. Search, expand to see roles and where each one stands.
      </p>
      <CompaniesClient groups={groups} />
    </main>
  );
}
