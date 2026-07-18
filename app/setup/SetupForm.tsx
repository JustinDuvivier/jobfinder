'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DEFAULT_OWNER_NAME } from '@/lib/types';
import type { UserConfig, ScraperStrategyName } from '@/lib/types';
import { CURATED_OLLAMA_MODELS, DEFAULT_OLLAMA_MODEL } from '@/lib/ai/models';
import {
  choiceFromConfig,
  configFromChoice,
  formatPullProgress,
  localTagForChoice,
  type OllamaModelsStatus,
  type ScoringChoice,
} from './scoring-choice';
import { postJson } from '../sse-client';

const DEFAULT_KEYWORDS = [
  'AI Engineer',
  'Machine Learning Engineer',
  'ML Engineer',
  'Software Engineer',
  'Forward Deployed Engineer',
  'Solutions Engineer',
];
const DEFAULT_LOCATIONS = ['New York', 'New Jersey'];
const DEFAULT_EXCLUDED_TITLE_TERMS = [
  'senior',
  'sr',
  'staff',
  'principal',
  'lead',
  'manager',
  'director',
  'head of',
  'vp',
  'chief',
  'scientist',
];

function toLines(values: string[]): string {
  return values.join('\n');
}
function fromLines(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function SetupForm({
  config,
  blocklist,
  rapidApiKeyPresent,
}: {
  config: UserConfig | null;
  blocklist: string[];
  rapidApiKeyPresent: boolean;
}) {
  const [runIntervalMinutes, setRunIntervalMinutes] = useState(config?.runIntervalMinutes ?? 0);
  const [searchLookbackHours, setSearchLookbackHours] = useState(config?.searchLookbackHours ?? 1);
  const [scoreThreshold, setScoreThreshold] = useState(config?.scoreThreshold ?? 50);
  const [ownerName, setOwnerName] = useState(config?.ownerName ?? DEFAULT_OWNER_NAME);
  const [scraperStrategy, setScraperStrategy] = useState<ScraperStrategyName>(
    config?.scraperStrategy ?? 'linkedin',
  );
  const [greenhouseEnabled, setGreenhouseEnabled] = useState(config?.greenhouseEnabled ?? false);
  const [scoringChoice, setScoringChoice] = useState<ScoringChoice>(
    choiceFromConfig({
      scoringBackend: config?.scoringBackend ?? 'ollama',
      ollamaModel: config?.ollamaModel ?? DEFAULT_OLLAMA_MODEL,
    }),
  );
  const [ollamaModel, setOllamaModel] = useState(config?.ollamaModel ?? DEFAULT_OLLAMA_MODEL);
  const [modelStatus, setModelStatus] = useState<OllamaModelsStatus | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [startingPull, setStartingPull] = useState(false);
  const [keywords, setKeywords] = useState(toLines(config?.keywords ?? DEFAULT_KEYWORDS));
  const [locations, setLocations] = useState(toLines(config?.locations ?? DEFAULT_LOCATIONS));
  const [excludedTitleTerms, setExcludedTitleTerms] = useState(
    toLines(config?.excludedTitleTerms ?? DEFAULT_EXCLUDED_TITLE_TERMS),
  );

  const router = useRouter();
  const [companies, setCompanies] = useState<string[]>(blocklist);
  const [newCompany, setNewCompany] = useState('');
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  const refreshModels = useCallback(async () => {
    try {
      const res = await fetch('/api/ollama/models');
      const data = (await res.json()) as OllamaModelsStatus;
      setModelStatus(data);
      // A finished pull is reported exactly once — surface its failure (or
      // clear a stale one on success) the moment the poll sees it.
      if (data.pulling?.done) {
        setPullError(data.pulling.error ? `Download failed: ${data.pulling.error}` : null);
      }
    } catch {
      // Keep the last known status; the next poll or save retries.
    }
  }, []);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  // While a pull runs, poll the status route so progress and completion land
  // without SSE (start-then-poll refetch, like the schedule countdown).
  useEffect(() => {
    if (!modelStatus?.pulling || modelStatus.pulling.done) return;
    const handle = setInterval(() => void refreshModels(), 1500);
    return () => clearInterval(handle);
  }, [modelStatus, refreshModels]);

  async function startDownload(tag: string) {
    setPullError(null);
    setStartingPull(true);
    try {
      await postJson('/api/ollama/models', { tag });
      await refreshModels();
    } catch (err) {
      setPullError((err as Error).message);
    } finally {
      setStartingPull(false);
    }
  }

  async function save() {
    setSaving(true);
    setBanner(null);
    try {
      await postJson('/api/config', {
        ownerName,
        scraperStrategy,
        greenhouseEnabled,
        keywords: fromLines(keywords),
        locations: fromLines(locations),
        excludedTitleTerms: fromLines(excludedTitleTerms),
        runIntervalMinutes,
        searchLookbackHours,
        scoreThreshold,
        ...configFromChoice(scoringChoice, ollamaModel),
      });
      setBanner({ ok: true, text: 'Saved.' });
      // The stored custom tag may have changed — refresh its installed status.
      void refreshModels();
    } catch (err) {
      setBanner({ ok: false, text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function blockAction(action: 'add' | 'remove', name: string) {
    try {
      const res = await postJson<{ companies: string[] }>('/api/blocklist', { action, name });
      setCompanies(res.companies);
      if (action === 'add') setNewCompany('');
    } catch (err) {
      setBanner({ ok: false, text: (err as Error).message });
    }
  }

  async function resetData() {
    if (
      !window.confirm(
        'Delete ALL jobs and application history and start fresh?\n\nThis keeps your Settings (resume, Source of Truth, prompts) and your blocked-companies list, but every scraped/scored/tracked job is permanently removed. This cannot be undone.',
      )
    )
      return;
    setResetting(true);
    setBanner(null);
    try {
      const res = await postJson<{ deleted: number }>('/api/reset', {});
      setBanner({ ok: true, text: `Cleared ${res.deleted} job(s). You're starting fresh.` });
      router.refresh();
    } catch (err) {
      setBanner({ ok: false, text: (err as Error).message });
    } finally {
      setResetting(false);
    }
  }

  const activePull = modelStatus?.pulling && !modelStatus.pulling.done ? modelStatus.pulling : null;
  const localTag = localTagForChoice(scoringChoice, ollamaModel);

  /** Installed / not-installed / downloading line for the selected local model. */
  function localModelStatus(tag: string) {
    if (activePull?.tag === tag) return <span>Downloading… {formatPullProgress(activePull)}</span>;
    if (!modelStatus) return <span>Checking Ollama…</span>;
    if (!modelStatus.reachable) return <span>Ollama unreachable — {modelStatus.error}</span>;
    const entry = modelStatus.models.find((m) => m.tag === tag);
    if (!entry) return <span>Save configuration to check this tag against Ollama.</span>;
    if (entry.installed) return <span>Installed on Ollama.</span>;
    return (
      <span className="row" style={{ gap: '0.5rem' }}>
        Not installed on Ollama.
        <button
          type="button"
          className="btn-sm"
          onClick={() => void startDownload(tag)}
          disabled={startingPull || activePull !== null}
        >
          {startingPull ? 'Starting…' : 'Download'}
        </button>
      </span>
    );
  }

  return (
    <div>
      <div className="card">
        <div className="split">
          <div>
            <label>Owner name <span className="hint">(used in the PDF filename)</span></label>
            <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
          </div>
          <div>
            <label>Scraper strategy</label>
            <select value={scraperStrategy} onChange={(e) => setScraperStrategy(e.target.value as ScraperStrategyName)}>
              <option value="demo">Demo (static sample jobs)</option>
              <option value="linkedin">LinkedIn guest API</option>
            </select>
            <label className="row" style={{ marginTop: '0.75rem', gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={greenhouseEnabled}
                onChange={(e) => setGreenhouseEnabled(e.target.checked)}
              />
              <span>Also scrape Greenhouse</span>
            </label>
            <div className="hint">
              RapidAPI key: {rapidApiKeyPresent ? 'set' : 'missing'}
              {!rapidApiKeyPresent && ' — Greenhouse won’t run without it (set RAPID_API_KEY in .env.local).'}
            </div>
          </div>
        </div>

        <div className="split">
          <div>
            <label>Search keywords <span className="hint">(one per line)</span></label>
            <textarea rows={6} value={keywords} onChange={(e) => setKeywords(e.target.value)} />
          </div>
          <div>
            <label>Search locations <span className="hint">(one per line)</span></label>
            <textarea rows={6} value={locations} onChange={(e) => setLocations(e.target.value)} />
          </div>
        </div>

        <label>
          Exclude titles containing{' '}
          <span className="hint">
            (one term per line; whole-word, case-insensitive — drops over-senior postings LinkedIn lets
            through. Empty = keep all titles.)
          </span>
        </label>
        <textarea
          rows={5}
          value={excludedTitleTerms}
          onChange={(e) => setExcludedTitleTerms(e.target.value)}
        />

        <div className="split">
          <div>
            <label>Auto-run every <span className="hint">(minutes; 0 = manual only, while the app is open)</span></label>
            <input
              type="number"
              min={0}
              value={runIntervalMinutes}
              onChange={(e) => setRunIntervalMinutes(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            />
          </div>
          <div>
            <label>Only jobs posted in the last <span className="hint">(hours)</span></label>
            <input
              type="number"
              min={1}
              value={searchLookbackHours}
              onChange={(e) => setSearchLookbackHours(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            />
          </div>
          <div>
            <label>
              Auto-hide fit score below{' '}
              <span className="hint">(0–100; 0 = show everything. Lower scores stay as data but leave the queue.)</span>
            </label>
            <input
              type="number"
              min={0}
              max={100}
              value={scoreThreshold}
              onChange={(e) =>
                setScoreThreshold(Math.min(100, Math.max(0, Math.floor(Number(e.target.value) || 0))))
              }
            />
          </div>
        </div>

        <div className="split">
          <div>
            <label>
              Scoring model{' '}
              <span className="hint">(local models score for free; Claude scores via the Anthropic API)</span>
            </label>
            <select
              value={scoringChoice}
              onChange={(e) => setScoringChoice(e.target.value as ScoringChoice)}
            >
              {CURATED_OLLAMA_MODELS.map((m) => (
                <option key={m.tag} value={m.tag}>
                  {m.label} ({m.pullSize}; {m.hardware})
                </option>
              ))}
              <option value="anthropic">Claude (Anthropic Haiku — API, no local model)</option>
              <option value="custom">Custom Ollama tag…</option>
            </select>
            {localTag !== null && (
              <div className="hint" style={{ marginTop: '0.5rem' }}>
                {localModelStatus(localTag)}
              </div>
            )}
            {pullError && <div className="banner banner-err">{pullError}</div>}
          </div>
          {scoringChoice === 'custom' && (
            <div>
              <label>
                Custom Ollama model tag{' '}
                <span className="hint">(any tag Ollama can pull; save to check and download it)</span>
              </label>
              <input
                value={ollamaModel}
                onChange={(e) => setOllamaModel(e.target.value)}
                placeholder={DEFAULT_OLLAMA_MODEL}
              />
            </div>
          )}
        </div>

        {banner && <div className={`banner ${banner.ok ? 'banner-ok' : 'banner-err'}`}>{banner.text}</div>}
        <div className="row" style={{ marginTop: '1rem' }}>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save configuration'}
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Blocked companies</h2>
        <p className="muted">Jobs from these companies never enter the queue or cost scoring.</p>
        <div className="row">
          <input
            style={{ maxWidth: 320 }}
            placeholder="Company name"
            value={newCompany}
            onChange={(e) => setNewCompany(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newCompany.trim()) blockAction('add', newCompany);
            }}
          />
          <button onClick={() => newCompany.trim() && blockAction('add', newCompany)}>Add</button>
        </div>
        <ul style={{ marginTop: '0.75rem' }}>
          {companies.length === 0 && <li className="muted">None.</li>}
          {companies.map((c) => (
            <li key={c} className="row" style={{ justifyContent: 'space-between', maxWidth: 360 }}>
              <span>{c}</span>
              <button className="btn-sm btn-danger" onClick={() => blockAction('remove', c)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="card danger-zone">
        <h2 style={{ marginTop: 0 }}>Danger zone</h2>
        <p className="muted">
          Wipe every job and all application history to start fresh. Your Settings above and your
          blocked-companies list are kept.
        </p>
        <button className="btn-danger btn-lg" onClick={resetData} disabled={resetting}>
          {resetting ? 'Clearing…' : 'Clear all job data'}
        </button>
      </div>
    </div>
  );
}
