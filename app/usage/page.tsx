/**
 * AI Usage — the per-call ledger view (FR-27). Every recorded AI call
 * (score — Anthropic or local Ollama, batch score, rewrite, explain, salary
 * lookup) with the model that served it, token usage, estimated cost (local
 * calls at $0), latency, and outcome, newest first, read live from the
 * ai_calls table. Aggregates at
 * the top mirror the dashboard's AI-usage card.
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { fmtTokens, fmtUsd, fmtTimestamp } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** How many ledger rows the page shows — plenty for a single-user tool. */
const LEDGER_LIMIT = 500;

function fmtLatency(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export default function UsagePage() {
  const db = getDb();
  const calls = repo.listAiCalls(db, LEDGER_LIMIT);
  const usage = repo.listAiUsageSummary(db);

  const todayCost = usage.today.reduce((s, r) => s + r.costUsd, 0);
  const todayCalls = usage.today.reduce((s, r) => s + r.calls, 0);
  const weekCost = usage.last7Days.reduce((s, r) => s + r.costUsd, 0);
  const weekCalls = usage.last7Days.reduce((s, r) => s + r.calls, 0);
  const listedCost = calls.reduce((s, c) => s + (c.costUsd ?? 0), 0);
  const cacheCold = usage.scoreCalls7d > 0 && (usage.cacheHitRate7d ?? 0) < 0.05;

  return (
    <main className="container wide">
      <p className="eyebrow">Telemetry</p>
      <h1>AI Usage</h1>
      <p className="muted">
        Every AI call, newest first — tokens, estimated cost (local model calls are $0), latency, and outcome.
      </p>

      <div className="kpi-grid">
        <div className="kpi" style={{ ['--accent-color' as string]: 'var(--signal)' }}>
          <div className="kpi-label">Today</div>
          <div className="kpi-value">{fmtUsd(todayCost)}</div>
          <div className="kpi-sub">{todayCalls} call{todayCalls === 1 ? '' : 's'}</div>
        </div>
        <div className="kpi" style={{ ['--accent-color' as string]: 'var(--steel)' }}>
          <div className="kpi-label">Last 7 days</div>
          <div className="kpi-value">{fmtUsd(weekCost)}</div>
          <div className="kpi-sub">{weekCalls} call{weekCalls === 1 ? '' : 's'}</div>
        </div>
        <div
          className="kpi"
          style={{ ['--accent-color' as string]: cacheCold ? 'var(--red)' : 'var(--green)' }}
        >
          <div className="kpi-label">Cache hit rate · 7d</div>
          <div className="kpi-value">
            {usage.cacheHitRate7d === null ? '—' : `${Math.round(usage.cacheHitRate7d * 100)}%`}
          </div>
          <div className="kpi-sub">
            {cacheCold ? 'scoring prefix may have broken' : 'reads / (input + reads)'}
          </div>
        </div>
        <div className="kpi" style={{ ['--accent-color' as string]: '#8a55c8' }}>
          <div className="kpi-label">Listed below</div>
          <div className="kpi-value">{calls.length}</div>
          <div className="kpi-sub">{fmtUsd(listedCost)} estimated</div>
        </div>
      </div>

      {cacheCold && (
        <div className="banner banner-warn">
          Cache hit rate is {Math.round((usage.cacheHitRate7d ?? 0) * 100)}% across{' '}
          {usage.scoreCalls7d} scoring calls this week — the cached scoring prefix (resume +
          scoring prompt) may have broken, so every call is paying full input price.
        </div>
      )}

      {calls.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            No AI calls recorded yet. Score, rewrite, or look up a salary and each call will
            appear here.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Model</th>
              <th>Job</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cache r / w</th>
              <th>Cost</th>
              <th>Latency</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id}>
                <td className="muted" title={`${c.createdAt} UTC`}>
                  {fmtTimestamp(c.createdAt)}
                </td>
                <td>
                  <code>{c.callType}</code>
                </td>
                <td>
                  <code>{c.model}</code>
                </td>
                <td>
                  {c.jobCompany ? (
                    <>
                      {c.jobCompany} <span className="muted">— {c.jobTitle}</span>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>{c.inputTokens === null ? '—' : fmtTokens(c.inputTokens)}</td>
                <td>{c.outputTokens === null ? '—' : fmtTokens(c.outputTokens)}</td>
                <td>
                  {c.cacheReadTokens === null && c.cacheCreationTokens === null
                    ? '—'
                    : `${fmtTokens(c.cacheReadTokens ?? 0)} / ${fmtTokens(c.cacheCreationTokens ?? 0)}`}
                </td>
                <td>{c.costUsd === null ? '—' : fmtUsd(c.costUsd)}</td>
                <td className="muted">{fmtLatency(c.latencyMs)}</td>
                <td>
                  {c.error ? (
                    <span style={{ color: 'var(--red)' }} title={c.error}>
                      error
                    </span>
                  ) : c.stopReason === 'max_tokens' ? (
                    <span style={{ color: 'var(--amber, #b8860b)' }}>truncated</span>
                  ) : (
                    <span className="muted">{c.stopReason ?? 'ok'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
