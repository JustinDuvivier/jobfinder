import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '../db/index';
import * as repo from '../db/repo';
import { computeLatexDiff } from './index';
import { refreshResumeDiff } from './persist';
import { CONFIG } from '../test-fixtures';

const RESUME = 'name: Alex\nskills: TypeScript';

let db: DB;
let jobId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo.upsertUserConfig(db, { ...CONFIG, resumeLatex: RESUME });
  const info = db
    .prepare(
      `INSERT INTO jobs (job_id, company, title, url, status) VALUES ('lk-1', 'Stripe', 'AI Engineer', 'https://x', 'rewriting')`,
    )
    .run();
  jobId = Number(info.lastInsertRowid);
});

describe('refreshResumeDiff', () => {
  it('persists the diff between the effective base resume and the given LaTeX', () => {
    refreshResumeDiff(db, jobId, 'v1 latex');
    expect(repo.getResumeChanges(db, jobId)).toEqual(computeLatexDiff(RESUME, 'v1 latex'));
  });

  it('replaces any previously stored diff rather than appending', () => {
    refreshResumeDiff(db, jobId, 'v1 latex');
    refreshResumeDiff(db, jobId, 'v2 latex');
    expect(repo.getResumeChanges(db, jobId)).toEqual(computeLatexDiff(RESUME, 'v2 latex'));
  });

  it('stores an all-equal diff when the LaTeX matches the base resume (manual edits reverted)', () => {
    // The autosave caller can hand back the base resume verbatim; the stored
    // diff must then contain no insert/delete blocks, which is what makes the
    // Changes panel empty and trips explain's "no recorded changes" guard.
    refreshResumeDiff(db, jobId, 'v1 latex');
    refreshResumeDiff(db, jobId, RESUME);
    const blocks = repo.getResumeChanges(db, jobId);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((block) => block.blockType === 'equal')).toBe(true);
  });
});
