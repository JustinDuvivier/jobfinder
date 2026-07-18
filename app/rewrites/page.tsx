/**
 * /rewrites — there is no standalone list anymore. Tailoring happens strictly on
 * the /rewrite/[id] page, which carries its own in-page navigator to scroll
 * between the jobs waiting in the rewrite queue. This route simply forwards to
 * the first job in that queue, or shows an empty state when nothing is waiting.
 */
import { redirect } from 'next/navigation';
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';

export const dynamic = 'force-dynamic';

export default function RewritesPage() {
  const db = getDb();
  const queue = repo.listRewriteQueue(db);

  if (queue.length > 0) {
    redirect(`/rewrite/${queue[0].id}`);
  }

  return (
    <main className="container">
      <p className="eyebrow">In Progress</p>
      <h1>Rewrites</h1>
      <div className="card empty-cell">
        Nothing is being tailored right now. Continue a scored job from <a href="/jobs">Jobs</a> to
        start a rewrite.
      </div>
    </main>
  );
}
