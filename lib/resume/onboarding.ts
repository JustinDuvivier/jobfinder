/**
 * The first-run gate condition (FR-33), decided in exactly one place. The
 * pipeline pages are gated behind the guided onboarding flow until the user
 * has either finished it or supplied a base resume of their own — authored
 * in-app (a `resume_assets` row) or mounted/dropped as a `resume/` file.
 * The (pipeline) route-group layout redirects to /setup while this is true.
 */
import type { DB } from '../db';
import * as repo from '../db/repo';
import { hasUserBaseResumeFile } from './load';

/** True when a user-supplied base resume exists in any layer above the
 *  committed example: the in-app row or a resume/ file. */
export function hasUserBaseResume(db: DB, rootDir?: string): boolean {
  return (
    repo.getResumeAssets(db).base_resume !== undefined || hasUserBaseResumeFile(rootDir)
  );
}

/** The gate: onboarding never finished AND no user base resume anywhere. */
export function needsOnboarding(db: DB, rootDir?: string): boolean {
  return !repo.isOnboardingComplete(db) && !hasUserBaseResume(db, rootDir);
}
