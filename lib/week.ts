/**
 * SQLite-UTC timestamp parsing and Monday-start calendar-week bucketing for
 * the Tracker's week filter (FR-24a). Weeks are computed in local time —
 * single-user local tool, so the server's timezone is the user's. A week is
 * identified by its key: the Monday's local date as "YYYY-MM-DD", which makes
 * keys comparable with plain string ordering.
 */

/**
 * Milliseconds since epoch for a SQLite `datetime('now')` string
 * ("YYYY-MM-DD HH:MM:SS", UTC). NaN if unparseable.
 */
export function sqliteUtcMs(ts: string): number {
  return Date.parse(ts.replace(' ', 'T') + 'Z');
}

/** Local-midnight Monday of the week containing `d`. */
export function mondayOf(d: Date): Date {
  const daysSinceMonday = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysSinceMonday);
}

/** Week key ("YYYY-MM-DD" of the local Monday) for a Date. */
export function weekKeyOf(d: Date): string {
  const m = mondayOf(d);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
}

/**
 * The week key `n` weeks after `key` (`n` may be negative). Built from local
 * date components, so it steps calendar weeks correctly across DST changes.
 */
export function addWeeks(key: string, n: number): string {
  const [y, mo, da] = key.split('-').map(Number);
  return weekKeyOf(new Date(y, mo - 1, da + n * 7));
}

/**
 * Human label for a week key as its Monday–Sunday range: "Jun 29 – Jul 5, 2026".
 * A week spanning two years carries a year on both ends: "Dec 29, 2025 – Jan 4, 2026".
 */
export function weekLabel(key: string): string {
  const [y, mo, da] = key.split('-').map(Number);
  const monday = new Date(y, mo - 1, da);
  const sunday = new Date(y, mo - 1, da + 6);
  const monthDay: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const withYear: Intl.DateTimeFormatOptions = { ...monthDay, year: 'numeric' };
  const sameYear = monday.getFullYear() === sunday.getFullYear();
  const start = monday.toLocaleDateString(undefined, sameYear ? monthDay : withYear);
  const end = sunday.toLocaleDateString(undefined, withYear);
  return `${start} – ${end}`;
}

/**
 * Week key for a job's SQLite `created_at`, or null when the timestamp is
 * unparseable — callers treat null as "belongs to every week" so a malformed
 * row can never silently vanish from the filtered view.
 */
export function jobWeekKey(createdAt: string): string | null {
  const ms = sqliteUtcMs(createdAt);
  return Number.isNaN(ms) ? null : weekKeyOf(new Date(ms));
}
