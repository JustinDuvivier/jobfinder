'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { JobStatus } from '@/lib/types';
import { hasEdits, type DiffBlock } from '@/lib/diff';
import { canApprove, canPass } from '@/lib/status/transitions';
import { postSse, postJson } from '../../sse-client';

interface RewriteJob {
  id: number;
  company: string;
  title: string;
  status: JobStatus;
  rewrittenLatex: string | null;
  explanation: string | null;
}

type Explanation = { summary: string; bullets: string[] };
/** /api/explain answers benignly when the persisted diff records no edits. */
type ExplainResponse = Explanation | { noChanges: true };
/** The third pane toggles between the diff (FR-13) and the rationale (FR-14). */
type Tab = 'changes' | 'why';

function parseExplanation(json: string | null): Explanation | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Explanation;
  } catch {
    return null;
  }
}

export function RewriteClient({
  job,
  changes,
  originalLatex,
  configured,
  nextRewriteId,
}: {
  job: RewriteJob;
  /** The persisted server-computed diff (resume_changes rows), in seq order. */
  changes: DiffBlock[];
  originalLatex: string;
  configured: boolean;
  /** Next job in the rewrite queue, to land on after declining this one. */
  nextRewriteId: number | null;
}) {
  const router = useRouter();
  const [latex, setLatex] = useState(job.rewrittenLatex ?? originalLatex);
  const [tab, setTab] = useState<Tab>('changes');
  const [streaming, setStreaming] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [approving, setApproving] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [explanation, setExplanation] = useState<Explanation | null>(parseExplanation(job.explanation));
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Pending while router.refresh() refetches the server-loaded `changes` prop,
  // so the Changes panel shows a loading note instead of the stale diff.
  const [refreshing, startRefresh] = useTransition();

  const firstRender = useRef(true);
  // Guards the mount bootstrap (reconnect-or-auto-compile) so React strict
  // mode's double-invoke in dev doesn't fire it twice.
  const bootstrapped = useRef(false);

  async function copyLatex() {
    try {
      await navigator.clipboard.writeText(latex);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  // Debounced autosave (FR-15).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (streaming) return;
    const handle = setTimeout(() => {
      postJson('/api/autosave', { jobId: job.id, latex })
        // The server recomputed the persisted diff for this edit — re-read the
        // `changes` prop so the Changes panel tracks the current document.
        .then(() => startRefresh(() => router.refresh()))
        .catch(() => {});
    }, 1500);
    return () => clearTimeout(handle);
  }, [latex, streaming, job.id, router]);

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  // On load, reconnect-or-auto-compile in one shot (durable-background-rewrites
  // spec). `streamRewrite(true)` POSTs an attach-only reconnect: if a background
  // rewrite for this job is still running, the server streams it and the editor
  // fills in real time — the same view as if I'd never left; if nothing is
  // running the server answers `idle`, and we auto-compile the current resume so
  // the PDF preview shows a page without clicking Compile. The attach-only route
  // never starts a generation, so this can't double-pay or clobber a result that
  // finished while I was away. Runs once on mount; the persisted result is
  // already hydrated from the server render.
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void streamRewrite(true);
    // Mount-only: streamRewrite closes over the initial state we want here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Drive an `/api/rewrite` SSE stream into the editor.
   *  - `reconnect: false` (the AI Rewrite / Regenerate button) starts a fresh
   *    background generation and streams it.
   *  - `reconnect: true` (on load) attaches to an in-flight generation without
   *    starting one; an `idle` reply means nothing was running, so we just
   *    auto-compile the already-hydrated resume.
   * Streaming state is entered eagerly for a click (immediate feedback) but only
   * once tokens actually arrive on reconnect, so a normal page load with nothing
   * running never flashes "Generating…".
   */
  async function streamRewrite(reconnect: boolean) {
    setBanner(null);
    const previous = latex;
    let acc = '';
    let truncated = false;
    let failed = false;
    let idle = false;
    let streamingStarted = false;
    const beginStreaming = () => {
      if (streamingStarted) return;
      streamingStarted = true;
      setStreaming(true);
      // Clear the editor now that a generation is actually streaming, so the
      // prior content doesn't linger beneath the incoming tokens.
      acc = '';
      setLatex('');
    };
    if (!reconnect) beginStreaming();
    try {
      await postSse('/api/rewrite', { jobId: job.id, reconnect }, (ev) => {
        if (ev.type === 'token') {
          beginStreaming();
          acc += ev.text as string;
          setLatex(acc);
        } else if (ev.type === 'truncated') {
          truncated = true;
          setBanner({ kind: 'warn', text: 'The rewrite was cut off (max tokens). Regenerate to try again.' });
        } else if (ev.type === 'error') {
          failed = true;
          setBanner({ kind: 'err', text: ev.message as string });
        } else if (ev.type === 'idle') {
          idle = true; // reconnect only: no generation was running
        }
      });
    } catch (err) {
      failed = true;
      setBanner({ kind: 'err', text: (err as Error).message });
    } finally {
      if (streamingStarted) setStreaming(false);
    }
    if (idle) {
      // Nothing was running; the persisted result is already shown. Auto-compile
      // it so the preview isn't blank on load (FR-16). No refresh — the server
      // render is already current.
      if (latex.trim()) await compile();
      return;
    }
    if (truncated || failed || acc.trim().length === 0) {
      // The route persisted nothing — restore the editor so the debounced
      // autosave doesn't store LaTeX the server refused to keep. (Only if we
      // actually blanked it to stream.)
      if (streamingStarted) setLatex(previous);
      return;
    }
    // The route persisted the rewrite and its recomputed diff; re-read the
    // server-loaded `changes` prop so the Changes panel reflects the new diff.
    startRefresh(() => router.refresh());
    setTab('changes');
    // Auto-compile the PDF and populate "Why these changes".
    await compile(acc);
    await explain(acc);
  }

  async function compile(latexArg?: string) {
    const src = latexArg ?? latex;
    setCompiling(true);
    setBanner(null);
    try {
      const res = await fetch('/api/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latex: src }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? 'Compile failed');
      }
      const count = Number(res.headers.get('X-Page-Count'));
      const blob = await res.blob();
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
      setPdfUrl(URL.createObjectURL(blob));
      setPageCount(count);
    } catch (err) {
      setBanner({ kind: 'err', text: (err as Error).message });
    } finally {
      setCompiling(false);
    }
  }

  async function approve() {
    setApproving(true);
    setBanner(null);
    try {
      await postJson('/api/autosave', { jobId: job.id, latex }); // persist current editor state first
      await postJson<{ relativePath: string }>('/api/save', { jobId: job.id }); // compile, one-page gate, write PDF, status → approved
      router.push('/tracker'); // approved jobs land on the tracker automatically
    } catch (err) {
      setBanner({ kind: 'err', text: (err as Error).message });
      setApproving(false); // on success we navigate away, so only reset on error
    }
  }

  /** Back out of a rewrite I've realized I'm not a fit for: decline the job
   *  (rewriting → passed, reversible) and move on to the next in the queue. */
  async function notAMatch() {
    if (
      !window.confirm(
        "Remove this job from your rewrites? It'll be marked passed — you can undo it from the Jobs queue.",
      )
    )
      return;
    setRemoving(true);
    setBanner(null);
    try {
      await postJson('/api/command', { type: 'pass', jobId: job.id });
      router.push(nextRewriteId ? `/rewrite/${nextRewriteId}` : '/jobs');
    } catch (err) {
      setBanner({ kind: 'err', text: (err as Error).message });
      setRemoving(false); // on success we navigate away, so only reset on error
    }
  }

  async function explain(latexArg?: string) {
    setBanner(null);
    try {
      await postJson('/api/autosave', { jobId: job.id, latex: latexArg ?? latex });
      // The autosave refreshed the persisted diff explain is about to read —
      // sync the Changes panel so the "why" matches what the panel shows.
      startRefresh(() => router.refresh());
      const result = await postJson<ExplainResponse>('/api/explain', { jobId: job.id });
      if ('noChanges' in result) {
        // Nothing recorded to explain — a valid outcome, not an error. Clear
        // any prior rationale; the Why tab shows its empty state instead.
        setExplanation(null);
        return;
      }
      setExplanation(result);
      setTab('why'); // surface the rationale the moment it lands (FR-14)
    } catch (err) {
      setBanner({ kind: 'err', text: (err as Error).message });
    }
  }

  return (
    <div>
      {!configured && (
        <div className="banner banner-warn">
          No resume configured — set it in <a href="/setup">Setup</a> first.
        </div>
      )}
      <div className="card">
        <div className="row">
          <button
            className="btn-primary btn-lg"
            onClick={() => streamRewrite(false)}
            disabled={streaming || !canApprove(job.status)}
            title={
              canApprove(job.status)
                ? 'Generate a tailored rewrite from your resume and Source of Truth'
                : `Cannot edit a job in status "${job.status}"`
            }
          >
            {streaming ? 'Generating…' : job.rewrittenLatex ? 'Regenerate' : 'AI Rewrite'}
          </button>
          <button
            className="btn-lg"
            onClick={() => compile()}
            disabled={compiling || streaming}
            title="Recompile your manual edits and refresh the PDF preview"
          >
            {compiling ? 'Compiling…' : 'Compile'}
          </button>
          <div className="spacer" />
          {canPass(job.status) && (
            <button
              className="btn-lg btn-danger"
              onClick={notAMatch}
              disabled={removing || streaming || approving}
              title="I'm not a fit — remove this job from the rewrite queue (reversible from Jobs)"
            >
              {removing ? 'Removing…' : 'Not a match'}
            </button>
          )}
          <span className="rewrite-status">{job.status}</span>
          <button
            className="btn-primary btn-lg"
            onClick={approve}
            disabled={approving || streaming || removing || !canApprove(job.status)}
            title={
              canApprove(job.status)
                ? 'Compile, verify one page, save the PDF, and open the tracker'
                : `Cannot approve a job in status "${job.status}"`
            }
          >
            {approving ? 'Approving…' : 'Approve'}
          </button>
        </div>
        {banner && <div className={`banner banner-${banner.kind}`}>{banner.text}</div>}
      </div>

      <div className="triple">
        <div>
          <div className="pane-title">
            <span>LaTeX resume</span>
            <span className="spacer" />
            <span className="mono" style={{ color: 'var(--faint)' }}>{latex.length.toLocaleString()} ch</span>
            <button className="btn-sm btn-ghost" onClick={copyLatex} disabled={!latex}>
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          </div>
          <textarea
            className="editor"
            value={latex}
            onChange={(e) => setLatex(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div>
          <div className="pane-title">
            <span>Compiled PDF</span>
            <span className="spacer" />
            {pageCount != null && (
              <span className={`lock ${pageCount === 1 ? 'ok' : 'bad'}`}>
                {pageCount === 1 ? '🔒 1 page' : `⚠ ${pageCount} pages`}
              </span>
            )}
          </div>
          {streaming ? (
            // A rewrite is streaming into the editor — the PDF can't compile from
            // partial LaTeX, so mirror the toast's live state instead of a static
            // placeholder. Compiles automatically the moment streaming completes.
            <div className="preview-frame placeholder-box muted">
              <span className="preview-streaming">
                <span className="preview-streaming-dot" aria-hidden />
                Generating the rewrite…
              </span>
            </div>
          ) : pdfUrl ? (
            <iframe className="preview-frame" src={pdfUrl} title="PDF preview" />
          ) : (
            <div className="preview-frame placeholder-box muted">
              {compiling ? 'Compiling…' : 'Run AI Rewrite to generate and preview the PDF.'}
            </div>
          )}
          {pageCount != null && pageCount !== 1 && (
            <div className="banner banner-warn">
              {pageCount} pages — approval requires exactly one page.
            </div>
          )}
        </div>
        <div>
          <div className="tabs">
            <button
              className={`tab ${tab === 'changes' ? 'active' : ''}`}
              onClick={() => setTab('changes')}
            >
              Changes
            </button>
            <button className={`tab ${tab === 'why' ? 'active' : ''}`} onClick={() => setTab('why')}>
              Why these changes
            </button>
          </div>
          {tab === 'changes' ? (
            <div className="diff">
              {refreshing ? (
                <p className="muted">Loading the updated diff…</p>
              ) : changes.length > 0 ? (
                changes.map((block) => (
                  <span
                    key={block.seq}
                    className={
                      block.blockType === 'insert'
                        ? 'diff-insert'
                        : block.blockType === 'delete'
                          ? 'diff-delete'
                          : undefined
                    }
                  >
                    {block.content}
                  </span>
                ))
              ) : (
                <p className="muted">Run AI Rewrite — what changed appears here automatically.</p>
              )}
            </div>
          ) : (
            <div className="why-box">
              {explanation ? (
                <>
                  <p className="why-summary">{explanation.summary}</p>
                  <ul className="why-list">
                    {explanation.bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                </>
              ) : refreshing ? (
                // The job/changes props are mid-refetch — don't derive an
                // empty state from stale values (mirrors the Changes panel).
                <p className="muted">Loading…</p>
              ) : job.rewrittenLatex && !hasEdits(changes) ? (
                <p className="muted">No recorded changes, so there is nothing to explain.</p>
              ) : (
                <p className="muted">Run AI Rewrite — the rationale appears here automatically.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
