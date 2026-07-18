'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { DEFAULT_OWNER_NAME } from '@/lib/types';
import type { UserConfig, ScraperStrategyName, ScoringBackendName } from '@/lib/types';
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
    config?.scraperStrategy ?? 'demo',
  );
  const [greenhouseEnabled, setGreenhouseEnabled] = useState(config?.greenhouseEnabled ?? false);
  const [scoringBackend, setScoringBackend] = useState<ScoringBackendName>(
    config?.scoringBackend ?? 'ollama',
  );
  const [ollamaModel, setOllamaModel] = useState(config?.ollamaModel ?? 'qwen3:4b-instruct-2507-q4_K_M');
  const [searchUrl, setSearchUrl] = useState(config?.searchUrl ?? '');
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

  async function save() {
    setSaving(true);
    setBanner(null);
    try {
      await postJson('/api/config', {
        ownerName,
        scraperStrategy,
        greenhouseEnabled,
        searchUrl,
        keywords: fromLines(keywords),
        locations: fromLines(locations),
        excludedTitleTerms: fromLines(excludedTitleTerms),
        runIntervalMinutes,
        searchLookbackHours,
        scoreThreshold,
        scoringBackend,
        ollamaModel,
      });
      setBanner({ ok: true, text: 'Saved.' });
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
              <option value="proxycurl">Proxycurl</option>
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

        <label>Proxycurl search URL <span className="hint">(only used by the Proxycurl strategy)</span></label>
        <input value={searchUrl} onChange={(e) => setSearchUrl(e.target.value)} placeholder="https://www.linkedin.com/jobs/search/?..." />

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
              Scoring backend{' '}
              <span className="hint">(local model = zero AI cost; Anthropic = Haiku with prompt caching)</span>
            </label>
            <select
              value={scoringBackend}
              onChange={(e) => setScoringBackend(e.target.value as ScoringBackendName)}
            >
              <option value="ollama">Local Ollama (default)</option>
              <option value="anthropic">Anthropic (Haiku)</option>
            </select>
          </div>
          <div>
            <label>
              Ollama model tag <span className="hint">(must be pulled; only used by the local backend)</span>
            </label>
            <input
              value={ollamaModel}
              onChange={(e) => setOllamaModel(e.target.value)}
              placeholder="qwen3:4b-instruct-2507-q4_K_M"
            />
          </div>
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
