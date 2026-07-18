'use client';

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { Job, JobSource } from '@/lib/types';
import { canContinue, canPass } from '@/lib/status/transitions';
import { sourceBadge } from '@/lib/jobs/source-badge';
import { postSse, postJson } from '../sse-client';
import { formatCountdown } from '@/lib/countdown';
import { ScoreReason } from '../components/score-reason';
import { EditableSalary } from '../components/editable-salary';

/** Mirror of lib/scrape/run.ts SourceScrapeCounts — the per-source counts the
 *  scrape `done` SSE event carries. Kept local so no server module is imported
 *  into the client bundle. */
interface SourceScrapeCounts {
  source: JobSource;
  found: number;
  blocked: number;
  inserted: number;
}

/** Mirror of lib/schedule/scheduler.ts SchedulerStatus (the GET /api/schedule body). */
interface ScheduleStatus {
  intervalMinutes: number;
  nextRunAt: number | null;
  running: boolean;
  lastRunAt: number | null;
  lastSummary: string | null;
  lastError: string | null;
}

type QueueJob = Pick<
  Job,
  | 'id'
  | 'company'
  | 'title'
  | 'location'
  | 'salary'
  | 'score'
  | 'scoreReason'
  | 'status'
  | 'url'
  | 'source'
  | 'postedAt'
  | 'seniorityLevel'
  | 'employmentType'
  | 'jobFunction'
  | 'industries'
  | 'applicants'
>;

function ScoreReticle({ score }: { score: number | null }) {
  if (score == null) return <span className="reticle is-empty" title="Not scored yet">—</span>;
  const cls = score >= 75 ? 'is-green' : score >= 50 ? 'is-amber' : 'is-red';
  return (
    <span className={`reticle ${cls}`} title={`Fit score ${score}/100`}>
      {score}
    </span>
  );
}

/**
 * Labeled chips for LinkedIn's structured detail-page fields (employment
 * type, job function, industries, applicant count). Rendered in the
 * expanded row; absent fields are simply omitted.
 */
function JobFacts({ job }: { job: QueueJob }) {
  const facts: Array<[string, string | null]> = [
    ['Type', job.employmentType],
    ['Function', job.jobFunction],
    ['Industries', job.industries],
    ['Applicants', job.applicants],
  ];
  const present = facts.filter(([, value]) => value);
  if (present.length === 0) return null;
  return (
    <div className="job-facts">
      {present.map(([label, value]) => (
        <span key={label} className="job-fact">
          <span className="job-fact-label">{label}</span>
          {value}
        </span>
      ))}
    </div>
  );
}

/** A colorful, characterful status chip for the decision queue. */
function StatusPill({ status }: { status: string }) {
  const meta: Record<string, { label: string; cls: string; icon: string }> = {
    new: { label: 'New', cls: 'st-new', icon: '✦' },
    scored: { label: 'Scored', cls: 'st-scored', icon: '✓' },
  };
  const m = meta[status] ?? { label: status, cls: 'st-other', icon: '•' };
  return (
    <span className={`job-status ${m.cls}`}>
      <span className="job-status-icon" aria-hidden>{m.icon}</span>
      {m.label}
    </span>
  );
}

/**
 * A live wall-clock plus a countdown to the next scheduled auto-run (PRD §12).
 * `now` is null until the client mounts so server and first-client render agree
 * (a live time string would otherwise trip a hydration mismatch).
 */
function RunClock({
  now,
  nextRunAt,
  intervalMinutes,
  running,
}: {
  now: number | null;
  nextRunAt: number | null;
  intervalMinutes: number;
  running: boolean;
}) {
  if (now == null) return null;
  const clock = new Date(now).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  let next: ReactNode = null;
  if (intervalMinutes > 0) {
    if (running) {
      next = <span className="run-clock-next is-running">running now…</span>;
    } else if (nextRunAt != null) {
      const at = new Date(nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      next = (
        <span className="run-clock-next" title={`Next auto-run at ${at} · every ${intervalMinutes}m`}>
          next run in {formatCountdown(nextRunAt - now)}
        </span>
      );
    }
  }

  return (
    <span className="run-clock">
      <span className="run-clock-time" title="Current time">
        🕑 {clock}
      </span>
      {next}
    </span>
  );
}

/** Columns the queue can be sorted by (click a header to toggle asc/desc). */
type SortKey = 'score' | 'company' | 'title' | 'location' | 'salary' | 'posted' | 'status';
type SortDir = 'asc' | 'desc';

/** Leading dollar amount of a salary string, for numeric sorting. */
function salaryValue(salary: string | null): number {
  if (!salary) return -1;
  const m = salary.match(/\$\s*([\d,]+(?:\.\d+)?)\s*([kK])?/);
  if (!m) return -1;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (m[2]) n *= 1000;
  return Number.isFinite(n) ? n : -1;
}

/** The comparable value of a job on a given column. */
function sortValue(j: QueueJob, key: SortKey): number | string {
  switch (key) {
    case 'score':
      return j.score ?? -1;
    case 'company':
      return j.company.toLowerCase();
    case 'title':
      return j.title.toLowerCase();
    case 'location':
      return (j.location ?? '').toLowerCase();
    case 'salary':
      return salaryValue(j.salary);
    case 'posted':
      return j.postedAt ?? '';
    case 'status':
      return j.status;
  }
}

export function JobsClient({
  initialJobs,
  configured,
  runIntervalMinutes,
}: {
  initialJobs: QueueJob[];
  configured: boolean;
  runIntervalMinutes: number;
}) {
  const router = useRouter();
  const [jobs, setJobs] = useState<QueueJob[]>(initialJobs);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [scraping, setScraping] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [findingSalary, setFindingSalary] = useState<Set<number>>(new Set());
  const [noSalary, setNoSalary] = useState<Set<number>>(new Set());

  // Desktop notifications fire through the Python notifier (POST /api/notify),
  // which shows a native Windows toast even when this tab is backgrounded.
  const [alertsOn, setAlertsOn] = useState(true);
  const alertsOnRef = useRef(true);
  // A live mirror of jobs so SSE callbacks can read company/title without a stale closure.
  const jobsRef = useRef<QueueJob[]>(initialJobs);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  useEffect(() => {
    alertsOnRef.current = alertsOn;
  }, [alertsOn]);
  useEffect(() => {
    // Restore the user's alert preference.
    if (localStorage.getItem('jobAlerts') === '0') setAlertsOn(false);
  }, []);

  function notify(title: string, body: string) {
    if (!alertsOnRef.current) return;
    fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    }).catch(() => {});
  }

  function toggleAlerts() {
    const next = !alertsOnRef.current;
    alertsOnRef.current = next;
    setAlertsOn(next);
    try {
      localStorage.setItem('jobAlerts', next ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (next) notify('🔔 JobFinder', "Desktop alerts on — you'll be pinged when jobs are found.");
  }

  // Column sort: null sortKey keeps the server order (newest first).
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  function sortBy(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Numeric columns read best high-to-low first; text columns A→Z.
      setSortDir(key === 'score' || key === 'salary' || key === 'posted' ? 'desc' : 'asc');
    }
  }

  const visible = useMemo(() => {
    if (sortKey === null) return jobs;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...jobs].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [jobs, sortKey, sortDir]);

  // Live summary over all jobs in the queue.
  const stats = useMemo(() => {
    const scoredJobs = jobs.filter((j) => j.score != null) as Array<QueueJob & { score: number }>;
    const avg = scoredJobs.length
      ? Math.round(scoredJobs.reduce((s, j) => s + j.score, 0) / scoredJobs.length)
      : null;
    const top = scoredJobs.length ? Math.max(...scoredJobs.map((j) => j.score)) : null;
    const strong = scoredJobs.filter((j) => j.score >= 75).length;
    return { avg, top, strong, total: jobs.length };
  }, [jobs]);

  const newCount = useMemo(() => jobs.filter((j) => j.status === 'new').length, [jobs]);
  const scoredCount = useMemo(() => jobs.filter((j) => j.status === 'scored').length, [jobs]);

  function upsert(job: QueueJob) {
    setJobs((prev) => {
      const i = prev.findIndex((j) => j.id === job.id);
      if (i === -1) return [job, ...prev];
      const next = [...prev];
      next[i] = { ...next[i], ...job };
      return next;
    });
  }

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) =>
      prev.size === visible.length ? new Set() : new Set(visible.map((j) => j.id)),
    );
  }

  async function scrape() {
    setScraping(true);
    setError(null);
    setStatus('Scraping…');
    let found = 0;
    try {
      await postSse('/api/scrape', {}, (ev) => {
        if (ev.type === 'job') {
          found += 1;
          setStatus(`Scraping… ${found} found`);
          upsert({
            id: ev.id as number,
            company: ev.company as string,
            title: ev.title as string,
            location: (ev.location as string) ?? null,
            salary: (ev.salary as string) ?? null,
            score: null,
            scoreReason: null,
            status: 'new',
            url: (ev.url as string) ?? '',
            source: (ev.source as JobSource) ?? 'linkedin',
            postedAt: (ev.postedAt as string) ?? null,
            seniorityLevel: (ev.seniorityLevel as string) ?? null,
            employmentType: (ev.employmentType as string) ?? null,
            jobFunction: (ev.jobFunction as string) ?? null,
            industries: (ev.industries as string) ?? null,
            applicants: (ev.applicants as string) ?? null,
          });
        } else if (ev.type === 'done') {
          const inserted = ev.inserted as number;
          const bySource = (ev.bySource as SourceScrapeCounts[]) ?? [];
          // When more than one source ran, append a per-source inserted breakdown
          // so LinkedIn vs Greenhouse contributions are visible at a glance.
          const suffix =
            bySource.length > 1
              ? ` (${bySource
                  .map((s) => `${sourceBadge(s.source).label} ${s.inserted}`)
                  .join(' · ')})`
              : '';
          setStatus(`Scrape complete — ${inserted} new, ${ev.blocked} blocked${suffix}.`);
          const warnings = (ev.warnings as string[]) ?? [];
          if (warnings.length > 0) setError(warnings.join(' '));
          if (inserted > 0) {
            notify(
              '🎯 JobFinder',
              `${inserted} new job${inserted === 1 ? '' : 's'} found — open the queue to review.`,
            );
          }
        } else if (ev.type === 'error') {
          setError(ev.message as string);
        }
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setScraping(false);
    }
  }

  /** Run one scoring pass; returns the ids that errored (e.g. truncation). */
  async function runScorePass(ids?: number[]): Promise<number[]> {
    const failed: number[] = [];
    const payload = ids ? { jobIds: ids } : {};
    await postSse('/api/score', payload, (ev) => {
      if (ev.type === 'score') {
        const score = ev.score as number;
        if (ev.filtered) {
          // Scored below the configured cutoff (FR-9a): drop it from the live
          // queue. It remains in the DB for analytics, just not in triage.
          setJobs((prev) => prev.filter((j) => j.id !== ev.jobId));
        } else {
          setJobs((prev) =>
            prev.map((j) =>
              j.id === ev.jobId
                ? { ...j, score, scoreReason: ev.reason as string, status: 'scored' }
                : j,
            ),
          );
        }
        // Ping for strong matches (read company/title from the live mirror).
        if (score >= 75) {
          const job = jobsRef.current.find((j) => j.id === ev.jobId);
          if (job) {
            notify('💯 Strong match', `${job.company} — ${job.title} · fit ${score}/100`);
          }
        }
      } else if (ev.type === 'score_error') {
        failed.push(ev.jobId as number);
      } else if (ev.type === 'error') {
        setError(ev.message as string);
      }
    });
    return failed;
  }

  async function scoreAll() {
    setScoring(true);
    setError(null);
    setStatus('Scoring…');
    try {
      let failed = await runScorePass();
      if (failed.length > 0) {
        // Truncation is transient — one automatic retry of just the failures.
        setStatus(`Retrying ${failed.length} job(s)…`);
        failed = await runScorePass(failed);
      }
      if (failed.length > 0) {
        setError(`${failed.length} job(s) couldn't be scored — click Score all to retry.`);
        setStatus(null);
      } else {
        setStatus('Scoring complete.');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setScoring(false);
    }
  }

  // "Run now" goes through the backend scheduler (POST /api/schedule/run): it
  // runs scrape+score server-side and resets the countdown. We don't await the
  // run here — the status poll below reflects it and refetches when it finishes.
  async function runNow() {
    setError(null);
    try {
      const res = await postJson<ScheduleStatus>('/api/schedule', {});
      setSchedule(res);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Wall-clock tick driving the live clock and countdown. `now` stays null until
  // mount so SSR and the first client render agree (no hydration mismatch).
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, []);

  // The schedule (next-run time, running state) is owned by the backend; we poll
  // it so the countdown is authoritative across tabs and survives reloads. When
  // a server-side run completes (lastRunAt advances), refetch the queue.
  const [schedule, setSchedule] = useState<ScheduleStatus | null>(null);
  const lastRunAtRef = useRef<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch('/api/schedule');
        if (!res.ok || cancelled) return;
        const s = (await res.json()) as ScheduleStatus;
        if (cancelled) return;
        setSchedule(s);
        if (s.lastRunAt && s.lastRunAt !== lastRunAtRef.current) {
          // Skip the first observation (page just loaded); refresh on real changes.
          if (lastRunAtRef.current !== null) router.refresh();
          lastRunAtRef.current = s.lastRunAt;
        }
      } catch {
        /* transient — try again next tick */
      }
    }
    void poll();
    const handle = setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [router]);

  const scheduleRunning = schedule?.running ?? false;
  const intervalMinutes = schedule?.intervalMinutes ?? runIntervalMinutes;

  function remove(ids: number[]) {
    const set = new Set(ids);
    setJobs((prev) => prev.filter((j) => !set.has(j.id)));
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  }

  async function findSalary(id: number) {
    setFindingSalary((prev) => new Set(prev).add(id));
    try {
      const res = await postJson<{ salary: string | null }>('/api/salary', { jobId: id });
      if (res.salary) {
        setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, salary: res.salary } : j)));
      } else {
        setNoSalary((prev) => new Set(prev).add(id)); // searched, nothing found
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setFindingSalary((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  /** Persist a manually entered/edited salary (empty clears it). */
  async function saveSalary(id: number, salary: string) {
    const res = await postJson<{ salary: string | null }>('/api/jobs/salary', { jobId: id, salary });
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, salary: res.salary } : j)));
    // A manual value supersedes the "searched, nothing found" state.
    setNoSalary((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  async function clearAll() {
    if (jobs.length === 0) return;
    if (!window.confirm(`Remove all ${jobs.length} queued job(s)? This cannot be undone.`)) return;
    try {
      const res = await postJson<{ deleted: number }>('/api/jobs/clear', {});
      setJobs([]);
      setSelected(new Set());
      setStatus(`Cleared ${res.deleted} job(s).`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function pass(id: number) {
    remove([id]);
    try {
      await postJson('/api/command', { type: 'pass', jobId: id });
    } catch (err) {
      setError((err as Error).message);
      router.refresh();
    }
  }

  async function pursue(id: number) {
    try {
      await postJson('/api/command', { type: 'continue', jobId: id });
      router.push(`/rewrite/${id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // The selected jobs each guard allows the batch action on — 'new' jobs stay
  // selected but are never sent an invalid transition.
  const eligible = useMemo(() => {
    const chosen = jobs.filter((j) => selected.has(j.id));
    return {
      pass: chosen.filter((j) => canPass(j.status)).map((j) => j.id),
      continue: chosen.filter((j) => canContinue(j.status)).map((j) => j.id),
    };
  }, [jobs, selected]);

  async function batch(type: 'pass' | 'continue') {
    const ids = eligible[type];
    if (ids.length === 0) return;
    remove(ids);
    for (const id of ids) {
      try {
        await postJson('/api/command', { type, jobId: id });
      } catch (err) {
        setError((err as Error).message);
      }
    }
    router.refresh();
  }

  const allChecked = visible.length > 0 && selected.size === visible.length;

  // A clickable column header. Plain render function (not a nested component) so
  // headers reconcile rather than remount each render.
  function sortableTh(key: SortKey, label: string) {
    const active = sortKey === key;
    return (
      <th
        className={`sortable${active ? ' sorted' : ''}`}
        onClick={() => sortBy(key)}
        title="Click to sort"
        aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        <span className="sort-ind" aria-hidden>
          {active ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
        </span>
      </th>
    );
  }

  return (
    <div>
      {!configured && (
        <div className="banner banner-warn">
          No configuration yet — add your resume and Source of Truth in <a href="/setup">Settings</a> before scoring or rewriting.
        </div>
      )}
      <div className="card">
        <div className="row">
          <button
            className="btn-primary"
            onClick={runNow}
            disabled={scraping || scoring || scheduleRunning}
            title="Scrape and score now on the server (resets the auto-run countdown)"
          >
            {scheduleRunning ? 'Running…' : 'Run now'}
          </button>
          <button onClick={scrape} disabled={scraping || scoring || scheduleRunning}>
            {scraping ? 'Scraping…' : 'Scrape'}
          </button>
          <button onClick={scoreAll} disabled={scoring || scraping || scheduleRunning || jobs.length === 0}>
            {scoring ? 'Scoring…' : 'Score all'}
          </button>
          {selected.size > 0 && (
            <>
              <span className="field-label">{selected.size} selected</span>
              <button
                className="btn-sm"
                onClick={() => batch('pass')}
                disabled={eligible.pass.length === 0}
                title={eligible.pass.length === 0 ? 'Score these jobs first' : 'Decline the selected scored jobs'}
              >
                Pass {eligible.pass.length}
              </button>
              <button
                className="btn-sm btn-primary"
                onClick={() => batch('continue')}
                disabled={eligible.continue.length === 0}
                title={eligible.continue.length === 0 ? 'Score these jobs first' : 'Tailor resumes for the selected scored jobs'}
              >
                Continue {eligible.continue.length}
              </button>
            </>
          )}
          <RunClock
            now={now}
            nextRunAt={schedule?.nextRunAt ?? null}
            intervalMinutes={intervalMinutes}
            running={scheduleRunning}
          />
          <div className="spacer" />
          {status && <span className="muted">{status}</span>}
          <button
            className="btn-sm"
            onClick={toggleAlerts}
            title="Native desktop notifications (via the Python notifier) when jobs are found"
            style={alertsOn ? { borderColor: 'rgba(76,203,139,0.5)', color: 'var(--green)' } : undefined}
          >
            {alertsOn ? '🔔 Alerts on' : '🔕 Alerts off'}
          </button>
          <button
            className="btn-danger"
            onClick={clearAll}
            disabled={scraping || scoring || jobs.length === 0}
            title="Delete every job in the queue"
          >
            Clear all
          </button>
        </div>
        {error && <div className="banner banner-err">{error}</div>}
      </div>

      <div className="kpi-grid" style={{ margin: '0 0 1.1rem' }}>
        <div className="kpi" style={{ ['--accent-color' as string]: 'var(--steel)' }}>
          <div className="kpi-label">Showing</div>
          <div className="kpi-value">{stats.total}</div>
          <div className="kpi-sub">{newCount} new · {scoredCount} scored</div>
        </div>
        <div className="kpi" style={{ ['--accent-color' as string]: 'var(--signal)' }}>
          <div className="kpi-label">Avg fit</div>
          <div className="kpi-value">{stats.avg ?? '—'}</div>
          <div className="kpi-sub">over scored jobs</div>
        </div>
        <div className="kpi" style={{ ['--accent-color' as string]: 'var(--green)' }}>
          <div className="kpi-label">Top fit</div>
          <div className="kpi-value">{stats.top ?? '—'}</div>
          <div className="kpi-sub">best target in view</div>
        </div>
        <div className="kpi" style={{ ['--accent-color' as string]: '#8a55c8' }}>
          <div className="kpi-label">Strong (75+)</div>
          <div className="kpi-value">{stats.strong}</div>
          <div className="kpi-sub">worth pursuing</div>
        </div>
      </div>

      <table className="jobs-table">
        <thead>
          <tr>
            <th style={{ width: 28 }}>
              <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Select all" />
            </th>
            {sortableTh('score', 'Score')}
            {sortableTh('company', 'Company')}
            {sortableTh('title', 'Title')}
            {sortableTh('location', 'Location')}
            {sortableTh('salary', 'Salary')}
            {sortableTh('posted', 'Posted')}
            {sortableTh('status', 'Status')}
            <th />
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && (
            <tr>
              <td colSpan={9} className="empty-cell">
                No jobs in scope. Scrape to acquire targets, or clear the filters.
              </td>
            </tr>
          )}
          {visible.map((job) => {
            const isOpen = expanded === job.id;
            const badge = sourceBadge(job.source);
            return (
            <Fragment key={job.id}>
              <tr
                className={`job-row${isOpen ? ' is-open' : ''}`}
                onClick={() => setExpanded(isOpen ? null : job.id)}
                title="Click to see why it scored this way"
              >
                <td onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(job.id)} onChange={() => toggle(job.id)} aria-label="Select job" />
                </td>
                <td>
                  <ScoreReticle score={job.score} />
                </td>
                <td>
                  {job.company}{' '}
                  <span className={badge.className} title={badge.title}>
                    {badge.label}
                  </span>
                </td>
                <td>
                  {job.url ? (
                    <a
                      href={job.url}
                      target="_blank"
                      rel="noreferrer"
                      className="job-title-link"
                      onClick={(e) => e.stopPropagation()}
                      title="Open the posting"
                    >
                      {job.title} <span className="ext">↗</span>
                    </a>
                  ) : (
                    job.title
                  )}
                  {(job.seniorityLevel || job.employmentType || job.applicants) && (
                    <div className="job-meta">
                      {[job.seniorityLevel, job.employmentType, job.applicants]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  )}
                </td>
                <td>{job.location ?? '—'}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <EditableSalary
                    value={job.salary}
                    onSave={(s) => saveSalary(job.id, s)}
                    onFind={() => findSalary(job.id)}
                    finding={findingSalary.has(job.id)}
                    searched={noSalary.has(job.id)}
                  />
                </td>
                <td className="muted">{job.postedAt ?? '—'}</td>
                <td>
                  <StatusPill status={job.status} />
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <div className="row">
                    <button
                      className="btn-sm"
                      onClick={() => pass(job.id)}
                      disabled={!canPass(job.status)}
                      title={canPass(job.status) ? 'Decline this job' : 'Score this job first'}
                    >
                      Pass
                    </button>
                    <button
                      className="btn-sm btn-primary"
                      onClick={() => pursue(job.id)}
                      disabled={!canContinue(job.status)}
                      title={canContinue(job.status) ? 'Tailor a resume' : 'Score this job first'}
                    >
                      Continue
                    </button>
                  </div>
                </td>
              </tr>
              {isOpen && (
                <tr className="job-why-row">
                  <td colSpan={9}>
                    <JobFacts job={job} />
                    <ScoreReason reason={job.scoreReason} />
                  </td>
                </tr>
              )}
            </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
