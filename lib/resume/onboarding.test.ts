import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../db';
import * as repo from '../db/repo';
import { hasUserBaseResume, needsOnboarding } from './onboarding';

let root: string;
let db: DB;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jobfinder-onboard-'));
  db = openDatabase(':memory:');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('needsOnboarding (the FR-33 gate)', () => {
  it('gates a fresh start: empty database, no resume/ files', () => {
    expect(needsOnboarding(db, root)).toBe(true);
  });

  it('lifts when a base resume is authored in-app', () => {
    repo.setResumeAsset(db, 'base_resume', '\\documentclass{article}');
    expect(hasUserBaseResume(db, root)).toBe(true);
    expect(needsOnboarding(db, root)).toBe(false);
  });

  it('does not lift for a non-resume in-app asset', () => {
    repo.setResumeAsset(db, 'scoring_prompt', 'score it');
    expect(hasUserBaseResume(db, root)).toBe(false);
    expect(needsOnboarding(db, root)).toBe(true);
  });

  it('lifts when the user mounted a resume/ base resume file', () => {
    mkdirSync(join(root, 'resume'));
    writeFileSync(join(root, 'resume', 'base_resume.tex'), 'USER TEX');
    expect(needsOnboarding(db, root)).toBe(false);
  });

  it('lifts once the guided flow is finished, even with no user resume', () => {
    repo.setOnboardingComplete(db);
    expect(needsOnboarding(db, root)).toBe(false);
  });
});
