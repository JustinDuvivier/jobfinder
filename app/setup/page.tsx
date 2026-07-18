/**
 * /setup — Setup module (FR-25) and the guided first-run flow (FR-33).
 * Server-rendered: initial values are loaded from SQLite before the page is
 * sent, so there is no loading flash. Until onboarding is finished, the page
 * IS the guided flow; afterwards it is the regular settings form plus the
 * always-editable Documents card (the four resume assets with provenance and
 * per-file revert).
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { resolveResumeAssets, type ResolvedResumeAssets } from '@/lib/resume/load';
import { hasRapidApiKey } from '@/lib/env/rapidapi';
import { SetupForm } from './SetupForm';
import { Onboarding } from './Onboarding';
import { ResumeAssetsCard } from './ResumeAssetsCard';

export const dynamic = 'force-dynamic';

export default function SetupPage() {
  const db = getDb();

  let assets: ResolvedResumeAssets | null = null;
  try {
    assets = resolveResumeAssets(db);
  } catch {
    // An asset is missing from every layer (a broken checkout with nothing
    // authored in-app) — fall through to the settings view without the cards.
  }

  if (!repo.isOnboardingComplete(db) && assets) {
    return (
      <main className="container">
        <p className="eyebrow">First run</p>
        <h1>Welcome</h1>
        <p className="muted">
          JobFinder tailors <strong>your</strong> resume. Supply it once here — the companion
          documents all work out of the box and stay editable later.
        </p>
        <Onboarding assets={assets} />
      </main>
    );
  }

  const config = repo.getUserConfig(db) ?? null;
  const blocklist = repo.listBlockedCompanies(db);

  return (
    <main className="container">
      <p className="eyebrow">Configuration</p>
      <h1>Setup</h1>
      <p className="muted">
        Stored locally in SQLite. The more specific your Source of Truth, the better the rewrites.
      </p>
      {assets && <ResumeAssetsCard assets={assets} />}
      <SetupForm config={config} blocklist={blocklist} rapidApiKeyPresent={hasRapidApiKey()} />
    </main>
  );
}
