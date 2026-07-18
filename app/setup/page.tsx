/**
 * /setup — Setup module (FR-25). Server-rendered: initial values are loaded
 * from SQLite before the form is sent, so there is no loading flash.
 */
import { getDb } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { loadResumeAssets } from '@/lib/resume/load';
import { hasRapidApiKey } from '@/lib/env/rapidapi';
import { SetupForm } from './SetupForm';

export const dynamic = 'force-dynamic';

export default function SetupPage() {
  const db = getDb();
  const config = repo.getUserConfig(db) ?? null;
  const blocklist = repo.listBlockedCompanies(db);

  let defaults = { resumeLatex: '', sourceOfTruth: '', scoringPrompt: '', rewriteRules: '' };
  try {
    const a = loadResumeAssets();
    defaults = {
      resumeLatex: a.baseResume,
      sourceOfTruth: a.sourceOfTruth,
      scoringPrompt: a.scoringPrompt,
      rewriteRules: a.rewriteRules,
    };
  } catch {
    // Neither resume/ nor the committed resume-example/ has the assets (a
    // broken checkout) — start blank.
  }

  return (
    <main className="container">
      <p className="eyebrow">Configuration</p>
      <h1>Setup</h1>
      <p className="muted">
        Stored locally in SQLite. The more specific your Source of Truth, the better the rewrites.
      </p>
      <SetupForm
        config={config}
        blocklist={blocklist}
        defaults={defaults}
        rapidApiKeyPresent={hasRapidApiKey()}
      />
    </main>
  );
}
