'use client';

/**
 * The post-onboarding Documents card (FR-33): each of the four resume assets
 * stays editable after the guided flow. Every editor shows where its content
 * currently resolves from (in-app / resume/ file / example default); saving
 * authors the asset in-app (the base resume compile-gated to one page), and an
 * in-app asset can be reverted to its file/example fallback per file.
 */
import { useState } from 'react';
import { RESUME_ASSET_NAMES } from '@/lib/types';
import type { ResumeAssetName, ResumeAssetProvenance } from '@/lib/types';
import {
  ASSET_META,
  PROVENANCE_LABEL,
  revertAsset,
  saveAsset,
  type AssetViews,
} from './assets';

function ProvenanceBadge({ provenance }: { provenance: ResumeAssetProvenance }) {
  const tone = provenance === 'in-app' ? 'badge-green' : provenance === 'file' ? 'badge-amber' : '';
  return <span className={`badge ${tone}`}>{PROVENANCE_LABEL[provenance]}</span>;
}

function AssetEditor({
  name,
  initialContent,
  initialProvenance,
}: {
  name: ResumeAssetName;
  initialContent: string;
  initialProvenance: ResumeAssetProvenance;
}) {
  const [content, setContent] = useState(initialContent);
  const [provenance, setProvenance] = useState(initialProvenance);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ ok: boolean; text: string; log?: string } | null>(null);

  async function onSave() {
    setBusy(true);
    setBanner(null);
    const result = await saveAsset(name, content);
    setBusy(false);
    if (!result.ok) {
      setBanner({ ok: false, text: result.error, log: result.log });
      return;
    }
    setProvenance('in-app');
    setBanner({ ok: true, text: 'Saved — this in-app version now wins.' });
  }

  async function onRevert() {
    setBusy(true);
    setBanner(null);
    try {
      const fallback = await revertAsset(name);
      setContent(fallback.content);
      setProvenance(fallback.provenance);
      setBanner({ ok: true, text: `Reverted — now using the ${PROVENANCE_LABEL[fallback.provenance]}.` });
    } catch (err) {
      setBanner({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const meta = ASSET_META[name];
  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <label>
        {meta.label} <span className="hint">({meta.hint})</span> <ProvenanceBadge provenance={provenance} />
      </label>
      <textarea
        rows={meta.rows}
        className={meta.mono ? 'mono' : undefined}
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      {banner && (
        <div className={`banner ${banner.ok ? 'banner-ok' : 'banner-err'}`}>
          {banner.text}
          {banner.log && (
            <pre className="mono" style={{ whiteSpace: 'pre-wrap', marginTop: '0.5rem' }}>
              {banner.log}
            </pre>
          )}
        </div>
      )}
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button className="btn-sm" onClick={onSave} disabled={busy}>
          {busy ? 'Working…' : name === 'base_resume' ? 'Compile & save' : 'Save'}
        </button>
        {provenance === 'in-app' && (
          <button className="btn-sm btn-danger" onClick={onRevert} disabled={busy}>
            Revert to default
          </button>
        )}
      </div>
    </div>
  );
}

export function ResumeAssetsCard({ assets }: { assets: AssetViews }) {
  return (
    <div className="card">
      <h2>Documents</h2>
      <p className="muted">
        The resume and companion documents the pipeline runs on. Each resolves per file:
        in-app version → your <span className="mono">resume/</span> file → the committed example.
        The base resume only saves if it compiles to exactly one page.
      </p>
      {RESUME_ASSET_NAMES.map((name) => (
        <AssetEditor
          key={name}
          name={name}
          initialContent={assets[name].content}
          initialProvenance={assets[name].provenance}
        />
      ))}
    </div>
  );
}
