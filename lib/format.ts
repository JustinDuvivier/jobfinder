/**
 * Display formatting for the AI-usage readouts (FR-27) — token counts, USD
 * cost snapshots, and the ledger's UTC timestamps. Shared by the dashboard's
 * AI-usage card and the /usage ledger page so the two never drift.
 */

import { sqliteUtcMs } from './week';

/** Compact token count: 1234 → "1.2k", 3400000 → "3.4M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** USD with sub-cent precision so tiny Haiku calls don't render as $0.00. */
export function fmtUsd(n: number): string {
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/**
 * A ledger `created_at` ("YYYY-MM-DD HH:MM:SS", UTC — SQLite datetime('now'))
 * rendered in the machine's local time. Single-user local tool: the server's
 * locale is the user's locale. Falls back to the raw string if unparseable.
 */
export function fmtTimestamp(createdAt: string): string {
  const ms = sqliteUtcMs(createdAt);
  if (Number.isNaN(ms)) return createdAt;
  const d = new Date(ms);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}
