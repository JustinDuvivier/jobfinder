'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Job, JobStatus } from '@/lib/types';
import { TRACKER_STATUSES } from '@/lib/status/transitions';
import { addWeeks, jobWeekKey, weekKeyOf, weekLabel } from '@/lib/week';
import { postJson } from '../sse-client';
import { ScoreReason } from '../components/score-reason';
import { EditableSalary } from '../components/editable-salary';

type TrackerJob = Pick<
  Job,
  | 'id'
  | 'company'
  | 'title'
  | 'status'
  | 'score'
  | 'scoreReason'
  | 'salary'
  | 'location'
  | 'url'
  | 'postedAt'
  | 'createdAt'
  | 'updatedAt'
  | 'approvedPdfPath'
>;

/** Label + accent color per tracked status. */
const META: Record<JobStatus, { label: string; color: string }> = {
  new: { label: 'New', color: '#2664bd' },
  scored: { label: 'Scored', color: '#2664bd' },
  passed: { label: 'Passed', color: '#707a8a' },
  rewriting: { label: 'Reopen', color: 'var(--signal)' },
  approved: { label: 'Approved', color: '#8a55c8' },
  applied: { label: 'Applied', color: 'var(--green)' },
  interview: { label: 'Interview', color: '#0e9e8f' },
  offer: { label: 'Offer', color: '#b8860b' },
  accepted: { label: 'Accepted', color: 'var(--green)' },
  rejected: { label: 'Rejected', color: 'var(--red)' },
  withdrawn: { label: 'Withdrawn', color: '#707a8a' },
  ghosted: { label: 'Ghosted', color: '#707a8a' },
};

// The board lanes: which tracker statuses render in the "closed out" row is a
// presentation choice; the set and order of stages come from the status module.
const CLOSED: readonly JobStatus[] = ['rejected', 'withdrawn', 'ghosted'];
const FUNNEL: readonly JobStatus[] = TRACKER_STATUSES.filter((s) => !CLOSED.includes(s));

type View = 'board' | 'table';
type SortKey = 'score' | 'company' | 'title' | 'status' | 'salary' | 'location' | 'posted' | 'updated';
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

function sortValue(j: TrackerJob, key: SortKey): number | string {
  switch (key) {
    case 'score':
      return j.score ?? -1;
    case 'company':
      return j.company.toLowerCase();
    case 'title':
      return j.title.toLowerCase();
    case 'status':
      return TRACKER_STATUSES.indexOf(j.status);
    case 'salary':
      return salaryValue(j.salary);
    case 'location':
      return (j.location ?? '').toLowerCase();
    case 'posted':
      return j.postedAt ?? '';
    case 'updated':
      return j.updatedAt ?? '';
  }
}

export function TrackerClient({ jobs: initial }: { jobs: TrackerJob[] }) {
  const [jobs, setJobs] = useState<TrackerJob[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<JobStatus | 'all'>('all');
  const [drag, setDrag] = useState<{ id: number; from: JobStatus } | null>(null);
  const [overCol, setOverCol] = useState<JobStatus | null>(null);

  // Remember the chosen view across visits.
  const [view, setView] = useState<View>('board');
  useEffect(() => {
    if (localStorage.getItem('trackerView') === 'table') setView('table');
  }, []);
  function chooseView(v: View) {
    setView(v);
    try {
      localStorage.setItem('trackerView', v);
    } catch {
      /* ignore */
    }
  }

  const [expanded, setExpanded] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Weekly filter (FR-24a): jobs bucketed by the Monday-start calendar week
  // they were scraped (created_at). Opens on the current week; null = all time.
  const todayKey = useMemo(() => weekKeyOf(new Date()), []);
  const [week, setWeek] = useState<string | null>(todayKey);
  const oldestKey = useMemo(() => {
    let oldest: string | null = null;
    for (const j of jobs) {
      const k = jobWeekKey(j.createdAt);
      if (k !== null && (oldest === null || k < oldest)) oldest = k;
    }
    return oldest ?? todayKey;
  }, [jobs, todayKey]);

  // A job with an unparseable created_at has a null key and stays visible in
  // every week rather than silently vanishing.
  const weekJobs = useMemo(() => {
    if (week === null) return jobs;
    return jobs.filter((j) => {
      const k = jobWeekKey(j.createdAt);
      return k === null || k === week;
    });
  }, [jobs, week]);

  const counts = useMemo(() => {
    const c = {} as Record<JobStatus, number>;
    for (const j of weekJobs) c[j.status] = (c[j.status] ?? 0) + 1;
    return c;
  }, [weekJobs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return weekJobs.filter((j) => {
      if (q && !`${j.company} ${j.title} ${j.location ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [weekJobs, query]);

  // The table additionally honors the status filter and column sort.
  const tableRows = useMemo(() => {
    let rows = filtered;
    if (statusFilter !== 'all') rows = rows.filter((j) => j.status === statusFilter);
    if (sortKey === null) return rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [filtered, statusFilter, sortKey, sortDir]);

  const byStatus = (status: JobStatus) => filtered.filter((j) => j.status === status);

  function sortBy(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'score' || key === 'salary' || key === 'posted' || key === 'updated' ? 'desc' : 'asc');
    }
  }

  /** Free move between tracker stages (any direction) — used by drag-and-drop and the table select. */
  async function moveFree(id: number, to: JobStatus) {
    const prev = jobs.find((j) => j.id === id);
    if (!prev || prev.status === to) return;
    setBusy(id);
    setError(null);
    setJobs((list) => list.map((j) => (j.id === id ? { ...j, status: to } : j)));
    try {
      await postJson('/api/command', { type: 'tracker-move', jobId: id, to });
    } catch (err) {
      setJobs((list) => list.map((j) => (j.id === id ? { ...j, status: prev.status } : j))); // rollback
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function saveSalary(id: number, salary: string) {
    const res = await postJson<{ salary: string | null }>('/api/jobs/salary', { jobId: id, salary });
    setJobs((list) => list.map((j) => (j.id === id ? { ...j, salary: res.salary } : j)));
  }

  async function openFolder(id: number) {
    try {
      await postJson('/api/open-folder', { jobId: id });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function onDrop(col: JobStatus) {
    if (drag && drag.from !== col) void moveFree(drag.id, col);
    setDrag(null);
    setOverCol(null);
  }

  const funnelTotal = FUNNEL.reduce((s, st) => s + (counts[st] ?? 0), 0);

  // A plain render function (NOT a nested component): returning elements inline
  // keeps them part of TrackerClient's tree so they reconcile across renders.
  function renderColumn(status: JobStatus) {
    const cards = byStatus(status);
    const isTarget = drag != null && drag.from !== status;
    const cls = [
      'board-col',
      isTarget ? 'droppable' : '',
      overCol === status && isTarget ? 'over' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div
        key={status}
        className={cls}
        onDragOver={(e) => {
          if (isTarget) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (overCol !== status) setOverCol(status);
          }
        }}
        onDragLeave={() => setOverCol((c) => (c === status ? null : c))}
        onDrop={(e) => {
          e.preventDefault();
          onDrop(status);
        }}
      >
        <div className="col-head" style={{ ['--col' as string]: META[status].color }}>
          <span className="col-dot" />
          <span className="col-title">{META[status].label}</span>
          <span className="col-count">{cards.length}</span>
        </div>
        <div className="col-body">
          {cards.length === 0 && <div className="col-empty">{isTarget ? 'Drop here' : '—'}</div>}
          {cards.map((job) => (
            <div
              key={job.id}
              className={`job-card${drag?.id === job.id ? ' dragging' : ''}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', String(job.id));
                e.dataTransfer.effectAllowed = 'move';
                setDrag({ id: job.id, from: job.status });
              }}
              onDragEnd={() => {
                setDrag(null);
                setOverCol(null);
              }}
            >
              <div className="job-card-top">
                {job.score != null && (
                  <span
                    className={`reticle ${job.score >= 75 ? 'is-green' : job.score >= 50 ? 'is-amber' : 'is-red'}`}
                    style={{ width: 26, height: 26, fontSize: '0.66rem', flex: 'none' }}
                    title={`Fit ${job.score}`}
                  >
                    {job.score}
                  </span>
                )}
                <div className="job-card-text">
                  <div className="job-company">{job.company}</div>
                  <div className="job-title">{job.title}</div>
                  {job.salary && <div className="job-card-salary">{job.salary}</div>}
                </div>
              </div>
              <div className="job-card-actions">
                {job.url && (
                  <a
                    className="btn btn-sm btn-ghost"
                    href={job.url}
                    target="_blank"
                    rel="noreferrer"
                    draggable={false}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    title="Open the job posting"
                  >
                    ↗ Posting
                  </a>
                )}
                {job.approvedPdfPath && (
                  <button className="btn-sm btn-ghost" onClick={() => openFolder(job.id)} title="Open saved folder">
                    📁
                  </button>
                )}
                <span className="drag-hint" title="Drag to any stage">⠿</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

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

  function renderTable() {
    return (
      <table className="jobs-table">
        <thead>
          <tr>
            {sortableTh('score', 'Score')}
            {sortableTh('company', 'Company')}
            {sortableTh('title', 'Title')}
            {sortableTh('status', 'Status')}
            {sortableTh('salary', 'Salary')}
            {sortableTh('location', 'Location')}
            {sortableTh('posted', 'Posted')}
            {sortableTh('updated', 'Updated')}
            <th />
          </tr>
        </thead>
        <tbody>
          {tableRows.length === 0 && (
            <tr>
              <td colSpan={9} className="empty-cell">
                No applications match the current filters.
              </td>
            </tr>
          )}
          {tableRows.map((job) => {
            const isOpen = expanded === job.id;
            return (
              <Fragment key={job.id}>
                <tr
                  className={`job-row${isOpen ? ' is-open' : ''}`}
                  onClick={() => setExpanded(isOpen ? null : job.id)}
                  title="Click to see the tale of the tape"
                >
                  <td>
                    {job.score != null ? (
                      <span
                        className={`reticle ${job.score >= 75 ? 'is-green' : job.score >= 50 ? 'is-amber' : 'is-red'}`}
                        title={`Fit ${job.score}/100`}
                      >
                        {job.score}
                      </span>
                    ) : (
                      <span className="reticle is-empty">—</span>
                    )}
                  </td>
                  <td>{job.company}</td>
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
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select
                      className="status-select"
                      value={job.status}
                      disabled={busy === job.id}
                      onChange={(e) => void moveFree(job.id, e.target.value as JobStatus)}
                      style={{ ['--col' as string]: META[job.status].color }}
                    >
                      {TRACKER_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {META[s].label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <EditableSalary value={job.salary} onSave={(s) => saveSalary(job.id, s)} />
                  </td>
                  <td>{job.location ?? '—'}</td>
                  <td className="muted">{job.postedAt ?? '—'}</td>
                  <td className="muted">{job.updatedAt ? job.updatedAt.slice(0, 10) : '—'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {job.approvedPdfPath && (
                      <button className="btn-sm btn-ghost" onClick={() => openFolder(job.id)} title="Open saved folder">
                        📁
                      </button>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="job-why-row">
                    <td colSpan={9}>
                      <ScoreReason reason={job.scoreReason} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <div>
      <div className="card">
        <div className="row">
          <input
            style={{ maxWidth: 280 }}
            placeholder="🔎  Filter by company, title, or location…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="seg" role="tablist" aria-label="View">
            <button
              className={`seg-btn${view === 'board' ? ' is-active' : ''}`}
              onClick={() => chooseView('board')}
            >
              ▦ Board
            </button>
            <button
              className={`seg-btn${view === 'table' ? ' is-active' : ''}`}
              onClick={() => chooseView('table')}
            >
              ☰ Table
            </button>
          </div>
          <div className="seg" role="group" aria-label="Week">
            <button
              className="seg-btn"
              onClick={() => setWeek((w) => addWeeks(w ?? todayKey, -1))}
              disabled={week === null || week <= oldestKey}
              title="Previous week"
              aria-label="Previous week"
            >
              ‹
            </button>
            <button
              className={`seg-btn${week !== null ? ' is-active' : ''}`}
              onClick={() => setWeek(todayKey)}
              title="Jump to the current week"
            >
              {week !== null ? weekLabel(week) : 'All time'}
            </button>
            <button
              className="seg-btn"
              onClick={() => setWeek((w) => addWeeks(w ?? todayKey, 1))}
              disabled={week === null || week >= todayKey}
              title="Next week"
              aria-label="Next week"
            >
              ›
            </button>
            <button
              className={`seg-btn${week === null ? ' is-active' : ''}`}
              onClick={() => setWeek(null)}
              title="Show every week"
            >
              All
            </button>
          </div>
          <div className="spacer" />
          <span className="field-label">
            {view === 'board' ? 'Drag a card between stages to update its status' : 'Click a row for the tale of the tape'}
          </span>
        </div>

        {view === 'table' && weekJobs.length > 0 && (
          <div className="chip-row" style={{ marginTop: '0.75rem' }}>
            <button
              className={`filter-chip${statusFilter === 'all' ? ' is-active' : ''}`}
              onClick={() => setStatusFilter('all')}
            >
              All · {weekJobs.length}
            </button>
            {TRACKER_STATUSES.filter((s) => (counts[s] ?? 0) > 0).map((s) => (
              <button
                key={s}
                className={`filter-chip${statusFilter === s ? ' is-active' : ''}`}
                style={{ ['--col' as string]: META[s].color }}
                onClick={() => setStatusFilter(s)}
              >
                {META[s].label} · {counts[s]}
              </button>
            ))}
          </div>
        )}

        {view === 'board' && funnelTotal > 0 && (
          <>
            <div className="funnel" style={{ marginTop: '0.85rem' }}>
              {FUNNEL.filter((s) => (counts[s] ?? 0) > 0).map((s) => (
                <div
                  key={s}
                  className="funnel-seg"
                  style={{ flex: counts[s], background: META[s].color }}
                  title={`${META[s].label}: ${counts[s]}`}
                >
                  {counts[s]}
                </div>
              ))}
            </div>
            <div className="funnel-legend">
              {FUNNEL.map((s) => (
                <span key={s} style={{ ['--dot' as string]: META[s].color }}>
                  {META[s].label} · {counts[s] ?? 0}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {error && <div className="banner banner-err">{error}</div>}

      {jobs.length === 0 ? (
        <div className="card empty-cell">No tracked applications yet. Approve a rewrite to add one.</div>
      ) : weekJobs.length === 0 ? (
        <div className="card empty-cell">
          No jobs were scraped during this week. Step ‹ › to another week, or choose All to see everything.
        </div>
      ) : view === 'table' ? (
        renderTable()
      ) : (
        <>
          <div className="board">{FUNNEL.map((s) => renderColumn(s))}</div>
          <div className="board-section-label">Closed out</div>
          <div className="board">{CLOSED.map((s) => renderColumn(s))}</div>
        </>
      )}
    </div>
  );
}
