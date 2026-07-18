'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

export interface QueueItem {
  id: number;
  company: string;
  title: string;
  score: number | null;
}

/**
 * In-page navigator for the rewrite queue. Lets you scroll between every job
 * currently waiting to be tailored without leaving the editor: a horizontal
 * strip of chips, prev/next arrows, and Alt+Arrow keyboard shortcuts. The
 * active job is auto-scrolled into view.
 */
export function RewriteNav({ queue, currentId }: { queue: QueueItem[]; currentId: number }) {
  const router = useRouter();
  const stripRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);

  const index = queue.findIndex((q) => q.id === currentId);
  const prev = index > 0 ? queue[index - 1] : null;
  const next = index >= 0 && index < queue.length - 1 ? queue[index + 1] : null;

  // Keep the active chip visible as you move through the queue.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [currentId]);

  // Alt+Left / Alt+Right move between waiting rewrites (Alt avoids clobbering
  // caret movement inside the LaTeX editor).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey) return;
      if (e.key === 'ArrowLeft' && prev) {
        e.preventDefault();
        router.push(`/rewrite/${prev.id}`);
      } else if (e.key === 'ArrowRight' && next) {
        e.preventDefault();
        router.push(`/rewrite/${next.id}`);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prev, next, router]);

  if (queue.length === 0) return null;

  return (
    <div className="card rewrite-nav">
      <a
        className="btn btn-sm nav-arrow"
        href={prev ? `/rewrite/${prev.id}` : undefined}
        aria-disabled={!prev}
        title={prev ? `${prev.company} — ${prev.title}` : 'Start of queue'}
      >
        ←
      </a>

      <div className="nav-strip" ref={stripRef}>
        {queue.map((q) => {
          const active = q.id === currentId;
          return (
            <a
              key={q.id}
              ref={active ? activeRef : undefined}
              href={`/rewrite/${q.id}`}
              className={`queue-chip${active ? ' active' : ''}`}
              title={`${q.company} — ${q.title}`}
            >
              {q.score != null && (
                <span
                  className={`queue-dot ${q.score >= 75 ? 'is-green' : q.score >= 50 ? 'is-amber' : 'is-red'}`}
                >
                  {q.score}
                </span>
              )}
              <span className="queue-chip-text">
                <span className="queue-company">{q.company}</span>
                <span className="queue-title">{q.title}</span>
              </span>
            </a>
          );
        })}
      </div>

      <span className="nav-count mono">
        {index >= 0 ? index + 1 : '–'} / {queue.length}
      </span>

      <a
        className="btn btn-sm nav-arrow"
        href={next ? `/rewrite/${next.id}` : undefined}
        aria-disabled={!next}
        title={next ? `${next.company} — ${next.title}` : 'End of queue'}
      >
        →
      </a>
    </div>
  );
}
