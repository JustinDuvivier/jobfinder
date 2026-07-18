/**
 * runRewrite tests — orchestration only, never model output: the fake client
 * asserts request construction and token fan-out, and SQLite asserts what a
 * completed vs truncated generation persists. The RecordRewrite command's own
 * edge cases (guards, undo, transaction rollback) live in lib/commands.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { openDatabase, type DB } from '@/lib/db';
import * as repo from '@/lib/db/repo';
import { computeLatexDiff } from '@/lib/diff';
import { makeTextMessage } from '@/lib/ai/mock-message';
import { REWRITE_MODEL } from '@/lib/ai/models';
import { CONFIG, insertTestJob } from '@/lib/test-fixtures';
import type { JobStatus } from '@/lib/types';
import { runRewrite } from './run';

const RESUME = '\\documentclass{article}\\begin{document}Alex\\end{document}';
const RULES = 'Tailor minimally; never fabricate.';

let db: DB;
let seq = 0;

function seedJob(status: JobStatus = 'rewriting'): number {
  seq += 1;
  return insertTestJob(db, `lk-${seq}`, {
    company: 'Stripe',
    title: 'AI Engineer',
    description: 'Build agents.',
    status,
  });
}

function seedConfig(): void {
  repo.upsertUserConfig(db, { ...CONFIG, resumeLatex: RESUME, rewriteRules: RULES });
}

/** A fake Anthropic client whose stream yields the given tokens and resolves
 *  to their concatenation, recording each request it receives. */
function fakeClient(
  tokens: string[],
  stopReason: Anthropic.Message['stop_reason'] = 'end_turn',
): { client: Anthropic; requests: Anthropic.MessageCreateParamsNonStreaming[] } {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client = {
    messages: {
      stream(request: Anthropic.MessageCreateParamsNonStreaming) {
        requests.push(request);
        return {
          async *[Symbol.asyncIterator]() {
            for (const text of tokens) {
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
            }
          },
          finalMessage: async () => makeTextMessage(tokens.join(''), stopReason),
        };
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

function versionCount(jobId: number): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM rewritten_latex_versions WHERE job_id = ?`).get(jobId) as {
      n: number;
    }
  ).n;
}

function commandCount(jobId: number): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM command_history WHERE job_id = ?`).get(jobId) as {
      n: number;
    }
  ).n;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  seedConfig();
});

describe('runRewrite', () => {
  it('streams every token through onToken in order and reports done', async () => {
    const id = seedJob();
    const { client } = fakeClient(['\\documentclass', '{article}', ' tailored']);
    const onToken = vi.fn();

    const result = await runRewrite(db, id, { client, onToken });

    expect(result).toEqual({ kind: 'done' });
    expect(onToken.mock.calls.map(([t]) => t)).toEqual([
      '\\documentclass',
      '{article}',
      ' tailored',
    ]);
  });

  it('builds the rewrite request from the job and the effective config', async () => {
    const id = seedJob();
    const { client, requests } = fakeClient(['x']);

    await runRewrite(db, id, { client });

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.model).toBe(REWRITE_MODEL);
    const system = request.system as Array<{ text: string }>;
    expect(system[0].text).toContain(RULES);
    expect(system[1].text).toContain(RESUME);
    expect(request.messages[0].content).toContain('AI Engineer at Stripe');
    expect(request.messages[0].content).toContain('Build agents.');
  });

  it('persists a completed generation via the RecordRewrite command: version, LaTeX, diff, history', async () => {
    const id = seedJob();
    const { client } = fakeClient(['tailored latex']);

    await runRewrite(db, id, { client });

    expect(versionCount(id)).toBe(1);
    expect(repo.getJobById(db, id)!.rewrittenLatex).toBe('tailored latex');
    expect(repo.getResumeChanges(db, id)).toEqual(computeLatexDiff(RESUME, 'tailored latex'));
    expect(commandCount(id)).toBe(1);
  });

  it('selects first-generation vs regeneration by the prior version (undo record differs)', async () => {
    const id = seedJob();

    await runRewrite(db, id, { client: fakeClient(['gen one']).client });
    const firstVersionId = repo.getLatestRewriteVersionId(db, id)!;
    await runRewrite(db, id, { client: fakeClient(['gen two']).client });

    const rows = db
      .prepare(`SELECT version_id FROM command_history WHERE job_id = ? ORDER BY id ASC`)
      .all(id) as Array<{ version_id: number | null }>;
    expect(rows).toEqual([{ version_id: null }, { version_id: firstVersionId }]);
    expect(repo.getJobById(db, id)!.rewrittenLatex).toBe('gen two');
  });

  it('a truncated generation persists nothing and surfaces the warning', async () => {
    const id = seedJob();
    const { client } = fakeClient(['cut off mid-docu'], 'max_tokens');

    const result = await runRewrite(db, id, { client });

    expect(result).toEqual({ kind: 'truncated' });
    expect(versionCount(id)).toBe(0);
    expect(repo.getJobById(db, id)!.rewrittenLatex).toBeNull();
    expect(repo.getResumeChanges(db, id)).toEqual([]);
    expect(commandCount(id)).toBe(0);
  });

  it('returns job_not_found without calling the model', async () => {
    const { client, requests } = fakeClient(['x']);

    const result = await runRewrite(db, 999, { client });

    expect(result).toEqual({ kind: 'job_not_found' });
    expect(requests).toHaveLength(0);
  });

  it('returns not_editable for a non-rewriting job without paying for the generation', async () => {
    const id = seedJob('approved');
    const { client, requests } = fakeClient(['x']);

    const result = await runRewrite(db, id, { client });

    expect(result).toEqual({ kind: 'not_editable', status: 'approved' });
    expect(requests).toHaveLength(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ai_calls`).get()).toEqual({ n: 0 });
  });

  it('ledgers the call in ai_calls through the metering seam (FR-27)', async () => {
    const id = seedJob();
    await runRewrite(db, id, { client: fakeClient(['x']).client });

    const rows = db
      .prepare(`SELECT call_type, job_id FROM ai_calls WHERE job_id = ?`)
      .all(id) as Array<{ call_type: string; job_id: number }>;
    expect(rows).toEqual([{ call_type: 'rewrite', job_id: id }]);
  });
});
