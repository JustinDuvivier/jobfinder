/**
 * Format a remaining-time duration for the auto-run countdown shown in the Jobs
 * view (PRD §12 "Optional scheduled scraping"; jobfinder-docs "Scheduled
 * scraping"). Pure and deterministic so it can be unit-tested without rendering.
 *
 * Input is milliseconds remaining; negatives clamp to zero (the timer never
 * shows a past time). Output is `m:ss` under an hour and `h:mm:ss` at or above
 * it. Seconds round *up* so a freshly-scheduled run reads the full interval
 * (e.g. 5 minutes shows "5:00", not "4:59").
 */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}
