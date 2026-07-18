/**
 * /tracker — applications in Approved or later status (FR-21–FR-24), most
 * recently changed first. Every status change is an undoable command.
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { TrackerClient } from './TrackerClient';

export const dynamic = 'force-dynamic';

export default function TrackerPage() {
  const db = getDb();
  const jobs = repo.listTrackerJobs(db);

  return (
    <main className="container wide">
      <p className="eyebrow">Pipeline</p>
      <h1>Tracker</h1>
      <p className="muted">Approved resumes and applications moving through the pipeline.</p>
      <TrackerClient jobs={jobs} />
    </main>
  );
}
