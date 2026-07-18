'use client';

import { useMemo, useState } from 'react';
import type { JobStatus } from '@/lib/types';
import { canOpenRewrite } from '@/lib/status/transitions';
import { postJson } from '../sse-client';

export interface CompanyJob {
  id: number;
  title: string;
  status: JobStatus;
  score: number | null;
  location: string | null;
  url: string;
}
export interface CompanyGroup {
  company: string;
  blocked: boolean;
  jobs: CompanyJob[];
}

/** Display label + accent color for each lifecycle status. */
const STATUS_META: Record<JobStatus, { label: string; color: string }> = {
  new: { label: 'New', color: '#2664bd' },
  scored: { label: 'Scored', color: '#2664bd' },
  passed: { label: 'Passed', color: '#707a8a' },
  rewriting: { label: 'Tailoring', color: 'var(--signal)' },
  approved: { label: 'Approved', color: '#8a55c8' },
  applied: { label: 'Applied', color: 'var(--green)' },
  interview: { label: 'Interview', color: '#0e9e8f' },
  offer: { label: 'Offer', color: '#b8860b' },
  accepted: { label: 'Accepted', color: 'var(--green)' },
  rejected: { label: 'Rejected', color: 'var(--red)' },
  withdrawn: { label: 'Withdrawn', color: '#707a8a' },
  ghosted: { label: 'Ghosted', color: '#707a8a' },
};

const ACTIVE: ReadonlySet<JobStatus> = new Set(['applied', 'interview', 'offer']);

function ScoreDot({ score }: { score: number | null }) {
  if (score == null) return <span className="reticle is-empty" style={{ width: 30, height: 30, fontSize: '0.72rem' }}>—</span>;
  const cls = score >= 75 ? 'is-green' : score >= 50 ? 'is-amber' : 'is-red';
  return (
    <span className={`reticle ${cls}`} style={{ width: 30, height: 30, fontSize: '0.72rem' }} title={`Fit ${score}`}>
      {score}
    </span>
  );
}

type SortKey = 'name' | 'jobs' | 'score' | 'active';

export function CompaniesClient({ groups: initial }: { groups: CompanyGroup[] }) {
  const [groups, setGroups] = useState(initial);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('jobs');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const totals = useMemo(() => {
    const totalJobs = groups.reduce((s, g) => s + g.jobs.length, 0);
    const blocked = groups.filter((g) => g.blocked).length;
    const withActive = groups.filter((g) => g.jobs.some((j) => ACTIVE.has(j.status))).length;
    return { companies: groups.length, totalJobs, blocked, withActive };
  }, [groups]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = groups.filter((g) => {
      if (!q) return true;
      if (g.company.toLowerCase().includes(q)) return true;
      return g.jobs.some((j) => j.title.toLowerCase().includes(q));
    });
    const best = (g: CompanyGroup) => Math.max(-1, ...g.jobs.map((j) => j.score ?? -1));
    const active = (g: CompanyGroup) => g.jobs.filter((j) => ACTIVE.has(j.status)).length;
    const sorted = [...filtered];
    if (sort === 'name') sorted.sort((a, b) => a.company.localeCompare(b.company));
    else if (sort === 'jobs') sorted.sort((a, b) => b.jobs.length - a.jobs.length || a.company.localeCompare(b.company));
    else if (sort === 'score') sorted.sort((a, b) => best(b) - best(a));
    else if (sort === 'active') sorted.sort((a, b) => active(b) - active(a) || b.jobs.length - a.jobs.length);
    return sorted;
  }, [groups, query, sort]);

  function toggleOpen(company: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(company)) next.delete(company);
      else next.add(company);
      return next;
    });
  }

  async function toggleBlock(company: string, blocked: boolean) {
    setBusy(company);
    setError(null);
    try {
      await postJson('/api/blocklist', { action: blocked ? 'remove' : 'add', name: company });
      setGroups((prev) => prev.map((g) => (g.company === company ? { ...g, blocked: !blocked } : g)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function StatusBreakdown({ jobs }: { jobs: CompanyJob[] }) {
    const counts = new Map<JobStatus, number>();
    for (const j of jobs) counts.set(j.status, (counts.get(j.status) ?? 0) + 1);
    return (
      <div className="chip-row">
        {[...counts.entries()].map(([status, n]) => (
          <span
            key={status}
            className="status"
            style={{ color: STATUS_META[status].color, borderColor: 'var(--border)' }}
          >
            {STATUS_META[status].label} · {n}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="kpi-grid" style={{ margin: '0 0 1.1rem' }}>
        <div className="kpi" style={{ ['--accent-color' as string]: 'var(--steel)' }}>
          <div className="kpi-label">Companies</div>
          <div className="kpi-value">{totals.companies}</div>
          <div className="kpi-sub">{totals.totalJobs} postings total</div>
        </div>
        <div className="kpi" style={{ ['--accent-color' as string]: 'var(--green)' }}>
          <div className="kpi-label">With live apps</div>
          <div className="kpi-value">{totals.withActive}</div>
          <div className="kpi-sub">applied · interview · offer</div>
        </div>
        <div className="kpi" style={{ ['--accent-color' as string]: 'var(--red)' }}>
          <div className="kpi-label">Blocked</div>
          <div className="kpi-value">{totals.blocked}</div>
          <div className="kpi-sub">excluded from scraping</div>
        </div>
        <div className="kpi" style={{ ['--accent-color' as string]: 'var(--signal)' }}>
          <div className="kpi-label">In view</div>
          <div className="kpi-value">{visible.length}</div>
          <div className="kpi-sub">matching filter</div>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <input
            style={{ maxWidth: 320 }}
            placeholder="🔎  Search companies or roles…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="spacer" />
          <span className="field-label">Sort</span>
          <select style={{ maxWidth: 170 }} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="jobs">Most postings</option>
            <option value="active">Most active</option>
            <option value="score">Best fit</option>
            <option value="name">Name A–Z</option>
          </select>
        </div>
      </div>

      {error && <div className="banner banner-err">{error}</div>}

      {visible.length === 0 && (
        <div className="card empty-cell">No companies match. Scrape some jobs, or clear the search.</div>
      )}

      <div className="company-list">
        {visible.map((g) => {
          const isOpen = open.has(g.company);
          return (
            <div key={g.company} className={`company-card${g.blocked ? ' is-blocked' : ''}`}>
              <div className="company-head" onClick={() => toggleOpen(g.company)}>
                <span className={`caret${isOpen ? ' open' : ''}`} aria-hidden>
                  ▸
                </span>
                <span className="company-name">{g.company}</span>
                {g.blocked && <span className="badge badge-red">Blocked</span>}
                <span className="badge">{g.jobs.length} role{g.jobs.length === 1 ? '' : 's'}</span>
                <div className="spacer" />
                <div onClick={(e) => e.stopPropagation()}>
                  <StatusBreakdown jobs={g.jobs} />
                </div>
                <button
                  className={`btn-sm ${g.blocked ? '' : 'btn-danger'}`}
                  disabled={busy === g.company}
                  onClick={(e) => {
                    e.stopPropagation();
                    void toggleBlock(g.company, g.blocked);
                  }}
                >
                  {g.blocked ? 'Unblock' : 'Block'}
                </button>
              </div>

              {isOpen && (
                <table className="company-jobs">
                  <tbody>
                    {g.jobs.map((j) => (
                      <tr key={j.id}>
                        <td style={{ width: 44 }}>
                          <ScoreDot score={j.score} />
                        </td>
                        <td>{j.title}</td>
                        <td className="muted" style={{ width: 160 }}>{j.location ?? '—'}</td>
                        <td style={{ width: 130 }}>
                          <span className="status" style={{ color: STATUS_META[j.status].color }}>
                            {STATUS_META[j.status].label}
                          </span>
                        </td>
                        <td style={{ width: 90 }}>
                          {canOpenRewrite(j.status) && (
                            <a className="btn btn-sm" href={`/rewrite/${j.id}`}>Open</a>
                          )}
                        </td>
                        <td style={{ width: 36 }}>
                          {j.url ? (
                            <a href={j.url} target="_blank" rel="noreferrer" title="Open posting">↗</a>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
