'use client';

/**
 * The guided first-run flow (FR-33). One required step — supply your base
 * LaTeX resume (prefilled with the effective starter, so filling it in means
 * replacing the example with yours; saving is explicit and compile-gated to
 * exactly one page) — followed by three optional companion-document steps that
 * work as-is out of the box. When a resume/ file is already mounted, the
 * resume step confirms it instead of demanding a paste.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ResumeAssetName } from '@/lib/types';
import { postJson } from '@/app/sse-client';
import { ASSET_META, saveAsset, type AssetViews } from './assets';

const STEPS: ResumeAssetName[] = [
  'base_resume',
  'source_of_truth',
  'scoring_prompt',
  'rewrite_rules',
];

const OPTIONAL_NOTE = 'Optional — works as-is out of the box. Customize only if needed.';

/** Step-specific guidance beyond the shared asset hint. */
const STEP_GUIDANCE: Partial<Record<ResumeAssetName, string>> = {
  source_of_truth:
    'Fill this in to match what your base resume actually claims — scoring and rewrite ' +
    'quality depend on it. Keep an explicitly stated years-of-experience figure ' +
    '(e.g. "Years of experience: 3"): the app’s experience-gap logic reads it.',
  scoring_prompt:
    'If you edit this, keep the JSON output contract intact — the app parses the ' +
    'scorer’s JSON reply (score, verdict, reasoning, experience quote), and a reply ' +
    'that breaks the shape fails every scoring run.',
};

export function Onboarding({ assets }: { assets: AssetViews }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  // Per-asset editor content, seeded with the effective (prefilled) content.
  const [drafts, setDrafts] = useState<Record<ResumeAssetName, string>>({
    base_resume: assets.base_resume.content,
    source_of_truth: assets.source_of_truth.content,
    scoring_prompt: assets.scoring_prompt.content,
    rewrite_rules: assets.rewrite_rules.content,
  });
  const [saved, setSaved] = useState<Record<ResumeAssetName, boolean>>({
    base_resume: assets.base_resume.provenance === 'in-app',
    source_of_truth: assets.source_of_truth.provenance === 'in-app',
    scoring_prompt: assets.scoring_prompt.provenance === 'in-app',
    rewrite_rules: assets.rewrite_rules.provenance === 'in-app',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; log?: string } | null>(null);
  const [finishing, setFinishing] = useState(false);

  const baseFromFile = assets.base_resume.provenance === 'file';
  const finished = step >= STEPS.length;
  const name = finished ? null : STEPS[step];

  function advance() {
    setError(null);
    setStep((s) => s + 1);
  }

  async function save(asset: ResumeAssetName, thenAdvance: boolean) {
    setBusy(true);
    setError(null);
    const result = await saveAsset(asset, drafts[asset]);
    setBusy(false);
    if (!result.ok) {
      setError({ text: result.error, log: result.log });
      return;
    }
    setSaved((s) => ({ ...s, [asset]: true }));
    if (thenAdvance) advance();
  }

  async function finish() {
    setFinishing(true);
    setError(null);
    try {
      await postJson('/api/onboarding', {});
      router.push('/');
      router.refresh();
    } catch (err) {
      setError({ text: (err as Error).message });
      setFinishing(false);
    }
  }

  return (
    <div className="card">
      <p className="muted">
        {finished
          ? 'All set.'
          : `Step ${step + 1} of ${STEPS.length}${step === 0 ? ' — required' : ' — optional'}`}
      </p>

      {name === 'base_resume' && (
        <div>
          <h2 style={{ marginTop: 0 }}>Your base resume</h2>
          {baseFromFile ? (
            <div>
              <div className="banner banner-ok">
                Found your resume file (<span className="mono">resume/base_resume.tex</span>) —
                using it. Nothing to paste.
              </div>
              <div className="row" style={{ marginTop: '1rem' }}>
                <button className="btn-primary" onClick={advance}>
                  Use my resume file
                </button>
              </div>
            </div>
          ) : (
            <div>
              <p className="muted">
                The editor is prefilled with the committed example resume (&quot;Alex
                Candidate&quot;) — replace it with <strong>your</strong> one-page LaTeX resume.
                Saving is explicit: the resume is accepted only after it compiles in the sandbox
                to exactly one page.
              </p>
              {saved.base_resume && (
                <div className="banner banner-ok">
                  Your resume is saved. You can keep editing and re-save, or continue.
                </div>
              )}
              <label>
                {ASSET_META.base_resume.label}{' '}
                <span className="hint">({ASSET_META.base_resume.hint})</span>
              </label>
              <textarea
                rows={ASSET_META.base_resume.rows}
                className="mono"
                value={drafts.base_resume}
                onChange={(e) => setDrafts((d) => ({ ...d, base_resume: e.target.value }))}
              />
              <div className="row" style={{ marginTop: '1rem' }}>
                <button
                  className="btn-primary"
                  onClick={() => save('base_resume', true)}
                  disabled={busy}
                >
                  {busy ? 'Compiling…' : 'Compile & save my resume'}
                </button>
                {saved.base_resume && (
                  <button onClick={advance} disabled={busy}>
                    Continue
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {name !== null && name !== 'base_resume' && (
        <div>
          <h2 style={{ marginTop: 0 }}>{ASSET_META[name].label}</h2>
          <div className="banner">{OPTIONAL_NOTE}</div>
          <p className="muted">
            {STEP_GUIDANCE[name] ?? `This is the effective ${ASSET_META[name].label.toLowerCase()} — edit it here if you want to customize it.`}
          </p>
          {saved[name] && <div className="banner banner-ok">Saved.</div>}
          <label>
            {ASSET_META[name].label} <span className="hint">({ASSET_META[name].hint})</span>
          </label>
          <textarea
            rows={ASSET_META[name].rows}
            className={ASSET_META[name].mono ? 'mono' : undefined}
            value={drafts[name]}
            onChange={(e) => setDrafts((d) => ({ ...d, [name]: e.target.value }))}
          />
          <div className="row" style={{ marginTop: '1rem' }}>
            <button onClick={() => save(name, false)} disabled={busy}>
              {busy ? 'Saving…' : 'Save my version'}
            </button>
            <button className="btn-primary" onClick={advance} disabled={busy}>
              Continue
            </button>
          </div>
        </div>
      )}

      {finished && (
        <div>
          <h2 style={{ marginTop: 0 }}>Ready</h2>
          <p className="muted">
            The pipeline is armed. Everything you just saw stays editable after this — the
            documents live under Settings, and each one can be reverted to its default per file.
          </p>
          <div className="row" style={{ marginTop: '1rem' }}>
            <button className="btn-primary" onClick={finish} disabled={finishing}>
              {finishing ? 'Finishing…' : 'Finish and open the pipeline'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="banner banner-err" style={{ marginTop: '1rem' }}>
          {error.text}
          {error.log && (
            <pre className="mono" style={{ whiteSpace: 'pre-wrap', marginTop: '0.5rem' }}>
              {error.log}
            </pre>
          )}
        </div>
      )}

      {step > 0 && !finishing && (
        <div className="row" style={{ marginTop: '1rem' }}>
          <button className="btn-sm" onClick={() => setStep((s) => s - 1)} disabled={busy}>
            Back
          </button>
        </div>
      )}
    </div>
  );
}
