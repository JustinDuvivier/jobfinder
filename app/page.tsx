/**
 * Home — the operations dashboard. Everything here is derived live from SQLite:
 * pipeline counts, fit-score distribution, top employers, outcomes, and headline
 * stats. No static "getting started" copy — the numbers are the homepage.
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { fmtTokens, fmtUsd } from '@/lib/format';
import type { JobStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 100);
}

export default function HomePage() {
  const db = getDb();
  const jobs = repo.listAllJobs(db);
  const blocked = repo.listBlockedCompanies(db);
  const configured = repo.getUserConfig(db) !== undefined;

  const by = (s: JobStatus) => jobs.filter((j) => j.status === s).length;

  const newJobs = by('new');
  const scored = by('scored');
  const rewriting = by('rewriting');
  const approved = by('approved');
  const applied = by('applied');
  const interview = by('interview');
  const offer = by('offer');
  const accepted = by('accepted');
  const rejected = by('rejected');
  const passed = by('passed');

  // Auto-filtered jobs (scored below the cutoff, FR-9a) are still `scored` but
  // hidden from the decision queue, so the queue count must exclude them. They
  // remain in the score distribution below as data.
  const hidden = jobs.filter((j) => j.status === 'scored' && j.belowThreshold).length;
  const visibleScored = scored - hidden;
  const inQueue = newJobs + visibleScored;
  const liveApps = applied + interview + offer;

  // Fit-score insights over everything that has been scored.
  const withScore = jobs.filter((j) => j.score != null) as Array<{ score: number }>;
  const avgFit = withScore.length
    ? Math.round(withScore.reduce((s, j) => s + j.score, 0) / withScore.length)
    : null;
  const bestFit = withScore.length ? Math.max(...withScore.map((j) => j.score)) : null;
  const strong = withScore.filter((j) => j.score >= 75).length;
  const moderate = withScore.filter((j) => j.score >= 50 && j.score < 75).length;
  const weak = withScore.filter((j) => j.score < 50).length;
  const distMax = Math.max(1, strong, moderate, weak);

  // Decision rate: of the jobs I've decided on, how many did I pursue?
  const pursuedAll = rewriting + approved + liveApps + accepted + rejected + by('withdrawn') + by('ghosted');
  const decided = passed + pursuedAll;
  const pursueRate = pct(pursuedAll, decided);

  // Top employers by posting volume.
  const counts = new Map<string, number>();
  for (const j of jobs) counts.set(j.company, (counts.get(j.company) ?? 0) + 1);
  const topCompanies = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6);
  const companyMax = Math.max(1, ...topCompanies.map(([, n]) => n));

  const funnel: Array<{ label: string; n: number; color: string }> = [
    { label: 'Queue', n: inQueue, color: 'var(--steel)' },
    { label: 'Tailoring', n: rewriting, color: 'var(--signal)' },
    { label: 'Approved', n: approved, color: '#8a55c8' },
    { label: 'Applied', n: applied, color: 'var(--green)' },
    { label: 'Interview', n: interview, color: '#0e9e8f' },
    { label: 'Offer+', n: offer + accepted, color: '#b8860b' },
  ];
  const funnelTotal = funnel.reduce((s, f) => s + f.n, 0);

  const dist = [
    { label: 'Strong · 75+', n: strong, cls: 'is-green' },
    { label: 'Moderate · 50–74', n: moderate, cls: 'is-amber' },
    { label: 'Weak · <50', n: weak, cls: 'is-red' },
  ];

  // AI spend readout from the ai_calls ledger (FR-27).
  const aiUsage = repo.listAiUsageSummary(db);
  const aiTodayCost = aiUsage.today.reduce((s, r) => s + r.costUsd, 0);
  const aiTodayCalls = aiUsage.today.reduce((s, r) => s + r.calls, 0);
  const aiWeekCost = aiUsage.last7Days.reduce((s, r) => s + r.costUsd, 0);
  // Near-zero cache reads while scoring calls exist means the cached scoring
  // prefix (resume + scoring prompt) broke — costs quietly multiply.
  const cacheCold = aiUsage.scoreCalls7d > 0 && (aiUsage.cacheHitRate7d ?? 0) < 0.05;

  return (
    <main className="container wide">
      <p className="eyebrow">Operations Console</p>
      <h1>JobFinder</h1>
      <p className="muted">Live readout of the pipeline — one target at a time.</p>

      {!configured && (
        <div className="banner banner-warn">
          No configuration yet — set your resume and Source of Truth in <a href="/setup">Settings</a> to arm the pipeline.
        </div>
      )}

      <div className="kpi-grid">
        <a className="kpi" href="/jobs" style={{ ['--accent-color' as string]: 'var(--steel)' }}>
          <div className="kpi-label">In Queue</div>
          <div className="kpi-value">{inQueue}</div>
          <div className="kpi-sub">
            {newJobs} new · {visibleScored} scored
            {hidden > 0 ? ` · ${hidden} below cutoff` : ''}
          </div>
        </a>
        <a className="kpi" href="/rewrites" style={{ ['--accent-color' as string]: 'var(--signal)' }}>
          <div className="kpi-label">Tailoring</div>
          <div className="kpi-value">{rewriting}</div>
          <div className="kpi-sub">resumes in progress</div>
        </a>
        <a className="kpi" href="/tracker" style={{ ['--accent-color' as string]: 'var(--green)' }}>
          <div className="kpi-label">Live Apps</div>
          <div className="kpi-value">{liveApps}</div>
          <div className="kpi-sub">{applied} applied · {interview} interview</div>
        </a>
        <a className="kpi" href="/tracker" style={{ ['--accent-color' as string]: '#b8860b' }}>
          <div className="kpi-label">Offers</div>
          <div className="kpi-value">{offer + accepted}</div>
          <div className="kpi-sub">{accepted} accepted · {rejected} rejected</div>
        </a>
      </div>

      <div className="split">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Fit score distribution</h2>
          {withScore.length === 0 ? (
            <p className="muted">No jobs scored yet. Score some in <a href="/jobs">Jobs</a>.</p>
          ) : (
            <div className="bars">
              {dist.map((d) => (
                <div key={d.label} className="bar-row">
                  <span className="bar-label">{d.label}</span>
                  <span className="bar-track">
                    <span className={`bar-fill ${d.cls}`} style={{ width: `${pct(d.n, distMax)}%` }} />
                  </span>
                  <span className="bar-val">{d.n}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Top employers</h2>
          {topCompanies.length === 0 ? (
            <p className="muted">No postings yet.</p>
          ) : (
            <div className="bars">
              {topCompanies.map(([name, n]) => (
                <div key={name} className="bar-row">
                  <span className="bar-label" title={name}>{name}</span>
                  <span className="bar-track">
                    <span className="bar-fill is-steel" style={{ width: `${pct(n, companyMax)}%` }} />
                  </span>
                  <span className="bar-val">{n}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {funnelTotal > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Pipeline</h2>
          <div className="funnel">
            {funnel
              .filter((f) => f.n > 0)
              .map((f) => (
                <div key={f.label} className="funnel-seg" style={{ flex: f.n, background: f.color }} title={`${f.label}: ${f.n}`}>
                  {f.n}
                </div>
              ))}
          </div>
          <div className="funnel-legend">
            {funnel.map((f) => (
              <span key={f.label} style={{ ['--dot' as string]: f.color }}>{f.label} · {f.n}</span>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>
          AI usage{' '}
          <a href="/usage" className="muted" style={{ fontSize: '0.7em', fontWeight: 400 }}>
            all calls →
          </a>
        </h2>
        {aiUsage.last7Days.length === 0 ? (
          <p className="muted">No AI calls in the last 7 days.</p>
        ) : (
          <>
            {cacheCold && (
              <div className="banner banner-warn">
                Cache hit rate is {Math.round((aiUsage.cacheHitRate7d ?? 0) * 100)}% across{' '}
                {aiUsage.scoreCalls7d} scoring calls this week — the cached scoring prefix
                (resume + scoring prompt) may have broken, so every call is paying full input
                price.
              </div>
            )}
            <table>
              <thead>
                <tr>
                  <th>Call type</th>
                  <th>Calls · 7d</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Cache reads</th>
                  <th>Est. cost · 7d</th>
                </tr>
              </thead>
              <tbody>
                {aiUsage.last7Days.map((r) => (
                  <tr key={r.callType}>
                    <td>{r.callType}</td>
                    <td>{r.calls}</td>
                    <td>{fmtTokens(r.inputTokens)}</td>
                    <td>{fmtTokens(r.outputTokens)}</td>
                    <td>{fmtTokens(r.cacheReadTokens)}</td>
                    <td>{fmtUsd(r.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted" style={{ marginBottom: 0 }}>
              Today: {fmtUsd(aiTodayCost)} across {aiTodayCalls} call{aiTodayCalls === 1 ? '' : 's'} ·
              Last 7 days: {fmtUsd(aiWeekCost)} · Cache hit rate:{' '}
              {aiUsage.cacheHitRate7d === null
                ? '—'
                : `${Math.round(aiUsage.cacheHitRate7d * 100)}%`}
            </p>
          </>
        )}
      </div>

      <div className="kpi-grid">
        <div className="kpi" style={{ ['--accent-color' as string]: 'var(--steel)' }}>
          <div className="kpi-label">Total scraped</div>
          <div className="kpi-value">{jobs.length}</div>
          <div className="kpi-sub">{withScore.length} scored</div>
        </div>
        <div className="kpi" style={{ ['--accent-color' as string]: 'var(--signal)' }}>
          <div className="kpi-label">Avg fit</div>
          <div className="kpi-value">{avgFit ?? '—'}</div>
          <div className="kpi-sub">best {bestFit ?? '—'}</div>
        </div>
        <div className="kpi" style={{ ['--accent-color' as string]: 'var(--green)' }}>
          <div className="kpi-label">Pursue rate</div>
          <div className="kpi-value">{decided > 0 ? `${pursueRate}%` : '—'}</div>
          <div className="kpi-sub">{passed} passed · {pursuedAll} pursued</div>
        </div>
        <div className="kpi" style={{ ['--accent-color' as string]: 'var(--red)' }}>
          <div className="kpi-label">Blocked</div>
          <div className="kpi-value">{blocked.length}</div>
          <div className="kpi-sub">companies excluded</div>
        </div>
      </div>
    </main>
  );
}
