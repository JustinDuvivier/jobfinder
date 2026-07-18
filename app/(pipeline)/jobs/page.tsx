/**
 * /jobs — the decision queue (FR-9). Loads only jobs awaiting a decision
 * (new/scored), newest first. Scrape/score run live over SSE; pass/continue are
 * small command writes.
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { JobsClient } from './JobsClient';

export const dynamic = 'force-dynamic';

export default function JobsPage() {
  const db = getDb();
  const jobs = repo.listDecisionQueue(db, 100);
  const config = repo.getUserConfig(db);

  return (
    <main className="container wide">
      <p className="eyebrow">Decision Queue</p>
      <h1>Jobs</h1>
      <p className="muted">Scrape fresh postings, score them for fit, then pass or pursue.</p>
      <JobsClient
        initialJobs={jobs}
        configured={config !== undefined}
        runIntervalMinutes={config?.runIntervalMinutes ?? 0}
      />
    </main>
  );
}
