'use client';

import { useEffect, useState } from 'react';
// Type-only import (erased at build), so the registry's server-only transitive
// deps never reach this client bundle — but the snapshot shape stays single-
// sourced: add or rename a phase in the registry and this fails to typecheck.
import type { RewritePhase, RewriteSnapshotEntry } from '@/lib/rewrite/registry';

/** The GET /api/rewrite/status payload (lib/rewrite/registry snapshot). */
type Entry = RewriteSnapshotEntry;

const POLL_MS = 2500;
/** sessionStorage key holding the dismissed `${jobId}:${phase}` entries, so an
 *  X-ed out toast stays dismissed across full-page navigations (the toast is
 *  followed site-wide, and so is the dismissal) — but resets on a new session. */
const DISMISSED_KEY = 'rewrite-toast-dismissed';

const LABEL: Record<RewritePhase, string> = {
  running: 'Rewriting',
  done: 'Done',
  truncated: 'Cut off',
  error: 'Failed',
};

/** A dismissal is scoped to a job's current phase, so hiding a "rewriting"
 *  entry still lets its later "done"/"failed" transition re-announce itself. */
const keyOf = (e: { jobId: number; phase: RewritePhase }) => `${e.jobId}:${e.phase}`;

function loadDismissed(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.sessionStorage.getItem(DISMISSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/**
 * The always-visible, cross-page rewrite status indicator (durable-background-
 * rewrites spec). Mounted once in the root layout so it renders on every page,
 * it polls GET /api/rewrite/status on a short interval and lists jobs currently
 * rewriting and those that just finished / failed — so the operator always knows
 * a background rewrite is working (or done, and safe to review) without staring
 * at a blank page. Each entry links to its rewrite page and carries an × to
 * dismiss it; dismissals persist in sessionStorage so they survive navigation.
 * Pure presentation over the registry snapshot — no business logic. Renders
 * nothing when nothing is left to show.
 */
export function RewriteStatusIndicator() {
  const [jobs, setJobs] = useState<Entry[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function poll() {
      try {
        const res = await fetch('/api/rewrite/status', { signal: controller.signal });
        if (!res.ok) return;
        const data = (await res.json()) as { jobs?: Entry[] };
        if (!cancelled) setJobs(Array.isArray(data.jobs) ? data.jobs : []);
      } catch {
        /* offline / aborted — keep the last known state, try again next tick */
      }
    }

    poll();
    const handle = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(handle);
    };
  }, []);

  // Prune dismissals for jobs no longer tracked, so a later rewrite of the same
  // job starts un-dismissed and the store can't grow without bound.
  useEffect(() => {
    setDismissed((prev) => {
      const live = new Set(jobs.map(keyOf));
      const next = new Set([...prev].filter((k) => live.has(k)));
      if (next.size === prev.size) return prev;
      try {
        window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]));
      } catch {
        /* storage unavailable — the in-memory set still works this session */
      }
      return next;
    });
  }, [jobs]);

  function dismiss(entry: Entry) {
    setDismissed((prev) => {
      const next = new Set(prev).add(keyOf(entry));
      try {
        window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]));
      } catch {
        /* storage unavailable — dismissal still holds until navigation */
      }
      return next;
    });
  }

  const visible = jobs.filter((j) => !dismissed.has(keyOf(j)));
  if (visible.length === 0) return null;

  return (
    <aside className="rewrite-indicator" aria-label="Background rewrites">
      <div className="rewrite-indicator-head">Rewrites</div>
      <ul>
        {visible.map((j) => (
          <li key={j.jobId} className={`rewrite-indicator-item is-${j.phase}`}>
            <a href={`/rewrite/${j.jobId}`} className="rewrite-indicator-link">
              <span className="rewrite-indicator-dot" aria-hidden />
              <span className="rewrite-indicator-text">
                <span className="rewrite-indicator-company">{j.company}</span>
                <span className="rewrite-indicator-title">{j.title}</span>
              </span>
              <span className="rewrite-indicator-phase">{LABEL[j.phase]}</span>
            </a>
            <button
              className="rewrite-indicator-dismiss"
              onClick={() => dismiss(j)}
              aria-label={`Dismiss ${j.company} rewrite`}
              title="Dismiss"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
