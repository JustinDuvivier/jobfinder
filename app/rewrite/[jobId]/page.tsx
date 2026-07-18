/**
 * /rewrite/[jobId] — the side-by-side rewrite view (FR-11–FR-17). Loads the job,
 * the original resume, and any existing rewrite from SQLite, then hands off to
 * the client editor for streaming, diff, preview, and approval.
 */
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { RewriteClient } from './RewriteClient';
import { RewriteNav } from './RewriteNav';

export const dynamic = 'force-dynamic';

export default async function RewritePage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  const id = Number(jobId);
  if (Number.isNaN(id)) notFound();

  const db = getDb();
  const job = repo.getJobById(db, id);
  if (!job) notFound();
  const config = repo.getUserConfig(db);
  // The persisted server-computed diff (FR-13) — written by /api/rewrite,
  // rendered by the Changes panel.
  const changes = repo.getResumeChanges(db, id);

  // The rewrite queue powers the in-page navigator. If the current job isn't in
  // it (e.g. already approved), prepend it so the strip still reflects context.
  const queueJobs = repo.listRewriteQueue(db);
  const queue = (queueJobs.some((q) => q.id === job.id) ? queueJobs : [job, ...queueJobs]).map(
    (q) => ({ id: q.id, company: q.company, title: q.title, score: q.score }),
  );

  // Where to land after declining this job: the neighbouring rewrite, else Jobs.
  const here = queueJobs.findIndex((q) => q.id === job.id);
  const nextRewrite = here >= 0 ? (queueJobs[here + 1] ?? queueJobs[here - 1] ?? null) : null;
  const nextRewriteId = nextRewrite ? nextRewrite.id : null;

  return (
    <main className="container wide">
      <p className="eyebrow">Tailor · One-page lock</p>
      <h1>
        {job.title} <span className="muted">at {job.company}</span>
      </h1>
      {(job.location || job.salary || job.seniorityLevel || job.employmentType || job.applicants) && (
        <p className="muted job-meta">
          {[job.location, job.salary, job.seniorityLevel, job.employmentType, job.applicants]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      <RewriteNav queue={queue} currentId={job.id} />
      <RewriteClient
        job={{
          id: job.id,
          company: job.company,
          title: job.title,
          status: job.status,
          rewrittenLatex: job.rewrittenLatex,
          explanation: job.explanation,
        }}
        changes={changes}
        originalLatex={config?.resumeLatex ?? ''}
        configured={config !== undefined}
        nextRewriteId={nextRewriteId}
      />
    </main>
  );
}
